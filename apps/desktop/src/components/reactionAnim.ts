/**
 * Pure decision logic for the reaction-pill "pop" animation (ChatPane.tsx's
 * `ReactionPill`), kept DOM-free and React-free so the three-way trigger —
 * add / remove / bump, and the "never on mount" rule — is unit-testable
 * without mounting anything. See `popReactionPill` in ChatPane.tsx for the
 * actual `el.animate()` call this feeds.
 */

export type ReactionAnimKind = 'add' | 'remove' | 'bump';

export interface ReactionSnapshot {
    count: number;
    hasMine: boolean;
}

/**
 * Decide which reaction-pill animation (if any) a state transition should
 * play.
 *
 *  - `prev === null` (no snapshot yet for this reaction) -> always `null`.
 *    This is what stops the animation firing on first mount: without it,
 *    every reaction on every message would replay its animation every time
 *    the message list re-renders — a channel switch, a scroll that
 *    re-mounts rows, a paginated fetch — not just on a genuine change.
 *  - `!prev.hasMine && next.hasMine`             -> `'add'`    (you reacted)
 *  - `prev.hasMine && !next.hasMine`              -> `'remove'` (you un-reacted)
 *  - `next.count > prev.count`                    -> `'bump'`   (someone
 *    else reacted — a remote event no local click handler ever sees, so it
 *    has to be caught by diffing the count. Deliberately NOT gated on the
 *    viewer's own `hasMine`: a bystander watching a reaction appear should
 *    see it move, and requiring hasMine made that case silent.)
 *  - anything else (a count going DOWN because someone else un-reacted, or
 *    a no-op re-render) -> `null`.
 */
export function decideReactionAnim(
    prev: ReactionSnapshot | null,
    next: ReactionSnapshot,
): ReactionAnimKind | null {
    if (!prev) return null;
    if (!prev.hasMine && next.hasMine) return 'add';
    if (prev.hasMine && !next.hasMine) return 'remove';
    // Any count increase is someone else reacting — whether or not YOU also
    // hold this reaction. This previously required `prev.hasMine &&
    // next.hasMine`, which meant a viewer who had not reacted saw no
    // animation at all: every branch was gated on the local user's own
    // hasMine, so watching someone else react was completely silent. The
    // whole point of the bump is to show a REMOTE action, so it must not
    // depend on the viewer's own participation.
    if (next.count > prev.count) return 'bump';
    return null;
}
