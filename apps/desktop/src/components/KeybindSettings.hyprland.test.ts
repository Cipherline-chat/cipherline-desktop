// @vitest-environment jsdom
/**
 * Settings → Keybinds tells the truth about system-wide shortcuts from the portal's REAL result:
 * Hyprland's portal answers but binds nothing ("bound 0, not granted 7"), so the page must not say
 * "Work even when Cipherline is in the background", and it must show the hyprland.conf lines.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const writeToClipboard = vi.fn(async (_text: string) => undefined);
vi.mock('../utils/clipboard', () => ({ writeToClipboard: (t: string) => writeToClipboard(t) }));

const { KeybindSettings } = await import('./KeybindSettings');
const { mergeKeybinds } = await import('../hooks/useKeybinds');
import type { KeybindHook } from '../hooks/useKeybinds';
import type { GlobalShortcutStatus } from '../utils/globalShortcutNotice';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    writeToClipboard.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function mount(status: GlobalShortcutStatus | null) {
    const defaults = mergeKeybinds(null);
    const keybinds = {
        binds: defaults, defaults, setBind: vi.fn(), resetAll: vi.fn(), resetOne: vi.fn(),
        globalShortcutStatus: status,
    } as unknown as KeybindHook;
    act(() => root.render(React.createElement(KeybindSettings, { keybinds })));
}

const HYPR: GlobalShortcutStatus = {
    mode: 'portal', reason: 'wayland-portal', desktop: 'Hyprland', appId: 'chat.cipherline.Cipherline',
    portal: { bound: [], notBound: ['toggle-mute', 'toggle-deafen', 'toggle-camera', 'leave-call', 'quick-screenshare', 'lock-screen'] },
};

describe('KeybindSettings on a portal that bound nothing (Hyprland)', () => {
    it('says so plainly and no longer promises background shortcuts', () => {
        mount(HYPR);
        const notice = host.querySelector('[data-testid="global-shortcuts-binding-notice"]');
        expect(notice?.textContent).toContain('System-wide shortcuts are not set up');
        expect(notice?.textContent).toContain('Hyprland on Wayland accepted');
        expect(host.textContent).not.toContain('Work even when Cipherline is in the background');
        expect(host.textContent).toContain('Only work while Cipherline is focused on this desktop');
    });

    it('shows one bind line per shortcut with the registered app id and the current key, and copies them', async () => {
        mount(HYPR);
        const lines = host.querySelector('[data-testid="hyprland-bind-lines"] pre')?.textContent ?? '';
        const rows = lines.split('\n');
        expect(rows).toContain('bind = CTRL SHIFT, M, global, chat.cipherline.Cipherline:toggle-mute');
        expect(rows).toContain('bind = CTRL SHIFT, H, global, chat.cipherline.Cipherline:leave-call');
        expect(rows.every((r) => /^bind = [A-Z ]*, [A-Za-z0-9]+, global, chat\.cipherline\.Cipherline:[a-z-]+$/.test(r))).toBe(true);
        const btn = [...host.querySelectorAll('button')].find((b) => /Copy lines/.test(b.textContent ?? ''));
        expect(btn).toBeTruthy();
        await act(async () => { btn!.click(); });
        expect(writeToClipboard).toHaveBeenCalledWith(lines);
    });
});

describe('KeybindSettings negative controls', () => {
    it('everything bound: no notice, no lines, the original promise stays', () => {
        mount({ ...HYPR, portal: { bound: ['toggle-mute'], notBound: [] } });
        expect(host.querySelector('[data-testid="global-shortcuts-binding-notice"]')).toBeNull();
        expect(host.querySelector('[data-testid="hyprland-bind-lines"]')).toBeNull();
        expect(host.textContent).toContain('Work even when Cipherline is in the background');
    });
    it('a partial bind on GNOME names what is missing and shows no hyprland.conf lines', () => {
        mount({ mode: 'portal', reason: 'wayland-portal', desktop: 'GNOME', portal: { bound: ['toggle-mute'], notBound: ['leave-call'] } });
        const notice = host.querySelector('[data-testid="global-shortcuts-binding-notice"]');
        expect(notice?.textContent).toContain('Leave Call only works while Cipherline is focused');
        expect(host.querySelector('[data-testid="hyprland-bind-lines"]')).toBeNull();
    });
    it('native sessions and an unanswered status show nothing extra', () => {
        mount({ mode: 'native', reason: 'x11', desktop: 'KDE' });
        expect(host.querySelector('[data-testid="global-shortcuts-binding-notice"]')).toBeNull();
        expect(host.textContent).toContain('Work even when Cipherline is in the background');
        act(() => root.unmount());
        root = createRoot(host);
        mount(null);
        expect(host.querySelector('[data-testid="global-shortcuts-binding-notice"]')).toBeNull();
    });
});
