/**
 * notificationAsk — asking about notifications at the moment they make sense.
 *
 * Cipherline does NOT ask about notifications at launch (and never did: the
 * Electron main process raises toasts without any permission step on Windows
 * and Linux, and on macOS the OS's own sheet appears the first time a toast is
 * shown, which used to be whenever the first message happened to arrive). The
 * natural moment to ask is right after the user does something whose answer
 * they will want to hear about: sending a friend request or sharing an invite.
 * "Want a ping when they accept?"
 *
 * This module is the pure decision. The runtime is hooks/useFirstWeekNudges.ts,
 * the card is components/FirstWeekNudges.tsx. The setting itself stays in
 * Settings → Notifications ("Desktop notifications"); this only offers it.
 *
 * Asked at most once per ACCOUNT ON THIS DEVICE (the OS permission is a
 * property of the machine, so the marker is device-local and excluded from
 * backups — see backupRegistry.ts). Whatever the answer, we never ask again;
 * the toggle in Settings is the way back.
 */
import secureLocalStore from './secureLocalStore';

export type AskTrigger = 'friend_request_sent' | 'invite_sent';

/** 'enable'  — desktop notifications are OFF: offer to turn them on.
 *  'prime'   — they are ON (the default) but macOS has not been asked yet:
 *              this is the moment to let its sheet appear, with context. */
export type AskVariant = 'enable' | 'prime';

export type AskOutcome = 'accepted' | 'declined';

export interface AskMarker { v: 1; at: number; outcome: AskOutcome }

export interface AskDecisionInput {
    /** NotificationPrefs.desktop_notifications_enabled. */
    prefEnabled: boolean;
    /** window.electronAPI.platform. */
    platform: 'windows' | 'mac' | 'linux' | string | undefined;
    /** Already asked on this device. */
    alreadyAsked: boolean;
}

/**
 * What (if anything) to ask. Returns null when asking would be noise:
 *  - already asked once;
 *  - notifications are on and the platform has no permission sheet to prime
 *    (Windows / Linux): there is genuinely nothing to ask.
 */
export function decideNotificationAsk(i: AskDecisionInput): AskVariant | null {
    if (i.alreadyAsked) return null;
    if (!i.prefEnabled) return 'enable';
    if (i.platform === 'mac') return 'prime';
    return null;
}

export interface AskCopy { title: string; body: string; accept: string; decline: string }

export function notificationAskCopy(variant: AskVariant, trigger: AskTrigger): AskCopy {
    const title = trigger === 'invite_sent' ? 'Want a ping when they join?' : 'Want a ping when they accept?';
    if (variant === 'enable') {
        return {
            title,
            body: 'Turn on desktop notifications and you’ll hear back even when Cipherline is in the background.',
            accept: 'Turn on',
            decline: 'Not now',
        };
    }
    return {
        title,
        body: 'Your Mac will ask once to allow notifications. Say yes and replies reach you right away.',
        accept: 'Yes, ping me',
        decline: 'Not now',
    };
}

/** The confirmation toast shown by the OS after accepting. On macOS this is
 *  also what makes the system permission sheet appear — at this moment, in
 *  context, instead of at a random later one. */
export const ASK_CONFIRMATION_TOAST = {
    id: 'notif_primer',
    title: 'Cipherline',
    body: 'Pings are on. You’ll hear about replies and new friends here.',
    // No conversation to open on click.
    conv_id: '',
} as const;

// ── Device-local marker ──────────────────────────────────────────────────────

export function parseAskMarker(raw: string | null | undefined): AskMarker | null {
    if (!raw) return null;
    try {
        const p = JSON.parse(raw) as Partial<AskMarker> | null;
        if (!p || p.v !== 1 || (p.outcome !== 'accepted' && p.outcome !== 'declined')) return null;
        return { v: 1, at: typeof p.at === 'number' ? p.at : 0, outcome: p.outcome };
    } catch {
        return null;
    }
}

export function hasAskedNotifications(userId: string): boolean {
    try {
        return parseAskMarker(secureLocalStore.getItem(`cipherline_notif_ask_${userId}`)) !== null;
    } catch {
        // Unreadable store: treat as asked. Asking twice is the worse failure.
        return true;
    }
}

export function markNotificationsAsked(userId: string, outcome: AskOutcome, now: number = Date.now()): void {
    try {
        const marker: AskMarker = { v: 1, at: now, outcome };
        secureLocalStore.setItem(`cipherline_notif_ask_${userId}`, JSON.stringify(marker));
    } catch { /* store locked: the in-memory flag still stops a repeat this session */ }
}
