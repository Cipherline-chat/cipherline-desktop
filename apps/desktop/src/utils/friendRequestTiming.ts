/**
 * How old a pending friend request is, and when it lapses — for the Friends
 * pane's Pending rows. Presentation only: the server deletes pending requests
 * older than 30 days in a once-a-day sweep (apps/api/src/cleanup/
 * cleanup.service.ts, sweepPendingFriendRequests), so the real removal lands
 * up to a day after the 30-day mark. That is why the countdown only appears in
 * a request's last week and never claims an exact hour.
 */
export const FRIEND_REQUEST_TTL_DAYS = 30;
/** Only a request this close to lapsing shows a countdown. */
export const FRIEND_REQUEST_EXPIRY_NOTICE_DAYS = 7;

const DAY_MS = 86_400_000;

export interface FriendRequestTiming {
    /** "today", "yesterday", "3 days ago" — null when the date is unusable. */
    age: string | null;
    /** Whole days left before the request lapses (0 = any moment now), or
     *  null when it is not yet in its final week / the date is unusable. */
    expiresInDays: number | null;
}

/** "today" / "yesterday" / "N days ago" for an ISO instant; null when unusable.
 *  A future instant (clock skew) reads as "today", never a negative count. */
export function daysAgoLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return null;
    const elapsedDays = Math.max(0, Math.floor((now - t) / DAY_MS));
    return elapsedDays === 0 ? 'today' : elapsedDays === 1 ? 'yesterday' : `${elapsedDays} days ago`;
}

export function friendRequestTiming(requestedAt: string | null | undefined, now: number = Date.now()): FriendRequestTiming {
    const t = requestedAt ? Date.parse(requestedAt) : NaN;
    if (!Number.isFinite(t)) return { age: null, expiresInDays: null };
    const age = daysAgoLabel(requestedAt, now);
    const leftDays = Math.max(0, Math.ceil((t + FRIEND_REQUEST_TTL_DAYS * DAY_MS - now) / DAY_MS));
    return { age, expiresInDays: leftDays <= FRIEND_REQUEST_EXPIRY_NOTICE_DAYS ? leftDays : null };
}

/** "Expires in 3 days" / "Expires tomorrow" / "Expires soon". */
export function expiryLabel(days: number): string {
    if (days <= 0) return 'Expires soon';
    if (days === 1) return 'Expires tomorrow';
    return `Expires in ${days} days`;
}
