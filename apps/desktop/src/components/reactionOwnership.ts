/**
 * "Is this reaction mine?" — the single predicate behind both the pill's
 * highlight and the add/remove toggle.
 *
 * It exists because those two disagreed. Reactions are keyed by `user_id` in
 * server channels but only by `device_id` in DMs and groups, so the check has
 * to accept either. The pill did; the toggle checked device ids alone. In a
 * server channel that made `currentHasIt` always false, so clicking your own
 * reaction re-added it instead of removing it — while the pill still rendered
 * it highlighted as yours.
 *
 * Keep both call sites on this function so they cannot drift again.
 */
export function isMyReaction(
    reactorIds: readonly string[],
    myUserId: string | null | undefined,
    myDeviceIds: ReadonlySet<string>,
): boolean {
    return reactorIds.some(id => (!!myUserId && id === myUserId) || myDeviceIds.has(id));
}
