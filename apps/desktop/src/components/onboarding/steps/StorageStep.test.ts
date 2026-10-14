// @vitest-environment jsdom
/**
 * The storage step's chart: handle alignment, the intro animation, the drag
 * tooltip and the (unchanged) keyboard slider. jsdom has no layout engine, so
 * what is asserted here is the CONTRACT between StorageStep.tsx and
 * storage.css (class names, the inline widths/lefts/delays, state attributes);
 * the pixels are verified separately in real Chromium (screenshots).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StorageStep } from './StorageStep';
import { LANES, RULER_STOPS, introLeadMs, positionOf, presetRetention, retentionToChoice } from './storageModel';
import type { StepProps } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// OnboardingFlow (for StepActions) pulls in clPhysics, which calls matchMedia at import time.
vi.hoisted(() => {
    window.matchMedia ??= ((q: string) => ({
        matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});
const h = React.createElement;

const CSS = fs.readFileSync(path.resolve(__dirname, 'storage.css'), 'utf8');

// ── rAF control: the intro is a double requestAnimationFrame ────────────────
let frames: FrameRequestCallback[] = [];
function flushFrame() {
    const run = frames;
    frames = [];
    act(() => { run.forEach(cb => cb(0)); });
}

function stubDeps(status: 'prompt' | 'done' = 'prompt') {
    const complete = vi.fn();
    const deps = {
        deviceStorage: { status, complete },
        retention: { policy: {} },
    } as unknown as StepProps['deps'];
    return { deps, complete };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(over: Partial<StepProps> = {}, hostInit?: (h: HTMLElement) => void) {
    const { deps, complete } = stubDeps();
    host = document.createElement('div');
    hostInit?.(host);
    document.body.appendChild(host);
    root = createRoot(host);
    const props = {
        deps, flow: {}, setFlow: () => {}, reducedMotion: false, dots: null, showDots: () => {},
        onNext: () => {}, onBack: undefined, direction: 1, ...over,
    } as unknown as StepProps;
    act(() => root!.render(h(StorageStep, props)));
    return { host, complete };
}

beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { if (id > 0 && id <= frames.length) frames[id - 1] = () => {}; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const lane = (el: HTMLElement, l: string) => el.querySelector<HTMLElement>(`.st-lane[data-lane="${l}"]`)!;
const bar = (el: HTMLElement, l: string, k: 'm' | 'f') => lane(el, l).querySelector<HTMLElement>(`.st-bar--${k}`)!;
const handle = (el: HTMLElement, l: string, k: 'msg' | 'file') => lane(el, l).querySelector<HTMLButtonElement>(`.st-rh--${k}`)!;
const root$ = (el: HTMLElement) => el.querySelector<HTMLElement>('.st-rc')!;

// ── 1. the class names the CSS targets ──────────────────────────────────────
describe('handle class names match the stylesheet', () => {
    it('every handle carries .st-rh--msg or .st-rh--file, and storage.css styles both', () => {
        const { host: el } = mount();
        for (const l of LANES) {
            expect(handle(el, l, 'msg')).not.toBeNull();
            expect(handle(el, l, 'file')).not.toBeNull();
        }
        expect(el.querySelectorAll('.st-rh')).toHaveLength(6);
        // the selectors really exist in the CSS, each with its own vertical centre
        expect(CSS).toMatch(/\.ob \.st-rh--msg\s*\{[^}]*--cy:\s*14px/);
        expect(CSS).toMatch(/\.ob \.st-rh--file\s*\{[^}]*--cy:\s*29px/);
    });

    it('NEGATIVE CONTROL: the old selectors (.st-rh--m / .st-rh--f) are gone, and would not have matched the DOM', () => {
        expect(CSS).not.toMatch(/\.st-rh--m(?![a-z])/);
        expect(CSS).not.toMatch(/\.st-rh--f(?![a-z])/);
        const { host: el } = mount();
        expect(el.querySelector('.st-rh--m')).toBeNull();   // the typo'd class the old CSS targeted
        expect(el.querySelector('.st-rh--f')).toBeNull();
    });

    it('the handle centres match the bar centres (14px / 29px) the bars are laid out at', () => {
        expect(CSS).toMatch(/\.st-bar--m\s*\{[^}]*top:\s*9px;\s*height:\s*10px/);   // centre 14
        expect(CSS).toMatch(/\.st-bar--f\s*\{[^}]*top:\s*26px;\s*height:\s*6px/);   // centre 29
        expect(CSS).toMatch(/\.st-rh\s*\{[^}]*top:\s*var\(--cy\)/);
        expect(CSS).toMatch(/\.st-rh\s*\{[^}]*translate\(-50%,\s*-50%\)/);
    });
});

// ── 2. handle position == bar width ─────────────────────────────────────────
describe('handle left == bar width at every value', () => {
    function expectAligned(el: HTMLElement) {
        for (const l of LANES) {
            expect(handle(el, l, 'msg').style.left).toBe(bar(el, l, 'm').style.width);
            expect(handle(el, l, 'file').style.left).toBe(bar(el, l, 'f').style.width);
        }
    }
    function settle(el: HTMLElement) {
        flushFrame(); flushFrame();
        act(() => { vi.advanceTimersByTime(1400); });
        void el;
    }

    it('holds for every preset, including Forever (the ∞ stop = 100%)', () => {
        const { host: el } = mount({ reducedMotion: true });
        const hits = new Set<string>();
        for (const p of ['rec', 'all', 'less'] as const) {
            // drive the real preset buttons
            const btn = Array.from(el.querySelectorAll<HTMLButtonElement>('.st-seg button')).find(b => b.getAttribute('role') === 'radio' && b.textContent === { rec: 'Recommended', all: 'Keep everything', less: 'Keep less' }[p])!;
            act(() => { btn.click(); });
            expectAligned(el);
            for (const l of LANES) { hits.add(bar(el, l, 'm').style.width); hits.add(bar(el, l, 'f').style.width); }
        }
        expect(hits.has('100%')).toBe(true);                        // Forever reached
        expect(hits.size).toBeGreaterThanOrEqual(5);                // and several distinct values
        // the handle sits EXACTLY on the ∞ stop (no 0.985 clamp)
        const all = Array.from(hits).map(parseFloat);
        expect(Math.max(...all)).toBe(100);
    });

    it('holds after each keyboard step along the whole file range', () => {
        const { host: el } = mount({ reducedMotion: true });
        const hd = handle(el, 'dm', 'file');
        act(() => { hd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
        const seen: string[] = [];
        for (let i = 0; i <= RULER_STOPS; i++) {
            expectAligned(el);
            seen.push(bar(el, 'dm', 'f').style.width);
            act(() => { hd.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        }
        // 24h..Forever = ruler positions 1..7, the widths are exactly position/7
        expect(seen.slice(0, 7).map(parseFloat)).toEqual([1, 2, 3, 4, 5, 6, 7].map(n => (n / RULER_STOPS) * 100));
    });

    it('also holds during the intro (pre: both 0%, run: both at the value)', () => {
        const { host: el } = mount();
        expectAligned(el);
        expect(handle(el, 'dm', 'msg').style.left).toBe('0%');
        flushFrame(); flushFrame();
        expectAligned(el);
        expect(handle(el, 'dm', 'msg').style.left).not.toBe('0%');
        settle(el);
        expectAligned(el);
    });

    it('NEGATIVE CONTROL: a misaligned handle would be caught by this comparison', () => {
        const { host: el } = mount({ reducedMotion: true });
        const hd = handle(el, 'dm', 'msg');
        act(() => { hd.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
        expect(bar(el, 'dm', 'm').style.width).toBe('100%');
        expect(hd.style.left).toBe('100%');                          // aligned at Forever...
        hd.style.left = '98.5%';                                     // ...the old 0.985 clamp is NOT
        expect(hd.style.left).not.toBe(bar(el, 'dm', 'm').style.width);
    });
});

// ── 3. intro ────────────────────────────────────────────────────────────────
describe('intro animation', () => {
    const widths = (el: HTMLElement) => LANES.flatMap(l => [bar(el, l, 'm').style.width, bar(el, l, 'f').style.width]);

    it('first render: every bar is 0 wide and the handles/labels are held back', () => {
        const { host: el } = mount();
        expect(root$(el).dataset.intro).toBe('pre');
        expect(widths(el)).toEqual(Array(6).fill('0%'));
        for (const hd of Array.from(el.querySelectorAll<HTMLElement>('.st-rh'))) expect(hd.style.left).toBe('0%');
    });

    it('stays at 0 after ONE frame (double rAF), grows after the second', () => {
        const { host: el } = mount();
        flushFrame();
        expect(root$(el).dataset.intro).toBe('pre');
        expect(widths(el)).toEqual(Array(6).fill('0%'));
        flushFrame();
        expect(root$(el).dataset.intro).toBe('run');
        const rec = presetRetention('rec');
        expect(widths(el)).not.toContain('0%');
        expect(bar(el, 'dm', 'm').style.width).toBe(`${(positionOf(rec.dm.msg) / RULER_STOPS) * 100}%`);
    });

    it('while running: messages first, files 120ms later, lanes 90ms apart; delays vanish when done', () => {
        const { host: el } = mount();
        flushFrame(); flushFrame();
        expect(bar(el, 'dm', 'm').style.transitionDelay).toBe('0ms');
        expect(bar(el, 'dm', 'f').style.transitionDelay).toBe('120ms');
        expect(bar(el, 'group', 'm').style.transitionDelay).toBe('90ms');
        expect(bar(el, 'group', 'f').style.transitionDelay).toBe('210ms');
        expect(bar(el, 'server', 'm').style.transitionDelay).toBe('180ms');
        expect(bar(el, 'server', 'f').style.transitionDelay).toBe('300ms');
        // handles trail their own bar's timing
        expect(handle(el, 'server', 'file').style.transitionDelay).toBe('300ms');
        // value labels follow their lane
        expect(lane(el, 'group').querySelector<HTMLElement>('.st-vals')!.style.transitionDelay).toBe('310ms');

        act(() => { vi.advanceTimersByTime(1299); });
        expect(root$(el).dataset.intro).toBe('run');
        act(() => { vi.advanceTimersByTime(2); });
        expect(root$(el).dataset.intro).toBe('done');
        for (const e of Array.from(el.querySelectorAll<HTMLElement>('.st-bar, .st-rh, .st-vals'))) expect(e.style.transitionDelay).toBe('');
    });

    it('the intro runs once: a preset change afterwards animates with no delays and no re-zeroing', () => {
        const { host: el } = mount();
        flushFrame(); flushFrame();
        act(() => { vi.advanceTimersByTime(1400); });
        const all = Array.from(el.querySelectorAll<HTMLButtonElement>('.st-seg button')).find(b => b.textContent === 'Keep everything')!;
        act(() => { all.click(); });
        expect(root$(el).dataset.intro).toBe('done');
        expect(bar(el, 'dm', 'm').style.width).toBe('100%');
        expect(bar(el, 'dm', 'm').style.transitionDelay).toBe('');
        expect(frames).toHaveLength(0);                              // no further rAF work
    });

    it('a touch during the intro ends it at once (no waiting on delays)', () => {
        const { host: el } = mount();
        flushFrame(); flushFrame();
        expect(root$(el).dataset.intro).toBe('run');
        const less = Array.from(el.querySelectorAll<HTMLButtonElement>('.st-seg button')).find(b => b.textContent === 'Keep less')!;
        act(() => { less.click(); });
        expect(root$(el).dataset.intro).toBe('done');
        expect(bar(el, 'dm', 'm').style.transitionDelay).toBe('');
    });

    it('reduced motion: no intro at all, bars are at their values on the first render', () => {
        const { host: el } = mount({ reducedMotion: true });
        expect(root$(el).dataset.intro).toBe('done');
        expect(widths(el)).not.toContain('0%');
        expect(frames).toHaveLength(0);                              // never even asked for a frame
        expect(bar(el, 'dm', 'm').style.transitionDelay).toBe('');
    });

    it('NEGATIVE CONTROL: without reduced motion the very same first render IS zero', () => {
        const a = mount({ reducedMotion: false });
        const zero = a.host.querySelector<HTMLElement>('.st-bar--m')!.style.width;
        act(() => root!.unmount()); a.host.remove();
        const b = mount({ reducedMotion: true });
        expect(zero).toBe('0%');
        expect(b.host.querySelector<HTMLElement>('.st-bar--m')!.style.width).not.toBe('0%');
    });

    it('the stylesheet hides the handles until the intro is done', () => {
        expect(CSS).toMatch(/\.st-rc:not\(\[data-intro="done"\]\) \.st-rh:not\(:focus-visible\)\s*\{[^}]*opacity:\s*0 !important/);
    });
});

describe('intro waits for the shell\'s own entrance fade', () => {
    // jsdom has no Web Animations: stub what the wizard's `ob-wiz-in` (300ms delay + 550ms fade) reports.
    const wizFade = (localTime: number, playState = 'running') => (h: HTMLElement) => {
        h.className = 'ob-wiz';
        (h as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [
            { playState, effect: { getComputedTiming: () => ({ endTime: 850, localTime }) } },
        ];
    };

    it('introLeadMs: remaining entrance minus the 300ms overlap, clamped, 0 when nothing is running', () => {
        const el = document.createElement('div');
        const inner = document.createElement('div');
        el.appendChild(inner);
        expect(introLeadMs(inner)).toBe(0);                       // no .ob-wiz at all (and no Web Animations in jsdom)
        expect(introLeadMs(null)).toBe(0);
        wizFade(0)(el);
        expect(introLeadMs(inner)).toBe(550);                     // 850 - 0 - 300
        wizFade(100)(el);
        expect(introLeadMs(inner)).toBe(450);
        wizFade(700)(el);
        expect(introLeadMs(inner)).toBe(0);                       // already mostly visible
        wizFade(0, 'finished')(el);
        expect(introLeadMs(inner)).toBe(0);                       // NEGATIVE CONTROL: a finished fade holds nothing back
    });

    it('holds the zero-width frame for the lead, then runs the usual double rAF', () => {
        const { host: el } = mount({}, wizFade(100));              // lead 450ms
        flushFrame(); flushFrame();
        expect(frames).toHaveLength(0);                           // nothing even asked for a frame yet
        expect(root$(el).dataset.intro).toBe('pre');
        act(() => { vi.advanceTimersByTime(449); });
        expect(frames).toHaveLength(0);
        act(() => { vi.advanceTimersByTime(2); });
        expect(frames).toHaveLength(1);
        flushFrame(); flushFrame();
        expect(root$(el).dataset.intro).toBe('run');
    });

    it('unmounting during the lead leaves no timer or frame behind', () => {
        mount({}, wizFade(0));
        act(() => root!.unmount());
        act(() => { vi.advanceTimersByTime(2000); });
        expect(frames).toHaveLength(0);
    });
});

// ── 4. tooltip while dragging ───────────────────────────────────────────────
describe('value tooltip while dragging', () => {
    const W = 700;
    function stubRect(track: HTMLElement) {
        track.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: 40, width: W, height: 40, x: 0, y: 0, toJSON: () => ({}) });
    }
    const ptr = (type: string, x: number, y: number) =>
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    const tip = (el: HTMLElement, l: string, k: 'msg' | 'file') => handle(el, l, k).querySelector<HTMLElement>('.st-tip')!;

    it('shows ABOVE-handle text on the messages handle only while it is dragged', () => {
        const { host: el } = mount({ reducedMotion: true });
        const track = lane(el, 'dm').querySelector<HTMLElement>('.st-track')!;
        stubRect(track);
        expect(tip(el, 'dm', 'msg').dataset.open).toBe('false');
        act(() => { track.dispatchEvent(ptr('pointerdown', (4 / 7) * W, 10)); });   // top half = messages, stop 4 = 3 months
        expect(handle(el, 'dm', 'msg').classList.contains('drag')).toBe(true);
        expect(tip(el, 'dm', 'msg').dataset.open).toBe('true');
        expect(tip(el, 'dm', 'msg').textContent).toBe('3 months');
        expect(tip(el, 'dm', 'file').dataset.open).toBe('false');
        expect(tip(el, 'group', 'msg').dataset.open).toBe('false');
        // it follows the value
        act(() => { track.dispatchEvent(ptr('pointermove', (6 / 7) * W, 10)); });
        expect(tip(el, 'dm', 'msg').textContent).toBe('1 year');
        act(() => { track.dispatchEvent(ptr('pointerup', (6 / 7) * W, 10)); });
        expect(tip(el, 'dm', 'msg').dataset.open).toBe('false');
        expect(handle(el, 'dm', 'msg').classList.contains('drag')).toBe(false);
    });

    it('the files handle says "<window> files"', () => {
        const { host: el } = mount({ reducedMotion: true });
        const track = lane(el, 'server').querySelector<HTMLElement>('.st-track')!;
        stubRect(track);
        act(() => { track.dispatchEvent(ptr('pointerdown', (3 / 7) * W, 30)); });   // bottom half = files, stop 3 = 1 month
        expect(tip(el, 'server', 'file').dataset.open).toBe('true');
        expect(tip(el, 'server', 'file').textContent).toBe('1 month files');
        expect(tip(el, 'server', 'msg').dataset.open).toBe('false');
        act(() => { track.dispatchEvent(ptr('pointerup', 0, 30)); });
    });

    it('the tip is decorative (aria-hidden) and placed above/below by the stylesheet', () => {
        const { host: el } = mount({ reducedMotion: true });
        expect(tip(el, 'dm', 'msg').getAttribute('aria-hidden')).toBe('true');
        expect(CSS).toMatch(/\.st-rh--msg \.st-tip\s*\{\s*bottom:/);
        expect(CSS).toMatch(/\.st-rh--file \.st-tip\s*\{\s*top:/);
        expect(CSS).toMatch(/\.st-tip\[data-open="true"\]/);
    });

    it('NEGATIVE CONTROL: no drag, no open tooltip anywhere', () => {
        const { host: el } = mount({ reducedMotion: true });
        expect(Array.from(el.querySelectorAll<HTMLElement>('.st-tip')).every(t => t.dataset.open === 'false')).toBe(true);
    });
});

// ── 5. keyboard slider behaviour is unchanged ───────────────────────────────
describe('keyboard slider', () => {
    const key = (hd: HTMLElement, k: string) => act(() => { hd.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

    it('role/aria wiring: slider with min/max/now/text', () => {
        const { host: el } = mount({ reducedMotion: true });
        const hd = handle(el, 'dm', 'msg');
        expect(hd.getAttribute('role')).toBe('slider');
        expect(hd.getAttribute('aria-valuemin')).toBe('2');       // 1 week
        expect(hd.getAttribute('aria-valuemax')).toBe('7');
        expect(hd.getAttribute('aria-valuenow')).toBe(String(positionOf(presetRetention('rec').dm.msg)));
        expect(hd.getAttribute('aria-valuetext')).toBeTruthy();
        expect(handle(el, 'dm', 'file').getAttribute('aria-valuemin')).toBe('1');   // 24 hours
    });

    it('arrows step one window, Home/End jump to the ends, other keys do nothing', () => {
        const { host: el } = mount({ reducedMotion: true });
        const hd = handle(el, 'group', 'msg');
        key(hd, 'Home');
        expect(hd.getAttribute('aria-valuenow')).toBe('2');
        expect(hd.getAttribute('aria-valuetext')).toBe('1 week');
        key(hd, 'ArrowRight');
        expect(hd.getAttribute('aria-valuenow')).toBe('3');
        key(hd, 'ArrowUp');
        expect(hd.getAttribute('aria-valuenow')).toBe('4');
        key(hd, 'ArrowLeft');
        key(hd, 'ArrowDown');
        expect(hd.getAttribute('aria-valuenow')).toBe('2');
        key(hd, 'ArrowLeft');                                       // clamped at the start
        expect(hd.getAttribute('aria-valuenow')).toBe('2');
        key(hd, 'End');
        expect(hd.getAttribute('aria-valuenow')).toBe('7');
        expect(hd.getAttribute('aria-valuetext')).toBe('Forever');
        key(hd, 'ArrowRight');                                      // clamped at the end
        expect(hd.getAttribute('aria-valuenow')).toBe('7');
        key(hd, 'a');                                               // negative control
        expect(hd.getAttribute('aria-valuenow')).toBe('7');
    });

    it('Continue saves the chosen retention through deviceStorage.complete', () => {
        const onNext = vi.fn();
        const { host: el, complete } = mount({ reducedMotion: true, onNext });
        key(handle(el, 'server', 'msg'), 'End');
        const next = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('Continue'))!;
        act(() => { next.click(); });
        const expected = presetRetention('rec');
        expected.server.msg = 'never';
        expect(complete).toHaveBeenCalledWith(retentionToChoice(expected), 'signup');
        expect(onNext).toHaveBeenCalledTimes(1);
    });
});

// ── 6. a11y / reduced-motion contract in the stylesheet ─────────────────────
describe('stylesheet contract', () => {
    it('keeps a focus-visible ring, an ew-resize cursor and a reduced-motion override', () => {
        expect(CSS).toMatch(/\.st-rh:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--c\)/);
        expect(CSS).toMatch(/\.st-rh\s*\{[^}]*cursor:\s*ew-resize/);
        expect(CSS).toMatch(/\.ob\.rm \.st-bar, \.ob\.rm \.st-rh, \.ob\.rm \.st-tip[^{]*\{\s*transition:\s*none/);
        expect(CSS).toMatch(/\.ob\.rm \.st-rh\s*\{\s*--sc:\s*1/);
        expect(CSS).toMatch(/prefers-reduced-motion: reduce/);
    });
    it('uses design tokens for the handle colours', () => {
        expect(CSS).toMatch(/--c:\s*var\(--lume\)/);
        expect(CSS).toMatch(/--c:\s*var\(--glow\)/);
    });
});
