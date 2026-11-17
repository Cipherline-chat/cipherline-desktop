// @vitest-environment jsdom
/**
 * RailPingArrows wired through the REAL RailTrack (scroll track) with real
 * RailTile children: jsdom has no layout, so the scroller's height and each
 * tile's box are supplied from a tiny geometry model (content offsets minus
 * scrollTop) — everything else (the scroll listener, rAF scheduling, the
 * pill rendering, click-to-scroll, the live region) is the real code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RailTrack } from './RailTrack';
import { RailTile } from './RailTile';
import { RAIL_DM_KEY, PING_REVEAL_MARGIN } from './railOffscreenPings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const H = 300;
/** Content-space top of each tile (what offsetTop would be). */
const contentTop: Record<string, number> = {
    [RAIL_DM_KEY]: 6, 'nav:group': 56, 'srv:a': 106, 'srv:b': 456, 'srv:c': 806, 'srv:d': 856,
};
let scrollTop = 0;
let reduced = false;
let rafQueue: FrameRequestCallback[] = [];
const flushRaf = () => act(() => { const q = rafQueue; rafQueue = []; q.forEach(cb => cb(0)); });

let root: Root | null = null;
let host: HTMLDivElement;
let origRect: typeof Element.prototype.getBoundingClientRect;
let scrollToSpy: ReturnType<typeof vi.fn>;

function rect(top: number, height: number): DOMRect {
    return { top, height, bottom: top + height, left: 0, right: 44, width: 44, x: 0, y: top, toJSON() { return {}; } } as DOMRect;
}

function render(pingKeys: string[]) {
    const tiles = ['srv:a', 'srv:b', 'srv:c', 'srv:d'].map(k => React.createElement('div', { key: k, 'data-rail-id': k },
        React.createElement('button', { type: 'button' }, k)));
    act(() => {
        root!.render(React.createElement(RailTrack, {
            scroll: true, activeIndex: -1, pingKeys,
            children: [
                React.createElement(RailTile, { key: 'dm', title: 'Direct messages', railId: RAIL_DM_KEY, badge: { count: 2, tone: 'alert' } }),
                React.createElement(RailTile, { key: 'group', title: 'Group chats', railId: 'nav:group' }),
                ...tiles,
            ],
        }));
    });
}
const scroller = () => host.querySelector<HTMLElement>('[data-testid="rail-scroll"]')!;
const up = () => host.querySelector<HTMLButtonElement>('[data-testid="rail-ping-up"]');
const down = () => host.querySelector<HTMLButtonElement>('[data-testid="rail-ping-down"]');
const live = () => host.querySelector<HTMLElement>('[data-testid="rail-ping-live"]')!;

function mount(pingKeys: string[]) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    render(pingKeys);
    const el = scroller();
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => H });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => scrollTop, set: v => { scrollTop = v; } });
    el.scrollTo = scrollToSpy as unknown as typeof el.scrollTo;
    flushRaf();
}
function scrollToY(y: number) {
    scrollTop = y;
    act(() => { scroller().dispatchEvent(new Event('scroll')); });
    flushRaf();
}

beforeEach(() => {
    scrollTop = 0;
    reduced = false;
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
    scrollToSpy = vi.fn((opts: ScrollToOptions) => { scrollTop = opts.top ?? scrollTop; });
    origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
        if ((this as HTMLElement).dataset?.testid === 'rail-scroll') return rect(0, H);
        const k = this.getAttribute('data-rail-id');
        if (k && k in contentTop) return rect(contentTop[k] - scrollTop, 44);
        return rect(0, 0);
    };
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    Element.prototype.getBoundingClientRect = origRect;
    vi.unstubAllGlobals();
});

describe('RailPingArrows through RailTrack', () => {
    it('renders inside the server box but OUTSIDE the scrolling track (the pill is measured from track children by index)', () => {
        mount(['srv:c']);
        const d = down();
        expect(d).not.toBeNull();
        expect(scroller().contains(d)).toBe(false);
        expect(d!.closest('.cl-rail-box')).not.toBeNull();
    });

    it('a pinged tile below the box shows ONLY the down arrow, with count and label', () => {
        mount([RAIL_DM_KEY, 'srv:c', 'srv:d']);
        expect(up()).toBeNull();                       // DM tile is visible at the top
        expect(down()!.textContent).toBe('2');
        expect(down()!.getAttribute('aria-label')).toBe('2 unread pings below');
    });

    it('scrolling flips it: the DM tile goes above, the far tiles come into view', () => {
        mount([RAIL_DM_KEY, 'srv:c', 'srv:d']);
        scrollToY(650);   // c: 156..200, d: 206..250 visible; DM at -644
        expect(down()).toBeNull();
        expect(up()!.getAttribute('aria-label')).toBe('1 unread ping above');
    });

    it('no pinged tiles: no arrows at all (positive control for the two above)', () => {
        mount([]);
        scrollToY(650);
        expect(up()).toBeNull();
        expect(down()).toBeNull();
    });

    it('clicking the up arrow smooth-scrolls to the NEAREST pinged tile above, clear of the pill', () => {
        mount(['srv:a', 'srv:b']);
        scrollToY(700);   // a at -594, b at -244: both above; b is nearest
        expect(up()!.textContent).toBe('2');
        act(() => { up()!.click(); });
        expect(scrollToSpy).toHaveBeenCalledWith({ top: 700 - 244 - PING_REVEAL_MARGIN, behavior: 'smooth' });
    });

    it('prefers-reduced-motion: the scroll is instant', () => {
        reduced = true;
        mount(['srv:d']);
        act(() => { down()!.click(); });
        expect(scrollToSpy).toHaveBeenCalledWith({ top: 856 + 44 - (H - PING_REVEAL_MARGIN), behavior: 'auto' });
    });

    it('the arrow goes away once the ping is revealed', () => {
        mount(['srv:d']);
        act(() => { down()!.click(); });
        act(() => { scroller().dispatchEvent(new Event('scroll')); });
        flushRaf();
        expect(down()).toBeNull();
    });

    it('keyboard activation moves focus to the revealed tile; appearing never takes focus', () => {
        mount(['srv:d']);
        expect(document.activeElement).toBe(document.body);
        // detail 0 = keyboard-synthesised click
        act(() => { down()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
        expect(document.activeElement?.textContent).toBe('srv:d');
    });

    it('announces a NEW off-screen ping once, politely; a user scroll is not announced', () => {
        mount([]);
        expect(live().getAttribute('aria-live')).toBe('polite');
        scrollToY(0);
        expect(live().textContent).toBe('');
        render(['srv:c']);
        flushRaf();
        expect(live().textContent).toBe('1 unread ping below in the server list');
    });

    it('a user scroll that hides a ping does NOT announce it', () => {
        mount([RAIL_DM_KEY]);
        scrollToY(650);
        expect(up()).not.toBeNull();
        expect(live().textContent).toBe('');
    });
});
