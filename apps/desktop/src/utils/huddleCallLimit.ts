/**
 * True when a Calls (Huddle) channel has reached its per-channel concurrent
 * call cap — mirrors `HuddlesService.spawnCall`'s server-enforced limit
 * ("This Calls channel has reached its call limit of N", apps/api/src/servers/
 * huddles.service.ts). `activeCallCount` is the caller's own live,
 * event-driven call count for the channel (the same value the UI already
 * renders as "X/Y calls"), so answering this needs no extra fetch or poll.
 *
 * UX mirror only — the server remains the sole authority and independently
 * refuses `POST /huddles/:hid/calls` past the limit regardless of what the
 * client believes. This just lets the client hide/disable the "+" spawn
 * affordance instead of letting the user hit a confusing "Call connection
 * failed" toast for what is actually a full channel, not a network error.
 *
 * `maxCalls == null` means unlimited (never at the limit).
 */
export function isHuddleAtCallLimit(
    activeCallCount: number,
    maxCalls: number | null | undefined,
): boolean {
    return maxCalls != null && activeCallCount >= maxCalls;
}
