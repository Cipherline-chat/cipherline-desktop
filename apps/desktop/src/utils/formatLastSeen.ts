/**
 * Formats a last-seen timestamp as a relative "Offline X ago" string.
 *
 * Examples:
 *   "Offline just now"
 *   "Offline 5 minutes ago"
 *   "Offline 2 hours ago"
 *   "Offline yesterday"
 *   "Offline 3 days ago"
 *   "Offline 2 weeks ago"
 *   "Offline 3 months ago"
 *   "Offline 1 year ago"
 *
 * Returns null when the timestamp is null/undefined so the caller can
 * fall back to a plain "Offline" label.
 */
export function formatLastSeen(lastSeenAt: string | Date | null | undefined): string | null {
    if (!lastSeenAt) return null;

    const then = new Date(lastSeenAt);
    if (isNaN(then.getTime())) return null;

    const diffMs = Date.now() - then.getTime();
    if (diffMs < 0) return null; // clock skew — hide rather than show a future time

    const diffSecs  = Math.floor(diffMs / 1_000);
    const diffMins  = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays  = Math.floor(diffMs / 86_400_000);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30.44);
    const diffYears  = Math.floor(diffDays / 365.25);

    let ago: string;
    if (diffSecs < 60)            ago = 'just now';
    else if (diffMins < 60)       ago = `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
    else if (diffHours < 24)      ago = `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
    else if (diffDays === 1)      ago = 'yesterday';
    else if (diffDays < 7)        ago = `${diffDays} days ago`;
    else if (diffWeeks < 5)       ago = `${diffWeeks} ${diffWeeks === 1 ? 'week' : 'weeks'} ago`;
    else if (diffMonths < 12)     ago = `${diffMonths} ${diffMonths === 1 ? 'month' : 'months'} ago`;
    else                          ago = `${diffYears} ${diffYears === 1 ? 'year' : 'years'} ago`;

    return `Offline ${ago}`;
}
