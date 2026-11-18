/**
 * useCardStyleSync - keeps the "My styles" library in step across this
 * account's devices through the `card_styles` own-device slot
 * (docs/message-card-style-sync.md; same pattern as useServerRailSync).
 *
 * Pulls: once when the account's storage is readable, on window focus (>= 60 s
 * apart), when the network returns, and every 5 minutes while visible.
 * Publishes: after a USER edit (CARD_STYLE_USER_EDIT_EVENT), debounced 3 s, and
 * after a user backup restore / device transfer (BACKUP_RESTORED_EVENT), which
 * re-stamps the restored styles as "now" so the restore wins.
 * Adopting another device's state never publishes (no echo).
 * An API that does not know the slot answers 400: that silences sync for 30
 * minutes with no console noise and local styles keep working untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { cardStylesRepublishReason, publishCardStyles, pullCardStyles, isSlotUnavailableError } from '../services/cardStyleSyncService';
import {
    createCardStyleSyncEnv, getCardStylesView, loadLocalCardStyleState, saveCardStyleState, setCardStylesView,
} from '../services/cardStyleSyncEnv';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';
import { isEmptyStyleState, restampAll } from '../utils/cardStyleSync';
import { CARD_LIBRARY_CHANGED_EVENT, CARD_STYLE_USER_EDIT_EVENT } from './useCardStylePrefs';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;
const POLL_MS = 5 * 60_000;
export const UNAVAILABLE_BACKOFF_MS = 30 * 60_000;

export interface CardStyleSyncOptions {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

export function useCardStyleSync({ userId, deviceId, token }: CardStyleSyncOptions) {
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
        if (Date.now() < unavailableUntil.current) return; // older API: sync not available yet
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        try {
            do {
                again.current = false;
                lastRunAt.current = Date.now();
                const env = createCardStyleSyncEnv({ userId: userId!, deviceId: deviceId!, token: tokenRef.current! });
                let pulled = false;
                try {
                    const res = await pullCardStyles(env, getCardStylesView(userId!));
                    setCardStylesView(userId!, res.view);
                    pulled = true;
                } catch (e) {
                    if (isSlotUnavailableError(e)) { unavailableUntil.current = Date.now() + UNAVAILABLE_BACKOFF_MS; break; }
                    console.warn('[cardStyleSync] pull failed', e);
                }

                let publish = dirty.current;
                if (!publish && pulled && Date.now() - lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = cardStylesRepublishReason(
                            getCardStylesView(userId!), env.loadLocalState(), await env.listOwnDeviceIds(), deviceId!, Date.now(),
                        );
                        if (reason !== 'none') { publish = true; lastAntiEntropyAt.current = Date.now(); }
                    } catch (e) { console.warn('[cardStyleSync] anti-entropy check failed', e); }
                }
                if (publish) {
                    try {
                        dirty.current = false;
                        const view = await publishCardStyles(env, deviceId!);
                        if (view) setCardStylesView(userId!, view);
                    } catch (e) {
                        dirty.current = true;
                        if (isSlotUnavailableError(e)) { unavailableUntil.current = Date.now() + UNAVAILABLE_BACKOFF_MS; break; }
                        console.warn('[cardStyleSync] publish failed', e);
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
        // A user backup restore / device transfer: the restored styles are "newest".
        const onRestored = (e: Event) => {
            if ((e as CustomEvent<{ userId?: string }>).detail?.userId !== userId) return;
            try {
                const local = loadLocalCardStyleState(userId!);
                if (isEmptyStyleState(local)) return;
                if (!saveCardStyleState(userId!, restampAll(local, Date.now()))) return;
                window.dispatchEvent(new CustomEvent(CARD_LIBRARY_CHANGED_EVENT));
            } catch { return; }
            markDirty();
        };
        window.addEventListener(CARD_STYLE_USER_EDIT_EVENT, onUserEdit);
        window.addEventListener(BACKUP_RESTORED_EVENT, onRestored);
        return () => {
            window.removeEventListener(CARD_STYLE_USER_EDIT_EVENT, onUserEdit);
            window.removeEventListener(BACKUP_RESTORED_EVENT, onRestored);
        };
    }, [enabled, userId, markDirty]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    return useMemo(() => ({ markDirty, syncNow: () => { void run(); } }), [markDirty, run]);
}
