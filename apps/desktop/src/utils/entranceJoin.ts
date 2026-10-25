/**
 * What happens when someone joins the call you are in: whether their entrance
 * sound plays, decided in one place so the built-in and the custom path go
 * through exactly the same protections (components/call/useEntranceSounds.ts
 * calls this once per observed join).
 *
 *   1. YOUR listener switch off, or that person muted by you -> nothing (no
 *      network, no gate).
 *   2. Their CURRENT sound (they may have just changed it). None -> nothing.
 *   3. Built-in id -> playable. `custom:<id>` -> only if that exact sound has
 *      reached this device, verified (utils/customEntranceSound/receiver.ts).
 *      The sender can only start sending once it is connected, which is the
 *      same moment we see the join, so a transfer already under way gets
 *      CUSTOM_ARRIVAL_GRACE_MS from the join to land. That is a bounded
 *      grace, not a queue: if it is not here by then, nothing plays, then or
 *      later. Anything else (an id this build does not know) -> nothing.
 *   4. Only a person with something playable goes through the gate
 *      (utils/entranceSoundGate.ts: rejoin window, global gap, and the
 *      switch / mute re-read), so a joiner with no sound never uses up the
 *      2 s slot.
 */

import { isEntranceSoundId } from './entranceSounds';
import { customContentId } from './customEntranceSound/constants';
import type { EntranceGate } from './entranceSoundGate';
import type { EntrancePrefs } from './entrancePrefs';

export const CUSTOM_ARRIVAL_GRACE_MS = 1_500;

export interface EntranceJoinDeps {
    getPrefs(): EntrancePrefs;
    /** The joiner's current cosmetics (fresh read). */
    personalization(userId: string): Promise<{ entrance_sound: string | null }>;
    /** A verified received custom sound, waiting at most `timeoutMs`. */
    waitForCustom(contentId: string, timeoutMs: number): Promise<{ url: string | null; gain: number } | null>;
    gate: EntranceGate;
    now(): number;
    playBuiltin(soundId: string): void;
    playCustom(url: string, gain: number): void;
}

export type EntranceJoinResult =
    | 'disabled' | 'muted' | 'none' | 'unknown' | 'not-arrived'
    | 'rejoin' | 'busy' | 'played';

export async function handleEntranceJoin(userId: string, deps: EntranceJoinDeps): Promise<EntranceJoinResult> {
    const joinedAt = deps.now();
    const prefs = deps.getPrefs();
    if (!prefs.enabled) return 'disabled';
    if (prefs.muted.includes(userId)) return 'muted';

    let sound: string | null = null;
    try { sound = (await deps.personalization(userId)).entrance_sound; } catch { sound = null; }
    if (!sound) return 'none';

    let play: () => void;
    const contentId = customContentId(sound);
    if (contentId) {
        const left = Math.max(0, joinedAt + CUSTOM_ARRIVAL_GRACE_MS - deps.now());
        let got: { url: string | null; gain: number } | null = null;
        try { got = await deps.waitForCustom(contentId, left); } catch { got = null; }
        if (!got || !got.url || !(got.gain > 0)) return 'not-arrived';
        const { url, gain } = got;
        play = () => deps.playCustom(url, gain);
    } else if (isEntranceSoundId(sound)) {
        const id = sound;
        play = () => deps.playBuiltin(id);
    } else {
        return 'unknown';
    }

    // Re-read: the switch may have been flipped (or the person muted) while we waited.
    const decision = deps.gate.decide(userId, deps.now(), deps.getPrefs());
    if (decision !== 'play') return decision;
    play();
    return 'played';
}
