/**
 * The client must not OFFER an action whose server-side handler now requires
 * mutual friendship (or being the acting user) — DM creation, group
 * creation, adding someone to an existing group, and "Invite to Server"
 * (which works by DMing an invite). The server enforces the actual gate
 * independently (mutual-friendship check in createDm / createGroup /
 * inviteMember); this module is UX only — it exists so a click never
 * round-trips to a 400 the user can't do anything about. See CLAUDE.md's
 * "the client has NO load-bearing checks by design" — nothing here is a
 * security boundary.
 *
 * `FriendRelationship` names every state the client can find another user
 * in, so the "may I offer this" decision can be tested against each one
 * explicitly instead of relying on every call site remembering which states
 * collapse into "not a friend":
 *   - 'self'             — the viewer's own account. Always allowed — this
 *                          function must never gate someone out of an
 *                          action against their own profile.
 *   - 'friend'           — accepted mutual friendship. Allowed.
 *   - 'stranger'         — no relationship at all. Hidden.
 *   - 'pending_outgoing' — viewer sent a friend request, not yet accepted.
 *                          Hidden — the server has no mutual friendship yet.
 *   - 'pending_incoming' — the other user sent a request the viewer hasn't
 *                          accepted. Hidden, same reason.
 *   - 'blocked'          — either party has blocked the other. Hidden.
 *   - 'ex_friend'        — a friendship that existed and was removed. The
 *                          server has no record distinguishing this from a
 *                          plain stranger, so it is hidden identically. Kept
 *                          as its own case (rather than folded into
 *                          'stranger') so call sites and tests can name the
 *                          "friend removed after a DM/group already exists"
 *                          scenario explicitly.
 */
export type FriendRelationship =
    | 'self'
    | 'friend'
    | 'stranger'
    | 'pending_outgoing'
    | 'pending_incoming'
    | 'blocked'
    | 'ex_friend';

/**
 * Should the client render a friend-gated action for this relationship?
 * Pure and total over every `FriendRelationship` — no I/O, no React, no
 * app state — so it can be unit-tested in isolation from how each screen
 * happens to derive the relationship.
 */
export function canOfferFriendGatedAction(relationship: FriendRelationship): boolean {
    return relationship === 'self' || relationship === 'friend';
}
