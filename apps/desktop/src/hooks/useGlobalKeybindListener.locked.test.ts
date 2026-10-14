// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Hotkeys must not act on the app behind the Screen Lock. Both tiers of the
 * keybind dispatcher (the focused-window keydown and Electron's global
 * shortcut events) and the shared Escape stack are gated on the lock signal,
 * and the toast quick-reply path is covered by the same signal. Each test has
 * a negative control: the SAME input fires when the lock is not up.
 */
vi.mock('../utils/secureLocalStore', () => {
    const fake = { getItem: () => null, setItem: () => {}, removeItem: () => {}, flushNow: async () => {} };
    return { default: fake, secureLocalStore: fake };
});

const { useGlobalKeybindListener } = await import('./useGlobalKeybindListener');
const { pushEscapeLayer } = await import('../utils/escapeStack');
const { setScreenLockEngaged } = await import('../utils/screenLockEngaged');

type Handlers = Parameters<typeof useGlobalKeybindListener>[1];
type Keybinds = Parameters<typeof useGlobalKeybindListener>[0];

const keybinds = {
    comboToAction: new Map([
        ['ctrl+k', 'open-settings'],
        ['ctrl+shift+l', 'leave-call'],
        ['ctrl+m', 'toggle-mute'],
        ['ctrl+shift+s', 'toggle-screenshare'],
    ]),
} as unknown as Keybinds;

let handlers: Required<Pick<Handlers, 'open-settings' | 'leave-call' | 'toggle-mute' | 'toggle-screenshare'>>;
let root: Root;
let host: HTMLDivElement;
let shortcutCb: ((id: string) => void) | undefined;

const Probe: React.FC = () => { useGlobalKeybindListener(keybinds, handlers); return null; };
const press = (key: string, mods: Partial<KeyboardEventInit> = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    act(() => { window.dispatchEvent(e); });
    return e;
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    handlers = { 'open-settings': vi.fn(), 'leave-call': vi.fn(), 'toggle-mute': vi.fn(), 'toggle-screenshare': vi.fn() };
    shortcutCb = undefined;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        onGlobalShortcut: (cb: (id: string) => void) => { shortcutCb = cb; return () => { shortcutCb = undefined; }; },
    };
    setScreenLockEngaged(false);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(React.createElement(Probe)); });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setScreenLockEngaged(false);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.useRealTimers();
});

describe('hotkeys while the Screen Lock is up', () => {
    it('negative control: the same keys DO fire when not locked (focused-window tier)', () => {
        const e = press('k', { ctrlKey: true });
        expect(handlers['open-settings']).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(true);
        press('l', { ctrlKey: true, shiftKey: true });
        expect(handlers['leave-call']).toHaveBeenCalledTimes(1);
    });

    it('locked: no hotkey fires from the keyboard, and the press is left alone (not consumed)', () => {
        setScreenLockEngaged(true);
        for (const [key, mods] of [
            ['k', { ctrlKey: true }],
            ['l', { ctrlKey: true, shiftKey: true }],   // leave-call
            ['m', { ctrlKey: true }],                   // mute toggle (could open the mic)
            ['s', { ctrlKey: true, shiftKey: true }],   // screenshare
        ] as Array<[string, Partial<KeyboardEventInit>]>) {
            const e = press(key, mods);
            expect(e.defaultPrevented).toBe(false);
        }
        for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
    });

    it('locked: Electron global-shortcut events do not fire either; unlocked they do', () => {
        expect(shortcutCb).toBeTypeOf('function');
        act(() => { shortcutCb!('leave-call'); });
        expect(handlers['leave-call']).toHaveBeenCalledTimes(1); // control

        vi.setSystemTime(new Date('2026-10-14T12:01:00Z')); // past the dedup window
        setScreenLockEngaged(true);
        act(() => { shortcutCb!('leave-call'); shortcutCb!('toggle-screenshare'); shortcutCb!('toggle-mute'); });
        expect(handlers['leave-call']).toHaveBeenCalledTimes(1);
        expect(handlers['toggle-screenshare']).not.toHaveBeenCalled();
        expect(handlers['toggle-mute']).not.toHaveBeenCalled();
    });

    it('unlock restores hotkeys', () => {
        setScreenLockEngaged(true);
        press('k', { ctrlKey: true });
        expect(handlers['open-settings']).not.toHaveBeenCalled();
        act(() => { setScreenLockEngaged(false); });
        vi.setSystemTime(new Date('2026-10-14T12:02:00Z'));
        press('k', { ctrlKey: true });
        expect(handlers['open-settings']).toHaveBeenCalledTimes(1);
    });
});

describe('Escape while the Screen Lock is up', () => {
    it('negative control: Escape closes the top layer when not locked', () => {
        const close = vi.fn();
        const off = pushEscapeLayer(() => { close(); });
        press('Escape');
        expect(close).toHaveBeenCalledTimes(1);
        off();
    });

    it('locked: Escape does not close or touch any layer behind the lock; unlocked it does again', () => {
        const close = vi.fn();
        const off = pushEscapeLayer(() => { close(); });
        setScreenLockEngaged(true);
        const e = press('Escape');
        expect(close).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(false);
        act(() => { setScreenLockEngaged(false); });
        press('Escape');
        expect(close).toHaveBeenCalledTimes(1);
        off();
    });
});
