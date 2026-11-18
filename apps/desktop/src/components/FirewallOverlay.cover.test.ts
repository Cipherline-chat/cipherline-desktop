// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../utils/secureLocalStore', () => {
    const m = new Map<string, string>();
    const api = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
    return { default: api, secureLocalStore: api };
});

import { FirewallOverlay, FW_COVER_AFTER_MS, FW_COVERED_ATTR } from './FirewallOverlay';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import { __resetEscapeStackForTests } from '../utils/escapeStack';
import { __resetKeyClaims } from '../utils/keyClaims';
import { __resetFlappyBest } from '../utils/flappyBest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * coverRef: the game stops what it covers from rendering (the hidden Home deck's
 * animations and paint were costing the game frames), but only once its fade-in is
 * done, and the covered view is rendering again before focus goes back into it.
 */

const fakeWorker = (): WorkerLike => ({ postMessage() {}, terminate() {}, onmessage: null, onerror: null });
let root: Root;
let host: HTMLDivElement;
let column: HTMLDivElement;
const proto = HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: () => unknown };

function render(open: boolean, withCover = true) {
    const ref = { current: column };
    act(() => {
        root.render(open
            ? React.createElement(FirewallOverlay, { userId: 'u1', onClose: () => {}, placement: 'shell', coverRef: withCover ? ref : undefined })
            : React.createElement('div'));
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    __resetLoadingWorkerHost();
    __resetEscapeStackForTests();
    __resetKeyClaims();
    __resetFlappyBest();
    proto.transferControlToOffscreen = function () { return {}; };
    __setLoadingWorkerFactory(fakeWorker);
    window.requestAnimationFrame = vi.fn(() => 0);
    window.cancelAnimationFrame = vi.fn();
    column = document.createElement('div');
    const input = document.createElement('input');
    input.id = 'composer';
    column.appendChild(input);
    document.body.appendChild(column);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    column.remove();
    __setLoadingWorkerFactory('default');
    vi.useRealTimers();
});

describe('FirewallOverlay coverRef', () => {
    it('covers the view only after the fade-in, never during it', () => {
        render(true);
        expect(column.hasAttribute(FW_COVERED_ATTR)).toBe(false);
        act(() => { vi.advanceTimersByTime(FW_COVER_AFTER_MS - 1); });
        expect(column.hasAttribute(FW_COVERED_ATTR)).toBe(false);
        act(() => { vi.advanceTimersByTime(1); });
        expect(column.hasAttribute(FW_COVERED_ATTR)).toBe(true);
    });

    it('waits out the 220 ms fw-in fade in firewall.css', () => {
        const css = readFileSync(join(__dirname, '..', 'styles', 'firewall.css'), 'utf8');
        const fade = Number(/\.fw-root \{[^}]*animation: fw-in (\d+)ms/.exec(css)?.[1]);
        expect(fade).toBeGreaterThan(0);
        expect(FW_COVER_AFTER_MS).toBeGreaterThan(fade);
        expect(css).toMatch(/\[data-fw-covered\] \{ content-visibility: hidden; \}/);
    });

    it('uncovers on close, before focus goes back into the covered view', () => {
        const input = column.querySelector('input')!;
        input.focus();
        render(true);
        act(() => { vi.advanceTimersByTime(FW_COVER_AFTER_MS); });
        expect(document.activeElement).not.toBe(input); // the overlay took focus
        let coveredWhenFocused: boolean | null = null;
        input.addEventListener('focus', () => { coveredWhenFocused = column.hasAttribute(FW_COVERED_ATTR); });
        render(false);
        expect(column.hasAttribute(FW_COVERED_ATTR)).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(coveredWhenFocused).toBe(false);
    });

    it('closing during the fade-in never covers', () => {
        render(true);
        act(() => { vi.advanceTimersByTime(100); });
        render(false);
        act(() => { vi.advanceTimersByTime(FW_COVER_AFTER_MS * 2); });
        expect(column.hasAttribute(FW_COVERED_ATTR)).toBe(false);
    });

    it('without a coverRef nothing outside the overlay is touched', () => {
        render(true, false);
        act(() => { vi.advanceTimersByTime(FW_COVER_AFTER_MS * 2); });
        expect(document.querySelectorAll(`[${FW_COVERED_ATTR}]`).length).toBe(0);
    });

    it('Dashboard hands the overlay its content column', () => {
        const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
        expect(dash).toMatch(/<FirewallOverlay [^>]*coverRef=\{contentColumnRef\}/);
        expect(dash).toMatch(/<div data-banner-column="" ref=\{contentColumnRef\}/);
    });
});
