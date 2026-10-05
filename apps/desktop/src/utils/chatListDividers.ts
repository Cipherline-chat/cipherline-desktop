import { ANCIENT_CHATS_POOL, pickRotating } from './eggPools';

/**
 * Time-bucket dividers for the DM / group-chat list (Dashboard pane 2).
 *
 * The list is sorted newest-activity-first; these buckets slice it at the
 * points where a reader's sense of "recent" actually changes, not at every
 * calendar boundary. Calendar-day math for Today/Yesterday (a chat from
 * 11:58 pm yesterday is "Yesterday", not "23 minutes short of today"), rolling
 * windows beyond that.
 *
 * The final bucket (untouched for a year+) draws its label from
 * ANCIENT_CHATS_POOL per the personality doctrine — see docs/personality.md.
 * The label rotates by local day (stable within a day, so the divider never
 * flickers between renders; different tomorrow, satisfying rule 3's rotation).
 */

export type ChatBucketKey = 'today' | 'yesterday' | 'week' | 'month' | 'older' | 'ancient';

const DAY_MS = 86_400_000;

/** Local-midnight epoch ms for the day containing `now`. */
function startOfDay(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * Bucket a conversation's last-activity timestamp relative to `now`.
 * Future timestamps (clock skew between devices) count as 'today' — a divider
 * is the wrong place to litigate someone's clock.
 */
export function chatBucket(ts: number, now: number): ChatBucketKey {
    const today = startOfDay(now);
    if (ts >= today) return 'today';
    if (ts >= today - DAY_MS) return 'yesterday';
    // Rolling windows from local midnight — "this week" = the last 7 calendar
    // days, which matches how people describe it far better than ISO weeks.
    // (Millisecond day-math is ±1h fuzzy across DST changes; for a section
    // divider that's fine and not worth a calendar library.)
    if (ts >= today - 6 * DAY_MS) return 'week';
    if (ts >= today - 29 * DAY_MS) return 'month';
    if (ts >= today - 364 * DAY_MS) return 'older';
    return 'ancient';
}

/**
 * Human label for a bucket. `now` feeds the ancient pool's daily rotation.
 * 'today' has a label too — the caller decides whether to render it (the
 * shipped list suppresses a leading "Today" so the top of the list stays
 * clean, but shows it when something older sits above today's chats — which
 * can't happen in a newest-first sort, so effectively it only appears
 * mid-list after a search filter reorders nothing… it doesn't. It's here for
 * completeness).
 */
export function chatBucketLabel(key: ChatBucketKey, now: number): string {
    switch (key) {
        case 'today': return 'Today';
        case 'yesterday': return 'Yesterday';
        case 'week': return 'This week';
        case 'month': return 'This month';
        case 'older': return 'Months ago';
        case 'ancient': return pickRotating(ANCIENT_CHATS_POOL, Math.floor(startOfDay(now) / DAY_MS));
    }
}
