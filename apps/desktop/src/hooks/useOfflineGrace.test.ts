// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useOfflineGrace, OFFLINE_GRACE_MS } from './useOfflineGrace';
import { OfflineScreen } from '../components/OfflineScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../components/mascot/Keys', () => ({ Keys: () => null }));

/** Mirrors App.tsx: raw signal → useOfflineGrace → OfflineScreen. Also exposes
 *  the value the hook returns and the raw signal a non-UI consumer would read. */
const seen: { overlay: boolean[]; raw: boolean[] } = { overlay: [], raw: [] };
function Harness({ isOnline, grace }: { isOnline: boolean; grace?: number }) {
    const overlayOnline = useOfflineGrace(isOnline, grace);
    seen.overlay.push(overlayOnline);
    seen.raw.push(isOnline);
    return React.createElement(OfflineScreen, { isOnline: overlayOnline });
}

let root: Root;
let host: HTMLDivElement;
const render = (isOnline: boolean, grace?: number) =>
    act(() => { root.render(React.createElement(Harness, { isOnline, grace })); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const screenUp = () => host.textContent?.includes("You're offline") === true;
const backBeat = () => host.textContent?.includes('Back online!') === true;

beforeEach(() => {
    vi.useFakeTimers();
    seen.overlay = []; seen.raw = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

describe('useOfflineGrace → OfflineScreen', () => {
    it('grace constant is 10 s', () => {
        expect(OFFLINE_GRACE_MS).toBe(10_000);
    });

    it('online: nothing shown', () => {
        render(true);
        expect(screenUp()).toBe(false);
        expect(host.textContent).toBe('');
    });

    it('offline for 9.9 s: still nothing', () => {
        render(true);
        render(false);
        advance(9_900);
        expect(screenUp()).toBe(false);
    });

    it('offline for 10 s: the screen appears', () => {
        render(true);
        render(false);
        advance(9_900);
        expect(screenUp()).toBe(false);
        advance(100);
        expect(screenUp()).toBe(true);
    });

    it('coming back online inside the grace cancels it, and the timer restarts on the next drop', () => {
        render(true);
        render(false);
        advance(9_000);
        render(true);          // back at 9 s
        advance(30_000);       // the old timer must be dead
        expect(screenUp()).toBe(false);
        expect(backBeat()).toBe(false);

        render(false);         // fresh drop
        advance(9_900);
        expect(screenUp()).toBe(false);   // does NOT inherit the earlier 9 s
        advance(100);
        expect(screenUp()).toBe(true);
    });

    it('flapping offline/online never shows it', () => {
        render(true);
        for (let i = 0; i < 20; i++) {
            render(false);
            expect(screenUp()).toBe(false);
            advance(4_000);
            expect(screenUp()).toBe(false);
            render(true);
            expect(backBeat()).toBe(false);
            advance(1_000);
        }
        expect(screenUp()).toBe(false);
        expect(backBeat()).toBe(false);
        expect(host.textContent).toBe('');
    });

    it('a cold start while already offline also waits out the grace', () => {
        render(false);
        advance(9_900);
        expect(screenUp()).toBe(false);
        advance(100);
        expect(screenUp()).toBe(true);
    });

    it('shown, then online: existing "Back online!" beat, then it clears', () => {
        render(true);
        render(false);
        advance(10_000);
        expect(screenUp()).toBe(true);
        render(true);                 // the online edge is not delayed
        expect(backBeat()).toBe(true);
        advance(600);
        expect(host.textContent).toBe('');
    });

    it('the hook never delays the online edge, and never alters the raw signal', () => {
        render(true);
        render(false);
        advance(10_000);
        seen.overlay = [];
        render(true);
        expect(seen.overlay[seen.overlay.length - 1]).toBe(true);
        // The harness's own raw input is untouched: instant reads stay instant.
        expect(seen.raw[seen.raw.length - 1]).toBe(true);
    });

    it('honours a custom grace', () => {
        render(true, 2_000);
        render(false, 2_000);
        advance(1_900);
        expect(screenUp()).toBe(false);
        advance(100);
        expect(screenUp()).toBe(true);
    });
});

describe('App wiring', () => {
    it('only the OfflineScreen gets the graced value; useNetworkStatus stays the raw source', () => {
        const src = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8').replace(/\/\/.*$/gm, '');
        expect(src).toMatch(/useOfflineGrace\(isOnline\)/);
        expect(src).toMatch(/<OfflineScreen isOnline=\{overlayOnline\} \/>/);
        expect(src).not.toMatch(/<OfflineScreen isOnline=\{isOnline\}/);
    });
});
