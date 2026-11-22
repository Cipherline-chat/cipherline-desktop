/**
 * useMuteSync - keeps every notification mute (channels, categories, servers,
 * DMs, group chats) in step across this account's devices through the `mutes`
 * own-device slot. A copy of useMuteSync with two differences:
 *
 *  - REAL TIME: the server sends `own_slot:changed` to a user's other devices
 *    after any own-device slot write (hooks/useRealtime.ts re-dispatches it as
 *    OWN_SLOT_CHANGED_EVENT). A nudge for slot `mutes` pulls at once (coalesced
 *    to one run per second), so a mute made on a phone shows here within a
 *    second or two. Focus / online / the 5-minute poll stay as the fallback
 *    for a missed nudge or an API that does not send it.
 *  - Adopting another device's state re-reads the context (MUTES_CHANGED_EVENT)
 *    and never publishes (no echo).
 *
 * Publishes: after a USER edit (MUTES_USER_EDIT_EVENT), debounced 3 s, and after
 * a backup restore. An API that does not know the slot answers 400: that
 * silences sync for 30 minutes and local mutes keep working untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { mutesRepublishReason, publishMutes, pullMutes, isSlotUnavailableError } from '../services/muteSyncService';
import {
    MUTES_CHANGED_EVENT, MUTES_USER_EDIT_EVENT, OWN_SLOT_CHANGED_EVENT, createMuteSyncEnv, getMutesView, loadLocalMuteState, setMutesView,
} from '../services/muteSyncEnv';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';
import { MUTES_SLOT, isEmptyMuteState } from '../utils/muteSync';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;
const POLL_MS = 5 * 60_000;
export const MUTES_UNAVAILABLE_BACKOFF_MS = 30 * 60_000;
/** A nudge pulls at once, but a burst of them (several edits elsewhere) is one run a second. */
const NUDGE_MIN_GAP_MS = 1_000;

export interface MuteSyncOptions {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

export function useMuteSync({ userId, deviceId, token }: MuteSyncOptions) {
    const inFlight = useRef(false);
    const again = useRef(false);
    const dirty = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRunAt = useRef(0);
    const lastAntiEntropyAt = useRef(0);
    const unavailableUntil = useRef(0);
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });

    // Cold per-account storage reads as "nothing saved" (secure_local_store_account_rebind):
    // never pull/publish before it is readable.
    // `readyFor` only changes from the async callback (no synchronous setState in the effect).
    const [readyFor, setReadyFor] = useState<string | null>(null);
    const storageReady = !!userId && (readyFor === userId || secureLocalStore.isAccountReady(userId));
    useEffect(() => {
        if (!userId || secureLocalStore.isAccountReady(userId)) return;
        let cancelled = false;
        void secureLocalStore.whenAccountReady().then(() => { if (!cancelled) setReadyFor(userId); }, () => { /* stay off */ });
        return () => { cancelled = true; };
    }, [userId]);

    const enabled = storageReady && !!userId && !!deviceId && !!token;

    const run = useCallback(async () => {
        if (!enabled) return;
        if (Date.now() < unavailableUntil.current) return; // older API: sync not available yet
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        try {
            do {
                again.current = false;
                lastRunAt.current = Date.now();
                const env = createMuteSyncEnv({ userId: userId!, deviceId: deviceId!, token: tokenRef.current! });
                let pulled = false;
                try {
                    const res = await pullMutes(env, getMutesView(userId!));
                    setMutesView(userId!, res.view);
                    pulled = true;
                } catch (e) {
                    if (isSlotUnavailableError(e)) { unavailableUntil.current = Date.now() + MUTES_UNAVAILABLE_BACKOFF_MS; break; }
                    console.warn('[muteSync] pull failed', e);
                }

                let publish = dirty.current;
                if (!publish && pulled && Date.now() - lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = mutesRepublishReason(
                            getMutesView(userId!), env.loadLocalState(), await env.listOwnDeviceIds(), deviceId!, Date.now(),
                        );
                        if (reason !== 'none') { publish = true; lastAntiEntropyAt.current = Date.now(); }
                    } catch (e) { console.warn('[muteSync] anti-entropy check failed', e); }
                }
                if (publish) {
                    try {
                        dirty.current = false;
                        const view = await publishMutes(env, deviceId!);
                        if (view) setMutesView(userId!, view);
                    } catch (e) {
                        dirty.current = true;
                        if (isSlotUnavailableError(e)) { unavailableUntil.current = Date.now() + MUTES_UNAVAILABLE_BACKOFF_MS; break; }
                        console.warn('[muteSync] publish failed', e);
                    }
                }
            } while (again.current);
        } finally {
            inFlight.current = false;
        }
    }, [enabled, userId, deviceId]);

    const markDirty = useCallback(() => {
        dirty.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { void run(); }, PUBLISH_DEBOUNCE_MS);
    }, [run]);

    useEffect(() => { if (enabled) void run(); }, [enabled, run]);

    useEffect(() => {
        if (!enabled) return;
        const onFocus = () => { if (Date.now() - lastRunAt.current >= FOCUS_MIN_GAP_MS) void run(); };
        const onOnline = () => { void run(); };
        const poll = setInterval(() => { if (document.visibilityState !== 'hidden') void run(); }, POLL_MS);
        window.addEventListener('focus', onFocus);
        window.addEventListener('online', onOnline);
        return () => {
            clearInterval(poll);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('online', onOnline);
        };
    }, [enabled, run]);

    useEffect(() => {
        if (!enabled) return;
        const onUserEdit = (e: Event) => {
            if ((e as CustomEvent<{ userId?: string }>).detail?.userId === userId) markDirty();
        };
        // A backup restore / device transfer replaced the blob: the context re-reads it, and it is published
        // (the stamps in the restored record keep the merge honest; nothing is re-stamped).
        const onRestored = (e: Event) => {
            if ((e as CustomEvent<{ userId?: string }>).detail?.userId !== userId) return;
            try {
                if (isEmptyMuteState(loadLocalMuteState(userId!))) return;
                window.dispatchEvent(new CustomEvent(MUTES_CHANGED_EVENT, { detail: { userId } }));
            } catch { return; }
            markDirty();
        };
        window.addEventListener(MUTES_USER_EDIT_EVENT, onUserEdit);
        window.addEventListener(BACKUP_RESTORED_EVENT, onRestored);
        return () => {
            window.removeEventListener(MUTES_USER_EDIT_EVENT, onUserEdit);
            window.removeEventListener(BACKUP_RESTORED_EVENT, onRestored);
        };
    }, [enabled, userId, markDirty]);

    // Real time: the server told us another device wrote the `mutes` slot.
    useEffect(() => {
        if (!enabled) return;
        const onNudge = (e: Event) => {
            if ((e as CustomEvent<{ slot?: string }>).detail?.slot !== MUTES_SLOT) return;
            if (Date.now() - lastRunAt.current < NUDGE_MIN_GAP_MS) { again.current = true; if (!inFlight.current) setTimeout(() => { void run(); }, NUDGE_MIN_GAP_MS); return; }
            void run();
        };
        window.addEventListener(OWN_SLOT_CHANGED_EVENT, onNudge);
        return () => window.removeEventListener(OWN_SLOT_CHANGED_EVENT, onNudge);
    }, [enabled, run]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    return useMemo(() => ({ markDirty, syncNow: () => { void run(); } }), [markDirty, run]);
}
