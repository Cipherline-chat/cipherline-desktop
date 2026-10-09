// @vitest-environment jsdom
/**
 * The sliding indicator used to be measured only when the value changed, on
 * window resize, when fonts loaded and once 300 ms after mount. A segment
 * whose width changed any other way (the Friends "Pending" badge disappearing
 * after accepting a request, the view laying out while still settling) left
 * the cap stuck at the old size/position. It now follows a ResizeObserver on
 * every button and the track.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClSegment } from './ClSegment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Controllable layout: jsdom has no layout, so each button reports the box we set.
const boxes = new Map<string, { left: number; width: number }>();
Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get(this: HTMLElement) { return boxes.get(this.textContent ?? '')?.left ?? 0; } });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return boxes.get(this.textContent ?? '')?.width ?? 0; } });

// Minimal ResizeObserver whose callbacks the test fires by hand.
const observers: Array<() => void> = [];
class FakeRO {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; observers.push(cb); }
    observe() {}
    disconnect() { const i = observers.indexOf(this.cb); if (i >= 0) observers.splice(i, 1); }
}

let host: HTMLDivElement; let root: Root;
const opts = [
    { value: 'all', label: 'All Friends' },
    { value: 'pending', label: 'Pending' },
] as const;
const ind = () => host.querySelector('.sind') as HTMLElement;

beforeEach(() => {
    boxes.clear(); observers.length = 0;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver; });

describe('ClSegment indicator follows segment size changes', () => {
    it('re-measures when the active segment changes width without the value changing', () => {
        boxes.set('All Friends', { left: 4, width: 90 });
        act(() => root.render(React.createElement(ClSegment<'all' | 'pending'>, { options: [...opts], value: 'all', onChange: () => {} })));
        expect(ind().style.width).toBe('90px');

        // Layout settles / a badge elsewhere changes: the active button grows and moves.
        boxes.set('All Friends', { left: 6, width: 128 });
        act(() => { for (const cb of [...observers]) cb(); });
        expect(ind().style.width).toBe('128px');
        expect(ind().style.left).toBe('6px');
    });

    it('control: without a ResizeObserver the same change is never picked up (the old behaviour)', () => {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        boxes.set('All Friends', { left: 4, width: 90 });
        act(() => root.render(React.createElement(ClSegment<'all' | 'pending'>, { options: [...opts], value: 'all', onChange: () => {} })));
        boxes.set('All Friends', { left: 6, width: 128 });
        act(() => { for (const cb of [...observers]) cb(); });
        expect(ind().style.width).toBe('90px');
    });

    it('disconnects its observer on unmount', () => {
        act(() => root.render(React.createElement(ClSegment<'all' | 'pending'>, { options: [...opts], value: 'all', onChange: () => {} })));
        expect(observers.length).toBe(1);
        act(() => root.unmount());
        expect(observers.length).toBe(0);
        root = createRoot(host);
    });
});
