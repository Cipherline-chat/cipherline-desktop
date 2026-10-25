// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// utils/clPhysics.ts calls matchMedia at import time.
vi.hoisted(() => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});

// Keys pulls in the whole mascot rig (matchMedia, requestAnimationFrame...).
vi.mock('./mascot/Keys', () => ({ Keys: () => React.createElement('span', { 'data-testid': 'keys' }) }));
const requestOpenSettings = vi.fn();
vi.mock('../utils/openSettingsRequest', () => ({ requestOpenSettings: (p: string) => requestOpenSettings(p) }));

import { ShortcutsSheetHost } from './ShortcutsSheet';
import { OPEN_SHORTCUTS_EVENT } from '../utils/shortcutsSheet';
import { setScreenLockEngaged } from '../utils/screenLockEngaged';
import type { KeybindHook } from '../hooks/useKeybinds';

let root: Root;
let host: HTMLDivElement;

const keybinds = (over: Record<string, string> = {}) => ({
    binds: { 'toggle-mute': 'ctrl+shift+m', 'open-settings': 'ctrl+,', 'close-panel': 'escape', ...over },
}) as unknown as KeybindHook;

const mount = (kb: KeybindHook = keybinds(), ptt?: string | null) =>
    act(() => { root.render(React.createElement(ShortcutsSheetHost, { keybinds: kb, pushToTalkKey: ptt })); });
const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
const dialog = () => document.querySelector('[role="dialog"], .mcard');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    requestOpenSettings.mockClear();
    setScreenLockEngaged(false);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('ShortcutsSheetHost', () => {
    it('renders nothing until asked', () => {
        mount();
        expect(dialog()).toBeNull();
    });

    it('opens on ? when not typing, and lists the live keybinds', () => {
        mount();
        press('?');
        expect(dialog()).not.toBeNull();
        expect(document.body.textContent).toContain('Keyboard shortcuts');
        expect(document.body.textContent).toContain('Mute / Unmute');
        const caps = Array.from(document.querySelectorAll('.ss-cap')).map(e => e.textContent);
        expect(caps).toContain('Ctrl');
        expect(caps).toContain('Shift');
        expect(caps).toContain('M');
        // the fixed keys
        expect(document.body.textContent).toContain('Send message');
    });

    it('does not open while typing in the message box or any field', () => {
        mount();
        const ta = document.createElement('textarea');
        document.body.appendChild(ta);
        press('?', ta);
        expect(dialog()).toBeNull();
        const input = document.createElement('input');
        document.body.appendChild(input);
        press('?', input);
        expect(dialog()).toBeNull();
    });

    it('does not open for other keys or ctrl+?', () => {
        mount();
        press('/');
        press('?', document.body, { ctrlKey: true });
        expect(dialog()).toBeNull();
    });

    it('Escape closes it', () => {
        mount();
        press('?');
        expect(dialog()).not.toBeNull();
        press('Escape');
        act(() => { vi.advanceTimersByTime(300); });
        expect(dialog()).toBeNull();
    });

    it('? again closes it', () => {
        mount();
        press('?');
        press('?');
        expect(dialog()).toBeNull();
    });

    it('opens from the Settings -> Keybinds button (custom event)', () => {
        mount();
        act(() => { window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)); });
        expect(dialog()).not.toBeNull();
    });

    it('stays shut behind the Screen Lock', () => {
        mount();
        setScreenLockEngaged(true);
        press('?');
        act(() => { window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)); });
        expect(dialog()).toBeNull();
    });

    it('shows a rebound key and "Not bound" for a cleared one', () => {
        mount(keybinds({ 'toggle-mute': 'ctrl+alt+k', 'toggle-gif-picker': '' }));
        press('?');
        const caps = Array.from(document.querySelectorAll('.ss-cap')).map(e => e.textContent);
        expect(caps).toContain('K');
        expect(document.body.textContent).toContain('Not bound');
    });

    it('lists push to talk only when it is on', () => {
        mount(keybinds(), null);
        press('?');
        expect(document.body.textContent).not.toContain('Push to talk');
        press('?');
        mount(keybinds(), 'space');
        press('?');
        expect(document.body.textContent).toContain('Push to talk');
    });

    it('"Change shortcuts" goes to Settings -> Keybinds', () => {
        mount();
        press('?');
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Change shortcuts'))!;
        act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        act(() => { vi.advanceTimersByTime(300); });
        expect(requestOpenSettings).toHaveBeenCalledWith('keybinds');
    });
});
