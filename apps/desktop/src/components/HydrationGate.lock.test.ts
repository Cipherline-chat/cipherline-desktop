// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The boot loading screen and the Screen Lock must never be on screen together.
 *
 * Owner report: "On the lock screen I sometimes see the loading bar from when
 * Cipherline first opens, and it is behind the password lock." Two pieces of
 * the fix are covered here (the third, the lock's own worker, is in
 * LockScreenField.test.ts):
 *   - a locked app renders NO boot loader (HydrationGate yields to the lock),
 *     whether it starts locked, gets locked mid-load, or is locked on resume;
 *   - unlocking hands back to the normal sequence: loader if still loading,
 *     straight to the app if loading finished behind the lock — and a locked
 *     resume never resurrects the boot loader once the app has been shown.
 *
 * The real useScreenLock + HydrationProvider + HydrationGate run together,
 * laid out as App.tsx does it (Dashboard's hook above its sibling the gate).
 * Only the loading screen's drawing is stubbed.
 */

const h = vi.hoisted(() => ({
    onSurfaced: undefined as undefined | (() => void),
    mounts: 0,
}));

vi.mock('./AppLoadingScreen', async () => {
    const R = await import('react');
    return {
        AppLoadingScreen: (p: { phase?: string; progress?: number; onSurfaced?: () => void }) => {
            h.onSurfaced = p.onSurfaced;
            R.useEffect(() => { h.mounts++; return () => { h.mounts--; }; }, []);
            return R.createElement('div', {
                'data-testid': 'boot-loader', 'data-phase': p.phase ?? 'loading', 'data-progress': String(p.progress ?? 0),
            });
        },
    };
});

const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const fake = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        flushNow: async () => {},
    };
    return { default: fake, secureLocalStore: fake };
});

const { HydrationGate } = await import('./HydrationGate');
const { HydrationProvider, useHydration } = await import('../contexts/HydrationContext');
const { useScreenLock } = await import('../hooks/useScreenLock');
type ScreenLockHook = ReturnType<typeof useScreenLock>;
const { setScreenLockEngaged } = await import('../utils/screenLockEngaged');

const KEY = 'cipherline_screenlock_settings';
const PIN = '4821';

const cur = {} as { lock: ScreenLockHook; hydration: ReturnType<typeof useHydration> };

/** Dashboard's stand-in: the real hook, and the lock overlay's presence as a marker. */
const FakeDashboard: React.FC = () => {
    // eslint-disable-next-line react-hooks/immutability -- test probe: hands the hook's live return value out to the assertions
    cur.lock = useScreenLock();
    return React.createElement('div', { 'data-testid': 'dashboard' },
        cur.lock.isLocked ? React.createElement('div', { 'data-testid': 'lock-overlay' }) : null);
};
// eslint-disable-next-line react-hooks/immutability -- test probe: hands the hook's live return value out to the assertions
const Probe: React.FC = () => { cur.hydration = useHydration(); return null; };

const App: React.FC = () => React.createElement(HydrationProvider, null,
    React.createElement(Probe),
    React.createElement('div', { className: 'app-container' },
        React.createElement(FakeDashboard),
        React.createElement(HydrationGate)));

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const loader = () => q('boot-loader');
const settle = (...loads: Array<'conversations' | 'friends' | 'servers'>) => act(() => { loads.forEach(l => cur.hydration.markSettled(l)); });
const settleAll = () => settle('conversations', 'friends', 'servers');
const mount = () => act(() => { root.render(React.createElement(App)); });

/** Persist a REAL verifier for PIN, the way Settings does, then drop that mount. */
async function configurePin() {
    const tmpHost = document.createElement('div');
    const tmp = createRoot(tmpHost);
    act(() => { tmp.render(React.createElement(FakeDashboard)); });
    await act(async () => { await cur.lock.setPin(PIN, 4); });
    act(() => { tmp.unmount(); });
    expect(JSON.parse(store.get(KEY)!).enabled).toBe(true);
}

let osLock: (() => void) | undefined;

beforeEach(async () => {
    store.clear();
    h.onSurfaced = undefined;
    h.mounts = 0;
    osLock = undefined;
    setScreenLockEngaged(false);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        onOsLockScreen: (cb: () => void) => { osLock = cb; return () => { osLock = undefined; }; },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    setScreenLockEngaged(false);
});

