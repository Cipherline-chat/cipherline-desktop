/**
 * Keyboard navigation for the GIF picker grid. Pure so it can be tested
 * without a DOM.
 *
 * Returns the index focus should move to, `'search'` when focus should go back
 * up to the search box (ArrowUp from the first row), or `null` when the key is
 * not a navigation key for the grid.
 */
export type GridMove = number | 'search' | null;

export function nextGridIndex(current: number, key: string, count: number, columns: number): GridMove {
    if (count <= 0 || columns <= 0) return null;
    const i = Math.min(Math.max(current, 0), count - 1);
    switch (key) {
        case 'ArrowRight': return Math.min(i + 1, count - 1);
        case 'ArrowLeft': return Math.max(i - 1, 0);
        case 'ArrowDown': {
            const next = i + columns;
            // On a ragged last row, drop to the last item rather than stopping.
            if (next < count) return next;
            const lastRowStart = count - (count % columns || columns);
            return i < lastRowStart ? count - 1 : i;
        }
        case 'ArrowUp': return i - columns >= 0 ? i - columns : 'search';
        case 'Home': return 0;
        case 'End': return count - 1;
        case 'PageDown': return Math.min(i + columns * 3, count - 1);
        case 'PageUp': return Math.max(i - columns * 3, 0);
        default: return null;
    }
}
