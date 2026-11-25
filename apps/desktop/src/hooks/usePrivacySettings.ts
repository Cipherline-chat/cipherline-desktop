import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { API_BASE } from '../constants';
import { ownPrefsBus } from '../utils/ownStatusSync';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';

/** Controls when a linked image/GIF in a message auto-displays instead of
 *  requiring a click. See utils/imageHosts.ts for what "known" means and
 *  why it's the safe middle ground. */
export type ImageAutoLoadMode = 'always' | 'known' | 'never';

export interface PrivacySettings {
    screenCaptureProtection: boolean;
    showReadReceipts: boolean;
    showTypingIndicators: boolean;
    nsfwContentEnabled: boolean;
    allowFriendRequests: boolean;
    imageAutoLoad: ImageAutoLoadMode;
    /** "Show when I'm on mobile" (User.show_mobile_presence, server-side).
     *  While ON, people who can see your status see a small phone in place
     *  of your status dot whenever every device you're online on is a phone.
     *  ON by default (Discord parity; owner request 2026-09-29) — it says no
     *  more than the dot itself already does about WHEN you're around, only
     *  "phone, not computer", and "Appear offline" hides it with everything
     *  else. Replaces the old opt-in `shareActiveDevice`, whose friends-only
     *  attentive-device signal new clients no longer display. */
    showMobilePresence: boolean;
    /** "Generate link previews" (docs/plans/embeds.md phase 3). ON: when you
     *  send a link, YOUR device visits it to build a preview (title, picture)
     *  that travels inside the encrypted message, so the people you send it to
     *  see it without contacting the site. OFF: links are sent bare. Local to
     *  this device, like the rest of this object. */
    generateLinkPreviews: boolean;
    /** "Show embeds" (owner, 2026-11-23). ON (default): links in messages get
     *  their embeds (sender-built previews, linked images / GIFs, players).
     *  OFF: links only, with no embed of any kind, so this device makes no
     *  request to any linked site and downloads no preview thumbnail. Local to
     *  this device; it lives inside this object, whose key backupRegistry.ts
     *  already classifies (include: a privacy preference). Read live through
     *  useShowEmbeds(). */
    showEmbeds: boolean;
}

const STORAGE_KEY = 'cipherline_privacy_settings';
/** Fired whenever any copy of usePrivacySettings writes a change. */
export const PRIVACY_SETTINGS_CHANGED_EVENT = 'cipherline:privacy-settings-changed';

const DEFAULTS: PrivacySettings = {
    screenCaptureProtection: false,
    showReadReceipts: true,
    showTypingIndicators: true,
    nsfwContentEnabled: false,
    allowFriendRequests: true,
    imageAutoLoad: 'known',
    showMobilePresence: true,
    generateLinkPreviews: true,
    showEmbeds: true,
};

function loadSettings(): PrivacySettings {
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULTS };
        return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULTS };
    }
}

let lastRawForPreviews: string | null | undefined;
let lastPreviewsOn = DEFAULTS.generateLinkPreviews;
/**
 * "Generate link previews", read straight from storage. For the composer,
 * which stays mounted while Settings changes it (each usePrivacySettings
 * instance keeps its own copy). Re-parses only when the stored JSON changed.
 */
export function linkPreviewsEnabled(): boolean {
    let raw: string | null = null;
    try { raw = secureLocalStore.getItem(STORAGE_KEY); } catch { /* default */ }
    if (raw !== lastRawForPreviews) {
        lastRawForPreviews = raw;
        try { lastPreviewsOn = raw ? (JSON.parse(raw) as Partial<PrivacySettings>).generateLinkPreviews !== false : DEFAULTS.generateLinkPreviews; }
        catch { lastPreviewsOn = DEFAULTS.generateLinkPreviews; }
    }
    return lastPreviewsOn;
}

let lastRawForEmbeds: string | null | undefined;
let lastEmbedsOn = DEFAULTS.showEmbeds;
/** "Show embeds", read straight from storage (re-parsed only when the stored JSON changed). */
export function showEmbedsEnabled(): boolean {
    let raw: string | null = null;
    try { raw = secureLocalStore.getItem(STORAGE_KEY); } catch { /* default */ }
    if (raw !== lastRawForEmbeds) {
        lastRawForEmbeds = raw;
        try { lastEmbedsOn = raw ? (JSON.parse(raw) as Partial<PrivacySettings>).showEmbeds !== false : DEFAULTS.showEmbeds; }
        catch { lastEmbedsOn = DEFAULTS.showEmbeds; }
    }
    return lastEmbedsOn;
}

function subscribeEmbeds(cb: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    window.addEventListener(PRIVACY_SETTINGS_CHANGED_EVENT, cb);
    window.addEventListener(BACKUP_RESTORED_EVENT, cb);
    return () => {
        window.removeEventListener(PRIVACY_SETTINGS_CHANGED_EVENT, cb);
        window.removeEventListener(BACKUP_RESTORED_EVENT, cb);
    };
}

/**
 * "Show embeds", live: every link embed (MessageEmbed, SenderEmbed) reads it,
 * so turning it off re-renders open chats at once and unmounts any player
 * that was playing.
 */
export function useShowEmbeds(): boolean {
    return useSyncExternalStore(subscribeEmbeds, showEmbedsEnabled, () => DEFAULTS.showEmbeds);
}

