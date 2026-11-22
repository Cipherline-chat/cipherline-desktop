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

import { FirewallOverlay } from './FirewallOverlay';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import { __resetEscapeStackForTests } from '../utils/escapeStack';
import { __resetKeyClaims } from '../utils/keyClaims';
import { __resetFlappyBest } from '../utils/flappyBest';
import { useAppInFront } from '../utils/animatedImage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The probe runs on stable too (light), and the shell's decoration rests while the game is open. */
const posted: unknown[] = [];
const fakeWorker = (): WorkerLike => ({ postMessage(m: unknown) { posted.push(m); }, terminate() {}, onmessage: null, onerror: null });
let root: Root, host: HTMLDivElement, column: HTMLDivElement;
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
    posted.length = 0;
    __resetLoadingWorkerHost(); __resetEscapeStackForTests(); __resetKeyClaims(); __resetFlappyBest();
    proto.transferControlToOffscreen = function () { return {}; };
    __setLoadingWorkerFactory(fakeWorker);
    window.requestAnimationFrame = vi.fn(() => 0);
    window.cancelAnimationFrame = vi.fn();
    column = document.createElement('div');
    document.body.appendChild(column);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove(); column.remove();
    __setLoadingWorkerFactory('default');
    document.documentElement.removeAttribute('data-cl-game');
});

describe('FirewallOverlay on a stable build', () => {
    it('asks the worker for the probe (stable has no VITE_APP_VERSION staging suffix here)', () => {
        render(true);
        const init = posted.find(m => (m as { type?: string }).type === 'init') as { probe?: boolean } | undefined;
        expect(init?.probe).toBe(true);
    });
});

describe('the shell rests while the game is open', () => {
    it('sets data-cl-game on <html> while open and clears it on close', () => {
        render(true);
        expect(document.documentElement.getAttribute('data-cl-game')).toBe('on');
        render(false);
        expect(document.documentElement.hasAttribute('data-cl-game')).toBe(false);
    });
    it('freezes animated images (useAppInFront) while open, thaws on close', () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const seen: boolean[] = [];
        const P = () => { seen.push(useAppInFront()); return null; };
        const h2 = document.createElement('div');
        const r2 = createRoot(h2);
        act(() => r2.render(React.createElement(P)));
        expect(seen.at(-1)).toBe(true);
        render(true);
        expect(seen.at(-1)).toBe(false);
        render(false);
        expect(seen.at(-1)).toBe(true);
        act(() => r2.unmount());
    });
    it('the inline pane placement (no coverRef) touches nothing', () => {
        render(true, false);
        expect(document.documentElement.hasAttribute('data-cl-game')).toBe(false);
    });
    it('firewall.css stops the rail mascot and pauses the small loops under data-cl-game', () => {
        const css = readFileSync(join(__dirname, '..', 'styles', 'firewall.css'), 'utf8');
        expect(css).toMatch(/:root\[data-cl-game="on"\] \.k2-leg:not\(\.fw-root \*\)/);
        expect(css).toMatch(/:root\[data-cl-game="on"\] \.dock-bead:not\(\.fw-root \*\)/);
        expect(css).toMatch(/animation-play-state: paused/);
    });
});
