// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Turning ON Screen Lock offers - once, inline - to hide OS notification
 * previews, but only when the notification setting currently puts message TEXT
 * in the toast ('full'). The REAL ScreenLockSettings runs inside the REAL
 * NotificationProvider (so "Hide" is proven to go through the shared setter and
 * persist like a manual change); only the PIN keypad, the modal shell and the
 * storage backend are stubbed.
 */

const store = new Map<string, string>();
// Only the default export (what NotificationContext uses) is swapped; other
// importers of this module (crypto.ts → messageStore) keep the real named one.
vi.mock('../utils/secureLocalStore', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ userId: 'u1', isAuthenticated: true }) }));
// Keypad stand-in: one button that "types" the PIN and auto-submits it.
vi.mock('./SlottedCodeInput', () => ({
    default: (p: { onAutoSubmit?: (code: string) => void }) =>
        React.createElement('button', { 'data-testid': 'pin-submit', onClick: () => p.onAutoSubmit?.('1234') }, 'type pin'),
}));
// Modal shell without portal/animation: children only while open.
vi.mock('./cl', async (orig) => {
    const real = await orig<typeof import('./cl')>();
    return {
        ...real,
        ClModal: (p: { open: boolean; children: React.ReactNode }) => (p.open ? React.createElement('div', { 'data-testid': 'modal' }, p.children) : null),
    };
});

window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { default: ScreenLockSettings } = await import('./ScreenLockSettings');
const { NotificationProvider, useNotificationPrefs } = await import('../contexts/NotificationContext');

const PREFS_KEY = 'cipherline_notif_global_prefs_u1';
const storedPreview = () => (store.has(PREFS_KEY) ? JSON.parse(store.get(PREFS_KEY)!).show_preview : undefined);

/** Stateful stand-in for useScreenLock: setPin enables, disable disables. */
const Harness: React.FC<{ startEnabled?: boolean }> = ({ startEnabled = false }) => {
    const [enabled, setEnabled] = useState(startEnabled);
    const { prefs } = useNotificationPrefs();
    const screenLock = {
        settings: { enabled, pinLength: 4, timeoutMinutes: 5, lockOnOsLock: true, verifier: null },
        isLocked: false, attempts: 0, lockedOutUntil: null,
        lockNow: vi.fn(), unlock: vi.fn(),
        setPin: vi.fn(async () => { setEnabled(true); }),
        changePin: vi.fn(async () => { return true; }),
        disable: vi.fn(async () => { setEnabled(false); return true; }),
        forgotPinReset: vi.fn(), setTimeoutMinutes: vi.fn(), setLockOnOsLock: vi.fn(),
    } as unknown as React.ComponentProps<typeof ScreenLockSettings>['screenLock'];
    const keybinds = { binds: {} } as unknown as React.ComponentProps<typeof ScreenLockSettings>['keybinds'];
    return React.createElement(React.Fragment, null,
        React.createElement('span', { 'data-testid': 'probe' }, prefs.show_preview),
        React.createElement(ScreenLockSettings, { screenLock, keybinds }));
};

let host: HTMLDivElement;
let root: Root;

const mount = (startEnabled = false) => act(() => {
    root.render(React.createElement(NotificationProvider, null, React.createElement(Harness, { startEnabled })));
});
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
/** The notification setting as the app sees it (what NotificationsTab reads). */
const preview = () => $('[data-testid="probe"]')!.textContent;
const buttonByText = (text: string) =>
    Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };

/** Drive the real first-time setup: Set up → 4 digits → PIN → confirm PIN. */
const enableLock = async () => {
    await click(buttonByText('Set up'));
    await click(buttonByText('4 digits'));
    await click($('[data-testid="pin-submit"]'));   // enter
    await click($('[data-testid="pin-submit"]'));   // confirm (same code → match)
};

beforeEach(() => {
    store.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('Screen Lock → hide message previews suggestion', () => {
    it('negative control: nothing is suggested before the lock is enabled', () => {
        mount();
        expect(preview()).toBe('full');
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
    });

    it('shows after enabling the lock when previews show message text', async () => {
        mount();
        await enableLock();
        const card = $('[data-testid="lock-preview-suggestion"]');
        expect(card).not.toBeNull();
        expect(card!.textContent).toContain('Notifications can still show message text while Cipherline is locked. Hide message previews?');
        expect(buttonByText('Hide previews')).toBeDefined();
        expect(buttonByText('Keep as is')).toBeDefined();
        // Offering is not applying: the setting is untouched until the user chooses.
        expect(preview()).toBe('full');
    });

    it.each(['hidden', 'sender_only'])('does not show when previews are already %s', async (mode) => {
        store.set(PREFS_KEY, JSON.stringify({ show_preview: mode }));
        mount();
        expect(preview()).toBe(mode);
        await enableLock();
        expect(buttonByText('Turn off')).toBeDefined();               // the lock really is on
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
        expect(preview()).toBe(mode);
    });

    it('Hide applies "hidden" through the shared setter, and persists like a manual change', async () => {
        mount();
        await enableLock();
        await click(buttonByText('Hide previews'));
        expect(preview()).toBe('hidden');                          // NotificationsTab reads this same state
        expect(storedPreview()).toBe('hidden');
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
        expect($('[data-testid="lock-preview-done"]')).not.toBeNull();
    });

    it('Keep as is dismisses without changing anything', async () => {
        mount();
        await enableLock();
        const before = store.get(PREFS_KEY);
        await click(buttonByText('Keep as is'));
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
        expect($('[data-testid="lock-preview-done"]')).toBeNull();
        expect(preview()).toBe('full');
        expect(store.get(PREFS_KEY)).toBe(before);                    // no write at all
    });

    it('is once per enable: a fresh render with the lock already on shows nothing', () => {
        mount(true);
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
    });

    it('does not show on PIN change', async () => {
        mount(true);
        await click(buttonByText('Change'));
        // current → (length defaults to current) choose → new → submit
        await click($('[data-testid="pin-submit"]'));
        await click(buttonByText('4 digits'));
        await click($('[data-testid="pin-submit"]'));
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
        expect(preview()).toBe('full');
    });

    it('does not show on disable (and clears a pending suggestion)', async () => {
        mount();
        await enableLock();
        expect($('[data-testid="lock-preview-suggestion"]')).not.toBeNull();
        await click(buttonByText('Turn off'));
        await click($('[data-testid="pin-submit"]'));
        expect(buttonByText('Set up')).toBeDefined();                 // the lock is off again
        expect($('[data-testid="lock-preview-suggestion"]')).toBeNull();
        expect(preview()).toBe('full');
    });
});
