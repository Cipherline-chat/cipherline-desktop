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

/** A single reaction chip reaching this many is a pile-up: it gets a small burst. */
export const PILE_UP_AT = 10;

/**
 * Whether a count change is the live crossing of the pile-up line: from below
 * it to at-or-above it, in one step. `prevCount === null` (a chip that has only
 * just mounted: a channel switch, a scroll, a history load) never counts, which
 * is what keeps the burst from replaying on a message that already has ten.
 */
export function crossedPileUp(prevCount: number | null, nextCount: number, at: number = PILE_UP_AT): boolean {
    return prevCount !== null && prevCount < at && nextCount >= at;
}

/**
 * Remembers which chips have burst this session, so a chip that wobbles 9, 10,
 * 9, 10 (people un-reacting and re-reacting) bursts once, not each time.
 * Keyed by the chip's `${messageId}:${emoji}`.
 */
export function createPileUpGate(limit = 500) {
    const burst = new Set<string>();
    return {
        /** True the first time `key` is claimed; false afterwards. */
        claim(key: string): boolean {
            if (burst.has(key)) return false;
            if (burst.size >= limit) burst.delete(burst.values().next().value as string);
            burst.add(key);
            return true;
        },
        has: (key: string) => burst.has(key),
    };
}