describe('boot loader vs Screen Lock', () => {
    it('with no Screen Lock the boot loader shows as before (control)', () => {
        mount();
        expect(q('lock-overlay')).toBeNull();
        expect(loader()).not.toBeNull();
        expect(loader()!.getAttribute('data-phase')).toBe('loading');
    });

    it('starts locked: the lock is up on the very first render and no boot loader is ever mounted', async () => {
        await configurePin();
        const seen: number[] = [];
        // Every commit while booting: the loader must never be in the DOM, not even for a frame.
        const obs = new MutationObserver(() => seen.push(host.querySelectorAll('[data-testid="boot-loader"]').length));
        obs.observe(host, { childList: true, subtree: true });
        mount();
        obs.disconnect();
        expect(q('lock-overlay')).not.toBeNull();
        expect(loader()).toBeNull();
        expect(Math.max(0, ...seen)).toBe(0);
        expect(h.mounts).toBe(0);
    });

    it('the loads keep counting while locked, and the loader stays away', async () => {
        await configurePin();
        mount();
        settle('conversations');
        settle('friends');
        expect(loader()).toBeNull();
        expect(q('lock-overlay')).not.toBeNull();
    });

    it('unlock while still loading → the loader appears with the progress so far, then the app', async () => {
        await configurePin();
        mount();
        settle('conversations');
        expect(loader()).toBeNull();

        await act(async () => { expect(await cur.lock.unlock(PIN)).toBe(true); });
        expect(q('lock-overlay')).toBeNull();
        expect(loader()).not.toBeNull();
        expect(loader()!.getAttribute('data-phase')).toBe('loading');
        expect(Number(loader()!.getAttribute('data-progress'))).toBeCloseTo(1 / 3, 5);

        settle('friends', 'servers');
        expect(loader()!.getAttribute('data-phase')).toBe('surfacing');
        act(() => { h.onSurfaced!(); }); // the ascent finished
        expect(loader()).toBeNull();
        expect(q('dashboard')).not.toBeNull();
    });

    it('loading finished behind the lock → unlock goes straight to the app, no loader and no ascent', async () => {
        await configurePin();
        mount();
        settleAll();
        expect(loader()).toBeNull();
        await act(async () => { await cur.lock.unlock(PIN); });
        expect(q('lock-overlay')).toBeNull();
        expect(loader()).toBeNull();
        expect(h.mounts).toBe(0);
    });

    it('a wrong PIN leaves the lock up and the loader away', async () => {
        await configurePin();
        mount();
        await act(async () => { expect(await cur.lock.unlock('0000')).toBe(false); });
        expect(q('lock-overlay')).not.toBeNull();
        expect(loader()).toBeNull();
    });

    it('locking mid-load (idle / manual lock) takes the loader down, unlocking brings it back', async () => {
        await configurePin();
        // Boot with the lock released: forgetting the lock state for this mount only.
        const raw = JSON.parse(store.get(KEY)!);
        store.set(KEY, JSON.stringify({ ...raw, enabled: false }));
        mount();
        expect(loader()).not.toBeNull();

        // Turn it back on in the live hook, the way Settings does.
        await act(async () => { await cur.lock.setPin(PIN, 4); });
        act(() => { cur.lock.lockNow(); });
        expect(q('lock-overlay')).not.toBeNull();
        expect(loader()).toBeNull();

        await act(async () => { await cur.lock.unlock(PIN); });
        expect(loader()).not.toBeNull();
    });

    it('lock-on-resume after the app was shown never resurrects the boot loader', async () => {
        await configurePin();
        mount();
        await act(async () => { await cur.lock.unlock(PIN); });
        settleAll();
        act(() => { h.onSurfaced!(); });
        expect(loader()).toBeNull();

        // The OS reports the screen lock / resume: the hook locks the app.
        expect(osLock).toBeTypeOf('function');
        act(() => { osLock!(); });
        expect(q('lock-overlay')).not.toBeNull();
        expect(loader()).toBeNull();

        // ...and unlocking afterwards still shows no boot loader.
        await act(async () => { await cur.lock.unlock(PIN); });
        expect(q('lock-overlay')).toBeNull();
        expect(loader()).toBeNull();
        // Even a later hydration bump (the resume re-sync) does not raise the gate again.
        act(() => { cur.hydration.bumpGeneration(); });
        expect(loader()).toBeNull();
    });

    it('signing out / unmounting the Dashboard clears the lock signal (a stale "locked" cannot hide the next boot loader)', async () => {
        await configurePin();
        mount();
        expect(loader()).toBeNull();
        // Sign-out: Dashboard (the hook's home) goes away, the gate stays.
        act(() => {
            root.render(React.createElement(HydrationProvider, null,
                React.createElement(Probe),
                React.createElement(HydrationGate)));
        });
        expect(loader()).not.toBeNull();
    });
});
