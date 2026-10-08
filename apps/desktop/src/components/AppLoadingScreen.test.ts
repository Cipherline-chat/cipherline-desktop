// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    AppLoadingScreen, SURFACE_MS, REDUCED_MS, SLOW_MS,
    type LoadingPhase, type LoadingStage,
} from './AppLoadingScreen';
import {
    SLOW_LABEL, STAGE_LABEL, HANDOFF_MS, HINT_MS, OVER_GUARD_MS, __resetLoadingSession, isLeaving, showsReadyChip, progressBand, type GameState,
} from './loadingWait';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import type { FromWorker, ToWorker } from '../workers/loadingScreenProtocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The loading screen's contract with HydrationGate / App.tsx, and its perf
 * promises:
 *   - 'surfacing' calls onSurfaced exactly once, SURFACE_MS after the exit
 *     starts (REDUCED_MS under reduced motion) — HydrationGate only unmounts
 *     it, uncovering the Dashboard, when that fires — on every path: static
 *     fallback, no WebGL, worker crash, reduced motion;
 *   - a run of the easter-egg game is never cut short: once loaded mid-run,
 *     the screen waits for Enter, Esc or game over;
 *   - the main thread does no per-frame work: no rAF, the worker gets only
 *     sizes and input; the worker is parked across the handoff and
 *     terminated on the way out;
 *   - the stylesheet only ever animates transform/opacity.
 */

let reduceMotion = false;
let root: Root | null = null;
let host: HTMLDivElement;

const el = () => host.querySelector('.lo-root') as HTMLDivElement;

type Props = { phase?: LoadingPhase; stage?: LoadingStage; onSurfaced?: () => void; progress?: number };
function render(props: Props = {}, strict = false) {
    const node = React.createElement(AppLoadingScreen, props);
    act(() => { root!.render(strict ? React.createElement(React.StrictMode, null, node) : node); });
}
function unmount() {
    act(() => { root?.unmount(); });
    root = null;
}
function remount() {
    if (root) unmount();
    root = createRoot(host);
}

/* ── A fake worker (jsdom has neither Worker nor OffscreenCanvas) ─────────── */

class FakeWorker implements WorkerLike {
    sent: ToWorker[] = [];
    transfers: unknown[][] = [];
    terminated = false;
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(m: ToWorker, transfer?: Transferable[]) { this.sent.push(m); this.transfers.push(transfer ?? []); }
    terminate() { this.terminated = true; }
    /** Message types, leaving out the bar's layout and progress updates. */
    types() { return this.sent.map(m => m.type).filter(t => t !== 'bar' && t !== 'progress'); }
    progress() { return this.sent.flatMap(m => (m.type === 'progress' ? [m] : [])); }
    emit(m: FromWorker) { act(() => { this.onmessage?.({ data: m } as MessageEvent<FromWorker>); }); }
}
let workers: FakeWorker[] = [];
let transferCalls = 0;
const proto = HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: () => unknown };

/** Make the worker path available (OffscreenCanvas + a fake worker). */
function enableWorkers() {
    proto.transferControlToOffscreen = function () { transferCalls++; return { fake: 'offscreen' }; };
    __setLoadingWorkerFactory(() => { const w = new FakeWorker(); workers.push(w); return w; });
}
const lastWorker = () => workers[workers.length - 1];

function key(k: string, target: EventTarget = document.body, extra: KeyboardEventInit = {}) {
    const code = k === ' ' ? 'Space' : k;
    const ev = new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...extra });
    act(() => { target.dispatchEvent(ev); });
    return ev;
}

