import { useEffect, useState } from 'react';
import { ROW_BATCH, scrollParentOf } from '../utils/incrementalRows';

/**
 * Mount a long list in batches: the first `batch` rows now, another `batch`
 * each time the returned sentinel (a spacer sized for the unmounted rows) comes
 * within `marginPx` of the scroll container's visible area. Resets to the
 * first batch whenever `resetKey` changes (a different server), computed during
 * render so a switch never paints one frame with the previous list's budget.
 *
 * A list with `total <= batch` never renders the sentinel and never creates an
 * observer: identical to rendering everything.
 */
export function useIncrementalRows(
    resetKey: string,
    total: number,
    batch: number = ROW_BATCH,
    marginPx = 800,
): { budget: number; hidden: number; sentinelRef: (el: HTMLElement | null) => void } {
    const [state, setState] = useState({ key: resetKey, budget: batch });
    const budget = state.key === resetKey ? state.budget : batch;
    const [node, setNode] = useState<HTMLElement | null>(null);
    const hidden = Math.max(0, total - budget);

    useEffect(() => {
        if (!node || hidden === 0 || typeof IntersectionObserver === 'undefined') return;
        // Re-created after every growth: an observer only reports CHANGES, so a
        // sentinel that is still in range after a batch lands would never fire again.
        const io = new IntersectionObserver(entries => {
            if (!entries.some(e => e.isIntersecting)) return;
            setState(s => ({ key: resetKey, budget: (s.key === resetKey ? s.budget : batch) + batch }));
        }, { root: scrollParentOf(node), rootMargin: `${marginPx}px 0px` });
        io.observe(node);
        return () => io.disconnect();
    }, [node, hidden, budget, resetKey, batch, marginPx]);

    return { budget, hidden, sentinelRef: setNode };
}
