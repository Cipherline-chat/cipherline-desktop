// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The full-screen staging gate. Main does the real work (verify + remember);
 * this checks the screen sends the attempt, renders main's answer, and that
 * main.tsx shows it INSTEAD of the app (before anything that talks to the
 * server is mounted).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { default: StagingLockScreen } = await import('./StagingLockScreen');

let root: Root;
let host: HTMLDivElement;
const unlockStaging = vi.fn();

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    unlockStaging.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = { unlockStaging };
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const input = () => host.querySelector('input') as HTMLInputElement;
const submitBtn = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? '';

function mount(onUnlocked = vi.fn(), initialRetryAfterMs = 0) {
    act(() => root.render(React.createElement(StagingLockScreen, { onUnlocked, initialRetryAfterMs })));
    return onUnlocked;
}

function type(value: string) {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function pressEnter() {
    // Enter in a single-field form = implicit submission → the form's submit event.
    await act(async () => {
        input().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
}

describe('StagingLockScreen', () => {
    it('renders one autofocused password field, a disabled Unlock button and the non-tester line — no links', () => {
        mount();
        const fields = host.querySelectorAll('input');
        expect(fields.length).toBe(1);
        expect(input().type).toBe('password');
        expect(document.activeElement).toBe(input());
        expect(input().maxLength).toBe(256);
        expect(submitBtn().textContent).toContain('Unlock');
        expect(submitBtn().disabled).toBe(true);
        expect(host.textContent).toContain(
            'This is a pre-release test build. Get the stable release at cipherline.chat/download.',
        );
        expect(host.querySelectorAll('a').length).toBe(0);
    });

    it('show/hide toggles the field type', () => {
        mount();
        const toggle = host.querySelector('button[aria-label="Show password"]') as HTMLButtonElement;
        act(() => toggle.click());
        expect(input().type).toBe('text');
        act(() => (host.querySelector('button[aria-label="Hide password"]') as HTMLButtonElement).click());
        expect(input().type).toBe('password');
    });

    it('Enter submits; a wrong password shows "Wrong password", clears the field and stays locked', async () => {
        unlockStaging.mockResolvedValue({ ok: false, retryAfterMs: 0 });
        const onUnlocked = mount();
        type('not-it');
        await pressEnter();
        expect(unlockStaging).toHaveBeenCalledWith('not-it');
        expect(alertText()).toBe('Wrong password');
        expect(input().value).toBe('');
        expect(onUnlocked).not.toHaveBeenCalled();
    });

    it('shows the backoff from main as a countdown and blocks submitting until it ends', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(1_000_000);
        unlockStaging.mockResolvedValue({ ok: false, retryAfterMs: 80_000 });
        mount();
        type('guess');
        await pressEnter();
        expect(alertText()).toBe('Too many attempts — try again in 1m 20s');
        type('again');
        expect(submitBtn().disabled).toBe(true);
        await pressEnter();
        expect(unlockStaging).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(30_000); });
        expect(alertText()).toBe('Too many attempts — try again in 50s');
        act(() => { vi.advanceTimersByTime(50_000); });
        expect(alertText()).toBe('');
        expect(submitBtn().disabled).toBe(false);
    });

    it('honours a backoff already in force at mount (relaunch mid-backoff)', () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        mount(vi.fn(), 45_000);
        expect(alertText()).toBe('Too many attempts — try again in 45s');
    });

    it('the right password calls onUnlocked', async () => {
        unlockStaging.mockResolvedValue({ ok: true, retryAfterMs: 0 });
        const onUnlocked = mount();
        type('the-right-one');
        await pressEnter();
        expect(onUnlocked).toHaveBeenCalledTimes(1);
    });

    it('a failed IPC is reported, not treated as success', async () => {
        unlockStaging.mockRejectedValue(new Error('boom'));
        const onUnlocked = mount();
        type('x');
        await pressEnter();
        expect(onUnlocked).not.toHaveBeenCalled();
        expect(alertText()).toBe('Could not check the password. Please try again.');
    });
});

describe('main.tsx boot order', () => {
    const src = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

    it('asks main for the lock status and renders the lock screen BEFORE any provider mounts', () => {
        const gate = src.indexOf('await readStagingLockStatus()');
        const lockRender = src.indexOf('<StagingLockScreen');
        const storageLocked = src.indexOf('secureLocalStore.isLocked()');
        const auth = src.indexOf('<AuthProvider>');
        expect(gate).toBeGreaterThan(-1);
        expect(lockRender).toBeGreaterThan(gate);
        expect(storageLocked).toBeGreaterThan(lockRender);
        expect(auth).toBeGreaterThan(lockRender);
        // The locked branch returns without rendering the app.
        const lockedBranch = src.slice(gate, src.indexOf('await renderUnlockedApp(root);'));
        expect(lockedBranch).toContain('return;');
        expect(lockedBranch).not.toContain('<AuthProvider>');
        expect(lockedBranch).not.toContain('RouterProvider');
    });

    it('the app itself is only rendered from renderUnlockedApp', () => {
        const fn = src.slice(src.indexOf('async function renderUnlockedApp'));
        expect(fn).toContain('<AuthProvider>');
        expect(src.split('<AuthProvider>').length).toBe(2); // exactly one mount site
    });
});
