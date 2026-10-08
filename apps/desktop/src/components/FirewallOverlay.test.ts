// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// An in-memory secureLocalStore: the test is about which key the score goes
// under and when, not about the encryption (secureLocalStore's own tests).
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

import { FirewallOverlay } from './FirewallOverlay';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import { __resetEscapeStackForTests, escapeLayerCount, pushEscapeLayer } from '../utils/escapeStack';
import { __resetKeyClaims, isKeyComboClaimed } from '../utils/keyClaims';
import { applyMotionState } from '../utils/idleMotion';
import { firewallBestKey, readFirewallBest, writeFirewallBest } from '../utils/firewallBest';
import { classifyKvKey } from '../services/backupRegistry';
import type { FromWorker, ToWorker } from '../workers/loadingScreenProtocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Home easter-egg game's frame around the loading screen's worker:
 *   - open → one worker, handed a fresh canvas, told this account's best;
 *   - close (Esc, the close button, or the host unmounting it) → the worker
 *     gets 'detach' (drops its GL context) and is terminated, the canvas is
 *     gone, the Space claim and the Escape layer are released;
 *   - Space goes to the game and nowhere else; Esc goes through the shared
 *     Escape stack; the best score is kept per account in secureLocalStore.
 */

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

const UID = 'acct-1';
let root: Root | null = null;
let host: HTMLDivElement;
let workers: FakeWorker[] = [];
const proto = HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: () => unknown };
const last = () => workers[workers.length - 1];

function open(onClose = vi.fn(), strict = false) {
    const node = React.createElement(FirewallOverlay, { userId: UID, onClose });
    act(() => { root!.render(strict ? React.createElement(React.StrictMode, null, node) : node); });
    return onClose;
}
function close() {
    act(() => { root!.render(React.createElement('div')); });
}
function key(type: 'keydown' | 'keyup', k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
    const ev = new KeyboardEvent(type, { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(ev); });
    return ev;
}

