/**
 * Visual "slab" grouping for hoisted-role member sections in the right-hand
 * server context panel (`ServerContextPanel.tsx`).
 *
 * A role with "Display members separately" (hoisted) already gets its own
 * section in the member list. This module decides, for a given row inside
 * one of those sections, whether it sits at the top, bottom, both (a
 * single-member group), or neither (a middle row) — the only input the
 * corner-rounding / seam treatment needs. Deliberately data-only (no React,
 * no Tailwind) so the position rule is testable in isolation; the caller maps
 * the result onto class names.
 */

export type GroupRowPosition = 'single' | 'first' | 'middle' | 'last';

/**
 * `index` is the row's zero-based position within its hoisted-role group,
 * `total` is the group's member count. Both must describe a real row
 * (`total >= 1`, `0 <= index < total`) — this is a rendering-time helper fed
 * directly from `roleGroups[i].members.map(...)`, never user input.
 */
export function getGroupRowPosition(index: number, total: number): GroupRowPosition {
    if (total <= 1) return 'single';
    if (index <= 0) return 'first';
    if (index >= total - 1) return 'last';
    return 'middle';
}

/**
 * Tailwind classes for one hoisted-group row: a subtle darker wash (a
 * grouping cue, not a highlight — see index.css's `--cl-abyss`/`--cl-deep`
 * scale) plus the corner rounding that makes consecutive rows in a group
 * read as one merged slab. Only the very top of `first`/`single` and the
 * very bottom of `last`/`single` round; everything else butts flush against
 * its neighbour.
 *
 * The background is a plain Tailwind `bg-*` utility, same CSS property as
 * the row's own `hover:bg-white/[0.04]` — hover simply replaces it for that
 * one row, which is exactly the localized highlight we want on top of the
 * group's flat backdrop (see MemberTile).
 */
export function getGroupRowRoundingClass(pos: GroupRowPosition): string {
    switch (pos) {
        case 'single': return 'rounded-lg';
        case 'first':  return 'rounded-t-lg rounded-b-none';
        case 'last':   return 'rounded-b-lg rounded-t-none';
        case 'middle': return 'rounded-none';
    }
}
