/**
 * Ranking for the home deck's "Pick back up" section (HomePanel.tsx).
 *
 * The section shows conversations AND servers in one grid. Both are ranked on
 * the same two axes — how much they need you, then how recently they moved —
 * but they are NOT simply concatenated and cut to the limit, because the two
 * kinds don't carry comparable clocks:
 *
 *   - A conversation always has one: its own cached messages, or failing that
 *     the server-side `updated_at` on the row.
 *   - A server's clock is the newest message across its channels, which only
 *     exists once those channels have been opened and cached. A server you
 *     haven't visited this session reads as activity 0 — genuinely unknown,
 *     not genuinely idle.
 *
 * A straight top-N of the union therefore lets a busy DM list push every
 * server off the end, which is how the section ended up looking like it had
 * no servers in it at all. Reserving slots is the fix: servers get up to half
 * the grid, conversations take the rest, and the survivors are re-ranked
 * together so the final order still reads attention-first.
 *
 * Pure functions over plain data — no React, no DOM — so the reserved-slot
 * rule is testable under vitest's node environment, same as
 * utils/unreadBadges.ts.
 */

export interface RecentRankable {
    /** 2 = mentions you, 1 = unread, 0 = quiet. */
    attention: number;
    /** ms epoch of the newest known activity; 0 when nothing is cached. */
    activity: number;
}

/** Attention first, then recency. Stable for equal pairs (Array#sort is). */
export function compareRecent(a: RecentRankable, b: RecentRankable): number {
    return (b.attention - a.attention) || (b.activity - a.activity);
}

/**
 * Merge ranked conversations and servers into one capped list, reserving up
 * to `limit / 2` slots for servers so they can never be crowded out entirely.
 * Servers only claim the slots they can fill; the rest go to conversations.
 */
export function pickRecent<T extends RecentRankable>(
    conversations: T[],
    servers: T[],
    limit = 8,
): T[] {
    const rankedConvs = [...conversations].sort(compareRecent);
    const rankedServers = [...servers].sort(compareRecent);
    const serverSlots = Math.min(rankedServers.length, Math.floor(limit / 2));
    return [
        ...rankedConvs.slice(0, limit - serverSlots),
        ...rankedServers.slice(0, serverSlots),
    ].sort(compareRecent);
}
