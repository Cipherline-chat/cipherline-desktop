// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OfflineScreen } from './OfflineScreen';
import { SURFACE_MS } from './AppLoadingScreen';
import { HINT_MS, OVER_GUARD_MS, __resetLoadingSession } from './loadingWait';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import type { FromWorker, ToWorker } from '../workers/loadingScreenProtocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The offline screen's secret: "Press Space to play" after a quiet moment,
 * Space cross-fades into the loading screen's Firewall game, and — the safety
 * property — a connection coming back NEVER yanks a run.
 */

vi.mock('./mascot/Keys', () => ({ Keys: () => null }));

class FakeWorker implements WorkerLike {
    sent: ToWorker[] = [];
    terminated = false;
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(m: ToWorker) { this.sent.push(m); }
    terminate() { this.terminated = true; }
    types() { return this.sent.map(m => m.type); }
    emit(m: FromWorker) { act(() => { this.onmessage?.({ data: m } as MessageEvent<FromWorker>); }); }
}
let workers: FakeWorker[] = [];
const proto = HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: () => unknown };
function enableWorkers() {
    proto.transferControlToOffscreen = () => ({ fake: 'offscreen' });
    __setLoadingWorkerFactory(() => { const w = new FakeWorker(); workers.push(w); return w; });
}
const lastWorker = () => workers[workers.length - 1];

let reduceMotion = false;
let root: Root;
let host: HTMLDivElement;

function render(isOnline: boolean) {
    act(() => { root.render(React.createElement(OfflineScreen, { isOnline })); });
}
function key(k: string, target: EventTarget = document.body) {
    const ev = new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(ev); });
    return ev;
}
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const hint = () => host.querySelector('p[aria-hidden]') as HTMLElement | null;
const game = () => host.querySelector('.lo-root') as HTMLElement | null;

/** Offline, hint showing, Space pressed, field drawn: a run in progress. */
function startRun() {
    enableWorkers();
    render(false);
    advance(HINT_MS);
    key(' ');
    lastWorker().emit({ type: 'ok' });
    lastWorker().emit({ type: 'game', mode: 'playing', score: 0, best: 0 });
    return lastWorker();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    __resetLoadingSession();
    __resetLoadingWorkerHost();
    __setLoadingWorkerFactory('default');
    delete proto.transferControlToOffscreen;
    workers = [];
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
    act(() => { root.unmount(); });
    host.remove();
    __resetLoadingWorkerHost();
    __setLoadingWorkerFactory('default');
    delete proto.transferControlToOffscreen;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the hint', () => {
    it('is quiet at first, fades in after HINT_MS, and says Press Space to play', () => {
        enableWorkers();
        render(false);
        expect(host.textContent).toContain("You're offline");
        expect(hint()!.style.opacity).toBe('0');
        advance(HINT_MS - 1);
        expect(hint()!.style.opacity).toBe('0');
        advance(1);
        expect(hint()!.style.opacity).not.toBe('0');
        expect(hint()!.textContent).toBe('Press Space to play');
    });

    it('is not offered where the game cannot run (no worker / OffscreenCanvas)', () => {
        render(false);
        advance(HINT_MS * 4);
        expect(hint()!.textContent).toBe('');
        expect(key(' ').defaultPrevented).toBe(false);
        expect(game()).toBeNull();
    });

    it('is not offered under reduced motion', () => {
        reduceMotion = true;
        enableWorkers();
        render(false);
        advance(HINT_MS * 4);
        expect(hint()!.textContent).toBe('');
        expect(key(' ').defaultPrevented).toBe(false);
    });
});