beforeEach(() => {
    store.clear();
    __resetLoadingWorkerHost();
    __resetEscapeStackForTests();
    __resetKeyClaims();
    workers = [];
    proto.transferControlToOffscreen = function () { return { fake: 'offscreen' }; };
    __setLoadingWorkerFactory(() => { const w = new FakeWorker(); workers.push(w); return w; });
    window.requestAnimationFrame = vi.fn(() => 0);
    window.cancelAnimationFrame = vi.fn();
    applyMotionState(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    __resetLoadingWorkerHost();
    __setLoadingWorkerFactory('default');
    delete proto.transferControlToOffscreen;
    __resetEscapeStackForTests();
    __resetKeyClaims();
    vi.restoreAllMocks();
});

describe('FirewallOverlay: lifecycle', () => {
    it('opens with one worker on a fresh canvas, told the stored best, not reduced', () => {
        store.set(firewallBestKey(UID), '12');
        open();
        expect(workers).toHaveLength(1);
        const init = last().sent[0];
        expect(init.type).toBe('init');
        if (init.type !== 'init') throw new Error('unreachable');
        expect(init.best).toBe(12);
        expect(init.reduced).toBe(false);
        expect(host.querySelectorAll('canvas')).toHaveLength(1);
        expect(host.querySelector('.fw-root')).not.toBeNull();
    });

    it('closing releases the GL context and terminates the worker, and removes the canvas', () => {
        open();
        const w = last();
        w.emit({ type: 'ok' });
        expect(w.terminated).toBe(false);
        close();
        expect(w.types()).toContain('detach');
        expect(w.terminated).toBe(true);
        expect(w.onmessage).toBeNull();
        expect(document.querySelectorAll('canvas')).toHaveLength(0);
    });

    it('closing mid-run terminates too (no parking for a later screen)', () => {
        open();
        const w = last();
        w.emit({ type: 'ok' });
        key('keydown', ' ');
        w.emit({ type: 'game', mode: 'playing', score: 3, best: 3 });
        close();
        expect(w.terminated).toBe(true);
        // a later loading screen gets a brand-new worker, not this one
        expect(workers.filter(x => !x.terminated)).toHaveLength(0);
    });

    it('survives StrictMode: each effect run has its own canvas and worker, and only the live one is left', () => {
        open(vi.fn(), true);
        expect(workers.length).toBe(2);
        expect(workers[0].terminated).toBe(true);
        expect(workers[1].terminated).toBe(false);
        expect(host.querySelectorAll('canvas')).toHaveLength(1);
        close();
        expect(workers.every(w => w.terminated)).toBe(true);
    });

    it('no WebGL: says so, offers a way back, and the worker is gone', () => {
        const onClose = open();
        const w = last();
        w.emit({ type: 'nogl' });
        expect(w.terminated).toBe(true);
        expect(host.textContent).toContain('can’t run here');
        const back = host.querySelector('.fw-btn') as HTMLButtonElement;
        act(() => { back.click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('no OffscreenCanvas: never spawns a worker', () => {
        delete proto.transferControlToOffscreen;
        open();
        expect(workers).toHaveLength(0);
        expect(host.textContent).toContain('can’t run here');
    });

    it('pauses with the idle-motion gate and resumes after', () => {
        open();
        const w = last();
        act(() => { applyMotionState(false); });
        act(() => { applyMotionState(true); });
        expect(w.types().slice(-2)).toEqual(['pause', 'resume']);
        close();
        const n = w.sent.length;
        act(() => { applyMotionState(false); });
        expect(w.sent.length).toBe(n); // unsubscribed
    });
});

describe('FirewallOverlay: Space', () => {
    it('Space is a swim, and nothing underneath sees it (keydown or keyup)', () => {
        open();
        const w = last();
        w.emit({ type: 'ok' });
        const below = vi.fn();
        window.addEventListener('keydown', below);
        window.addEventListener('keyup', below);
        const down = key('keydown', ' ');
        const up = key('keyup', ' ');
        window.removeEventListener('keydown', below);
        window.removeEventListener('keyup', below);
        expect(w.types().filter(t => t === 'act')).toHaveLength(1);
        expect(down.defaultPrevented).toBe(true);
        expect(up.defaultPrevented).toBe(true);
        expect(below).not.toHaveBeenCalled();
    });

    it('a held Space is one stroke, not a stream', () => {
        open();
        const w = last();
        key('keydown', ' ');
        key('keydown', ' ', document.body, { repeat: true });
        key('keydown', ' ', document.body, { repeat: true });
        expect(w.types().filter(t => t === 'act')).toHaveLength(1);
    });

    it('claims the plain `space` combo while open (keybinds and push-to-talk skip it), and gives it back', () => {
        expect(isKeyComboClaimed('space')).toBe(false);
        open();
        expect(isKeyComboClaimed('space')).toBe(true);
        expect(isKeyComboClaimed('ctrl+shift+m')).toBe(false);
        close();
        expect(isKeyComboClaimed('space')).toBe(false);
    });

    it('leaves Space alone in a text field, with a modifier, or when focus is elsewhere in the app', () => {
        open();
        const w = last();
        const input = document.createElement('input');
        const button = document.createElement('button');
        document.body.append(input, button);
        expect(key('keydown', ' ', input).defaultPrevented).toBe(false);
        expect(key('keydown', ' ', document.body, { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(key('keydown', ' ', button).defaultPrevented).toBe(false);
        expect(w.types()).not.toContain('act');
        input.remove(); button.remove();
    });

    it('takes focus on open and hands it back on close', () => {
        const before = document.createElement('button');
        document.body.appendChild(before);
        before.focus();
        open();
        expect(document.activeElement).toBe(host.querySelector('.fw-root'));
        close();
        expect(document.activeElement).toBe(before);
        before.remove();
    });
});

describe('FirewallOverlay: Escape', () => {
    it('registers exactly one layer on the shared stack; Esc closes; the layer is gone after', () => {
        const onClose = open();
        expect(escapeLayerCount()).toBe(1);
        const ev = key('keydown', 'Escape');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
        close();
        expect(escapeLayerCount()).toBe(0);
    });

    it('a layer opened on top of it (a dialog) gets Esc first', () => {
        const onClose = open();
        const top = vi.fn();
        const pop = pushEscapeLayer(top);
        key('keydown', 'Escape');
        expect(top).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        pop();
        key('keydown', 'Escape');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the close button closes too', () => {
        const onClose = open();
        act(() => { (host.querySelector('.fw-close') as HTMLButtonElement).click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('FirewallOverlay: best score per account', () => {
    it('a new best is written under this account’s key; a lower score is not', () => {
        store.set(firewallBestKey(UID), '5');
        open();
        const w = last();
        w.emit({ type: 'game', mode: 'over', score: 3, best: 5 });
        expect(store.get(firewallBestKey(UID))).toBe('5');
        w.emit({ type: 'game', mode: 'over', score: 9, best: 9 });
        expect(store.get(firewallBestKey(UID))).toBe('9');
        expect(host.querySelector('.fw-score-best')?.textContent).toBe('Best 9');
        expect(store.get(firewallBestKey('someone-else'))).toBeUndefined();
    });

    it('readFirewallBest / writeFirewallBest: never lower, never garbage, never without an account', () => {
        expect(readFirewallBest(UID)).toBe(0);
        expect(writeFirewallBest(UID, 4)).toBe(4);
        expect(writeFirewallBest(UID, 2)).toBe(4);
        expect(writeFirewallBest(UID, Number.NaN)).toBe(4);
        store.set(firewallBestKey(UID), 'not a number');
        expect(readFirewallBest(UID)).toBe(0);
        expect(writeFirewallBest('', 10)).toBe(0);
        expect(store.size).toBe(1);
    });

    it('its key is classified in the backup registry (excluded)', () => {
        expect(classifyKvKey(firewallBestKey(UID), UID)).toBe('exclude');
    });
});
