/**
 * Pure ordering math behind `ClSelect`'s drag-to-reorder (see the `reorder`
 * prop in `ClSelect.tsx`). Split into its own dependency-free module — same
 * pattern as `tooltipPlacement.ts` / `modalScroll.ts` — so it's testable from
 * a plain `.test.ts` file without dragging in `ClSelect.tsx`'s React-DOM /
 * `clPhysics` module-load side effects (the `node` vitest environment here
 * has no `window.matchMedia`, which `clPhysics.ts` calls at import time).
 */

/** A few px of pointer movement before a press-on-an-option becomes a drag
 *  rather than a click — small enough to feel immediate, large enough that a
 *  slightly-shaky click never gets misread as a reorder attempt. */
export const DRAG_THRESHOLD_PX = 6;

/**
 * Given the pointer's Y and the pre-drag bounding rects of every option row
 * (captured once, at drag-start — see the "why cache" note at the ClSelect
 * call site), returns the absolute index in `options` the dragged row would
 * land BEFORE if dropped right now. Clamped so nothing can land at or after
 * the first `isLocked` option (assumes locked options are TRAILING — true
 * for every current caller).
 */
export function computeReorderDropIndex<T extends string>(
    clientY: number,
    options: { value: T }[],
    rowRects: (DOMRect | null)[],
    isLocked: (value: T) => boolean,
): number {
    let target = options.length;
    for (let i = 0; i < options.length; i++) {
        if (isLocked(options[i].value)) continue;
        const r = rowRects[i];
        if (!r) continue;
        if (clientY < r.top + r.height / 2) { target = i; break; }
    }
    const firstLocked = options.findIndex((o) => isLocked(o.value));
    if (firstLocked !== -1 && target > firstLocked) target = firstLocked;
    return target;
}

/**
 * Moves `options[fromIndex]` to land BEFORE absolute index `dropAt` in the
 * original (pre-move) `options` array, returning the resulting full value
 * order — or `null` if that's a no-op (dropped back where it started). Used
 * for both a pointer drop and a keyboard nudge (an adjacent-slot swap is just
 * `dropAt = fromIndex + 2` moving down / `fromIndex - 1` moving up), so
 * there's exactly one ordering computation inside `ClSelect`, not two.
 */
export function applyReorderDrop<T extends string>(
    options: { value: T }[],
    fromIndex: number,
    dropAt: number,
): T[] | null {
    const values = options.map((o) => o.value);
    const moved = values[fromIndex];
    const without = values.filter((_, i) => i !== fromIndex);
    let insertAt = dropAt;
    if (fromIndex < dropAt) insertAt -= 1;
    insertAt = Math.max(0, Math.min(without.length, insertAt));
    without.splice(insertAt, 0, moved);
    return without.some((v, i) => v !== values[i]) ? without : null;
}
