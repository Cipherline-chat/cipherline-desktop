// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * "Forgot your PIN?" signs the user out. The reset used to live only in React
 * state + a persist EFFECT; sign-out unmounts Dashboard (the hook's home) in
 * the same render, so the effect never ran, the stored verifier survived, and
 * signing back in asked for the PIN again.
 */
const store = new Map<string, string>();
const flushNow = vi.fn(async () => {});
vi.mock('../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        flushNow: () => flushNow(),
    },
}));
vi.mock('../utils/crypto', () => ({ deriveBackupKey: vi.fn() }));

import { useScreenLock, type ScreenLockHook } from './useScreenLock';

const KEY = 'cipherline_screenlock_settings';
const configured = {
    enabled: true, timeoutMinutes: 5, lockOnOsLock: true, pinLength: 6,
    verifier: { saltB64: 'AA==', ivB64: 'AA==', ctB64: 'AA==', iterations: 1 },
};

let hook: ScreenLockHook;
const Probe: React.FC = () => { hook = useScreenLock(); return null; };

beforeEach(() => { store.clear(); flushNow.mockClear(); store.set(KEY, JSON.stringify(configured)); });

describe('forgotPinReset', () => {
    it('clears the stored verifier immediately, even if the component unmounts before any effect runs', async () => {
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => { root.render(React.createElement(Probe)); });
        expect(hook.isLocked).toBe(true);
        expect(JSON.parse(store.get(KEY)!).verifier).not.toBeNull();

        // What ScreenLockOverlay does: reset, then sign out (which unmounts us) in one batch.
        act(() => {
            hook.forgotPinReset();
            root.unmount();
        });

        const saved = JSON.parse(store.get(KEY)!);
        expect(saved.enabled).toBe(false);
        expect(saved.verifier).toBeNull();
        expect(saved.pinLength).toBe(6); // the rest of the settings are kept
        expect(flushNow).toHaveBeenCalled();
    });

    it('a fresh mount afterwards (signing back in) is NOT locked', () => {
        const root = createRoot(document.createElement('div'));
        act(() => { root.render(React.createElement(Probe)); });
        act(() => { hook.forgotPinReset(); root.unmount(); });

        const root2 = createRoot(document.createElement('div'));
        act(() => { root2.render(React.createElement(Probe)); });
        expect(hook.settings.enabled).toBe(false);
        expect(hook.isLocked).toBe(false);
        act(() => { root2.unmount(); });
    });
});