/** Mount with a live worker that has drawn its first frame, mid-run. */
function startPlaying(onSurfaced = vi.fn()) {
    enableWorkers();
    render({ phase: 'loading', stage: 'sync', onSurfaced });
    lastWorker().emit({ type: 'ok' });
    key(' ');
    lastWorker().emit({ type: 'game', mode: 'playing', score: 0, best: 0 });
    return { onSurfaced, w: lastWorker() };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    __resetLoadingSession();
    __resetLoadingWorkerHost();
    __setLoadingWorkerFactory('default');
    delete proto.transferControlToOffscreen;
    workers = [];
    transferCalls = 0;
    reduceMotion = false;
    window.matchMedia = ((q: string) => ({
        matches: reduceMotion && q.includes('reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.requestAnimationFrame = vi.fn(() => 0);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    if (root) unmount();
    host.remove();
    __resetLoadingWorkerHost();
    __setLoadingWorkerFactory('default');
    delete proto.transferControlToOffscreen;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/* ── The exit contract, on the static path (no OffscreenCanvas in jsdom) ── */

describe('surfacing contract (static fallback)', () => {
    it('falls back to the static mark when there is no OffscreenCanvas', () => {
        render({ onSurfaced: vi.fn() });
        expect(el().classList.contains('is-static')).toBe(true);
        expect(host.querySelector('svg.lo-mark')).not.toBeNull();
        expect(host.querySelector('canvas')).toBeNull();
        expect(host.querySelector('.lo-hint')).toBeNull(); // no dots, no game
    });

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

    it('calls the LATEST onSurfaced, without restarting the exit', () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ phase: 'surfacing', onSurfaced: first });
        act(() => { vi.advanceTimersByTime(SURFACE_MS - 50); });
        render({ phase: 'surfacing', onSurfaced: second });
        act(() => { vi.advanceTimersByTime(50); });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('keeps the exit short: at most 600 ms', () => {
        expect(SURFACE_MS).toBeLessThanOrEqual(600);
        expect(REDUCED_MS).toBeLessThanOrEqual(300);
        expect(REDUCED_MS).toBeLessThan(SURFACE_MS);
    });

    it('does not fire after an unmount mid-exit, and leaves no timer behind', () => {
        const onSurfaced = vi.fn();
        render({ phase: 'surfacing', onSurfaced });
        unmount();
        act(() => { vi.advanceTimersByTime(SURFACE_MS * 2); });
        expect(onSurfaced).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('reduced motion', () => {
    it('asks for a still field, offers no game, follows no pointer, and still fires onSurfaced (REDUCED_MS)', () => {
        reduceMotion = true;
        enableWorkers();
        const onSurfaced = vi.fn();
        render({ phase: 'loading', stage: 'sync', onSurfaced });
        const w = lastWorker();
        const init = w.sent[0];
        expect(init.type === 'init' && init.reduced).toBe(true);
        w.emit({ type: 'ok' });
        expect(host.querySelector('svg.lo-mark')).not.toBeNull(); // Keys, still
        expect(host.querySelector('.lo-track')).toBeNull(); // no moving cue at all
        expect(host.querySelector('.lo-hint')).toBeNull();
        expect(host.querySelector('.lo-headline')!.textContent).toBe(STAGE_LABEL.sync);
        // no game: Space is left alone; no pointer following
        expect(key(' ').defaultPrevented).toBe(false);
        act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 5 })); });
        expect(window.requestAnimationFrame).not.toHaveBeenCalled();
        expect(w.types()).toEqual(['init']);
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        act(() => { vi.advanceTimersByTime(REDUCED_MS - 1); });
        expect(onSurfaced).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });
});

/* ── The worker path ──────────────────────────────────────────────────────── */

describe('worker', () => {
    it('hands the canvas to a worker once, with the wait so far and the session best', () => {
        enableWorkers();
        render({ onSurfaced: vi.fn() });
        const w = lastWorker();
        expect(workers).toHaveLength(1);
        expect(transferCalls).toBe(1);
        const init = w.sent[0];
        expect(init.type).toBe('init');
        if (init.type === 'init') {
            expect(init.reduced).toBe(false);
            expect(init.best).toBeGreaterThanOrEqual(0);
            expect(w.transfers[0]).toEqual([init.canvas]); // transferred, not copied
        }
        // Keys himself is always the real mark, field or not.
        expect(host.querySelector('svg.lo-mark')).not.toBeNull();
        expect(el().classList.contains('is-gl')).toBe(false);
        w.emit({ type: 'ok' });
        expect(el().classList.contains('is-gl')).toBe(true);
    });

    it('sends nothing per frame while nothing happens: no rAF, only sizes and input', () => {
        enableWorkers();
        render({ onSurfaced: vi.fn() });
        lastWorker().emit({ type: 'ok' });
        act(() => { vi.advanceTimersByTime(5000); });
        expect(window.requestAnimationFrame).not.toHaveBeenCalled();
        expect(lastWorker().types()).toEqual(['init']);
        act(() => { window.dispatchEvent(new Event('resize')); });
        expect(lastWorker().types()).toEqual(['init', 'resize']);
    });

    it('coalesces the pointer to one message per frame, the latest position, and never renders for it', () => {
        enableWorkers();
        const frames: FrameRequestCallback[] = [];
        window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
        window.cancelAnimationFrame = vi.fn();
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
        render({ onSurfaced: vi.fn() });
        const w = lastWorker();
        w.emit({ type: 'ok' });
        const before = el();
        act(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10 * i, clientY: 250 })); });
        expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
        expect(w.types()).toEqual(['init']); // nothing until the frame
        act(() => { frames.splice(0).forEach(cb => cb(0)); });
        const m = w.sent[w.sent.length - 1];
        expect(m).toEqual({ type: 'pointer', x: (190 / 1000) * 2 - 1, y: 0, on: true });
        expect(el()).toBe(before);
        // leaving the window: one more message, pointer off
        act(() => { document.dispatchEvent(new MouseEvent('pointerout', { relatedTarget: null })); });
        act(() => { frames.splice(0).forEach(cb => cb(0)); });
        expect(w.sent[w.sent.length - 1]).toMatchObject({ type: 'pointer', on: false });
        // and nothing at all once the screen is leaving
        render({ phase: 'surfacing', onSurfaced: vi.fn() });
        const n = w.sent.length;
        act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, clientY: 1 })); });
        act(() => { frames.splice(0).forEach(cb => cb(0)); });
        expect(w.sent.slice(n).map(x => x.type)).not.toContain('pointer');
    });

    it('falls back to the static mark when the worker has no WebGL — and still exits', () => {
        enableWorkers();
        const onSurfaced = vi.fn();
        render({ phase: 'loading', onSurfaced });
        const w = lastWorker();
        w.emit({ type: 'nogl' });
        expect(w.terminated).toBe(true);
        expect(w.sent.map(m => m.type)).toContain('detach');
        expect(el().classList.contains('is-static')).toBe(true);
        expect(host.querySelector('canvas')).toBeNull();
        expect(host.querySelector('svg.lo-mark')).not.toBeNull();
        expect(key(' ').defaultPrevented).toBe(false); // no game without the dots
        render({ phase: 'surfacing', onSurfaced });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);

        // ...and the session doesn't try WebGL again.
        remount();
        render({ onSurfaced: vi.fn() });
        expect(workers).toHaveLength(1);
        expect(el().classList.contains('is-static')).toBe(true);
    });

    it('falls back when the worker script itself fails', () => {
        enableWorkers();
        const onSurfaced = vi.fn();
        render({ phase: 'surfacing', onSurfaced });
        act(() => { lastWorker().onerror?.({ preventDefault() {} } as ErrorEvent); });
        expect(lastWorker().terminated).toBe(true);
        expect(el().classList.contains('is-static')).toBe(true);
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('terminates the worker once the screen has exited', () => {
        enableWorkers();
        const onSurfaced = vi.fn();
        render({ phase: 'loading', onSurfaced });
        const w = lastWorker();
        w.emit({ type: 'ok' });
        render({ phase: 'surfacing', onSurfaced });
        expect(w.types()).toContain('exit');
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
        unmount(); // what HydrationGate does in onSurfaced
        expect(w.types().slice(-1)).toEqual(['detach']);
        expect(w.terminated).toBe(true);
    });

    it('parks the worker across the App → HydrationGate handoff and re-attaches it', () => {
        enableWorkers();
        render({ stage: 'auth' }); // App.tsx's screen: no onSurfaced
        const w = lastWorker();
        w.emit({ type: 'ok' });
        act(() => { vi.advanceTimersByTime(700); });
        remount(); // the handoff
        expect(w.terminated).toBe(false);
        expect(w.types()).toEqual(['init', 'pause']);
        render({ stage: 'sync', onSurfaced: vi.fn() });
        expect(workers).toHaveLength(1); // the same worker, not a new one
        expect(transferCalls).toBe(2); // a new canvas, handed over
        expect(w.sent.filter(m => m.type === 'init')).toHaveLength(2); // re-attached to the new canvas
    });

    it('terminates a parked worker nobody came back for', () => {
        enableWorkers();
        render({ stage: 'auth' });
        const w = lastWorker();
        unmount();
        act(() => { vi.advanceTimersByTime(HANDOFF_MS); });
        expect(w.terminated).toBe(true);
    });

    it('survives StrictMode: one worker, one transfer, then resume', () => {
        enableWorkers();
        render({ onSurfaced: vi.fn() }, true);
        expect(workers).toHaveLength(1);
        expect(transferCalls).toBe(1);
        expect(lastWorker().types()).toEqual(['init', 'pause', 'resume']);
        lastWorker().emit({ type: 'ok' });
        expect(el().classList.contains('is-gl')).toBe(true);
    });
});

