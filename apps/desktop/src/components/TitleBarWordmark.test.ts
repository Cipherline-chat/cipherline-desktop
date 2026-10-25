// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recordEggFound = vi.fn();
vi.mock('../utils/eggProgress', () => ({ recordEggFound: (id: string) => recordEggFound(id) }));

import { TitleBarWordmark, LAP_MS, LAP_STILL_MS, TITLEBAR_LAP_EGG } from './TitleBarWordmark';

let root: Root;
let host: HTMLDivElement;
let reduced = false;

const word = () => host.querySelector('[data-testid="titlebar-wordmark"]') as HTMLElement;
const lap = () => document.querySelector('[data-testid="titlebar-lap"]');
const click = () => act(() => { word().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const clicks = async (n: number, gapMs: number) => {
    for (let i = 0; i < n; i++) {
        click();
        await act(async () => { await vi.advanceTimersByTimeAsync(gapMs); });
    }
};

beforeEach(() => {
    reduced = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce') ? reduced : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    recordEggFound.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(React.createElement(TitleBarWordmark)); });
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('TitleBarWordmark: the word', () => {
    it('is still the plain, aria-hidden "Cipherline" mark', () => {
        expect(word().textContent).toBe('Cipherline');
        expect(word().getAttribute('aria-hidden')).toBe('true');
        expect(word().getAttribute('data-side')).toBeTruthy();
    });

    it('can receive clicks (carved out of the drag region), and only the word does', () => {
        const css = readFileSync(join(__dirname, '..', 'styles', 'titlebar-lap.css'), 'utf8');
        expect(word().className).toContain('is-clickable');
        expect(css).toMatch(/\.cl-titlebar-wordmark\.is-clickable\s*\{[^}]*pointer-events:\s*auto/);
        expect(css).toMatch(/\.cl-titlebar-wordmark\.is-clickable\s*\{[^}]*-webkit-app-region:\s*no-drag/);
        // above App.tsx's z-index:9999 drag strip, so the click reaches it
        expect(css).toMatch(/\.cl-titlebar-wordmark\.is-clickable\s*\{[^}]*z-index:\s*10000/);
    });
});

describe('TitleBarWordmark: ten clicks in four seconds', () => {
    it('sets off Keys on the tenth quick click, and counts the egg once', async () => {
        await clicks(9, 300);
        expect(lap()).toBeNull();
        expect(recordEggFound).not.toHaveBeenCalled();
        click();
        expect(lap()).not.toBeNull();
        expect(lap()!.className).toContain('tb-lap--swim');
        expect(recordEggFound).toHaveBeenCalledTimes(1);
        expect(recordEggFound).toHaveBeenCalledWith('titlebar-lap');
        expect(TITLEBAR_LAP_EGG).toBe('titlebar-lap');
    });

    it('does nothing for nine clicks', async () => {
        await clicks(9, 100);
        expect(lap()).toBeNull();
    });

    it('does nothing when ten clicks take longer than four seconds', async () => {
        await clicks(10, 500);
        expect(lap()).toBeNull();
        expect(recordEggFound).not.toHaveBeenCalled();
    });

    it('the lap is a non-interactive overlay that goes away on its own', async () => {
        await clicks(9, 100);
        click();
        const el = lap()!;
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.querySelector('button, a, input, [tabindex]')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(LAP_MS + 50); });
        expect(lap()).toBeNull();
    });

    it('rests after a lap: ten more clicks right away do nothing, ten later do', async () => {
        await clicks(9, 100);
        click();
        await act(async () => { await vi.advanceTimersByTimeAsync(LAP_MS + 50); });
        recordEggFound.mockClear();
        await clicks(10, 100);
        expect(lap()).toBeNull();
        expect(recordEggFound).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
        await clicks(9, 100);
        click();
        expect(lap()).not.toBeNull();
    });

    it('reduced motion: Keys does not swim; he appears still for a moment', async () => {
        reduced = true;
        await clicks(9, 100);
        click();
        expect(lap()!.className).toContain('tb-lap--still');
        expect(lap()!.className).not.toContain('tb-lap--swim');
        expect(recordEggFound).toHaveBeenCalledWith('titlebar-lap');
        await act(async () => { await vi.advanceTimersByTimeAsync(LAP_STILL_MS + 50); });
        expect(lap()).toBeNull();
    });

    it('unmounting mid-lap leaves nothing behind', async () => {
        await clicks(9, 100);
        click();
        act(() => { root.unmount(); });
        expect(lap()).toBeNull();
        root = createRoot(host);
    });
});

describe('the stylesheet', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'titlebar-lap.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    it('animates only transform and opacity', () => {
        const bodies = Array.from(css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\n)\}/g)).map(m => m[1]);
        expect(bodies.length).toBeGreaterThanOrEqual(4);
        for (const b of bodies) {
            for (const m of b.matchAll(/([a-z-]+)\s*:/g)) expect(['transform', 'opacity']).toContain(m[1]);
        }
    });
    it('never catches a click', () => {
        expect(css).toMatch(/\.tb-lap\s*\{[^}]*pointer-events:\s*none/);
    });
});
