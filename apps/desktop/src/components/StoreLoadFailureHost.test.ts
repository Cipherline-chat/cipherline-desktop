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
    return { push: vi.fn(), failed: false, listeners: new Set<() => void>() };
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
        expect(toast.action.label).toBe('Reload');
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
