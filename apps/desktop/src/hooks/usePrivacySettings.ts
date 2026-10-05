import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { API_BASE } from '../constants';
import { ownPrefsBus } from '../utils/ownStatusSync';

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
}

const STORAGE_KEY = 'cipherline_privacy_settings';

const DEFAULTS: PrivacySettings = {
    screenCaptureProtection: false,
    showReadReceipts: true,
    showTypingIndicators: true,
    nsfwContentEnabled: false,
    allowFriendRequests: true,
    imageAutoLoad: 'known',
    showMobilePresence: true,
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

export function usePrivacySettings() {
    const [settings, setSettings] = useState<PrivacySettings>(loadSettings);
    const { user, token } = useAuth();

    // Persist to localStorage on every change.
    useEffect(() => {
        try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
    }, [settings]);

    // Sync allow_friend_requests FROM the server on login (source of truth is the server).
    useEffect(() => {
        if (user && typeof (user as any).allow_friend_requests === 'boolean') {
            setSettings(prev => ({ ...prev, allowFriendRequests: (user as any).allow_friend_requests }));
        }
    }, [user?.user_id]); // only re-run when the user changes (login/logout)

    // Same pattern as allow_friend_requests above: the server is the source
    // of truth for show_mobile_presence (it decides what OTHER people are
    // sent), so a fresh login/account-switch pulls the account's actual
    // choice rather than trusting this device's local copy. An older server
    // doesn't return the field — the local value (default on) stands.
    useEffect(() => {
        if (user && typeof (user as any).show_mobile_presence === 'boolean') {
            setSettings(prev => ({ ...prev, showMobilePresence: (user as any).show_mobile_presence }));
        }
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
    }), [settings, setScreenCaptureProtection, setShowReadReceipts, setShowTypingIndicators,
        setNsfwContentEnabled, setAllowFriendRequests, setImageAutoLoad, setShowMobilePresence]);
}

export type PrivacySettingsHook = ReturnType<typeof usePrivacySettings>;
