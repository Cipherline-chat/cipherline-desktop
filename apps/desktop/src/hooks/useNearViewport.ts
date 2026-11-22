import { useEffect, useState, type RefObject } from 'react';

/**
 * True once `ref`'s element has come within `margin` of the viewport, and
 * stays true after that (a card that was seen keeps its answer; it never goes
 * back to "not asked"). Without IntersectionObserver (old runtimes, tests) it
 * is true at once, so nothing waits on it.
 *
 * Used by invite cards so a long history of them does not spend the preview
 * endpoint's per-account budget on cards nobody has scrolled to.
 */
export function useNearViewport(ref: RefObject<Element | null>, margin = '600px'): boolean {
    const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
    useEffect(() => {
        if (near) return;
        const el = ref.current;
        if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
        const io = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) { setNear(true); io.disconnect(); }
        }, { rootMargin: `${margin} 0px` });
        io.observe(el);
        return () => io.disconnect();
    }, [ref, margin, near]);
    return near;
}
