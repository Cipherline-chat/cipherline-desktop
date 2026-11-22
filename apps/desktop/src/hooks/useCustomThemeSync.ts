/**
 * useCustomThemeSync - keeps the custom theme library in step across this
 * account's devices through the `themes` own-device slot (plan T5, owner
 * decision D8; a copy of useCardStyleSync). Also re-applies THIS device's
 * active custom theme when a pull changes or deletes it.
 *
 * Pulls: once when the account's storage is readable, on window focus (>= 60 s
 * apart), when the network returns, and every 5 minutes while visible.
 * Publishes: after a USER edit (CUSTOM_THEME_USER_EDIT_EVENT), debounced 3 s, and
 * after a user backup restore / device transfer (BACKUP_RESTORED_EVENT), which
 * re-stamps the restored themes as "now" so the restore wins.
 * Adopting another device's state never publishes (no echo).
 * An API that does not know the slot answers 400: that silences sync for 30
 * minutes with no console noise and local themes keep working untouched.
 */
import { useOwnSlotNudge } from './useOwnSlotNudge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { customThemesRepublishReason, publishCustomThemes, pullCustomThemes, isSlotUnavailableError } from '../services/customThemeSyncService';
import {
    createCustomThemeSyncEnv, getCustomThemesView, loadLocalCustomThemeState, saveCustomThemeState, setCustomThemesView,
} from '../services/customThemeSyncEnv';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';
import { isEmptyThemeState, restampAllThemes } from '../utils/customThemeSync';
import { CUSTOM_THEMES_CHANGED_EVENT, CUSTOM_THEME_USER_EDIT_EVENT, reconcileActiveCustomTheme } from '../theme/customThemeLibrary';

const PUBLISH_DEBOUNCE_MS = 3_000;
const FOCUS_MIN_GAP_MS = 60_000;
const POLL_MS = 5 * 60_000;
export const THEMES_UNAVAILABLE_BACKOFF_MS = 30 * 60_000;

export interface CustomThemeSyncOptions {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

export function useCustomThemeSync({ userId, deviceId, token }: CustomThemeSyncOptions) {
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
                const env = createCustomThemeSyncEnv({ userId: userId!, deviceId: deviceId!, token: tokenRef.current! });
                let pulled = false;
                try {
                    const res = await pullCustomThemes(env, getCustomThemesView(userId!));
                    setCustomThemesView(userId!, res.view);
                    pulled = true;
                    // Another device edited or deleted the theme this device shows.
                    if (res.applied) reconcileActiveCustomTheme(userId);
                } catch (e) {
                    if (isSlotUnavailableError(e)) { unavailableUntil.current = Date.now() + THEMES_UNAVAILABLE_BACKOFF_MS; break; }
                    console.warn('[customThemeSync] pull failed', e);
                }

                let publish = dirty.current;
                if (!publish && pulled && Date.now() - lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = customThemesRepublishReason(
                            getCustomThemesView(userId!), env.loadLocalState(), await env.listOwnDeviceIds(), deviceId!, Date.now(),
                        );
                        if (reason !== 'none') { publish = true; lastAntiEntropyAt.current = Date.now(); }
                    } catch (e) { console.warn('[customThemeSync] anti-entropy check failed', e); }
                }
                if (publish) {
                    try {
                        dirty.current = false;
                        const view = await publishCustomThemes(env, deviceId!);
                        if (view) setCustomThemesView(userId!, view);
                    } catch (e) {
                        dirty.current = true;
                        if (isSlotUnavailableError(e)) { unavailableUntil.current = Date.now() + THEMES_UNAVAILABLE_BACKOFF_MS; break; }
                        console.warn('[customThemeSync] publish failed', e);
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
        // A user backup restore / device transfer: the restored themes are "newest".
        const onRestored = (e: Event) => {
            if ((e as CustomEvent<{ userId?: string }>).detail?.userId !== userId) return;
            try {
                const local = loadLocalCustomThemeState(userId!);
                if (isEmptyThemeState(local)) return;
                if (!saveCustomThemeState(userId!, restampAllThemes(local, Date.now()))) return;
                window.dispatchEvent(new CustomEvent(CUSTOM_THEMES_CHANGED_EVENT));
                reconcileActiveCustomTheme(userId);
            } catch { return; }
            markDirty();
        };
        window.addEventListener(CUSTOM_THEME_USER_EDIT_EVENT, onUserEdit);
        window.addEventListener(BACKUP_RESTORED_EVENT, onRestored);
        return () => {
            window.removeEventListener(CUSTOM_THEME_USER_EDIT_EVENT, onUserEdit);
            window.removeEventListener(BACKUP_RESTORED_EVENT, onRestored);
        };
    }, [enabled, userId, markDirty]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    // Real time: another device wrote this slot (own_slot:changed) -> one coalesced pull.
    useOwnSlotNudge('themes', enabled, () => { void run(); });
    return useMemo(() => ({ markDirty, syncNow: () => { void run(); } }), [markDirty, run]);
}
