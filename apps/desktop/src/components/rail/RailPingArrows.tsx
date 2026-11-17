/**
 * RailPingArrows — the "unseen ping" pills on the rail's server box.
 *
 * When a tile that shows a red (Flash) badge is scrolled out of the server
 * box, a small Flash-coral pill appears pinned to that edge of the box —
 * "^ 3" at the top, "v 1" at the bottom — and clicking it smooth-scrolls the
 * box to the nearest such tile in that direction (instant under
 * prefers-reduced-motion). It disappears once nothing pinged is out of view
 * that way. Everything it decides is in railOffscreenPings.ts (pure, tested);
 * this file only measures and draws.
 *
 * Placement: a sibling of the scrolling track inside `.cl-rail-box`, exactly
 * like RailScrollbar — NOT inside the track. RailTrack measures the sliding
 * lume pill from the track's DOM children by index, so nothing may be added
 * there; and inside the box (position:relative, overflow:hidden, rounded) the
 * pills stay fixed to the visible edge while the tiles scroll under them.
 *
 * Measuring: rect reads happen in at most one requestAnimationFrame per frame,
 * scheduled by a scroll of the box (passive), a resize of the box
 * (ResizeObserver), tiles being added / removed / reordered
 * (MutationObserver, childList), or the set of pinged tiles changing. Nothing
 * runs per frame at rest. IntersectionObserver was considered and rejected: it
 * reports only threshold CROSSINGS, so a jump scroll that carries a tile from
 * "below" straight to "above" (track click, Home/End, a reveal) fires nothing
 * and the arrow would point the wrong way.
 *
 * Accessibility: real <button>s with an aria-label ("3 unread pings above");
 * they never take focus on appearing. Activating one from the keyboard moves
 * focus to the revealed tile's button (the pill itself is about to unmount).
 * A polite live region announces a NEW off-screen ping once
 * (pingAnnouncement); scrolling a ping away yourself is not announced.
 */
import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
    NO_OFFSCREEN_PINGS, offscreenPings, pingAnnouncement, pingArrowCount, pingArrowLabel,
    sameOffscreenPings, scrollTopForPing, type OffscreenPings, type PingTileBox,
} from './railOffscreenPings';
import '../../styles/rail-ping-arrows.css';

const ANNOUNCE_CLEAR_MS = 4000;

/** Pinged tiles' boxes relative to the top of the scroller's visible area. */
function measurePingTiles(el: HTMLElement, keys: readonly string[]): PingTileBox[] {
    if (keys.length === 0) return [];
    const wanted = new Set(keys);
    const box = el.getBoundingClientRect();
    const originTop = box.top + el.clientTop;
    const out: PingTileBox[] = [];
    // One pass over the tiles rather than a selector per key: rail keys are
    // server/folder ids, and this avoids escaping them into a selector.
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-rail-id]'))) {
        const key = node.getAttribute('data-rail-id');
        if (!key || !wanted.has(key)) continue;
        const r = node.getBoundingClientRect();
        out.push({ key, top: r.top - originTop, height: r.height });
    }
    return out;
}

