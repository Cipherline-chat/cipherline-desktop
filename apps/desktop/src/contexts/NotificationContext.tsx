/**
 * NotificationContext — single source of truth for global notification prefs.
 *
 * Persisted under `cipherline_notif_global_prefs_${userId}` in localStorage.
 * Provides `prefs`, `updatePrefs(partial)`, and `resetPrefs()` to consumers.
 *
 * The context is mounted once in main.tsx (inside AuthProvider so it can read
 * the userId). On sign-out, the prefs are reset to defaults in memory (disk
 * copy remains so the next sign-in has the user's preferred config).
 */

import secureLocalStore from '../utils/secureLocalStore';
import { mergeStoredPrefs, deriveSoundGroups } from '../utils/notificationPrefsMerge';
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { soundGroupOf, buildDefaultSoundCategoryPrefs } from '../utils/notificationSounds';
import type { SoundCategory, CollapsedSoundGroup, SoundGroupPrefs } from '../utils/notificationSounds';

// ── Prefs shape ───────────────────────────────────────────────────────────────

export interface SoundCategoryPrefs {
    enabled: boolean;
    volume: number;
    file: string;
}

export interface NotificationPrefs {
    desktop_notifications_enabled: boolean;
    sounds_enabled: boolean;
    master_volume: number;
    show_preview: 'full' | 'sender_only' | 'hidden';
    quick_reply_enabled: boolean;
    keywords: string[];
    dnd_manual: boolean;
    dnd_schedule: {
        enabled: boolean;
        start_minute: number;
        end_minute: number;
        days: number[];
    };
    dnd_auto: {
        when_in_call: boolean;
        when_screensharing: boolean;
        when_in_game: boolean;
        when_status_dnd: boolean;
        when_status_away: boolean;
    };
    dnd_let_mentions_through: boolean;
    sounds: Record<SoundCategory, SoundCategoryPrefs>;
    /**
     * Collapsed groups (today: just "App sounds"). A gate AND a volume scalar
     * on top of each member category's own prefs — see notificationSounds'
     * resolve(). New field as of 2026-09; blobs written before it are migrated
     * by deriveSoundGroups() on load.
     */
    sound_groups: Record<CollapsedSoundGroup, SoundGroupPrefs>;
    custom_sounds: { name: string; file: string }[];
    suppress_when_active_conv: boolean;
    suppress_when_window_focused: boolean;
    show_badge_count: boolean;
    flash_taskbar: boolean;
    badge_only_mentions: boolean;
    badge_includes_muted: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
    desktop_notifications_enabled: true,
    sounds_enabled: true,
    master_volume: 0.8,
    show_preview: 'full',
    quick_reply_enabled: true,
    keywords: [],
    dnd_manual: false,
    dnd_schedule: {
        enabled: false,
        start_minute: 22 * 60,  // 22:00
        end_minute:    8 * 60,  //  8:00
        days: [0, 1, 2, 3, 4, 5, 6],
    },
    // Auto-DND defaults are deliberately conservative: each `true` here is the
    // app deciding, on the user's behalf, to withhold a notification they never
    // asked us to withhold. Being in a call or playing a game is not by itself
    // a statement that you don't want to be told your friend messaged you —
    // people take calls and play games *while* chatting. So only the one that
    // IS an explicit statement (the user set their status to Do Not Disturb)
    // and the one that leaks to an audience (screen sharing, where a toast
    // shows your private message to everyone watching) default on.
    //
    // `when_in_call` moved true → false and `dnd_let_mentions_through` moved
    // true → false on 2026-09-06. See load() for what that does (and does not)
    // do to accounts that already have prefs saved.
    dnd_auto: {
        when_in_call: false,
        when_screensharing: true,
        when_in_game: false,
        when_status_dnd: true,
        when_status_away: false,
    },
    // Only meaningful while DND is active, and DND is now something the user
    // turns on deliberately rather than something the app infers from a call.
    // "Pause all notifications" that quietly keeps letting @pings through is
    // not what the toggle says it does.
    dnd_let_mentions_through: false,
    // Derived from notificationSounds' DEFAULT_SOUNDS (file paths) and
    // DEFAULT_SOUND_PREFS (enabled/volume, including the "frequency of use
    // sets loudness" ladder — see that module for the full breakdown and
    // per-category reasoning) — this used to hand-duplicate all seventeen file
    // paths a second time, which is exactly the kind of drift that took the
    // renderer down once already (see notificationPrefsMigration.test.ts).
    sounds: buildDefaultSoundCategoryPrefs(),
    // The collapsed "App sounds" row. Volume 1.0 is the identity scalar, so a
    // fresh install sounds exactly like it did when every category had its own
    // slider — the group slider scales the whole family down from there rather
    // than flattening the per-category ladder above.
    sound_groups: {
        app: { enabled: true, volume: 1.0 },
    },
    custom_sounds: [],
    suppress_when_active_conv: true,
    suppress_when_window_focused: true,
    show_badge_count: true,
    flash_taskbar: false,
    badge_only_mentions: false,
    badge_includes_muted: false,
};

// ── Context ───────────────────────────────────────────────────────────────────

