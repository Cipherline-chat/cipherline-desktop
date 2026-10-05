/**
 * useDndState — computes the current Do Not Disturb state from all sources:
 *   1. Manual toggle (dnd_manual)
 *   2. Scheduled quiet hours (dnd_schedule)
 *   3. Auto-triggers (in call, screensharing, gaming, status)
 *
 * Deliberately NOT a source: `desktop_notifications_enabled`. See the note on
 * computeDnd. The `useDndState` hook itself currently has no consumers —
 * `computeDnd` is called directly by Dashboard and useNotificationDispatch —
 * so every caller today is asking "should this alert be swallowed?", not
 * "what should the DND badge say?".
 *
 * Re-evaluates every 60 seconds to handle schedule transitions.
 * Returns `{ active, reason }` so the UI can show "DND — in call" etc.
 */

import { useState, useEffect, useRef } from 'react';
import type { NotificationPrefs } from '../contexts/NotificationContext';

export interface DndStatus {
    active: boolean;
    /** Short human-readable reason, e.g. 'manual', 'schedule', 'in_call'. */
    reason: string;
}

function minuteOfDay(): number {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

function dayOfWeek(): number {
    return new Date().getDay(); // 0=Sun
}

function inSchedule(prefs: NotificationPrefs['dnd_schedule']): boolean {
    if (!prefs.enabled || !prefs.days.length) return false;
    const dow = dayOfWeek();
    if (!prefs.days.includes(dow)) return false;
    const min = minuteOfDay();
    if (prefs.start_minute <= prefs.end_minute) {
        return min >= prefs.start_minute && min < prefs.end_minute;
    }
    // Overnight schedule (e.g. 23:00–07:00)
    return min >= prefs.start_minute || min < prefs.end_minute;
}

/**
 * ── `desktop_notifications_enabled` is NOT a DND trigger. ──────────────────
 *
 * This function used to open with
 * `if (!prefs.desktop_notifications_enabled) return { active: true, reason: 'disabled' }`,
 * and that one line silently took the sound away with the toast.
 *
 * `computeDnd`'s only job is feeding `dndActive` into
 * `resolveNotification`, where `dndSwallows` gates BOTH `playsSound` and
 * `showsToast`. So switching off a toggle the settings screen describes as
 * "Show OS toasts when new messages arrive" also killed every audio cue —
 * unless the message happened to be a direct mention AND
 * `dnd_let_mentions_through` was on. The screen offers "Notification sounds"
 * as a separate toggle ("Play audio cues on messages and events"), and
 * `useNotificationDispatch`'s own master switch bails only when BOTH are
 * off, so the independence was intended everywhere except here.
 *
 * Nothing is lost by removing it. Toast suppression does not run through
 * DND at all: `useNotificationDispatch` step 4 checks
 * `p.desktop_notifications_enabled` directly before raising one. Sound keeps
 * its own gate on `p.sounds_enabled` in step 3.
 *
 * If the `useDndState` hook below is ever wired to a status badge ("DND —
 * in call"), and "notifications off" should read as DND *for display*, that
 * is a presentation decision and belongs in the badge — not here, where it
 * becomes a rule about whether a sound is allowed to play.
 */
export function computeDnd(
    prefs: NotificationPrefs,
    opts: {
        userStatus: string;
        activeCall: boolean;
        screensharing: boolean;
        gameActive: boolean;
    },
): DndStatus {
    if (prefs.dnd_manual) return { active: true, reason: 'manual' };
    if (prefs.dnd_auto.when_status_dnd && opts.userStatus === 'dnd') return { active: true, reason: 'status_dnd' };
    if (prefs.dnd_auto.when_status_away && opts.userStatus === 'away') return { active: true, reason: 'status_away' };
    if (prefs.dnd_auto.when_in_call && opts.activeCall) return { active: true, reason: 'in_call' };
    if (prefs.dnd_auto.when_screensharing && opts.screensharing) return { active: true, reason: 'screensharing' };
    if (prefs.dnd_auto.when_in_game && opts.gameActive) return { active: true, reason: 'gaming' };
    if (inSchedule(prefs.dnd_schedule)) return { active: true, reason: 'schedule' };
    return { active: false, reason: '' };
}

export function useDndState(
    prefs: NotificationPrefs | null,
    opts: {
        userStatus: string;
        activeCall: boolean;
        screensharing: boolean;
        gameActive: boolean;
    },
): DndStatus {
    const optsRef = useRef(opts);
    optsRef.current = opts;
    const prefsRef = useRef(prefs);
    prefsRef.current = prefs;

    const compute = () => {
        if (!prefsRef.current) return { active: false, reason: '' };
        return computeDnd(prefsRef.current, optsRef.current);
    };

    const [status, setStatus] = useState<DndStatus>(compute);

    // Re-evaluate whenever inputs change (P2-REND-9: deps array required to avoid infinite loop)
    const { userStatus, activeCall, screensharing, gameActive } = opts;
    useEffect(() => {
        setStatus(prev => {
            const next = compute();
            return (prev.active === next.active && prev.reason === next.reason) ? prev : next;
        });
    }, [prefs, userStatus, activeCall, screensharing, gameActive]); // eslint-disable-line react-hooks/exhaustive-deps

    // Also tick every 60s to catch schedule transitions without needing re-render
    useEffect(() => {
        const t = setInterval(() => setStatus(compute()), 60_000);
        return () => clearInterval(t);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return status;
}
