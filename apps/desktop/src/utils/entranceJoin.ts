/**
 * What happens when someone joins the call you are in: whether their entrance
 * sound plays, decided in one place so the built-in and the custom path go
 * through exactly the same protections (components/call/useEntranceSounds.ts
 * calls this once per observed join).
 *
 *   1. YOUR listener switch off, or that person muted by you -> nothing (no
 *      network, no gate).
 *   2. Their CURRENT sound (they may have just changed it). A read that
 *      FAILS (429, blip, transport not bound yet) is retried inside
 *      SELECTION_WAIT_MS, then falls back to DEFAULT_ENTRANCE_SOUND_ID: an
 *      unknown selection must not read as "has no sound". A read that
 *      SUCCEEDS with no sound -> nothing.
 *   3. Built-in id -> playable. `custom:<id>` -> only if that exact sound has
 *      reached this device, verified (utils/customEntranceSound/receiver.ts).
 *      The sender can only start sending once it is connected, which is the
 *      same moment we see the join, so a transfer already under way gets
 *      CUSTOM_ARRIVAL_GRACE_MS from the join to land. That is a bounded
 *      grace, not a queue: if it is not here by then the default sound plays
 *      instead (never silence), and the custom one is not played later.
 *      An id this build does not know -> nothing.
 *   4. Only a person with something playable goes through the gate
 *      (utils/entranceSoundGate.ts: rejoin window, global gap, and the
 *      switch / mute re-read), so a joiner with no sound never uses up the
 *      2 s slot. The gate is rolled back if playback itself fails, so a
 *      failed play never counts as "played".
 */

import { isEntranceSoundId } from './entranceSounds';
import { customContentId } from './customEntranceSound/constants';
import type { EntranceGate } from './entranceSoundGate';
import type { EntrancePrefs } from './entrancePrefs';

export const CUSTOM_ARRIVAL_GRACE_MS = 1_500;
/** How long an unreadable selection is retried before the default sound is used. */
export const SELECTION_WAIT_MS = 1_500;
/** The sound used when the joiner's choice cannot be learned or delivered in time. */
export const DEFAULT_ENTRANCE_SOUND_ID = 'bubble-pop';
const SELECTION_RETRY_DELAYS_MS = [200, 400, 700];

type PlayResult = void | boolean | Promise<boolean | void>;

export interface EntranceJoinDeps {
    getPrefs(): EntrancePrefs;
    /**
     * The joiner's current cosmetics (fresh read). MUST reject when the read
     * fails, so "unknown" is never mistaken for "has no sound".
     */
    personalization(userId: string): Promise<{ entrance_sound: string | null }>;
    /** A verified received custom sound, waiting at most `timeoutMs`. */
    waitForCustom(contentId: string, timeoutMs: number): Promise<{ url: string | null; gain: number } | null>;
    gate: EntranceGate;
    now(): number;
    /** Resolves false when playback was attempted and failed. */
    playBuiltin(soundId: string): PlayResult;
    playCustom(url: string, gain: number): PlayResult;
    /** Injected for deterministic tests. */
    sleep?(ms: number): Promise<void>;
}

export type EntranceJoinResult =
    | 'disabled' | 'muted' | 'none' | 'unknown' | 'not-arrived'
    | 'rejoin' | 'busy' | 'played' | 'failed';

export async function handleEntranceJoin(userId: string, deps: EntranceJoinDeps): Promise<EntranceJoinResult> {
    const joinedAt = deps.now();
    const prefs = deps.getPrefs();
    if (!prefs.enabled) return 'disabled';
    if (prefs.muted.includes(userId)) return 'muted';

    const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    let sound: string | null = null;
    let known = false;
    for (let attempt = 0; ; attempt++) {
        try { sound = (await deps.personalization(userId)).entrance_sound; known = true; break; } catch { /* retry */ }
        const delay = SELECTION_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || deps.now() + delay - joinedAt > SELECTION_WAIT_MS) break;
        await sleep(delay);
    }
    if (!known) {
        console.warn('[entrance-sound] joiner selection unavailable; using the default sound');
        sound = DEFAULT_ENTRANCE_SOUND_ID;
    }
    if (!sound) return 'none';

    let play: () => PlayResult;
    const contentId = customContentId(sound);
    if (contentId) {
        const left = Math.max(0, joinedAt + CUSTOM_ARRIVAL_GRACE_MS - deps.now());
        let got: { url: string | null; gain: number } | null = null;
        try { got = await deps.waitForCustom(contentId, left); } catch { got = null; }
        if (got && got.url && got.gain > 0) {
            const { url, gain } = got;
            play = () => deps.playCustom(url, gain);
        } else {
            console.warn('[entrance-sound] custom sound did not arrive in time; using the default sound');
            play = () => deps.playBuiltin(DEFAULT_ENTRANCE_SOUND_ID);
        }
    } else if (isEntranceSoundId(sound)) {
        const id = sound;
        play = () => deps.playBuiltin(id);
    } else {
        return 'unknown';
    }

    // Re-read: the switch may have been flipped (or the person muted) while we waited.
    const decision = deps.gate.decide(userId, deps.now(), deps.getPrefs());
    if (decision !== 'play') return decision;
    let ok: boolean | void = true;
    try { ok = await play(); } catch { ok = false; }
    if (ok === false) {
        deps.gate.rollback(userId);
        return 'failed';
    }
    return 'played';
}
