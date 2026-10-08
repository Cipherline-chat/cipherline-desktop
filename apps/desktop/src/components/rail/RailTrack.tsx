/**
 * RailTrack — moved verbatim out of Dashboard.tsx (2026-10, server folders)
 * so the rail can be exercised outside the ~13k-line Dashboard: the folder
 * harness renders THIS component, so the sliding pill's measured geometry
 * (and its border-box re-measure on the overflow/centred switch) is the real
 * thing rather than a mock. No behaviour change.
 */
import React from 'react';
import { RailScrollbar } from './RailScrollbar';
import { useRailMembrane } from './useRailMembrane';
import type { RestBox } from './railMembrane';

/**
 * Sunk rail track with the sliding lume indicator (verbatim from `app.jsx`
 * RailTrack). The track is a content-width "deck" recessed into the abyss;
 * the lume pill slides to `activeIndex` (44px tile + 6px gap = 50px step) and
 * scales/fades out when nothing in the track is active (`activeIndex < 0`).
 * The pill lives inside the track so it scrolls in lock-step with the tiles.
 */
export const RailTrack: React.FC<{
    activeIndex: number;
    children: React.ReactNode;
    /** The server-list box: its own height is bounded by the rail, the tiles
     *  scroll INSIDE it (clipped to its rounded edge) and an overlay scrollbar
     *  sits in its left padding. Other tracks (Friends/Settings) are fixed. */
    scroll?: boolean;
    /** Receives the scrolling element (the track itself when `scroll`). */
    scrollRef?: React.MutableRefObject<HTMLDivElement | null>;
    onScroll?: () => void;
}> = ({ activeIndex, children, scroll, scrollRef, onScroll }) => {
    const track = React.useRef<HTMLDivElement | null>(null);
    const setTrack = React.useCallback((el: HTMLDivElement | null) => {
        track.current = el;
        if (scrollRef) scrollRef.current = el;
    }, [scrollRef]);
    const indicator = React.useRef<HTMLSpanElement | null>(null);
    // Hold the last real slot while nothing is active, so the indicator fades
    // out where it was rather than sliding home first.
    const lastActive = React.useRef(0);
    if (activeIndex >= 0) lastActive.current = activeIndex;
    const slot = lastActive.current;

    // ── Geometry is MEASURED, never assumed ──────────────────────────────
    // This used to be `slot * 50` from a hardcoded 44px tile + 6px gap. That
    // is true for the RailTile buttons and FALSE for the server tiles, which
    // render inside a `<div className="relative group">` wrapper rather than
    // as bare flex children — so the indicator drifted further off-centre the
    // further down the rail it went, which is exactly what was reported.
    // Reading the real child box is immune to that and to any future layout
    // change. Child 0 is the indicator itself, so slot N is child N + 1.
    const [rest, setRest] = React.useState<RestBox | null>(null);
    // PERF (freeze fix): this effect used to depend on `children`, which is a
    // fresh element array on EVERY Dashboard render — so every render, for any
    // reason (a message arriving, a presence tick, a fetch landing), re-ran it:
    // it read offsetTop/offsetWidth straight after React's DOM commit, which
    // FORCES a synchronous style + layout of the whole document, and it tore
    // down and rebuilt a ResizeObserver over every tile. Measured with the
    // freeze harness it was the single largest JS-attributed cost at startup
    // (~1.1 s of forced layout across the boot renders), and it ran again on
    // every burst of state updates afterwards.
    //
    // Now it runs when the active slot changes (the only time the indicator
    // must move this frame), and otherwise lets observers report geometry
    // changes: ResizeObserver for any tile/track resize (callbacks run after
    // the browser's own layout, so reading geometry there forces nothing) and
    // a MutationObserver for tiles being added, removed or reordered (a server
    // joined, drag-to-reorder), which re-observes the new children and
    // re-measures on the next frame instead of synchronously.
    React.useLayoutEffect(() => {
        const el = track.current;
        const measure = () => {
            const tile = el?.children[slot + 1] as HTMLElement | undefined;
            if (!tile) return;
            const next = {
                top: tile.offsetTop, left: tile.offsetLeft,
                width: tile.offsetWidth, height: tile.offsetHeight,
            };
            setRest(prev => (prev && prev.top === next.top && prev.left === next.left
                && prev.width === next.width && prev.height === next.height) ? prev : next);
        };
        measure();
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        const observeAll = () => {
            // border-box: a change to the track's PADDING moves every tile's
            // offsetLeft without changing the track's content-box (the default)
            // or any tile's size — so a default observer never re-measures. (It
            // bit when the rail used to shift its column for the scrollbar; the
            // padding is constant now, but this stays robust to it.)
            ro.observe(el, { box: 'border-box' });
            for (const c of Array.from(el.children)) ro.observe(c);
        };
        observeAll();
        let raf = 0;
        const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
            // Tile set changed. Newly added children need observing; removed
            // ones are dropped by the browser. Re-measure on the next frame,
            // after layout has happened anyway.
            observeAll();
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); });
        });
        mo?.observe(el, { childList: true });
        return () => {
            ro.disconnect();
            mo?.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [slot]);

    // Geometry is written straight to the node every frame — see
    // useRailMembrane for why this bypasses React state, and railMembrane.ts
    // for why the integrator is analytic.
    useRailMembrane(indicator, rest ? rest.top : 0, rest);

    const hidden = activeIndex < 0 || !rest;
    const trackEl = (
        <div
            className={scroll ? 'cl-rail-track cl-rail-track--scroll' : 'cl-rail-track'}
            ref={setTrack}
            data-ob-anchor="rail-track"
            data-testid={scroll ? 'rail-scroll' : undefined}
            onScroll={onScroll}
        >
            <span
                ref={indicator}
                aria-hidden
                className="cl-rail-indicator"
                style={{
                    // The fade-out is the ONLY thing here that may transition:
                    // it is not part of the travel, and runs only when the
                    // track has nothing active at all.
                    transform: hidden ? 'scale(0.6)' : 'none',
                    opacity: hidden ? 0 : 1,
                }}
            />
            {children}
        </div>
    );
    if (!scroll) return trackEl;
    return (
        <div className="cl-rail-box">
            {trackEl}
            <RailScrollbar target={track} />
        </div>
    );
};
