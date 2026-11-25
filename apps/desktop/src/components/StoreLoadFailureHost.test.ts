// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
    // ClButton's module reads this at import time, and jsdom has none.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
        matches: false, addEventListener: () => {}, removeEventListener: () => {},
    });
    return { push: vi.fn(), failed: false, listeners: new Set<() => void>(), partial: false, partialListeners: new Set<() => void>() };
});
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: h.push, dismiss: () => {} }) }));
// The store's side of this (when it reports a failure) is covered against the
// real store in secureLocalStore.loadFailure.test.ts.
vi.mock('../utils/secureLocalStore', () => ({
    default: {
        onLoadFailure: (fn: () => void) => {
            if (h.failed) fn();
            h.listeners.add(fn);
            return () => { h.listeners.delete(fn); };
        },
        onUnreadableRecords: (fn: () => void) => {
            if (h.partial) fn();
            h.partialListeners.add(fn);
            return () => { h.partialListeners.delete(fn); };
        },
    },
}));

import { StoreLoadFailureHost } from './StoreLoadFailureHost';
import StorageReadFailedScreen from './StorageReadFailedScreen';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
    h.push.mockClear();
    h.failed = false;
    h.listeners.clear();
    h.partial = false;
    h.partialListeners.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
});

const mountHost = () => act(() => {
    root.render(React.createElement(StrictMode, null, React.createElement(StoreLoadFailureHost)));
});

describe('StoreLoadFailureHost', () => {
    it('says nothing when the data loaded', () => {
        mountHost();
        expect(h.push).not.toHaveBeenCalled();
    });

    it('reports a failure from before it mounted, once, even under StrictMode', () => {
        h.failed = true;
        mountHost();
        expect(h.push).toHaveBeenCalledTimes(1);
    });

    it('reports a failure that happens after it mounted (phase 2 lands after first paint)', () => {
        mountHost();
        act(() => { for (const fn of h.listeners) fn(); });
        expect(h.push).toHaveBeenCalledTimes(1);
    });

    it('stays up until acted on and offers the way back', () => {
        h.failed = true;
        mountHost();
        const toast = h.push.mock.calls[0][0];
        expect(toast.durationMs).toBe(0);
        expect(toast.action.label).toBe('Restart');
    });

    it('its action restarts the app (a page reload keeps the broken IndexedDB backend)', async () => {
        const relaunchApp = vi.fn(async () => {});
        (window as unknown as { electronAPI?: unknown }).electronAPI = { relaunchApp };
        try {
            h.failed = true;
            mountHost();
            await act(async () => { h.push.mock.calls[0][0].action.onClick(); });
            expect(relaunchApp).toHaveBeenCalledTimes(1);
        } finally {
            (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
        }
    });

    it('a partial load (records skipped) gets one calm notice that says nothing was deleted', () => {
        h.partial = true;
        mountHost();
        expect(h.push).toHaveBeenCalledTimes(1);
        const toast = h.push.mock.calls[0][0];
        expect(toast.kind).toBe('info');
        expect(toast.title).toMatch(/older history/);
        expect(toast.message).toMatch(/Nothing was deleted/);
        // Once per session, even when the store reports it again (an account switch).
        act(() => { for (const fn of h.partialListeners) fn(); });
        expect(h.push).toHaveBeenCalledTimes(1);
    });

    it('is mounted in the signed-in app', () => {
        const app = fs.readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');
        expect(app).toContain('{isAuthenticated && <StoreLoadFailureHost />}');
    });
});

describe('StorageReadFailedScreen', () => {
    it('can always be continued past, so a lasting failure cannot lock anyone out', () => {
        const onContinue = vi.fn();
        act(() => { root.render(React.createElement(StorageReadFailedScreen, { onContinue })); });
        const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Continue anyway'));
        expect(button).toBeTruthy();
        act(() => { button!.click(); });
        expect(onContinue).toHaveBeenCalledTimes(1);
    });

    it('"Try again" RESTARTS the app (relaunch), not a page reload', async () => {
        const relaunchApp = vi.fn(async () => {});
        (window as unknown as { electronAPI?: unknown }).electronAPI = { relaunchApp, platform: 'windows' };
        try {
            act(() => { root.render(React.createElement(StorageReadFailedScreen, { onContinue: () => {} })); });
            const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Restart and try again'));
            expect(button).toBeTruthy();
            await act(async () => { button!.click(); });
            expect(relaunchApp).toHaveBeenCalledTimes(1);
            // Pressing again while restarting does not queue a second relaunch.
            await act(async () => { button!.click(); });
            expect(relaunchApp).toHaveBeenCalledTimes(1);
        } finally {
            (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
        }
    });

    it.each([
        ['windows', /tray icon/, /OneDrive/, /%APPDATA%\\Cipherline/],
        ['mac', /⌘Q/, /sync app/, /Library\/Application Support\/Cipherline/],
        ['linux', /tray icon/, /sync or backup tool/, /\.config\/Cipherline/],
    ] as const)('shows %s guidance: quit fully, disk space, allow the data folder, never delete or reinstall', (platform, quit, watcher, folder) => {
        (window as unknown as { electronAPI?: unknown }).electronAPI = { platform };
        try {
            act(() => { root.render(React.createElement(StorageReadFailedScreen, { onContinue: () => {} })); });
            const text = host.textContent ?? '';
            expect(text).toMatch(quit);
            expect(text).toMatch(/free space/);
            expect(text).toMatch(watcher);
            expect(text).toMatch(folder);
            expect(text).toMatch(/Don’t delete the app’s data or reinstall/);
            expect(text).toMatch(/quarantine|moved or removed/);
        } finally {
            (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
        }
    });

    it('main.tsx shows "Opening your data…" only while the store retries, on the same root', () => {
        const main = fs.readFileSync(path.join(__dirname, '../main.tsx'), 'utf8');
        expect(main).toMatch(/secureLocalStore\.onLoadRetry\(\(\) => \{\s*getRoot\(\)\.render\([\s\S]{0,80}<StorageOpeningScreen \/>/);
        expect(main).toMatch(/\.finally\(offLoadRetry\)/);
        expect(main).toMatch(/const root = getRoot\(\);/);
    });

    it('shows the failure code (labels only) so it can be screenshotted, and nothing when there is none', () => {
        act(() => { root.render(React.createElement(StorageReadFailedScreen, { onContinue: () => {}, code: 'read/NotReadableError' })); });
        expect(host.textContent).toContain('Code: read/NotReadableError');
        act(() => { root.render(React.createElement(StorageReadFailedScreen, { onContinue: () => {}, code: null })); });
        expect(host.textContent).not.toContain('Code:');
        const main = fs.readFileSync(path.join(__dirname, '../main.tsx'), 'utf8');
        expect(main).toMatch(/code=\{storeFailureCode\(secureLocalStore\.loadHealth\(\)\)\}/);
    });

    it('offers no reset: nothing here is known to be damaged', () => {
        act(() => { root.render(React.createElement(StorageReadFailedScreen, { onContinue: () => {} })); });
        expect(host.textContent).not.toMatch(/start (over|fresh)|reset|recovery key/i);
    });

    it('main.tsx shows it for an unread store, and continuing does not come back to it', () => {
        const main = fs.readFileSync(path.join(__dirname, '../main.tsx'), 'utf8');
        expect(main).toMatch(/secureLocalStore\.isStoreUnread\(\) && !continuedPastReadFailure/);
        expect(main).toMatch(/onContinue=\{\(\) => \{ void renderUnlockedApp\(root, true\); \}\}/);
    });
});
