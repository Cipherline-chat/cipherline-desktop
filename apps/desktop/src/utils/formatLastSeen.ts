/**
 * Formats a last-seen timestamp as a compact relative "Last seen X ago" string.
 *
 * Examples:
 *   "Last seen just now"
 *   "Last seen 5m ago"
 *   "Last seen 20h ago"
 *   "Last seen yesterday"
 *   "Last seen 3d ago"
 *   "Last seen 2w ago"
 *   "Last seen 3mo ago"
 *   "Last seen 1y ago"
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

    // Compact units (owner 2026-11-16: "Last seen 20h ago", never "Offline ...").
    let ago: string;
    if (diffSecs < 60)            return 'Last seen just now';
    else if (diffMins < 60)       ago = `${diffMins}m`;
    else if (diffHours < 24)      ago = `${diffHours}h`;
    else if (diffDays === 1)      return 'Last seen yesterday';
    else if (diffDays < 7)        ago = `${diffDays}d`;
    else if (diffWeeks < 5)       ago = `${diffWeeks}w`;
    else if (diffMonths < 12)     ago = `${diffMonths}mo`;
    else                          ago = `${diffYears}y`;

    return `Last seen ${ago} ago`;
}
