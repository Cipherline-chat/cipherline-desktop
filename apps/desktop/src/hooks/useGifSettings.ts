import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GifSettings {
    /**
     * When ON (default), animated GIFs play automatically whenever the
     * Cipherline window is focused.  When OFF, GIFs are frozen on the
     * first frame and only animate while the cursor is over them.
     */
    autoPlayGifs: boolean;
    /**
     * KLIPY GIF search + loading KLIPY GIFs in chat. OFF by default — opt-in.
     *
     * When ON, this device talks to KLIPY directly (api.klipy.com for search,
     * KLIPY's CDN for the media), so KLIPY sees the user's IP address and what
     * they search for. When OFF, the picker's KLIPY tab only shows the opt-in
     * notice and makes NO request, and a received KLIPY GIF is a "tap to load"
     * placeholder that loads nothing until tapped. The Saved tab (the user's
     * own library) works either way.
     *
     * Lives in `cipherline_gif_settings`, which backupRegistry already
     * classifies as included — a preference, not media, so it may back up.
     */
    klipyEnabled: boolean;
    /**
     * The first-open notice was answered with "Not now". Only decides which
     * tab the picker opens on; it never enables anything.
     */
    klipyNoticeDismissed: boolean;
}

const STORAGE_KEY = 'cipherline_gif_settings';
/** Custom event name — dispatched on `window` whenever any instance updates
 *  the settings so that all other `useGifSettings()` hook instances (e.g.
 *  every mounted GifPlayer) pick up the change immediately without a refresh. */
export const GIF_SETTINGS_CHANGED = 'cipherline:gif-settings-changed';
const CHANGE_EVENT = GIF_SETTINGS_CHANGED;

const DEFAULTS: GifSettings = {
    autoPlayGifs: true,
    klipyEnabled: false,
    klipyNoticeDismissed: false,
};

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Read the stored settings. Booleans only — a stored non-boolean (a restored
 * backup from a future build, hand-edited storage) falls back to the default,
 * and for `klipyEnabled` the default is OFF, so nothing can opt a user in to a
 * third party by being malformed.
 */
export function loadGifSettings(): GifSettings {
    let parsed: Record<string, unknown> = {};
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        const v = raw ? JSON.parse(raw) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v;
    } catch { /* fall through to defaults */ }
    const bool = (k: keyof GifSettings) => (typeof parsed[k] === 'boolean' ? parsed[k] as boolean : DEFAULTS[k]);
    return {
        autoPlayGifs: bool('autoPlayGifs'),
        klipyEnabled: bool('klipyEnabled'),
        klipyNoticeDismissed: bool('klipyNoticeDismissed'),
    };
}

/** Synchronous opt-in check for non-React callers (the KLIPY client). */
export function isKlipyEnabled(): boolean {
    return loadGifSettings().klipyEnabled;
}

/**
 * Write one or more settings and tell every mounted hook instance. Usable
 * outside React (the tap-to-load "Always load KLIPY GIFs" action calls it).
 */
export function updateGifSettings(patch: Partial<GifSettings>): GifSettings {
    const next = { ...loadGifSettings(), ...patch };
    try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* locked store: in-memory only */ }
    try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT)); } catch { /* no DOM in tests */ }
    return next;
}

const loadSettings = loadGifSettings;

export function useGifSettings() {
    const [settings, setSettings] = useState<GifSettings>(loadSettings);

    // Re-read from localStorage whenever another instance (e.g. the Settings
    // modal) changes the value.  The setter dispatches CHANGE_EVENT so every
    // mounted hook instance syncs without needing a React context or a refresh.
    useEffect(() => {
        const onUpdate = () => setSettings(loadSettings());
        window.addEventListener(CHANGE_EVENT, onUpdate);
        return () => window.removeEventListener(CHANGE_EVENT, onUpdate);
    }, []);

    const setAutoPlayGifs = useCallback((v: boolean) => {
        setSettings(prev => {
            const next = { ...prev, autoPlayGifs: v };
            try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
            // Notify all other mounted instances of the hook.
            window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
            return next;
        });
    }, []);

    const setKlipyEnabled = useCallback((v: boolean) => {
        setSettings(updateGifSettings({ klipyEnabled: v }));
    }, []);

    const dismissKlipyNotice = useCallback(() => {
        setSettings(updateGifSettings({ klipyNoticeDismissed: true }));
    }, []);

    return useMemo(() => ({
        settings,
        setAutoPlayGifs,
        setKlipyEnabled,
        dismissKlipyNotice,
    }), [settings, setAutoPlayGifs, setKlipyEnabled, dismissKlipyNotice]);
}

export type GifSettingsHook = ReturnType<typeof useGifSettings>;