interface NotificationContextValue {
    prefs: NotificationPrefs;
    updatePrefs: (partial: Partial<NotificationPrefs>) => void;
    resetPrefs: () => void;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

function prefsKey(userId: string) {
    return `cipherline_notif_global_prefs_${userId}`;
}

/**
 * Load a user's prefs, migrating whatever shape is on disk.
 *
 * ── What changing a DEFAULT can and cannot do to existing accounts ──────────
 *
 * `save()` writes the WHOLE prefs object, so a stored blob contains an explicit
 * value for every field that existed when it was written — including fields the
 * user never touched. There is no "unset" sentinel and no per-field dirty
 * tracking, which means: for a field that already existed, "never set it" is
 * INDISTINGUISHABLE from "set it to what happened to be the default".
 *
 * So when the auto-DND defaults changed on 2026-09-06 (`when_in_call` and
 * `dnd_let_mentions_through`, both true → false), the migration semantics are
 * necessarily:
 *
 *   • No stored blob at all (fresh install, new account, never opened the
 *     Notifications page and never changed any other notification setting) →
 *     the new defaults apply.
 *   • A stored blob → its values are preserved verbatim. Someone who left DND
 *     auto-pausing during calls keeps it.
 *
 * That is the conservative half of the ambiguity on purpose. The alternative —
 * force-flipping every stored `true` to `false` — would silently undo a setting
 * for the users who DID deliberately turn it on, and the failure mode there is
 * "notifications now interrupt my calls and I never asked for that", which is
 * both louder and harder to attribute than "my old preference stuck". Users who
 * want the new behaviour have a Reset to defaults button on the same page.
 *
 * `sound_groups` is the one field where the distinction IS available, because
 * the field itself is new: its absence proves the blob predates it. See
 * deriveSoundGroups().
 */
function load(userId: string): NotificationPrefs {
    try {
        const raw = secureLocalStore.getItem(prefsKey(userId));
        if (!raw) return { ...DEFAULT_PREFS };
        // Deep merge via mergeStoredPrefs — `sounds` completeness is derived
        // from DEFAULT_PREFS' own keys (total over SoundCategory by type), so
        // a newly added category can never be dropped for existing users. The
        // hand-enumerated merge this replaces omitted four categories, which
        // crashed NotificationsTab (`prefs.sounds[cat].enabled` on undefined)
        // for every account with saved prefs — see notificationPrefsMerge.ts.
        const parsed = JSON.parse(raw);
        return deriveSoundGroups(mergeStoredPrefs(DEFAULT_PREFS, parsed), parsed, soundGroupOf);
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

function save(userId: string, prefs: NotificationPrefs) {
    try {
        secureLocalStore.setItem(prefsKey(userId), JSON.stringify(prefs));
    } catch { /* ignore quota errors */ }
}

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { userId, isAuthenticated } = useAuth();
    const [prefs, setPrefs] = useState<NotificationPrefs>(() =>
        userId ? load(userId) : { ...DEFAULT_PREFS }
    );

    // Reload from storage when user changes
    useEffect(() => {
        if (userId && isAuthenticated) {
            setPrefs(load(userId));
        } else {
            setPrefs({ ...DEFAULT_PREFS });
        }
    }, [userId, isAuthenticated]);

    const updatePrefs = useCallback((partial: Partial<NotificationPrefs>) => {
        setPrefs(prev => {
            const next = { ...prev, ...partial };
            // Handle nested objects that need merging
            if (partial.dnd_schedule !== undefined) {
                next.dnd_schedule = { ...prev.dnd_schedule, ...(partial.dnd_schedule ?? {}) };
            }
            if (partial.dnd_auto !== undefined) {
                next.dnd_auto = { ...prev.dnd_auto, ...(partial.dnd_auto ?? {}) };
            }
            if (partial.sounds !== undefined) {
                next.sounds = { ...prev.sounds };
                for (const cat of Object.keys(partial.sounds) as (keyof typeof partial.sounds)[]) {
                    next.sounds[cat] = { ...prev.sounds[cat], ...partial.sounds[cat] };
                }
            }
            if (partial.sound_groups !== undefined) {
                next.sound_groups = { ...prev.sound_groups };
                for (const g of Object.keys(partial.sound_groups) as CollapsedSoundGroup[]) {
                    next.sound_groups[g] = { ...prev.sound_groups[g], ...partial.sound_groups[g] };
                }
            }
            if (userId) save(userId, next);
            return next;
        });
    }, [userId]);

    const resetPrefs = useCallback(() => {
        const fresh = { ...DEFAULT_PREFS };
        setPrefs(fresh);
        if (userId) save(userId, fresh);
    }, [userId]);

    const value = useMemo(
        () => ({ prefs, updatePrefs, resetPrefs }),
        [prefs, updatePrefs, resetPrefs],
    );

    return (
        <NotificationContext.Provider value={value}>
            {children}
        </NotificationContext.Provider>
    );
};

export const useNotificationPrefs = (): NotificationContextValue => {
    const ctx = useContext(NotificationContext);
    if (!ctx) throw new Error('useNotificationPrefs must be used within NotificationProvider');
    return ctx;
};

/**
 * Same, but `undefined` outside the provider instead of throwing.
 *
 * For code whose ONLY use of prefs is deciding whether to play a sound: a
 * missing provider should cost that cue, not take down the surface that was
 * merely trying to be polite. Callers fall back to DEFAULT_PREFS.
 */
export const useNotificationPrefsSafe = (): NotificationContextValue | undefined =>
    useContext(NotificationContext);