describe('starting', () => {
    it('Space before the hint is showing does nothing (and is left alone)', () => {
        enableWorkers();
        render(false);
        advance(HINT_MS - 100);
        expect(key(' ').defaultPrevented).toBe(false);
        expect(game()).toBeNull();
    });

    it('a click never starts it', () => {
        enableWorkers();
        render(false);
        advance(HINT_MS);
        act(() => { host.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(game()).toBeNull();
    });

    it('typing in a field is not a game key', () => {
        enableWorkers();
        render(false);
        advance(HINT_MS);
        const input = document.createElement('input');
        document.body.appendChild(input);
        expect(key(' ', input).defaultPrevented).toBe(false);
        expect(game()).toBeNull();
        input.remove();
    });

    it('Space takes the key, moves into the game stage, and starts a run as the field appears', () => {
        enableWorkers();
        render(false);
        advance(HINT_MS);
        const ev = key(' ');
        expect(ev.defaultPrevented).toBe(true);
        expect(game()).not.toBeNull();
        const w = lastWorker();
        // Nothing to swim on until the field has drawn...
        expect(w.types()).not.toContain('act');
        w.emit({ type: 'ok' });
        // ...then exactly one Space-equivalent, not another prompt.
        expect(w.types().filter(t => t === 'act')).toHaveLength(1);
        expect(host.querySelector('.lo-hint')).toBeNull();
    });

    it('shows no loading bar and no loading copy: the offline words, nothing posted for a bar', () => {
        const w = startRun();
        expect(w.types()).not.toContain('bar');
        expect(w.types()).not.toContain('progress');
        expect(host.textContent).toContain("You're offline");
        expect(host.textContent).not.toContain('Getting things ready');
        expect(host.textContent).not.toContain('Taking a little longer');
    });
});

describe('leaving the game', () => {
    it('Esc leaves the run and brings the offline card back', () => {
        const w = startRun();
        key('Escape');
        expect(w.types().slice(-1)).toEqual(['quit']);
        w.emit({ type: 'game', mode: 'idle', score: 0, best: 0 });
        expect(game()).toBeNull();
        expect(host.textContent).toContain("You're offline");
    });

    it('with no WebGL the stage is abandoned and the card stays', () => {
        enableWorkers();
        render(false);
        advance(HINT_MS);
        key(' ');
        lastWorker().emit({ type: 'nogl' });
        expect(game()).toBeNull();
        expect(host.textContent).toContain("You're offline");
        // ...and it is not offered again this session.
        advance(HINT_MS * 2);
        expect(hint()!.textContent).toBe('');
    });
});

describe('the connection coming back', () => {
    it('NEVER yanks a run: no 550 ms "reconnecting" clear, a back-online chip waits for Enter', () => {
        const w = startRun();
        render(true);
        advance(60_000);
        expect(game()).not.toBeNull();
        expect(game()!.classList.contains('is-surfacing')).toBe(false);
        expect(w.types()).not.toContain('exit');
        expect(host.querySelector('.lo-ready')!.textContent).toContain("You're back online");

        const ev = key('Enter');
        expect(ev.defaultPrevented).toBe(true);
        expect(w.types().slice(-1)).toEqual(['exit']);
        advance(SURFACE_MS);
        expect(host.innerHTML).toBe('');
    });

    it('…Esc continues too, once the run is over the crash guard is irrelevant', () => {
        const w = startRun();
        render(true);
        key('Escape');
        expect(w.types().slice(-1)).toEqual(['exit']);
        advance(SURFACE_MS);
        expect(host.innerHTML).toBe('');
    });

    it('game over holds on the score even when back online; Enter continues after the guard', () => {
        const w = startRun();
        w.emit({ type: 'game', mode: 'over', score: 7, best: 7 });
        render(true);
        advance(60_000);
        expect(game()).not.toBeNull();
        expect(host.querySelector('.lo-over')!.textContent).toContain('Score 7');
        advance(OVER_GUARD_MS);
        key('Enter');
        advance(SURFACE_MS);
        expect(host.innerHTML).toBe('');
    });

    it('a connection that drops again mid-run just keeps the game going (offline copy returns)', () => {
        const w = startRun();
        render(true);
        render(false);
        advance(60_000);
        expect(game()).not.toBeNull();
        expect(host.querySelector('.lo-ready')).toBeNull();
        expect(w.types()).not.toContain('exit');
    });

    it('without a game, nothing changed: back online clears after the short beat', () => {
        enableWorkers();
        render(false);
        render(true);
        expect(host.textContent).toContain('Back online!');
        advance(550);
        expect(host.innerHTML).toBe('');
    });
});
