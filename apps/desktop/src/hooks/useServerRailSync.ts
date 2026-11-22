/**
 * useServerRailSync - keeps the server rail layout (order + folders) in step
 * across this account's devices through the `server_rail` own-device slot
 * (the achievements pattern, see useAchievementsSync.ts).
 *
 * Triggered by intent and attention:
 *   - once when the account's storage is readable (sign-in / account switch),
 *   - when the window regains focus (at most once a minute) and when the
 *     network comes back (`online`),
 *   - every 5 minutes while the window is visible (the API has no slot-change
 *     push; the probe is one cheap metadata GET),
 *   - after the user changes the rail (RAIL_LAYOUT_CHANGED_EVENT), debounced.
 * A user-initiated backup restore (BACKUP_RESTORED_EVENT) re-stamps the layout
 * as changed now and publishes it, so the restore wins on the other devices.
 * The restore event WE dispatch after adopting a remote layout is ignored
 * (source 'rail-sync'): adopting must never echo back as a push.
 * Best-effort: failures are logged and swallowed; the local layout is always
 * already correct before this runs.
 */
import { useOwnSlotNudge } from './useOwnSlotNudge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import {
    RAIL_LAYOUT_CHANGED_EVENT, RAIL_SYNC_EVENT_SOURCE, publishServerRail, pullServerRail, serverRailRepublishReason,
    serverRailSyncTsKey, loadLocalRailSnapshot,
} from '../services/serverRailSyncService';
import { createServerRailSyncEnv, getServerRailView, setServerRailView } from '../services/serverRailSyncEnv';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;
const POLL_MS = 5 * 60_000;

export interface ServerRailSyncOptions {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

export function useServerRailSync({ userId, deviceId, token }: ServerRailSyncOptions) {
    const inFlight = useRef(false);
    const again = useRef(false);
    const dirty = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRunAt = useRef(0);
    const lastAntiEntropyAt = useRef(0);
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });

    // Cold per-account storage reads as "nothing saved" (secure_local_store_account_rebind):
    // never pull/publish before it is readable.
    const [storageReady, setStorageReady] = useState(false);
    useEffect(() => {
        setStorageReady(false);
        if (!userId) return;
        if (secureLocalStore.isAccountReady(userId)) { setStorageReady(true); return; }
        let cancelled = false;
        void secureLocalStore.whenAccountReady().then(() => { if (!cancelled) setStorageReady(true); }, () => { /* stay off */ });
        return () => { cancelled = true; };
    }, [userId]);

    const enabled = storageReady && !!userId && !!deviceId && !!token;

    const run = useCallback(async () => {
        if (!enabled) return;
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        try {
            do {
                again.current = false;
                lastRunAt.current = Date.now();
                const env = createServerRailSyncEnv({ userId: userId!, deviceId: deviceId!, token: tokenRef.current! });
                let pulled = false;
                try {
                    const res = await pullServerRail(env, getServerRailView(userId!));
                    setServerRailView(userId!, res.view);
                    pulled = true;
                } catch (e) { console.warn('[serverRailSync] pull failed', e); }

                let publish = dirty.current;
                if (!publish && pulled && Date.now() - lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = serverRailRepublishReason(
                            getServerRailView(userId!), env.loadLocalState(), await env.listOwnDeviceIds(), deviceId!,
                        );
                        if (reason !== 'none') { publish = true; lastAntiEntropyAt.current = Date.now(); }
                    } catch (e) { console.warn('[serverRailSync] anti-entropy check failed', e); }
                }
                if (publish) {
                    try {
                        dirty.current = false;
                        const view = await publishServerRail(env, deviceId!);
                        if (view) setServerRailView(userId!, view);
                    } catch (e) {
                        dirty.current = true;
                        console.warn('[serverRailSync] publish failed', e);
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

    // A local rail edit, and a user-initiated restore, both mean "this device's layout is the newest".
    useEffect(() => {
        if (!enabled) return;
        const onChanged = (e: Event) => {
            if ((e as CustomEvent<{ userId?: string }>).detail?.userId === userId) markDirty();
        };
        const onRestored = (e: Event) => {
            const d = (e as CustomEvent<{ userId?: string; source?: string }>).detail;
            if (d?.userId !== userId || d.source === RAIL_SYNC_EVENT_SOURCE) return;
            try {
                if (loadLocalRailSnapshot(secureLocalStore, userId!).updatedAt === 0) return;
                secureLocalStore.setItem(serverRailSyncTsKey(userId!), String(Date.now()));
            } catch { return; }
            markDirty();
        };
        window.addEventListener(RAIL_LAYOUT_CHANGED_EVENT, onChanged);
        window.addEventListener(BACKUP_RESTORED_EVENT, onRestored);
        return () => {
            window.removeEventListener(RAIL_LAYOUT_CHANGED_EVENT, onChanged);
            window.removeEventListener(BACKUP_RESTORED_EVENT, onRestored);
        };
    }, [enabled, userId, markDirty]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    // Real time: another device wrote this slot (own_slot:changed) -> one coalesced pull.
    useOwnSlotNudge('server_rail', enabled, () => { void run(); });
    return useMemo(() => ({ markDirty, syncNow: () => { void run(); } }), [markDirty, run]);
}