/* ── The game ─────────────────────────────────────────────────────────────── */

describe('the game', () => {
    it('shows "Press Space to play" after HINT_MS, only where there is an exit hand-off', () => {
        enableWorkers();
        render({ onSurfaced: vi.fn() });
        lastWorker().emit({ type: 'ok' });
        const hint = host.querySelector<HTMLElement>('.lo-hint')!;
        expect(hint.textContent).toBe('Press Space to play');
        expect(parseFloat(hint.style.animationDelay)).toBeCloseTo(HINT_MS / 1000, 2);

        // App.tsx's own screen is unmounted abruptly: no game there.
        remount();
        __resetLoadingWorkerHost();
        render({ stage: 'auth' });
        lastWorker().emit({ type: 'ok' });
        expect(host.querySelector('.lo-hint')).toBeNull();
        expect(key(' ').defaultPrevented).toBe(false);
    });

    it('a click on the loading screen never starts the game; only Space does', () => {
        enableWorkers();
        render({ onSurfaced: vi.fn() });
        const w = lastWorker();
        w.emit({ type: 'ok' });
        act(() => {
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                el().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
            }
        });
        expect(w.types()).toEqual(['init']);
        expect(el().classList.contains('is-game')).toBe(false);
        expect(host.querySelector('.lo-hint')!.textContent).toBe('Press Space to play');
        expect(host.textContent).not.toMatch(/click/i);

        const seen = vi.fn();
        document.addEventListener('keydown', seen);
        try {
            const ev = key(' ');
            expect(ev.defaultPrevented).toBe(true);
            expect(seen).not.toHaveBeenCalled(); // the app underneath never sees it
            expect(w.types()).toEqual(['init', 'act']);
            key(' ', document.body, { repeat: true }); // a held key: no extra strokes
            expect(w.types()).toEqual(['init', 'act']);
        } finally {
            document.removeEventListener('keydown', seen);
        }
    });

    it('inside a run, Space is the stroke and clicks still do nothing', () => {
        const { w } = startPlaying();
        const before = w.types().length;
        act(() => { el().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
        act(() => { el().dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); });
        expect(w.types().length).toBe(before);
        key(' ');
        expect(w.types().slice(before)).toEqual(['act']);
    });

    it('leaves typing alone: Space in an input is not a game key', () => {
        enableWorkers();
        render({ onSurfaced: vi.fn() });
        lastWorker().emit({ type: 'ok' });
        const input = document.createElement('input');
        document.body.appendChild(input);
        expect(key(' ', input).defaultPrevented).toBe(false);
        expect(lastWorker().types()).toEqual(['init']);
        input.remove();
    });

    it('Esc mid-run (still loading) leaves the game, not the screen', () => {
        const { w, onSurfaced } = startPlaying();
        expect(el().classList.contains('is-game')).toBe(true);
        key('Escape');
        expect(w.types().slice(-1)).toEqual(['quit']);
        w.emit({ type: 'game', mode: 'idle', score: 0, best: 0 });
        expect(el().classList.contains('is-game')).toBe(false);
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(onSurfaced).not.toHaveBeenCalled();
    });

    it('NEVER yanks a run: loaded mid-run shows the ready chip and waits for Enter', () => {
        const { w, onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(onSurfaced).not.toHaveBeenCalled();
        expect(el().classList.contains('is-surfacing')).toBe(false);
        expect(w.types()).not.toContain('exit');
        const chip = host.querySelector('.lo-ready')!;
        expect(chip.textContent).toContain('Cipherline is ready');
        expect(host.querySelector('[role="status"]')!.textContent).toContain('Press Enter to continue');
        // Still playable while waiting.
        key(' ');
        expect(w.types().slice(-1)).toEqual(['act']);

        const ev = key('Enter');
        expect(ev.defaultPrevented).toBe(true);
        expect(el().classList.contains('is-surfacing')).toBe(true);
        expect(w.types().slice(-1)).toEqual(['exit']);
        act(() => { vi.advanceTimersByTime(SURFACE_MS - 1); });
        expect(onSurfaced).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('…or Esc', () => {
        const { onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        key('Escape');
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('…or a click on the chip', () => {
        const { onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        act(() => { (host.querySelector('.lo-ready') as HTMLButtonElement).click(); });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('shows the score as plain text in the top strip, live, with the best beside it', () => {
        const { w } = startPlaying();
        expect(host.querySelector('.lo-hud .lo-score-now')!.textContent).toBe('0');
        w.emit({ type: 'game', mode: 'playing', score: 5, best: 0 });
        expect(host.querySelector('.lo-score-now')!.textContent).toBe('5');
        w.emit({ type: 'game', mode: 'over', score: 5, best: 9 });
        expect(host.querySelector('.lo-score-best')!.textContent).toMatch(/^Best \d+$/);
        // not while waiting
        key('Escape'); // inside the guard: ignored
        act(() => { vi.advanceTimersByTime(OVER_GUARD_MS); });
        key('Escape');
        w.emit({ type: 'game', mode: 'idle', score: 5, best: 9 });
        expect(host.querySelector('.lo-hud')).toBeNull();
    });

    it('game over with the app ready HOLDS on the score: never continues on its own', () => {
        const { w, onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        w.emit({ type: 'game', mode: 'over', score: 7, best: 7 });
        act(() => { vi.advanceTimersByTime(120_000); });
        expect(onSurfaced).not.toHaveBeenCalled();
        expect(el().classList.contains('is-surfacing')).toBe(false);
        expect(w.types()).not.toContain('exit');
        const card = host.querySelector('.lo-over')!.textContent!;
        expect(card).toMatch(/Score 7 · Best \d+/);
        expect(card).toMatch(/Enter to continue · Space to play again/);
        expect(host.querySelector('.lo-ready')!.textContent).toContain('Cipherline is ready');
    });

    it('…then Enter continues into the app (after the short crash guard)', () => {
        const { w, onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        w.emit({ type: 'game', mode: 'over', score: 2, best: 2 });
        key('Enter'); // mashed right at the crash: ignored
        act(() => { vi.advanceTimersByTime(OVER_GUARD_MS - 50); });
        key('Enter');
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onSurfaced).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(100); });
        key('Enter');
        expect(el().classList.contains('is-surfacing')).toBe(true);
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('…or Esc does, after the guard too', () => {
        const { w, onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        w.emit({ type: 'game', mode: 'over', score: 2, best: 2 });
        key('Escape');
        act(() => { vi.advanceTimersByTime(OVER_GUARD_MS); });
        expect(onSurfaced).not.toHaveBeenCalled();
        key('Escape');
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('…and Space plays again instead (the worker guards the restart)', () => {
        const { w, onSurfaced } = startPlaying();
        render({ phase: 'surfacing', stage: 'sync', onSurfaced });
        w.emit({ type: 'game', mode: 'over', score: 4, best: 4 });
        const before = w.types().length;
        key(' ');
        expect(w.types().slice(before)).toEqual(['act']);
        w.emit({ type: 'game', mode: 'playing', score: 0, best: 4 });
        act(() => { vi.advanceTimersByTime(30_000); });
        expect(onSurfaced).not.toHaveBeenCalled();
        expect(host.querySelector('.lo-ready')).not.toBeNull(); // still offered
    });

    it('game over while still loading: the score, Space to play again, Esc to stop', () => {
        const { w, onSurfaced } = startPlaying();
        w.emit({ type: 'game', mode: 'over', score: 3, best: 3 });
        const card = host.querySelector('.lo-over')!.textContent!;
        expect(card).toMatch(/Score 3 · Best \d+/);
        expect(card).toMatch(/Space to play again · Esc to stop/);
        act(() => { vi.advanceTimersByTime(OVER_GUARD_MS); });
        key('Escape');
        expect(w.types().slice(-1)).toEqual(['quit']);
        expect(onSurfaced).not.toHaveBeenCalled();
    });

    it('with no run in progress, the screen exits as normal, and Space no longer plays', () => {
        enableWorkers();
        const onSurfaced = vi.fn();
        render({ phase: 'loading', onSurfaced });
        const w = lastWorker();
        w.emit({ type: 'ok' });
        render({ phase: 'surfacing', onSurfaced });
        expect(key(' ').defaultPrevented).toBe(false);
        expect(w.types()).not.toContain('act');
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(onSurfaced).toHaveBeenCalledTimes(1);
    });

    it('keeps the session best for the next screen', () => {
        const { w } = startPlaying();
        w.emit({ type: 'game', mode: 'over', score: 12, best: 12 });
        remount();
        __resetLoadingWorkerHost();
        render({ onSurfaced: vi.fn() });
        const init = lastWorker().sent[0];
        expect(init.type === 'init' && init.best).toBe(12);
    });
});

describe('the loading bar', () => {
    it('is honest: bands from the real stage and loads, never full while loading', () => {
        const bands = [
            progressBand('start', 0, false), progressBand('auth', 0, false),
            progressBand('sync', 0, false), progressBand('sync', 1 / 3, false),
            progressBand('sync', 2 / 3, false), progressBand('sync', 1, false),
        ];
        for (let i = 0; i < bands.length; i++) {
            expect(bands[i].done).toBe(false);
            expect(bands[i].ceil).toBeLessThanOrEqual(0.9);
            expect(bands[i].floor).toBeLessThan(bands[i].ceil);
            if (i) {
                expect(bands[i].floor).toBeGreaterThanOrEqual(bands[i - 1].floor);
                expect(bands[i].ceil).toBeGreaterThanOrEqual(bands[i - 1].ceil);
            }
        }
        expect(progressBand('sync', 0.5, true).done).toBe(true);
    });

    it('tells the worker what is known as it changes, and that it is done on load', () => {
        enableWorkers();
        const onSurfaced = vi.fn();
        render({ stage: 'sync', progress: 0, onSurfaced });
        const w = lastWorker();
        expect(w.sent.map(m => m.type)).toContain('bar'); // its place under the status line
        expect(w.progress().slice(-1)[0]).toEqual({ type: 'progress', ...progressBand('sync', 0, false) });
        render({ stage: 'sync', progress: 2 / 3, onSurfaced });
        expect(w.progress().slice(-1)[0]).toEqual({ type: 'progress', ...progressBand('sync', 2 / 3, false) });
        render({ phase: 'surfacing', stage: 'sync', progress: 1, onSurfaced });
        expect(w.progress().slice(-1)[0].done).toBe(true);
        // and never a number on screen
        expect(host.textContent).not.toMatch(/\d\s*%/);
    });
});

describe('never-yank decision table', () => {
    const cases: Array<[boolean, GameState, boolean, boolean, boolean]> = [
        // loaded, game, continued → leaving, chip
        [false, 'idle', false, false, false],
        [false, 'playing', false, false, false],
        [false, 'over', false, false, false],
        [false, 'playing', true, false, false],
        [true, 'idle', false, true, false],
        [true, 'over', false, false, true], // game over holds on the score
        [true, 'over', true, true, false],
        [true, 'playing', false, false, true],
        [true, 'playing', true, true, false],
    ];
    it.each(cases)('loaded=%s game=%s continued=%s → leaving=%s chip=%s', (loaded, game, continued, leaving, chip) => {
        expect(isLeaving(loaded, game, continued)).toBe(leaving);
        expect(showsReadyChip(loaded, game, continued)).toBe(chip);
    });
});

/* ── The stylesheet ───────────────────────────────────────────────────────── */

describe('perf: the stylesheet', () => {
    const css = readFileSync(join(__dirname, '../styles/app-loading.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ''); // comments may name what they forbid

    /** The body of every @keyframes block, by name. */
    const keyframes = (() => {
        const out: Record<string, string> = {};
        const re = /@keyframes\s+([\w-]+)\s*\{/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(css))) {
            let depth = 1;
            let i = re.lastIndex;
            for (; i < css.length && depth; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
            out[m[1]] = css.slice(re.lastIndex, i - 1);
        }
        return out;
    })();

    it('has keyframes to check (positive control)', () => {
        expect(Object.keys(keyframes).sort()).toEqual(['lo-bob', 'lo-fade', 'lo-fade-out', 'lo-keys-out', 'lo-out', 'lo-pop', 'lo-rise', 'lo-sweep']);
    });

    it('animates only transform and opacity, and never through a custom property', () => {
        for (const [name, body] of Object.entries(keyframes)) {
            const props = Array.from(body.matchAll(/([a-z-]+)\s*:/g)).map(m => m[1]);
            expect(props.length, name).toBeGreaterThan(0);
            for (const p of props) expect(['transform', 'opacity', 'animation-timing-function'], `${name}: ${p}`).toContain(p);
            expect(body, name).not.toMatch(/var\(/);
        }
    });

    it('transitions only transform and opacity', () => {
        const transitions = Array.from(css.matchAll(/transition\s*:\s*([^;]+);/g)).map(m => m[1]);
        expect(transitions.length).toBeGreaterThan(0);
        for (const t of transitions) {
            if (/^none\b/.test(t.trim())) continue;
            for (const part of t.split(',')) expect(['transform', 'opacity']).toContain(part.trim().split(/\s+/)[0]);
        }
    });

    it('uses no filter, blur, shadow or will-change, and no rounded clip on the bar', () => {
        expect(css).not.toMatch(/filter\s*:|blur\(|box-shadow|text-shadow|will-change/);
        const track = css.match(/\.lo-track\s*\{([^}]*)\}/)![1];
        expect(track).toMatch(/overflow:\s*hidden/);
        expect(track).not.toMatch(/border-radius/);
    });

    it('has only two loops: Keys\' slow bob and the static fallback bar', () => {
        const loops = Array.from(css.matchAll(/animation\s*:\s*([\w-]+)[^;]*infinite/g)).map(m => m[1]);
        expect(loops.sort()).toEqual(['lo-bob', 'lo-sweep']);
    });
});

/* ── Status line ──────────────────────────────────────────────────────────── */

describe('status line', () => {
    it('names the stage it was given, and is generic by default', () => {
        render();
        expect(host.querySelector('.lo-headline')!.textContent).toBe(STAGE_LABEL.start);
        render({ stage: 'sync' });
        expect(host.querySelector('.lo-headline')!.textContent).toBe(STAGE_LABEL.sync);
        expect(host.querySelector('[role="status"]')!.textContent).toContain(STAGE_LABEL.sync);
    });

    it('has no fake percentage', () => {
        render({ stage: 'sync' });
        expect(host.textContent).not.toMatch(/\d\s*%/);
    });

    it('turns calm-slow after SLOW_MS, and announces it', () => {
        render({ stage: 'sync' });
        act(() => { vi.advanceTimersByTime(SLOW_MS - 1); });
        expect(el().classList.contains('is-slow')).toBe(false);
        act(() => { vi.advanceTimersByTime(1); });
        expect(el().classList.contains('is-slow')).toBe(true);
        expect(host.querySelector('[role="status"]')!.textContent).toContain(SLOW_LABEL);
    });

    it('cancels the slow timer once loaded', () => {
        render({ onSurfaced: vi.fn() });
        render({ phase: 'surfacing', onSurfaced: vi.fn() });
        act(() => { vi.advanceTimersByTime(SURFACE_MS); });
        expect(vi.getTimerCount()).toBe(0);
        act(() => { vi.advanceTimersByTime(SLOW_MS); });
        expect(el().classList.contains('is-slow')).toBe(false);
    });

    it('keeps counting across the App → HydrationGate handoff remount', () => {
        render({ stage: 'auth' });
        act(() => { vi.advanceTimersByTime(5000); });
        remount();
        render({ stage: 'sync' });
        expect(parseFloat(el().style.getPropertyValue('--lo-el'))).toBeCloseTo(5, 1);
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
        expect(parseFloat(el().style.getPropertyValue('--lo-el'))).toBe(0);
        act(() => { vi.advanceTimersByTime(SLOW_MS - 1000); });
        expect(el().classList.contains('is-slow')).toBe(false);
    });
});
