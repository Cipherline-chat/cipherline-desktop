import { useLayoutEffect, useState } from 'react';

export interface ElementSize { w: number; h: number }

const NONE: ElementSize = { w: 0, h: 0 };

/**
 * Live content-box size of whichever element holds the returned `ref`.
 *
 * Keyed on the ELEMENT, not on some value that happens to change alongside it:
 * a useRef plus an effect keyed on anything else misses a remount with the key
 * unchanged, and then measures nothing or a detached node. Back to 0 x 0 while
 * no element is mounted, so a stale size never survives into the next one.
 *
 * Reads once before paint too. ResizeObserver only delivers after layout, which
 * would give the new element one frame at the caller's unmeasured fallback.
 */
export function useElementSize<T extends HTMLElement>(): { ref: (el: T | null) => void; size: ElementSize } {
    const [el, ref] = useState<T | null>(null);
    const [size, setSize] = useState<ElementSize>(NONE);
    useLayoutEffect(() => {
        if (!el) {
            setSize(NONE);
            return;
        }
        setSize({ w: el.clientWidth, h: el.clientHeight });
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setSize({ w: cr.width, h: cr.height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [el]);
    return { ref, size };
}
