// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useElementSize } from './useElementSize';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fake = { cb: ResizeObserverCallback; el: Element | null; live: boolean };
let observers: Fake[] = [];

beforeEach(() => {
    observers = [];
    vi.stubGlobal('ResizeObserver', class {
        private rec: Fake;
        constructor(cb: ResizeObserverCallback) { this.rec = { cb, el: null, live: true }; observers.push(this.rec); }
        observe(el: Element) { this.rec.el = el; }
        unobserve() {}
        disconnect() { this.rec.live = false; }
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

const fire = (el: Element, width: number, height: number) => {
    const o = observers.find(x => x.live && x.el === el);
    if (!o) throw new Error('nothing is observing this element');
    act(() => o.cb([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
};

let seen: { w: number; h: number } = { w: -1, h: -1 };
/** `show` is what the fullscreen overlay's early return does: no element while off. */
const Probe: React.FC<{ show: boolean; k?: string }> = ({ show, k }) => {
    const { ref, size } = useElementSize<HTMLDivElement>();
    seen = size;
    return show ? React.createElement('div', { ref, key: k, id: 'grid' }) : null;
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (show: boolean, k?: string) => act(() => root.render(React.createElement(Probe, { show, k })));
const grid = () => document.getElementById('grid')!;

describe('useElementSize', () => {
    it('an element that appears later is measured (entering fullscreen with nothing else changing)', () => {
        render(false);
        expect(observers.length).toBe(0);
        render(true);
        fire(grid(), 1920, 1080);
        expect(seen).toEqual({ w: 1920, h: 1080 });
    });

    it('follows live size changes', () => {
        render(true);
        fire(grid(), 800, 600);
        fire(grid(), 2560, 1080);
        expect(seen).toEqual({ w: 2560, h: 1080 });
    });

    it('leaving and re-entering: the new element is observed, the old observer is gone, no stale size carries over', () => {
        render(true);
        const first = grid();
        fire(first, 800, 600);
        render(false);
        expect(seen).toEqual({ w: 0, h: 0 });
        expect(observers.filter(o => o.live).length).toBe(0);
        render(true);
        expect(grid()).not.toBe(first);
        fire(grid(), 1600, 900);
        expect(seen).toEqual({ w: 1600, h: 900 });
    });

    it('a swap to a different element is picked up (the grid and people grids are separate elements)', () => {
        render(true, 'a');
        const a = grid();
        render(true, 'b');
        expect(grid()).not.toBe(a);
        fire(grid(), 1280, 720);
        expect(seen).toEqual({ w: 1280, h: 720 });
        expect(observers.filter(o => o.live).length).toBe(1);
    });
});

describe('FullscreenOverlay wiring', () => {
    const src = readFileSync(join(__dirname, '..', 'components/call/FullscreenOverlay.tsx'), 'utf8');

    it('measures through the hook: nothing keys the observer on layout.mode any more', () => {
        expect(src).toContain('useElementSize<HTMLDivElement>()');
        expect(src).not.toMatch(/\}, \[layout\.mode\]\);/);
        expect((src.match(/ref=\{gridRef\}/g) ?? []).length).toBe(2);
    });

    it('the column count comes from the measured size and the live count, on every render', () => {
        expect(src).toContain('bestGrid(gridCount, gridSize.w, gridSize.h)');
    });
});
