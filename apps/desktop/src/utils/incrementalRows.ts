/**
 * Row budgeting for a long list rendered as ordered sections (the server panel's
 * member list: hoisted role groups, then Online, then Offline).
 *
 * Why: mounting every row is the cost that is left once the roster itself comes
 * from cache. Measured in the roster bench (production build, ~1.2k DOM nodes
 * per 62 members): ~80 ms of React render + ~65 ms of style recalc + ~15 ms of
 * layout per server switch at 62 members, ~190 + ~180 + ~45 ms at 200 — linear
 * in rows, and almost all of it for rows nobody has scrolled to. So only the
 * first `budget` rows are mounted; the rest are a sized spacer that grows the
 * budget when it nears the viewport (see useIncrementalRows). A list that fits
 * the budget renders exactly as before.
 */

/** Rows mounted up front, and added each time the spacer nears the viewport. */
export const ROW_BATCH = 48;

/** Estimated height of one member row in px (py-1.5 + 32 px avatar + the 2 px gap) — only sizes the spacer. */
export const ROW_PX_ESTIMATE = 46;

/**
 * Split `budget` rows over sections in display order: each section gets as many
 * of its rows as are left, so the first sections fill completely and the budget
 * runs out part-way down the list. `counts[i]` is section i's full size.
 */
export function allocateRows(counts: ReadonlyArray<number>, budget: number): number[] {
    let left = Math.max(0, budget);
    return counts.map(n => {
        const take = Math.min(Math.max(0, n), left);
        left -= take;
        return take;
    });
}

/** Nearest ancestor that scrolls vertically (the IntersectionObserver root), or null for the viewport. */
export function scrollParentOf(node: Element | null): Element | null {
    for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
    }
    return null;
}
