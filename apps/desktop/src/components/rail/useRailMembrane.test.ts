// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRailMembrane } from './useRailMembrane';
import type { RestBox } from './railMembrane';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (top: number): RestBox => ({ top, left: 6, width: 44, height: 44 });

const Host: React.FC<{ top: number | null; visible: boolean }> = ({ top, visible }) => {
    const ref = React.useRef<HTMLSpanElement | null>(null);
    const rest = React.useMemo(() => (top === null ? null : box(top)), [top]);
    useRailMembrane(ref, top ?? 0, rest, visible);
    return React.createElement('span', { ref, 'data-testid': 'ind' });
};

describe('useRailMembrane', () => {
    let host: HTMLDivElement, root: Root, frames: FrameRequestCallback[], clock: number;
    const render = (top: number | null, visible: boolean) => act(() => { root.render(React.createElement(Host, { top, visible })); });
    const ind = () => host.querySelector<HTMLElement>('[data-testid="ind"]')!;
    const frame = () => { clock += 16; const due = frames; frames = []; act(() => { due.forEach(f => f(clock)); }); };

    beforeEach(() => {
        frames = []; clock = performance.now();
        vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.push(f); return frames.length; });
        vi.stubGlobal('cancelAnimationFrame', () => {});
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    });

    it('coming back from hidden appears on the new tile: no flight from the old slot', () => {
        render(600, true);
        render(600, false);
        render(100, true);
        expect(ind().style.top).toBe('100px');
        expect(ind().style.height).toBe('44px');
        expect(ind().style.width).toBe('44px');
        // and it stays there
        for (let i = 0; i < 5; i++) frame();
        expect(ind().style.top).toBe('100px');
        expect(ind().style.height).toBe('44px');
    });

    it('coming back waits for the new tile to be measured: it never lands on the old one', () => {
        render(600, true);
        render(600, false);
        render(null, true); // the commit that changed slot, before the layout effect's measure
        render(100, true);
        expect(ind().style.top).toBe('100px');
        expect(ind().style.height).toBe('44px');
    });

    it('moving between tiles stays a flight across the not-yet-measured commit', () => {
        render(0, true);
        render(null, true);
        render(100, true);
        frame(); frame(); frame();
        expect(parseFloat(ind().style.height)).toBeGreaterThan(44);
    });

    it('coming back mid-flight drops the old flight too', () => {
        render(0, true);
        render(600, true);
        frame(); frame();
        render(600, false);
        render(50, true);
        expect(ind().style.top).toBe('50px');
        frame();
        expect(ind().style.height).toBe('44px');
    });

    it('a first frame stamped BEFORE the loop started cannot throw it off the rail (server first-open bug)', () => {
        // A rAF stamp is the frame's vsync. After a long commit (the first open of a
        // server) the first frame the loop receives began before the effect ran;
        // the old loop subtracted performance.now() from it and stepped backwards.
        render(0, true);
        render(100, true);
        const painted: Array<[number, number]> = [];
        const at = (ts: number) => { const due = frames; frames = []; act(() => { due.forEach(f => f(ts)); }); painted.push([parseFloat(ind().style.top), parseFloat(ind().style.height)]); };
        const t0 = performance.now();
        at(t0 - 50);                                 // began 50 ms before the effect
        for (let i = 1; i <= 60; i++) at(t0 - 50 + i * 16);
        for (const [top, h] of painted) {
            expect(Number.isFinite(top) && Number.isFinite(h)).toBe(true);
            expect(top).toBeGreaterThanOrEqual(-0.01);           // never above the DM tile
            expect(top + h).toBeLessThanOrEqual(144.01);          // never past the target's bottom
        }
        // it moved on its very first frame, and it lands
        expect(painted[0][1]).toBeGreaterThan(44);
        expect(ind().style.top).toBe('100px');
        expect(ind().style.height).toBe('44px');
    });

    it('a move between visible tiles still travels and stretches', () => {
        render(0, true);
        render(100, true);
        frame(); frame(); frame();
        expect(parseFloat(ind().style.height)).toBeGreaterThan(44);
        expect(parseFloat(ind().style.top)).toBeLessThan(100);
    });
});
