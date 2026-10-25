/**
 * "Back online": the quiet note after a long outage.
 *
 * Offline for two minutes or more, then the connection returns: one small toast
 * saying so and for how long. Shorter drops say nothing (the app already
 * recovers silently from those), and the note is rate-limited so a flaky link
 * that keeps dropping for minutes at a time cannot turn it into a ticker.
 *
 * The tracker is a pure state machine over (online?, now): no timers, no DOM,
 * and nothing about the connection beyond two timestamps held in memory.
 * components/BackOnlineHost.tsx feeds it the app's own connectivity signal
 * (hooks/useNetworkStatus) and shows the toast.
 */

/** Offline at least this long before the return is worth a note. */
export const BACK_ONLINE_MIN_OFFLINE_MS = 2 * 60 * 1000;
/** Never two notes closer together than this. */
export const BACK_ONLINE_MIN_GAP_MS = 10 * 60 * 1000;

export interface BackOnlineResult {
    /** Show the note now. */
    show: boolean;
    /** How long the connection was gone (only meaningful when it just returned). */
    offlineMs: number;
}

export function createBackOnlineTracker(
    minOfflineMs = BACK_ONLINE_MIN_OFFLINE_MS,
    minGapMs = BACK_ONLINE_MIN_GAP_MS,
) {
    let offlineSince: number | null = null;
    let lastShownAt: number | null = null;
    return {
        /** Report the connection state at `now` (ms). Repeats of the same state are harmless. */
        update(online: boolean, now: number): BackOnlineResult {
            if (!online) {
                if (offlineSince === null) offlineSince = now;
                return { show: false, offlineMs: 0 };
            }
            if (offlineSince === null) return { show: false, offlineMs: 0 };   // was never offline
            const offlineMs = Math.max(0, now - offlineSince);
            offlineSince = null;
            if (offlineMs < minOfflineMs) return { show: false, offlineMs };
            if (lastShownAt !== null && now - lastShownAt < minGapMs) return { show: false, offlineMs };
            lastShownAt = now;
            return { show: true, offlineMs };
        },
        /** Test hook: is an outage in progress? */
        get offline() { return offlineSince !== null; },
    };
}

/** "2 minutes", "47 minutes", "3 hours": rounded, never in seconds. */
export function formatOutage(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 90) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    const days = Math.round(hours / 24);
    return `${days} days`;
}
