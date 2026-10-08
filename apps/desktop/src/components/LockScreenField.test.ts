// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LockScreenField } from './LockScreenField';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import type { FromWorker, ToWorker } from '../workers/loadingScreenProtocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The lock screen's dot field: Keys off, cheap while hidden, gone when unlocked, harmless when unsupported. */

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
let root: Root;
let host: HTMLDivElement;
let reduce = false;

beforeEach(() => {
    __resetLoadingWorkerHost();
    workers = [];
    reduce = false;
    proto.transferControlToOffscreen = () => ({ fake: true });
    __setLoadingWorkerFactory(() => { const w = new FakeWorker(); workers.push(w); return w; });
    window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
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
});

const mount = (onLive?: (l: boolean) => void) => act(() => { root.render(React.createElement(LockScreenField, { onLive })); });

describe('LockScreenField', () => {
    it('starts the loading screen\'s worker with Keys switched off', () => {
        mount();
        const w = workers[0];
        expect(w.types()).toEqual(['init', 'keys']);
        expect(w.sent[1]).toEqual({ type: 'keys', visible: false });
        expect(w.sent[0]).toMatchObject({ type: 'init', reduced: false });
    });

    it('fades in and tells the lock screen only once a frame has drawn', () => {
        const onLive = vi.fn();
        mount(onLive);
        const c = host.querySelector('canvas')!;
        expect(c.style.opacity).toBe('0');
        workers[0].emit({ type: 'ok' });
        expect(c.style.opacity).toBe('1');
        expect(onLive).toHaveBeenLastCalledWith(true);
    });

    it('asks for a still frame under reduced motion', () => {
        reduce = true;
        mount();
        expect(workers[0].sent[0]).toMatchObject({ type: 'init', reduced: true });
    });

    it('stops drawing while the window is hidden and resumes when shown', () => {
        mount();
        const w = workers[0];
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(w.types().slice(-1)).toEqual(['pause']);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(w.types().slice(-1)).toEqual(['resume']);
    });

    it('releases the GL context and ends the worker when unlocked (unmounted)', () => {
        mount();
        const w = workers[0];
        act(() => { root.render(React.createElement('div')); });
        expect(w.types()).toContain('detach');
        expect(w.terminated).toBe(true);
    });

    it('falls back to the plain backdrop without WebGL, and never draws again this session', () => {
        const onLive = vi.fn();
        mount(onLive);
        workers[0].emit({ type: 'nogl' });
        expect(workers[0].terminated).toBe(true);
        expect(onLive).toHaveBeenLastCalledWith(false);
        expect(host.querySelector('canvas')!.style.opacity).toBe('0');
    });

    it('renders nothing where OffscreenCanvas does not exist', () => {
        delete proto.transferControlToOffscreen;
        mount();
        expect(host.querySelector('canvas')).toBeNull();
        expect(workers).toHaveLength(0);
    });
});
