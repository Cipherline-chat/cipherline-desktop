// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    AppLoadingScreen, SURFACE_MS, REDUCED_MS, SLOW_MS, POINTER_WRITE_MS,
    type LoadingPhase, type LoadingStage,
} from './AppLoadingScreen';
import { SLOW_LABEL, STAGE_LABEL, __resetLoadingSession, seabedPaths } from './loadingScene';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The loading screen's contract with HydrationGate / App.tsx, and its perf
 * promises:
 *   - 'surfacing' calls onSurfaced exactly once, SURFACE_MS later (REDUCED_MS
 *     under reduced motion), whether it arrives by re-render or at mount;
 *   - the pointer never causes a React render (it writes CSS custom
 *     properties, coalesced to one write per animation frame);
 *   - every listener, rAF and timer is gone after unmount / once surfaced;
 *   - a calm "taking longer" line appears after SLOW_MS, counted across the
 *     App → HydrationGate handoff remount.
 */

let reduceMotion = false;
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;
let root: Root | null = null;
let host: HTMLDivElement;
let renders = 0;

const flushRaf = () => {
    const q = rafQueue;
    rafQueue = [];
    for (const { cb } of q) cb(performance.now());
};

const el = () => host.querySelector('.ls-root') as HTMLDivElement;
const look = () => host.querySelector('.ls-k-look') as HTMLDivElement;

function render(props: { phase?: LoadingPhase; stage?: LoadingStage; onSurfaced?: () => void } = {}) {
    act(() => {
        root!.render(
            React.createElement(React.Profiler, { id: 'ls', onRender: () => { renders++; } },
                React.createElement(AppLoadingScreen, props)),
        );
    });
}

function unmount() {
    act(() => { root?.unmount(); });
    root = null;
}