function prefersReducedMotion(): boolean {
    try {
        return typeof window !== 'undefined' && !!window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/** DOM writes live in plain functions so the React Compiler doesn't see a
 *  prop-derived element being mutated inside the component body. */
function scrollBoxTo(el: HTMLElement, top: number, smooth: boolean): void {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    else el.scrollTop = top;
}
function focusTile(el: HTMLElement, key: string): void {
    const tile = Array.from(el.querySelectorAll<HTMLElement>('[data-rail-id]')).find(n => n.getAttribute('data-rail-id') === key);
    const target = tile?.matches('button') ? tile : tile?.querySelector<HTMLElement>('button');
    target?.focus({ preventScroll: true });
}

export const RailPingArrows: React.FC<{
    /** The rail's scrolling track. */
    target: React.RefObject<HTMLElement | null>;
    /** `data-rail-id`s of the tiles showing a red badge (pingedRailKeys). */
    pingKeys: readonly string[];
}> = ({ target, pingKeys }) => {
    const [state, setState] = React.useState<OffscreenPings>(NO_OFFSCREEN_PINGS);
    const [announcement, setAnnouncement] = React.useState('');
    const keysRef = React.useRef<readonly string[]>(pingKeys);
    const pingsChangedRef = React.useRef(false);
    /** Set by the measuring effect below; a no-op until it is mounted. */
    const scheduleRef = React.useRef<() => void>(() => {});

    // Box scroll / resize / tile set changes -> one re-measure next frame.
    React.useEffect(() => {
        const el = target.current;
        if (!el) return;
        let raf = 0;
        let prev: OffscreenPings = NO_OFFSCREEN_PINGS;
        let clearTimer: ReturnType<typeof setTimeout> | null = null;
        const measure = () => {
            raf = 0;
            const next = offscreenPings(measurePingTiles(el, keysRef.current), el.clientHeight);
            const said = pingAnnouncement(prev, next, pingsChangedRef.current);
            pingsChangedRef.current = false;
            prev = next;
            setState(cur => (sameOffscreenPings(cur, next) ? cur : next));
            if (said) {
                setAnnouncement(said);
                if (clearTimer) clearTimeout(clearTimer);
                clearTimer = setTimeout(() => { clearTimer = null; setAnnouncement(''); }, ANNOUNCE_CLEAR_MS);
            }
        };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
        scheduleRef.current = schedule;
        el.addEventListener('scroll', schedule, { passive: true });
        const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
        ro?.observe(el);
        const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
        mo?.observe(el, { childList: true });
        schedule();
        return () => {
            scheduleRef.current = () => {};
            el.removeEventListener('scroll', schedule);
            ro?.disconnect();
            mo?.disconnect();
            if (raf) cancelAnimationFrame(raf);
            if (clearTimer) clearTimeout(clearTimer);
        };
    }, [target]);

    // Pinged set changed (a ping arrived, was read, a server moved). Declared
    // AFTER the effect above so scheduleRef is live on mount. The first run is
    // the initial state, not news: pings already off-screen when the rail
    // mounts (app start) are shown, not announced.
    const pingSig = pingKeys.join('|');
    const seenFirstSig = React.useRef(false);
    React.useEffect(() => {
        keysRef.current = pingSig ? pingSig.split('|') : [];
        if (seenFirstSig.current) pingsChangedRef.current = true;
        seenFirstSig.current = true;
        scheduleRef.current();
    }, [pingSig]);

    const reveal = (direction: 'up' | 'down', e: React.MouseEvent<HTMLButtonElement>) => {
        const el = target.current;
        if (!el) return;
        // Fresh geometry at click time — the stored state is up to a frame old.
        const tiles = measurePingTiles(el, keysRef.current);
        const now = offscreenPings(tiles, el.clientHeight);
        const key = direction === 'up' ? now.nearestAbove : now.nearestBelow;
        const tile = key ? tiles.find(t => t.key === key) : undefined;
        if (!tile) { scheduleRef.current(); return; }
        scrollBoxTo(el, scrollTopForPing(el.scrollTop, tile, el.clientHeight), !prefersReducedMotion());
        // detail === 0: activated by keyboard (Enter / Space), not a pointer.
        if (e.detail === 0) focusTile(el, tile.key);
    };
    const revealUp = (e: React.MouseEvent<HTMLButtonElement>) => reveal('up', e);
    const revealDown = (e: React.MouseEvent<HTMLButtonElement>) => reveal('down', e);

    return (
        <>
            {state.above > 0 && (
                <button
                    type="button"
                    className="cl-rail-ping no-drag cl-rail-ping--up"
                    data-testid="rail-ping-up"
                    aria-label={pingArrowLabel('up', state.above)}
                    title={pingArrowLabel('up', state.above)}
                    onClick={revealUp}
                >
                    <ArrowUp size={10} strokeWidth={3} aria-hidden />
                    <span className="cl-rail-ping-num">{pingArrowCount(state.above)}</span>
                </button>
            )}
            {state.below > 0 && (
                <button
                    type="button"
                    className="cl-rail-ping no-drag cl-rail-ping--down"
                    data-testid="rail-ping-down"
                    aria-label={pingArrowLabel('down', state.below)}
                    title={pingArrowLabel('down', state.below)}
                    onClick={revealDown}
                >
                    <ArrowDown size={10} strokeWidth={3} aria-hidden />
                    <span className="cl-rail-ping-num">{pingArrowCount(state.below)}</span>
                </button>
            )}
            <span className="cl-rail-ping-live" aria-live="polite" data-testid="rail-ping-live">{announcement}</span>
        </>
    );
};

export default RailPingArrows;
