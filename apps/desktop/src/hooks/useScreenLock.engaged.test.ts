// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * useScreenLock publishes "the lock is up" (utils/screenLockEngaged.ts) for the
 * boot loading screen, which is Dashboard's sibling and cannot see the hook.
 */
const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        flushNow: async () => {},
    },
}));
vi.mock('../utils/crypto', () => ({ deriveBackupKey: vi.fn() }));

import { useScreenLock, type ScreenLockHook } from './useScreenLock';
import { isScreenLockEngaged, setScreenLockEngaged } from '../utils/screenLockEngaged';

const KEY = 'cipherline_screenlock_settings';
const configured = {
    enabled: true, timeoutMinutes: 5, lockOnOsLock: true, pinLength: 6,
    verifier: { saltB64: 'AA==', ivB64: 'AA==', ctB64: 'AA==', iterations: 1 },
};

const cur = {} as { hook: ScreenLockHook; seen: boolean | null };
cur.seen = null;
/** A sibling rendered AFTER the hook, as HydrationGate is after Dashboard. */
const Sibling: React.FC = () => { if (cur.seen === null) cur.seen = isScreenLockEngaged(); return null; };
// eslint-disable-next-line react-hooks/immutability -- test probe: hands the hook's live return value out to the assertions
const Probe: React.FC = () => { cur.hook = useScreenLock(); return React.createElement(Sibling); };

beforeEach(() => { store.clear(); cur.seen = null; setScreenLockEngaged(false); });

describe('screen-lock engaged signal', () => {
    it('is already true when a sibling renders in the SAME first pass (app starts locked)', () => {
        store.set(KEY, JSON.stringify(configured));
        const root = createRoot(document.createElement('div'));
        act(() => { root.render(React.createElement(Probe)); });
        expect(cur.seen).toBe(true);
        expect(isScreenLockEngaged()).toBe(true);
        act(() => root.unmount());
    });

    it('is false when no Screen Lock is configured', () => {
        const root = createRoot(document.createElement('div'));
        act(() => { root.render(React.createElement(Probe)); });
        expect(cur.seen).toBe(false);
        expect(isScreenLockEngaged()).toBe(false);
        act(() => root.unmount());
    });

    it('follows the lock: released by forgot-PIN', () => {
        store.set(KEY, JSON.stringify(configured));
        const root = createRoot(document.createElement('div'));
        act(() => { root.render(React.createElement(Probe)); });
        expect(isScreenLockEngaged()).toBe(true);
        act(() => { cur.hook.forgotPinReset(); });
        expect(cur.hook.isLocked).toBe(false);
        expect(isScreenLockEngaged()).toBe(false);
        act(() => root.unmount());
    });

    it('is cleared when the hook\'s home unmounts (sign-out / account switch)', () => {
        store.set(KEY, JSON.stringify(configured));
        const root = createRoot(document.createElement('div'));
        act(() => { root.render(React.createElement(Probe)); });
        expect(isScreenLockEngaged()).toBe(true);
        act(() => root.unmount());
        expect(isScreenLockEngaged()).toBe(false);
    });
});
