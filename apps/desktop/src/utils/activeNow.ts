/**
 * Who counts as "Active Now" in the Friends panel.
 *
 * This lives outside Dashboard.tsx so the rule can be unit-tested against the
 * arrival orderings that used to break it. The section is populated from TWO
 * independent, asynchronously-arriving sources, and neither one is reliably
 * first:
 *
 *   1. `friendStatuses` (useUserStatus) — the rich per-friend status map. It is
 *      SEEDED for every accepted friend the moment the friends list resolves,
 *      defaulting to 'offline' (useUserStatus.ts), then corrected by the WS
 *      `user:friends_status_batch` snapshot on connect and by incremental
 *      `user:status_changed` events.
 *   2. `presence` (Dashboard) — a boolean map polled from
 *      `GET /v1/gateway/presence`, backed by Redis TTL keys. Live, but only
 *      covers users the caller has a DM conversation with.
 *
 * The bug this replaces read:
 *
 *     const status = fs?.status ?? (presence[f.user_id] ? 'online' : 'offline');
 *     return status === 'online';
 *
 * `??` only falls through on null/undefined, and the seed guarantees every
 * friend has a defined `status` as soon as the friends list loads. So the
 * presence half was effectively dead code: whenever the seed landed before the
 * status batch — or the batch omitted someone, or their persisted `users.status`
 * column was a stale 'offline' from an ungraceful disconnect — that friend was
 * filtered out and stayed filtered out, and the section rendered its empty
 * state even though the app knew perfectly well they were online.
 *
 * The rule here is a UNION of the live signals rather than a precedence chain,
 * so it cannot depend on which source arrives first:
 *
 *   - an explicit NON-offline status ('online' | 'away' | 'dnd') wins outright;
 *   - otherwise (status absent, unrecognised, or a possibly-stale 'offline')
 *     live presence decides.
 *
 * This also matches what HomePanel.tsx already does for its "N of M on" tile
 * (`presence[id] === true || status !== 'offline'`), so the two surfaces no
 * longer disagree about who is around.
 */

/** The statuses a user can hold. Mirrors `UserStatus` in hooks/useUserStatus.ts. */
export type ActiveStatus = 'online' | 'away' | 'dnd' | 'offline';

/** The subset of `FriendStatusEntry` this module needs. */
export interface ActiveNowStatusEntry {
    status?: string | null;
    current_game?: string | null;
}

export type StatusMap = Record<string, ActiveNowStatusEntry | undefined>;
export type PresenceMap = Record<string, boolean | undefined>;

/** Statuses that mean "this person is connected", in display-priority order. */
const PRESENT_STATUSES: readonly ActiveStatus[] = ['online', 'away', 'dnd'];

function asPresentStatus(raw: string | null | undefined): ActiveStatus | null {
    return PRESENT_STATUSES.includes(raw as ActiveStatus) ? (raw as ActiveStatus) : null;
}

/**
 * Resolve a user's effective status from both sources, order-independently.
 *
 * A known non-offline status is authoritative — it carries more information
 * (away/dnd) than the presence boolean can. Only when the status map has
 * nothing useful to say does the live presence map get to promote the user to
 * 'online'; that is the path that rescues a friend still sitting on a stale
 * seeded 'offline'.
 */
export function resolveActiveStatus(
    userId: string,
    statuses: StatusMap,
    presence: PresenceMap,
): ActiveStatus {
    const known = asPresentStatus(statuses[userId]?.status);
    if (known) return known;
    if (presence[userId] === true) return 'online';
    return 'offline';
}

/** Whether a user should appear under "Active Now". */
export function isActiveNow(userId: string, statuses: StatusMap, presence: PresenceMap): boolean {
    return resolveActiveStatus(userId, statuses, presence) !== 'offline';
}

/**
 * The "Active Now" list, derived fresh from whatever live state exists right
 * now. Never memoised against a snapshot of one source — that is how the
 * section used to go stale when the other source updated.
 */
export function selectActiveFriends<T extends { user_id: string }>(
    friends: readonly T[],
    statuses: StatusMap,
    presence: PresenceMap,
): T[] {
    return friends.filter(f => isActiveNow(f.user_id, statuses, presence));
}

/**
 * A user's status plus the server's on-mobile bit, for surfaces that draw a
 * dot (the Home deck). On-mobile only ever applies while present — the same
 * rule as StatusDot's own guard, applied here so callers can't disagree.
 */
export function resolvePresenceWithMobile(
    userId: string,
    statuses: Record<string, (ActiveNowStatusEntry & { on_mobile?: boolean | null }) | undefined> | undefined,
    presence: PresenceMap,
): { status: ActiveStatus; onMobile: boolean } {
    const status = resolveActiveStatus(userId, statuses ?? {}, presence);
    return { status, onMobile: status !== 'offline' && !!statuses?.[userId]?.on_mobile };
}