export function usePrivacySettings() {
    const [settings, setSettings] = useState<PrivacySettings>(loadSettings);
    const { user, token } = useAuth();

    // Persist to localStorage on every change, and tell every other copy of
    // this hook (each mounted instance keeps its own state) so they all agree:
    // without that, an instance mounted before a change (a chat's embed reading
    // imageAutoLoad) would write its stale copy back on its next update, and
    // useShowEmbeds() readers would not re-render live.
    useEffect(() => {
        const raw = JSON.stringify(settings);
        let stored: string | null = null;
        try { stored = secureLocalStore.getItem(STORAGE_KEY); } catch { /* treat as unknown */ }
        if (stored === raw) return;
        try { secureLocalStore.setItem(STORAGE_KEY, raw); } catch { /* persisting a UI preference is best-effort; a failed write must not break the UI */ }
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(PRIVACY_SETTINGS_CHANGED_EVENT));
    }, [settings]);

    // Another instance (Settings) changed them, or a backup was restored: re-read.
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        const reload = () => {
            const fresh = loadSettings();
            setSettings(prev => (JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh));
        };
        window.addEventListener(PRIVACY_SETTINGS_CHANGED_EVENT, reload);
        return () => window.removeEventListener(PRIVACY_SETTINGS_CHANGED_EVENT, reload);
    }, []);

    // Sync allow_friend_requests FROM the server on login (source of truth is the server).
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
        if (user && typeof (user as any).allow_friend_requests === 'boolean') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
            setSettings(prev => ({ ...prev, allowFriendRequests: (user as any).allow_friend_requests }));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the account changes (login/logout/switch); a refreshed user object must not overwrite the local setting
    }, [user?.user_id]); // only re-run when the user changes (login/logout)

    // Same pattern as allow_friend_requests above: the server is the source
    // of truth for show_mobile_presence (it decides what OTHER people are
    // sent), so a fresh login/account-switch pulls the account's actual
    // choice rather than trusting this device's local copy. An older server
    // doesn't return the field — the local value (default on) stands.
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
        if (user && typeof (user as any).show_mobile_presence === 'boolean') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
            setSettings(prev => ({ ...prev, showMobilePresence: (user as any).show_mobile_presence }));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the account changes (login/logout/switch); a refreshed user object must not overwrite the local setting
    }, [user?.user_id]); // only re-run when the user changes (login/logout)

    // ...and kept in step afterwards: every (re)connect re-reads it from
    // /auth/me, and a change made on another device (the phone's Privacy
    // screen) arrives live as `presence:self` — both via ownPrefsBus
    // (utils/ownStatusSync.ts). Local only: nothing is sent back.
    useEffect(() => ownPrefsBus.subscribe(({ showMobilePresence }) => {
        setSettings(prev => (prev.showMobilePresence === showMobilePresence ? prev : { ...prev, showMobilePresence }));
    }), []);

    // Push screen-capture-protection to the main process on change.
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.setContentProtection) return;
        electronAPI.setContentProtection(settings.screenCaptureProtection);
    }, [settings.screenCaptureProtection]);

    const setScreenCaptureProtection = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, screenCaptureProtection: v }));
    }, []);

    const setShowReadReceipts = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, showReadReceipts: v }));
    }, []);

    const setShowTypingIndicators = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, showTypingIndicators: v }));
    }, []);

    const setNsfwContentEnabled = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, nsfwContentEnabled: v }));
    }, []);

    const setAllowFriendRequests = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, allowFriendRequests: v }));
        // Sync to server so friends.service.ts can enforce it.
        if (token) {
            axios.patch(`${API_BASE}/auth/profile`, { allow_friend_requests: v }, {
                headers: { Authorization: `Bearer ${token}` },
            }).catch(() => {/* non-critical; localStorage already updated */});
        }
    }, [token]);

    const setImageAutoLoad = useCallback((v: ImageAutoLoadMode) => {
        setSettings(prev => ({ ...prev, imageAutoLoad: v }));
    }, []);

    const setGenerateLinkPreviews = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, generateLinkPreviews: v }));
    }, []);

    const setShowEmbeds = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, showEmbeds: v }));
    }, []);

    const setShowMobilePresence = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, showMobilePresence: v }));
        // Server-enforced: the server decides what everyone else is sent, so
        // this is not merely a client-side preference.
        if (token) {
            axios.patch(API_BASE + '/auth/profile', { show_mobile_presence: v }, {
                headers: { Authorization: 'Bearer ' + token },
            }).catch(() => {/* non-critical; localStorage already updated, next login resyncs from server */});
        }
    }, [token]);

    return useMemo(() => ({
        settings,
        setScreenCaptureProtection,
        setShowReadReceipts,
        setShowTypingIndicators,
        setNsfwContentEnabled,
        setAllowFriendRequests,
        setImageAutoLoad,
        setShowMobilePresence,
        setGenerateLinkPreviews,
        setShowEmbeds,
    }), [settings, setScreenCaptureProtection, setShowReadReceipts, setShowTypingIndicators,
        setNsfwContentEnabled, setAllowFriendRequests, setImageAutoLoad, setShowMobilePresence, setGenerateLinkPreviews, setShowEmbeds]);
}

export type PrivacySettingsHook = ReturnType<typeof usePrivacySettings>;
