// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ClientStatus } from '../utils/clientControl';

/**
 * ClientControlGate: shows the blocking shutdown screen from any signal,
 * dismisses it ONLY when /v1/client-status says the switch lifted, treats a
 * failed check as "no information" (never as lifted), makes the app inert
 * while blocked, and reports a below-floor build to the update screen.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { ClientControlGate } = await import('./ClientControlGate');
const {
    APP_SUSPENDED_EVENT, APP_RESUMED_EVENT, UPGRADE_REQUIRED_EVENT,
} = await import('../utils/clientControl');

const OPEN: ClientStatus = { shutdown: null, minVersionDesktop: '0.0.0', updateUrl: 'https://cipherline.chat/download', retryAfterS: 30, betaDiagnostics: false };
const DOWN: ClientStatus = {
    ...OPEN,
    shutdown: { title: 'Back soon', message: 'Patching a security issue.', until: null, since: null },
};

let appRoot: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.useFakeTimers();
    appRoot = document.createElement('div');
    appRoot.id = 'root';
    document.body.appendChild(appRoot);
    host = document.createElement('div');
    appRoot.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    appRoot.remove();
    vi.useRealTimers();
});

const screen = () => document.querySelector('[data-testid="app-suspended-screen"]');
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

async function mount(fetchStatus: () => Promise<ClientStatus | null>, appVersion = '1.0.23') {
    await act(async () => {
        root.render(React.createElement(ClientControlGate, { fetchStatus, appVersion }));
    });
    await flush();
}

describe('ClientControlGate', () => {
    it('boot check: a live shutdown blocks immediately, with the server copy as text', async () => {
        await mount(async () => DOWN);
        expect(screen()).not.toBeNull();
        expect(screen()!.getAttribute('role')).toBe('alertdialog');
        expect(screen()!.textContent).toContain('Back soon');
        expect(screen()!.textContent).toContain('Patching a security issue.');
        expect(appRoot.inert).toBe(true); // nothing underneath can be clicked or focused
    });

    it('no shutdown at boot → nothing shown, app not inert', async () => {
        await mount(async () => OPEN);
        expect(screen()).toBeNull();
        expect(appRoot.inert).toBeFalsy();
    });

    it('a suspended signal (503 / WS) shows it; it clears ONLY when the status says lifted, then fires app-resumed', async () => {
        let status: ClientStatus | null = OPEN;
        const fetchStatus = vi.fn(async () => status);
        await mount(fetchStatus);
        const resumed = vi.fn();
        window.addEventListener(APP_RESUMED_EVENT, resumed);

        status = DOWN;
        await act(async () => {
            window.dispatchEvent(new CustomEvent(APP_SUSPENDED_EVENT, { detail: DOWN.shutdown }));
        });
        expect(screen()).not.toBeNull();

        // A failed check (offline, proxy error) is NOT "lifted".
        status = null;
        await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
        expect(screen()).not.toBeNull();

        // Still shut down on the next poll.
        status = DOWN;
        await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
        expect(screen()).not.toBeNull();
        expect(resumed).not.toHaveBeenCalled();

        // Lifted → "We're back!" beat, app-resumed (useRealtime redials), then gone.
        status = OPEN;
        await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
        expect(resumed).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(screen()).toBeNull();
        expect(appRoot.inert).toBe(false);
        window.removeEventListener(APP_RESUMED_EVENT, resumed);
    });

    it('a content-less signal (bare 4503 close) fetches the real notice', async () => {
        let status: ClientStatus = OPEN;
        const fetchStatus = vi.fn(async () => status);
        await mount(fetchStatus);
        const callsAtBoot = fetchStatus.mock.calls.length;
        status = DOWN;
        await act(async () => { window.dispatchEvent(new CustomEvent(APP_SUSPENDED_EVENT)); });
        await flush();
        expect(fetchStatus.mock.calls.length).toBeGreaterThan(callsAtBoot);
        expect(screen()!.textContent).toContain('Back soon');
    });

    it('"Check again" checks immediately', async () => {
        let status: ClientStatus = DOWN;
        const fetchStatus = vi.fn(async () => status);
        await mount(fetchStatus);
        status = OPEN;
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Check again'))!;
        expect(btn).toBeTruthy();
        await act(async () => { btn.click(); });
        await flush();
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(screen()).toBeNull();
    });

    it('the app below the effective floor triggers the update screen at boot', async () => {
        const upgrade = vi.fn();
        window.addEventListener(UPGRADE_REQUIRED_EVENT, upgrade as EventListener);
        await mount(async () => ({ ...OPEN, minVersionDesktop: '1.0.24' }), '1.0.23');
        expect(upgrade).toHaveBeenCalledTimes(1);
        expect((upgrade.mock.calls[0][0] as CustomEvent).detail).toEqual({ minVersion: '1.0.24' });
        window.removeEventListener(UPGRADE_REQUIRED_EVENT, upgrade as EventListener);
    });

    it('at or above the floor → no update screen', async () => {
        const upgrade = vi.fn();
        window.addEventListener(UPGRADE_REQUIRED_EVENT, upgrade as EventListener);
        await mount(async () => ({ ...OPEN, minVersionDesktop: '1.0.23' }), '1.0.23');
        expect(upgrade).not.toHaveBeenCalled();
        window.removeEventListener(UPGRADE_REQUIRED_EVENT, upgrade as EventListener);
    });

    it('re-checks on every WebSocket (re)connect', async () => {
        const fetchStatus = vi.fn(async () => OPEN);
        await mount(fetchStatus);
        const n = fetchStatus.mock.calls.length;
        await act(async () => { window.dispatchEvent(new CustomEvent('cipherline:ws-connected')); });
        await flush();
        expect(fetchStatus.mock.calls.length).toBe(n + 1);
    });

    it('Escape does not dismiss; app shortcuts underneath never see keys', async () => {
        await mount(async () => DOWN);
        const seen = vi.fn();
        appRoot.addEventListener('keydown', seen);
        await act(async () => {
            appRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            appRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        });
        expect(seen).not.toHaveBeenCalled();
        expect(screen()).not.toBeNull();
    });
});