function move(x: number, y: number) {
    el().dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    __resetLoadingSession();
    reduceMotion = false;
    rafQueue = [];
    renders = 0;
    window.matchMedia = ((q: string) => ({
        matches: reduceMotion && q.includes('reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
        const id = ++rafSeq;
        rafQueue.push({ id, cb });
        return id;
    });
    window.cancelAnimationFrame = vi.fn((id: number) => {
        rafQueue = rafQueue.filter(r => r.id !== id);
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    if (root) unmount();
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('surfacing contract', () => {
    it('fires onSurfaced once, SURFACE_MS after the phase flips', () => {
        const onSurfaced = vi.fn();
        render({ phase: 'loading', onSurfaced });
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onSurfaced).not.toHaveBeenCalled();

        render({ phase: 'surfacing', onSurfaced });
        expect(el().classList.contains('is-surfacing')).toBe(true);
        act(() => { vi.advanceTimersByTime(SURFACE_MS - 1); });
        expect(onSurfaced).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);

        // A later re-render (new callback identity) must not fire it again.
        render({ phase: 'surfacing', onSurfaced: () => onSurfaced() });
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('fires when mounted already surfacing', () => {
        const onSurfaced = vi.fn();
        render({ phase: 'surfacing', onSurfaced });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('calls the LATEST onSurfaced', () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ phase: 'surfacing', onSurfaced: first });
        render({ phase: 'surfacing', onSurfaced: second });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('uses the short cross-fade under reduced motion', () => {
        reduceMotion = true;
        const onSurfaced = vi.fn();
        render({ phase: 'surfacing', onSurfaced });
        act(() => { vi.advanceTimersByTime(REDUCED_MS - 1); });
        expect(onSurfaced).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
        expect(REDUCED_MS).toBeLessThan(SURFACE_MS);
    });

    it('leaves no timer or frame callback running once surfaced', () => {
        const onSurfaced = vi.fn();
        render({ phase: 'loading', onSurfaced });
        move(900, 900); // leaves a pending rAF
        render({ phase: 'surfacing', onSurfaced });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(rafQueue).toHaveLength(0);
    });
});

describe('pointer', () => {
    it('never re-renders React, and coalesces moves to one write per frame', () => {
        render();
        const before = renders;
        // inside act() so any state update the handlers made would be flushed
        // (and counted) before the assertion — outside it, React defers them
        act(() => { for (let i = 0; i < 25; i++) move(500 + i * 20, 460 + i * 10); });
        expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
        act(() => { flushRaf(); });
        expect(renders).toBe(before);
        // last position wins: x = 980 → mx = (980 - 500) / 500
        expect(Number(look().style.getPropertyValue('--mx'))).toBeCloseTo(0.96, 2);
        expect(Number(look().style.getPropertyValue('--my'))).toBeCloseTo((700 - 460) / 540, 2);

        // A burst right after a write waits out POINTER_WRITE_MS (one timer,
        // then one frame) instead of writing every frame.
        act(() => { for (let i = 0; i < 10; i++) move(100, 100); });
        expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(2); // the throttle + the slow-hint timer
        act(() => { vi.advanceTimersByTime(POINTER_WRITE_MS); });
        expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2);
        act(() => { flushRaf(); });
        expect(Number(look().style.getPropertyValue('--mx'))).toBeCloseTo(-0.8, 2);
        expect(renders).toBe(before);
    });

    it('writes the values only onto the elements that follow the pointer', () => {
        render();
        move(900, 900);
        flushRaf();
        const followers = Array.from(host.querySelectorAll<HTMLElement>('.ls-p'));
        expect(followers.length).toBe(6);
        for (const f of followers) expect(f.style.getPropertyValue('--mx')).toBe('0.80');
        // Never on the root, and never on an element running a keyframe loop:
        // an (inherited) change there re-syncs every compositor animation.
        expect(el().style.getPropertyValue('--mx')).toBe('');
        for (const sel of ['.ls-k-bob', '.ls-k-leg', '.ls-k-dome', '.ls-k-blink', '.ls-orbit-spin', '.ls-bub', '.ls-k-pos']) {
            for (const n of Array.from(host.querySelectorAll<HTMLElement>(sel))) {
                expect(n.classList.contains('ls-p')).toBe(false);
                expect(n.style.getPropertyValue('--mx')).toBe('');
            }
        }
    });

    it('carries the last pointer position across the handoff remount', () => {
        render();
        move(900, 900);
        flushRaf();
        unmount();
        root = createRoot(host);
        render({ stage: 'sync' });
        expect(look().style.getPropertyValue('--mx')).toBe('0.80');
    });

    it('throttles bursts to one write per POINTER_WRITE_MS, and fires nothing else', () => {
        render();
        // 2 s of a 60 Hz pointer: one move per 16 ms, frames flushed as they come
        for (let t = 0; t < 2000; t += 16) {
            move(100 + (t % 800), 300);
            act(() => { vi.advanceTimersByTime(16); });
            flushRaf();
        }
        const frames = (window.requestAnimationFrame as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
        expect(frames).toBeLessThanOrEqual(Math.ceil(2000 / POINTER_WRITE_MS) + 1);
        expect(frames).toBeGreaterThanOrEqual(Math.floor(2000 / POINTER_WRITE_MS) - 1);
    });

    it('sets proximity from the distance to Keys', () => {
        render();
        move(500, 460); // on top of him
        flushRaf();
        expect(Number(look().style.getPropertyValue('--md'))).toBe(1);
        act(() => { vi.advanceTimersByTime(POINTER_WRITE_MS); });
        move(0, 0); // far away
        act(() => { vi.advanceTimersByTime(POINTER_WRITE_MS); });
        flushRaf();
        expect(Number(look().style.getPropertyValue('--md'))).toBe(0);
    });

    it('drifts home when the pointer leaves', () => {
        render();
        move(900, 900);
        flushRaf();
        expect(look().style.getPropertyValue('--mx')).not.toBe('0.00');
        move(950, 950); // a pending throttled write must not land after the leave
        el().dispatchEvent(new MouseEvent('pointerleave'));
        expect(look().style.getPropertyValue('--mx')).toBe('0.00');
        expect(look().style.getPropertyValue('--my')).toBe('0.00');
        act(() => { vi.advanceTimersByTime(POINTER_WRITE_MS); });
        flushRaf();
        expect(look().style.getPropertyValue('--mx')).toBe('0.00');
    });

    it('hops on click without rendering, restarting via alternating classes', () => {
        render();
        const before = renders;
        const boop = host.querySelector('.ls-k-boop')!;
        act(() => { el().dispatchEvent(new MouseEvent('pointerdown')); });
        expect(boop.classList.contains('ls-boop-a')).toBe(true);
        act(() => { el().dispatchEvent(new MouseEvent('pointerdown')); });
        expect(boop.classList.contains('ls-boop-b')).toBe(true);
        expect(boop.classList.contains('ls-boop-a')).toBe(false);
        expect(renders).toBe(before);
    });

    it('removes every listener and cancels the pending frame on unmount', () => {
        type Call = { target: unknown; type: string; fn: unknown };
        const ours = (spy: { mock: { calls: unknown[][]; contexts: unknown[] } }): Call[] =>
            spy.mock.calls
                .map((c, i) => ({ target: spy.mock.contexts[i], type: String(c[0]), fn: c[1] }))
                .filter(c => (c.target === window || c.target === el()) && /pointer|resize/.test(c.type));
        // jsdom's window has its own addEventListener, so spy on both paths.
        const addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
        const winAdd = vi.spyOn(window, 'addEventListener');
        render();
        const rootEl = el();
        const added = [...ours(addSpy), ...ours(winAdd)];
        expect(added.map(c => c.type).sort()).toEqual(['pointerdown', 'pointerleave', 'pointermove', 'resize']);

        rootEl.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
        expect(rafQueue).toHaveLength(1);
        flushRaf();
        rootEl.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 20 })); // throttle timer pending
        act(() => { vi.advanceTimersByTime(POINTER_WRITE_MS); }); // ...now a frame is pending
        expect(rafQueue).toHaveLength(1);

        const remSpy = vi.spyOn(EventTarget.prototype, 'removeEventListener');
        const winRem = vi.spyOn(window, 'removeEventListener');
        unmount();
        const removed = [remSpy, winRem].flatMap(sp => sp.mock.calls.map((c, i) => ({ target: sp.mock.contexts[i], type: String(c[0]), fn: c[1] })));
        // every listener we added is removed from the same target, same handler
        for (const a of added) {
            expect(removed.some(r => r.target === a.target && r.type === a.type && r.fn === a.fn)).toBe(true);
        }
        expect(window.cancelAnimationFrame).toHaveBeenCalled();
        expect(rafQueue).toHaveLength(0);
        // events on the detached node do nothing
        rootEl.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
        expect(rafQueue).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops following the pointer once surfacing', () => {
        render();
        render({ phase: 'surfacing' });
        move(900, 900);
        expect(rafQueue).toHaveLength(0);
    });

    it('attaches no pointer listeners at all under reduced motion', () => {
        reduceMotion = true;
        const addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
        const winAdd = vi.spyOn(window, 'addEventListener');
        render();
        expect([...addSpy.mock.calls, ...winAdd.mock.calls].filter(c => /pointer|resize/.test(String(c[0])))).toHaveLength(0);
        move(900, 900);
        expect(rafQueue).toHaveLength(0);
    });
});

describe('status line', () => {
    it('names the stage it was given, and is generic by default', () => {
        render();
        expect(host.textContent).toContain(STAGE_LABEL.start);
        render({ stage: 'sync' });
        expect(host.textContent).toContain(STAGE_LABEL.sync);
        expect(host.querySelector('[role="status"]')!.textContent).toContain(STAGE_LABEL.sync);
    });

    it('turns calm-slow after SLOW_MS, and announces it', () => {
        render({ stage: 'sync' });
        act(() => { vi.advanceTimersByTime(SLOW_MS - 1); });
        expect(el().classList.contains('is-slow')).toBe(false);
        act(() => { vi.advanceTimersByTime(1); });
        expect(el().classList.contains('is-slow')).toBe(true);
        expect(host.querySelector('[role="status"]')!.textContent).toContain(SLOW_LABEL);
    });

    it('cancels the slow timer when surfacing starts', () => {
        render();
        render({ phase: 'surfacing' });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(vi.getTimerCount()).toBe(0);
        act(() => { vi.advanceTimersByTime(SLOW_MS); });
        expect(el().classList.contains('is-slow')).toBe(false);
    });

    it('keeps counting across the App → HydrationGate handoff remount', () => {
        render({ stage: 'auth' });
        act(() => { vi.advanceTimersByTime(5000); });
        unmount();
        root = createRoot(host);
        render({ stage: 'sync' });
        // continues mid-stride rather than restarting every loop
        expect(parseFloat(el().style.getPropertyValue('--ls-el'))).toBeCloseTo(5, 1);
        act(() => { vi.advanceTimersByTime(SLOW_MS - 5000); });
        expect(el().classList.contains('is-slow')).toBe(true);
    });

    it('starts a fresh wait when the previous screen is long gone', () => {
        render();
        act(() => { vi.advanceTimersByTime(5000); });
        unmount();
        act(() => { vi.advanceTimersByTime(60_000); });
        root = createRoot(host);
        render();
        expect(parseFloat(el().style.getPropertyValue('--ls-el'))).toBe(0);
        act(() => { vi.advanceTimersByTime(SLOW_MS - 1000); });
        expect(el().classList.contains('is-slow')).toBe(false);
    });
});

describe('plankton strips', () => {
    it('loops seamlessly: every dot appears twice, exactly half a strip apart', () => {
        render();
        const strips = Array.from(host.querySelectorAll<HTMLElement>('.ls-strip'));
        expect(strips.length).toBe(9); // a handful of loops, not one per dot
        for (const st of strips) {
            const tops = Array.from(st.querySelectorAll<HTMLElement>('.ls-bub')).map(b => parseFloat(b.style.top));
            expect(tops.length % 2).toBe(0);
            const upper = tops.filter(t => t < 50).sort((a, b) => a - b);
            const lower = tops.filter(t => t >= 50).map(t => t - 50).sort((a, b) => a - b);
            expect(lower).toEqual(upper);
        }
    });
});

describe('seabed', () => {
    it('is a handful of static paths, built once', () => {
        const a = seabedPaths();
        expect(a).toBe(seabedPaths()); // memoised: no work on the handoff remount
        expect(a.length).toBeGreaterThan(3);
        expect(a.length).toBeLessThan(40);
        for (const p of a) {
            expect(p.opacity).toBeGreaterThan(0);
            expect(p.opacity).toBeLessThanOrEqual(1);
            expect(p.d.startsWith('M')).toBe(true);
        }
        render();
        expect(host.querySelectorAll('.ls-floor path').length).toBe(a.length);
    });
});
