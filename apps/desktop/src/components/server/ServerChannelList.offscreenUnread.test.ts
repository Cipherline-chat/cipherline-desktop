// @vitest-environment jsdom
/**
 * The off-screen unread pill, end to end through the REAL ServerChannelList:
 * the badge rows, the collapsed-category header, the pills, the click → scroll
 * target, the pulse, keyboard activation, reduced motion.
 *
 * jsdom does no layout, so geometry is faked from document order: every
 * `.group` element in the scroller (channel rows and category headers) is one
 * 30 px slot, the viewport is 300 px. That is enough to drive the real
 * measure → classify → render → click → scroll loop; the pixel-level look is
 * checked in a real browser by harness/offscreen-unread-drive.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ServerChannelList from './ServerChannelList';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../../hooks/useServers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 30;
const VIEWPORT = 300;

// Installed via vi.hoisted: clPhysics (pulled in by the component tree) reads
// matchMedia at import time, before any beforeEach could run.
const media = vi.hoisted(() => {
    const state = { reduced: false };
    window.matchMedia = ((q: string) => ({
        matches: state.reduced && q.includes('prefers-reduced-motion'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return state;
});

// ── fake layout ─────────────────────────────────────────────────────────────
let scroller: HTMLElement | null = null;
let scrollTopValue = 0;
const scrollToCalls: Array<{ top: number; behavior?: string }> = [];

function slots(): HTMLElement[] { return scroller ? [...scroller.querySelectorAll<HTMLElement>('.group')] : []; }
const contentHeight = () => Math.max(slots().length * ROW + 16, VIEWPORT);

function installLayout() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this === scroller) return { top: 0, bottom: VIEWPORT, left: 0, right: 200, width: 200, height: VIEWPORT, x: 0, y: 0, toJSON() {} } as DOMRect;
        const i = slots().indexOf(this as HTMLElement);
        if (i < 0) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
        const top = i * ROW - scrollTopValue;
        return { top, bottom: top + ROW, left: 0, right: 200, width: 200, height: ROW, x: 0, y: top, toJSON() {} } as DOMRect;
    });
}

function attachScrollerGeometry(el: HTMLElement) {
    scroller = el;
    scrollTopValue = 0;
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => scrollTopValue, set: (v: number) => { scrollTopValue = v; } });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: contentHeight });
    (el as unknown as { scrollTo: unknown }).scrollTo = (opts: ScrollToOptions) => {
        scrollToCalls.push({ top: opts.top ?? 0, behavior: opts.behavior });
        scrollTopValue = Math.min(Math.max(0, opts.top ?? 0), contentHeight() - VIEWPORT);
        el.dispatchEvent(new Event('scroll'));
    };
}

// rAF is a macrotask here so it stays asynchronous like the real one (the hook
// coalesces scroll events on it); `frame()` waits it out inside act().
const frame = () => act(async () => { await new Promise(r => setTimeout(r, 5)); });
beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    media.reduced = false;
    installLayout();
    scrollToCalls.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// ── fixture: 25 text channels — 4 uncategorized, 3 categories (7 / 7 / 7) ───
const SERVER = {
    server_id: 's1', name: 'Test', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'u1', created_at: '',
} as ServerInfo;

const mkChannel = (id: string, position: number, cat: string | null): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind: 'text', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: cat, active_call_session_id: null, member_limit: null, max_calls: null,
});
const CATS: CategoryInfo[] = ['catA', 'catB', 'catC'].map((id, i) => ({
    category_id: id, server_id: 's1', name: id, position: i, kind: 'text', icon_name: null,
}));
const CHANNELS: ChannelInfo[] = [];
for (let i = 0; i < 4; i++) CHANNELS.push(mkChannel(`g${i}`, i, null));
['catA', 'catB', 'catC'].forEach((cat, ci) => {
    for (let i = 0; i < 7; i++) CHANNELS.push(mkChannel(`${cat}-${i}`, 10 + ci * 10 + i, cat));
});

type Props = Partial<React.ComponentProps<typeof ServerChannelList>>;

let host: HTMLDivElement;
let root: Root;

async function mount(props: Props) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(ServerChannelList, {
            server: SERVER, channels: CHANNELS, categories: CATS, loading: false,
            activeChannelId: null, onSelectChannel: () => {}, token: null, userId: null,
            ...props,
        }));
    });
    const list = host.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    attachScrollerGeometry(list);
    // measure now that geometry exists (ResizeObserver does this in a browser)
    await act(async () => { list.dispatchEvent(new Event('scroll')); });
    await frame();
    return list;
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); scroller = null; });

const pill = (dir: 'above' | 'below') => host.querySelector<HTMLButtonElement>(`[data-unread-pill="${dir}"]`);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await frame(); };
const scrollTo = async (top: number) => {
    await act(async () => {
        scrollTopValue = top;
        scroller!.dispatchEvent(new Event('scroll'));
    });
    await frame();
};

// Slot index of a channel = its position in the rendered list:
//  g0..g3 = 0..3, catA header = 4, catA-0..6 = 5..11, catB header = 12, catB-0..6 = 13..19, catC header = 20, catC-0..6 = 21..27
const slotOf = (id: string) => slots().findIndex(el => el.textContent?.startsWith(id));

describe('ServerChannelList off-screen unread pill', () => {
    it('shows a "New unreads" pill at the bottom, and none at the top, when an unread is below the fold', async () => {
        await mount({ unreadCounts: { 'catC-5': 3 } });
        const below = pill('below')!;
        expect(below).not.toBeNull();
        expect(below.textContent).toBe('New unreads');
        expect(below.dataset.tone).toBe('unread');
        expect(below.getAttribute('aria-label')).toBe('Jump to next unread channel below');
        expect(pill('above')).toBeNull();
    });

    it('negative control: no unreads anywhere → no pill', async () => {
        await mount({});
        expect(pill('below')).toBeNull();
        expect(pill('above')).toBeNull();
    });

    it('negative control: unreads that are already in view → no pill', async () => {
        await mount({ unreadCounts: { g1: 2, g2: 1 } });
        expect(pill('below')).toBeNull();
    });

    it('the open channel does not count', async () => {
        await mount({ unreadCounts: { 'catC-5': 3 }, activeChannelId: 'catC-5' });
        expect(pill('below')).toBeNull();
    });

    it('a muted channel\'s plain unread does not count, its mention does', async () => {
        await mount({ unreadCounts: { 'catC-5': 3 }, mutedChannelIds: new Set(['catC-5']) });
        expect(pill('below')).toBeNull();
        await act(async () => root.unmount()); host.remove();
        await mount({ unreadCounts: { 'catC-5': 3 }, mentionCounts: { 'catC-5': 1 }, mutedChannelIds: new Set(['catC-5']) });
        expect(pill('below')!.dataset.tone).toBe('mention');
    });

    it('mentions flip it to the red "N mentions" style with the summed count', async () => {
        await mount({ unreadCounts: { 'catC-1': 2 }, mentionCounts: { 'catB-3': 1, 'catC-5': 1 } });
        const below = pill('below')!;
        expect(below.dataset.tone).toBe('mention');
        expect(below.textContent).toBe('2 mentions');
        expect(below.getAttribute('aria-label')).toBe('Jump to next unread channel below, 2 mentions');
    });

    it('"@mentions only" server: a plain unread gets the quiet (grey) pill', async () => {
        await mount({ unreadCounts: { 'catC-5': 3 }, serverNotifMode: 'mentions' });
        expect(pill('below')!.dataset.tone).toBe('quiet');
    });

    it('both pills at once when unreads are above AND below', async () => {
        await mount({ unreadCounts: { g0: 1, 'catC-6': 1 } });
        await scrollTo(200);                 // g0 (slot 0, centre 15) is now above the fold
        expect(pill('above')!.textContent).toBe('New unreads');
        expect(pill('below')!.textContent).toBe('New unreads');
    });

    it('clicking steps to the NEAREST off-screen unread, centred, with a pulse; the next click goes to the next one', async () => {
        await mount({ unreadCounts: { 'catB-2': 1, 'catC-4': 1, 'catC-6': 1 } });
        await click(pill('below')!);
        // first target: catB-2 (nearest below)
        const first = slotOf('catB-2');
        expect(scrollToCalls[0]).toEqual({ top: Math.round(first * ROW + ROW / 2 - VIEWPORT / 2), behavior: 'smooth' });
        const row1 = slots()[first];
        expect(row1.classList.contains('cl-unread-pulse')).toBe(true);

        // it is in view now; the pill still points at the remaining ones
        expect(pill('below')).not.toBeNull();
        await click(pill('below')!);
        const second = slotOf('catC-4');
        expect(scrollToCalls[1].top).toBe(Math.min(contentHeight() - VIEWPORT, Math.round(second * ROW + ROW / 2 - VIEWPORT / 2)));
        expect(slots()[second].classList.contains('cl-unread-pulse')).toBe(true);
    });

    it('the pill disappears once nothing is left that way', async () => {
        await mount({ unreadCounts: { 'catC-6': 1 } });
        await click(pill('below')!);
        expect(pill('below')).toBeNull();
    });

    it('stepping up works the same', async () => {
        await mount({ unreadCounts: { g0: 1, g1: 1 } });
        await scrollTo(400);
        await click(pill('above')!);
        // nearest above is g1 (slot 1)
        expect(scrollToCalls[0].top).toBe(Math.max(0, Math.round(1 * ROW + ROW / 2 - VIEWPORT / 2)));
        expect(slots()[1].classList.contains('cl-unread-pulse')).toBe(true);
    });

    describe('reduced motion', () => {
        it('scrolls instantly and does not pulse', async () => {
            media.reduced = true;
            await mount({ unreadCounts: { 'catC-5': 3 } });
            await click(pill('below')!);
            expect(scrollToCalls).toHaveLength(1);
            expect(scrollToCalls[0].behavior).toBe('instant');
            expect(host.querySelector('.cl-unread-pulse')).toBeNull();
        });

        it('negative control: without it the same click is smooth and pulses', async () => {
            await mount({ unreadCounts: { 'catC-5': 3 } });
            await click(pill('below')!);
            expect(scrollToCalls[0].behavior).toBe('smooth');
            expect(host.querySelector('.cl-unread-pulse')).not.toBeNull();
        });
    });

    describe('keyboard', () => {
        it('the pill is a real, focusable <button> (Enter / Space activate it natively), labelled for screen readers', async () => {
            await mount({ unreadCounts: { 'catC-5': 3 } });
            const b = pill('below')!;
            expect(b.tagName).toBe('BUTTON');
            expect(b.type).toBe('button');
            expect(b.disabled).toBe(false);
            expect(b.tabIndex).toBeGreaterThanOrEqual(0);
            expect(b.getAttribute('aria-label')).toBeTruthy();
            b.focus();
            expect(document.activeElement).toBe(b);
        });

        it('activating it from the keyboard scrolls, and focus moves to the list if the pill goes away', async () => {
            const list = await mount({ unreadCounts: { 'catC-6': 1 } });
            const b = pill('below')!;
            b.focus();
            await click(b);
            expect(scrollToCalls).toHaveLength(1);
            expect(pill('below')).toBeNull();
            expect(document.activeElement).toBe(list);
        });
    });

    describe('collapsed categories', () => {
        it('a collapsed category hiding an unread is represented by its header: the header is the anchor, the pill counts it', async () => {
            // Collapse is read from secureLocalStore at mount; drive it via the header click instead.
            await mount({ userId: 'me', unreadCounts: { 'catC-2': 1 }, mentionCounts: { 'catC-4': 2 } });
            expect(pill('below')!.textContent).toBe('2 mentions');
            // collapse catC by clicking its header (the user tidying their list)
            const header = slots().find(el => el.textContent?.startsWith('catC'))!;
            await act(async () => { header.click(); });
            await frame();
            expect(host.querySelector('[data-unread-anchor="cat:catC"]')).not.toBeNull();
            expect(host.querySelector('[data-unread-anchor="ch:catC-2"]')).toBeNull();
            // still pilled: the unread did not become invisible to the pill because of the collapse
            expect(pill('below')!.textContent).toBe('2 mentions');
        });

        it('clicking the pill expands the category and lands on its first unread channel', async () => {
            await mount({ userId: 'me', unreadCounts: { 'catC-2': 1 }, mentionCounts: { 'catC-4': 2 } });
            const header = slots().find(el => el.textContent?.startsWith('catC'))!;
            await act(async () => { header.click(); });
            expect(host.querySelector('[data-unread-anchor="ch:catC-2"]')).toBeNull();

            await click(pill('below')!);
            // expanded: its channel rows are back
            const row = host.querySelector<HTMLElement>('[data-unread-anchor="ch:catC-2"]');
            expect(row).not.toBeNull();
            // and the jump landed on the FIRST unread channel in it (catC-2), pulsed
            expect(scrollToCalls.length).toBe(1);
            expect(row!.classList.contains('cl-unread-pulse')).toBe(true);
        });
    });
});
