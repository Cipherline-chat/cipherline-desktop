// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LockScreenField } from './LockScreenField';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, acquireWorker, releaseWorker, type WorkerLike } from './loadingWorkerHost';
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
    it('starts the loading screen\'s scene (its own worker) in lock mode: dots only', () => {
        mount();
        const w = workers[0];
        expect(workers).toHaveLength(1);
        // One message, and it carries the mode: no separate bar / progress / keys traffic at all.
        expect(w.types()).toEqual(['init']);
        expect(w.sent[0]).toMatchObject({ type: 'init', reduced: false, mode: 'lock', best: 0 });
        expect(w.sent[0]).toHaveProperty('canvas');
    });

    it('negative control: the boot loading screen\'s init carries no lock mode', () => {
        // AppLoadingScreen\'s init (src/components/AppLoadingScreen.tsx) has no `mode`.
        const src = readFileSync(resolve(__dirname, 'AppLoadingScreen.tsx'), 'utf8');
        const init = src.match(/postMessage\(\{ type: 'init'[\s\S]*?\[off\]\)/)?.[0] ?? '';
        expect(init).toMatch(/reduced \}, \[off\]\)$/); // the whole call was captured
        expect(init).not.toMatch(/mode/);
    });

    it('forwards the pointer to the worker (-1..1 from the centre, y up), once a frame', () => {
        const raf: FrameRequestCallback[] = [];
        window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => { raf.push(cb); return raf.length; });
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
        mount();
        const w = workers[0];
        const ev = (x: number, y: number) => { const e = new Event('pointermove') as Event & { clientX: number; clientY: number }; e.clientX = x; e.clientY = y; return e; };
        act(() => { window.dispatchEvent(ev(750, 125)); window.dispatchEvent(ev(750, 125)); window.dispatchEvent(ev(900, 100)); });
        expect(raf).toHaveLength(1); // coalesced: one rAF per burst
        act(() => { raf.splice(0).forEach(cb => cb(0)); });
        const ptr = w.sent.filter(m => m.type === 'pointer');
        expect(ptr).toHaveLength(1);
        expect(ptr[0]).toEqual({ type: 'pointer', x: 0.8, y: 0.6, on: true }); // the latest position
        // the pointer leaving the window
        const out = new Event('pointerout') as Event & { relatedTarget: EventTarget | null };
        out.relatedTarget = null;
        act(() => { document.dispatchEvent(out); raf.splice(0).forEach(cb => cb(0)); });
        expect(w.sent.filter(m => m.type === 'pointer').pop()).toMatchObject({ on: false });
    });

    it('negative control: without any pointer movement, nothing is posted', () => {
        mount();
        expect(workers[0].types()).not.toContain('pointer');
    });

    it('never posts bar / progress / keys / act / quit, over a whole lock session', () => {
        const raf: FrameRequestCallback[] = [];
        window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => { raf.push(cb); return raf.length; });
        mount();
        const w = workers[0];
        const spy = vi.spyOn(w, 'postMessage');
        const e = new Event('pointermove') as Event & { clientX: number; clientY: number };
        e.clientX = 10; e.clientY = 10;
        act(() => { window.dispatchEvent(e); raf.splice(0).forEach(cb => cb(0)); window.dispatchEvent(new Event('resize')); });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        act(() => { root.render(React.createElement('div')); }); // unlock
        const all = [...w.sent.map(m => m.type), ...spy.mock.calls.map(c => (c[0] as ToWorker).type)];
        for (const forbidden of ['bar', 'progress', 'keys', 'act', 'quit', 'exit']) expect(all).not.toContain(forbidden);
        expect(all).toEqual(expect.arrayContaining(['init', 'pointer', 'resize', 'pause', 'resume', 'detach']));
    });

    it('negative control: the spy does see a bar message when one is sent (the check can fail)', () => {
        mount();
        const w = workers[0];
        w.postMessage({ type: 'bar', x: 0, y: 0, w: 100 });
        expect(w.types()).toContain('bar');
    });

    it('starts paused when the lock comes up on a hidden/minimised window', () => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        mount();
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        expect(workers[0].types()).toEqual(['init', 'pause']);
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
        expect(w.onmessage).toBeNull();
        // negative control: while still locked (mounted) it is alive
    });

    it('negative control: a mounted (still locked) field keeps its worker alive', () => {
        mount();
        expect(workers[0].terminated).toBe(false);
        expect(workers[0].types()).not.toContain('detach');
    });

    it('falls back to the plain backdrop without WebGL, and never draws again this session', () => {
        const onLive = vi.fn();
        mount(onLive);
        workers[0].emit({ type: 'nogl' });
        expect(workers[0].terminated).toBe(true);
        expect(onLive).toHaveBeenLastCalledWith(false);
        expect(host.querySelector('canvas')!.style.opacity).toBe('0');
    });

    // The owner's bug: "I sometimes see the loading bar from when Cipherline
    // first opens, behind the password lock". The boot loading screen parks its
    // worker for the handoff; the lock used to take it, and the worker kept
    // drawing that screen's loading bar (placed + part-filled) behind the
    // lock's translucent PIN card.
    it('never takes the boot loading screen\'s parked worker (it would carry the loading bar)', () => {
        // What AppLoadingScreen leaves behind when it unmounts for the handoff.
        const canvas = document.createElement('canvas');
        const boot = acquireWorker(canvas)!.worker as FakeWorker;
        boot.postMessage({ type: 'bar', x: 0, y: -57, w: 180 });
        boot.postMessage({ type: 'progress', floor: 0, ceil: 0.18, done: false });
        releaseWorker(boot, canvas, false); // parked, bar and all
        const bootSent = boot.sent.length;

        mount();

        // The lock got a worker of its own...
        expect(workers).toHaveLength(2);
        const lockWorker = workers[1];
        expect(lockWorker).not.toBe(boot);
        expect(lockWorker.types()).toEqual(['init']);
        // ...that has never been told where a loading bar goes...
        expect(lockWorker.types()).not.toContain('bar');
        expect(lockWorker.types()).not.toContain('progress');
        // ...and the parked one was left strictly alone, still parked for its own handoff.
        expect(boot.sent).toHaveLength(bootSent);
        expect(boot.terminated).toBe(false);
        expect(acquireWorker(document.createElement('canvas'))?.worker).toBe(boot);
    });

    it('renders nothing where OffscreenCanvas does not exist', () => {
        delete proto.transferControlToOffscreen;
        mount();
        expect(host.querySelector('canvas')).toBeNull();
        expect(workers).toHaveLength(0);
    });
});
