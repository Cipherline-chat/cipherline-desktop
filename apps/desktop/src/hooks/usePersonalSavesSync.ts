/**
 * usePersonalSavesSync — keeps channel "Save for me" and personal pins in step
 * across this account's devices, through the `personal_saves` own-device slot.
 *
 * Triggered by intent and by attention, never by a timer:
 *
 *   • once when the account is ready (storage unlocked, pins restored),
 *   • when the window regains focus (at most once a minute),
 *   • `syncSoon()` when a surface that shows saves opens (channel switch,
 *     pinned panel) — at most every 30 s,
 *   • `markDirty()` after a local save/unsave/pin/unpin — debounced, so a
 *     burst of changes uploads once.
 *
 * The probe (`GET /history/slot/:slot/meta`) is the only request on an idle
 * sync; the blob is downloaded only when it changed, and a publish happens only
 * for a local change or an anti-entropy reason (ownSlotSync.republishReason).
 *
 * Everything is best-effort: failures are logged and swallowed, the local
 * state is always already correct before this runs.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { pullSaves, publishSaves, savesRepublishReason } from '../services/personalSavesSyncService';
import { createSavesSyncEnv, getSavesView, setSavesView, type SavesLocalBinding } from '../services/personalSavesSyncEnv';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;
/** `syncSoon()` (channel switch, pinned panel opening) — frequent, so gapped. */
const SOON_MIN_GAP_MS = 30_000;

export interface PersonalSavesSyncOptions {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
    /** False until the local pin state has been restored from storage — a sync
     *  before that would merge the remote into an empty local state and then
     *  persist it over the real one. */
    ready: boolean;
    local: SavesLocalBinding;
}

export function usePersonalSavesSync({ userId, deviceId, token, ready, local }: PersonalSavesSyncOptions) {
    const inFlight = useRef(false);
    const again = useRef(false);
    const dirty = useRef(false);
    const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRunAt = useRef(0);
    const lastAntiEntropyAt = useRef(0);
    // Set once the first pull has been ATTEMPTED (succeeded or failed). The
    // retention sweep waits for it: a save made on another device must be
    // merged here before this device decides what is old enough to delete
    // (multi-device audit 2026-10-03). Attempted, not succeeded — an API
    // without the slot answers 400 forever, and that must not switch retention
    // off for good; the DM pull gate already covers "offline".
    const pulledOnce = useRef(false);
    // Latest binding without re-creating the callbacks on every render.
    const localRef = useRef(local);
    useEffect(() => { localRef.current = local; });

    const enabled = ready && !!userId && !!deviceId && !!token;

    const run = useCallback(async () => {
        if (!enabled) return;
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        try {
            do {
                again.current = false;
                lastRunAt.current = Date.now();
                const env = createSavesSyncEnv(
                    { userId: userId!, deviceId: deviceId!, token: token! },
                    { load: () => localRef.current.load(), save: (n, p) => localRef.current.save(n, p) },
                );

                // Pull first: publishing without merging would overwrite the
                // slot with a view that never saw the other devices' changes.
                let pulled = false;
                try {
                    const res = await pullSaves(env, getSavesView(userId!));
                    setSavesView(userId!, res.view);
                    pulled = true;
                } catch (e) {
                    console.warn('[savesSync] pull failed', e);
                }
                pulledOnce.current = true;

                let publish = dirty.current;
                if (!publish && pulled && Date.now() - lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = savesRepublishReason(
                            getSavesView(userId!),
                            env.loadLocalState(),
                            await env.listOwnDeviceIds(),
                            deviceId!,
                        );
                        if (reason !== 'none') { publish = true; lastAntiEntropyAt.current = Date.now(); }
                    } catch (e) {
                        console.warn('[savesSync] anti-entropy check failed', e);
                    }
                }

                // A LOCAL change is published even when the pull failed. Gating
                // it on the pull would deadlock the account on a slot nobody can
                // read (a record whose upload died mid-way): every device's pull
                // fails, so nobody ever publishes the repair. Replacing a slot
                // this device did not see is safe under LWW — anything it lacked
                // is still on the device that has it, and that device's
                // anti-entropy check republishes it. Anti-entropy itself needs a
                // successful pull (it compares against the slot), see above.
                if (publish) {
                    try {
                        dirty.current = false;
                        // null = nobody to publish to. Stay clean: a single-device
                        // account has nothing pending, and the next device to
                        // appear is caught by the anti-entropy check instead.
                        const view = await publishSaves(env, deviceId!);
                        if (view) setSavesView(userId!, view);
                    } catch (e) {
                        dirty.current = true;
                        console.warn('[savesSync] publish failed', e);
                    }
                }
            } while (again.current);
        } finally {
            inFlight.current = false;
        }
    }, [enabled, userId, deviceId, token]);

    const syncNow = useCallback(() => { void run(); }, [run]);
    const syncSoon = useCallback(() => {
        if (Date.now() - lastRunAt.current >= SOON_MIN_GAP_MS) void run();
    }, [run]);

    const markDirty = useCallback(() => {
        dirty.current = true;
        if (publishTimer.current) clearTimeout(publishTimer.current);
        publishTimer.current = setTimeout(() => { void run(); }, PUBLISH_DEBOUNCE_MS);
    }, [run]);

    // Once when ready, and whenever the account/device changes.
    useEffect(() => {
        if (enabled) void run();
    }, [enabled, run]);

    // On focus, throttled.
    useEffect(() => {
        if (!enabled) return;
        const onFocus = () => {
            if (Date.now() - lastRunAt.current >= FOCUS_MIN_GAP_MS) void run();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [enabled, run]);

    // Unmount (sign-out, account switch): drop the timer. A pending change is
    // not lost — it is in local state, and the anti-entropy check on the next
    // sync sees the slot is behind and publishes it.
    useEffect(() => () => {
        if (publishTimer.current) clearTimeout(publishTimer.current);
    }, []);

    const hasPulledOnce = useCallback(() => pulledOnce.current, []);
    return useMemo(() => ({ syncNow, syncSoon, markDirty, hasPulledOnce }), [syncNow, syncSoon, markDirty, hasPulledOnce]);
}
