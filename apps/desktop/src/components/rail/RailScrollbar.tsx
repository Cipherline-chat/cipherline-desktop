import React from 'react';
import { SCROLL_SHOW_MS, thumbGeometry, scrollTopForThumbDrag, scrollTopForTrackClick, type ThumbGeometry } from './railScrollbarMath';

/**
 * Overlay scrollbar for the rail's server box — sits INSIDE the box, on its
 * LEFT edge.
 *
 * Why custom rather than a native scrollbar: Chromium puts a native vertical
 * scrollbar on the right for LTR content. Moving it left needs
 * `direction: rtl` on the scroller (and `ltr` restored on every tile, tooltip
 * and badge), and a native bar always takes layout width from the box — so
 * the tiles shift whenever the bar appears or widens — and `:hover` can only
 * be tested on the scrollbar PART, which Chromium restyles unreliably. This is
 * a plain absolutely-positioned strip in the box's left padding: zero layout
 * footprint (icons never move), real DOM `:hover` limited to the strip itself,
 * and an honest CSS width transition. Scrolling itself stays 100% native
 * (wheel, touchpad, keyboard focus, dnd-kit auto-scroll); this only mirrors
 * scrollTop and lets you drag the thumb / click the track.
 *
 * Overlay-scrollbar visibility (index.css): invisible at rest, shown while
 * the pointer is over the box, while the list scrolls (this component sets
 * `.is-scrolling` on every scroll event and clears it SCROLL_SHOW_MS after the
 * last one — a direct class write, so a scroll re-renders nothing), and while
 * the thumb is dragged (`.is-drag`). Wide only over the strip / mid-drag.
 *
 * Purely visual + pointer sugar → aria-hidden; the scroller is the accessible
 * element.
 */
/** DOM writes live in plain functions so the React Compiler doesn't see a
 *  prop-derived element being mutated inside the component body. */
function setScrollTop(el: HTMLElement, value: number): void {
    el.scrollTop = value;
}

export const RailScrollbar: React.FC<{ target: React.RefObject<HTMLElement | null> }> = ({ target }) => {
    const trackRef = React.useRef<HTMLDivElement>(null);
    const [geo, setGeo] = React.useState<ThumbGeometry>({ visible: false, top: 0, height: 0 });
    const [dragging, setDragging] = React.useState(false);
    const drag = React.useRef<{ y: number; scrollTop: number } | null>(null);

    React.useEffect(() => {
        const el = target.current;
        if (!el) return;
        let hideTimer: ReturnType<typeof setTimeout> | null = null;
        const sync = () => {
            const track = trackRef.current;
            if (!track) return;
            const next = thumbGeometry(el.scrollTop, el.scrollHeight, el.clientHeight, track.clientHeight);
            setGeo(prev => (prev.visible === next.visible
                && Math.abs(prev.top - next.top) < 0.25
                && Math.abs(prev.height - next.height) < 0.25) ? prev : next);
        };
        // Show while scrolling, fade ~800ms after it stops.
        const onScroll = () => {
            sync();
            const strip = trackRef.current;
            if (!strip) return;
            strip.classList.add('is-scrolling');
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { hideTimer = null; strip.classList.remove('is-scrolling'); }, SCROLL_SHOW_MS);
        };
        sync();
        el.addEventListener('scroll', onScroll, { passive: true });
        const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
        ro?.observe(el);
        // Tiles added / removed / reordered change scrollHeight without
        // resizing the scroller itself.
        for (const c of Array.from(el.children)) ro?.observe(c);
        const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
            if (ro) for (const c of Array.from(el.children)) ro.observe(c);
            sync();
        });
        mo?.observe(el, { childList: true });
        return () => {
            el.removeEventListener('scroll', onScroll);
            if (hideTimer) clearTimeout(hideTimer);
            ro?.disconnect();
            mo?.disconnect();
        };
    }, [target]);

    const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const el = target.current;
        if (!el || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, scrollTop: el.scrollTop };
        setDragging(true);
    };
    const onThumbMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const el = target.current;
        const track = trackRef.current;
        const d = drag.current;
        if (!el || !track || !d) return;
        setScrollTop(el, scrollTopForThumbDrag(d.scrollTop, e.clientY - d.y, el.scrollHeight, el.clientHeight, track.clientHeight, geo.height));
    };
    const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    // The strip sits OVER the scroller's left padding but is not inside it, so
    // a wheel there would otherwise scroll nothing.
    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const el = target.current;
        if (el) setScrollTop(el, el.scrollTop + e.deltaY);
    };
    const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const el = target.current;
        const track = trackRef.current;
        if (!el || !track || e.button !== 0 || e.target !== e.currentTarget) return;
        const y = e.clientY - track.getBoundingClientRect().top;
        setScrollTop(el, scrollTopForTrackClick(y, el.scrollHeight, el.clientHeight, track.clientHeight, geo.height));
    };

    return (
        <div
            ref={trackRef}
            className={`cl-rail-sb no-drag${dragging ? ' is-drag' : ''}`}
            data-testid="rail-scrollbar"
            data-visible={geo.visible ? 'true' : 'false'}
            aria-hidden
            onPointerDown={onTrackDown}
            onWheel={onWheel}
        >
            <div
                className="cl-rail-sb-thumb"
                data-testid="rail-scrollbar-thumb"
                style={{ transform: `translateY(${geo.top}px)`, height: geo.height }}
                onPointerDown={onThumbDown}
                onPointerMove={onThumbMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            />
        </div>
    );
};

export default RailScrollbar;
