// @vitest-environment jsdom
/**
 * Settings → Keybinds when the desktop kept a different key (KDE Plasma 6.8 keeps the key it first accepted for a
 * shortcut; a tester's camera shortcut never fired while this page showed Ctrl+Shift+F10). The page names the live
 * key on the row and offers the desktop's own shortcut settings (portal ConfigureShortcuts).
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
vi.mock('../utils/clipboard', () => ({ writeToClipboard: async () => undefined }));

const { KeybindSettings } = await import('./KeybindSettings');
const { mergeKeybinds } = await import('../hooks/useKeybinds');
import type { KeybindHook } from '../hooks/useKeybinds';
import type { GlobalShortcutStatus } from '../utils/globalShortcutNotice';

let root: Root;
let host: HTMLDivElement;
const configure = vi.fn(async () => true);
beforeEach(() => {
    configure.mockReset().mockResolvedValue(true);
    (window as unknown as { electronAPI: unknown }).electronAPI = { configureDesktopShortcuts: configure };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function mount(status: GlobalShortcutStatus | null) {
    const defaults = mergeKeybinds(null);
    const keybinds = { binds: defaults, defaults, setBind: vi.fn(), resetAll: vi.fn(), resetOne: vi.fn(), globalShortcutStatus: status } as unknown as KeybindHook;
    act(() => root.render(React.createElement(KeybindSettings, { keybinds })));
}

const KDE_ELSEWHERE: GlobalShortcutStatus = {
    mode: 'portal', reason: 'wayland-portal', desktop: 'KDE',
    portal: { bound: ['toggle-camera', 'toggle-mute'], notBound: [], desktopKeys: { 'toggle-camera': 'Ctrl+Shift+V', 'toggle-mute': 'Ctrl+Shift+M' }, elsewhere: ['toggle-camera'] },
};

describe('KeybindSettings: the desktop kept a different key', () => {
    it('the camera row says which key works system-wide', () => {
        mount(KDE_ELSEWHERE);
        const hints = [...host.querySelectorAll('[data-testid="desktop-key-hint"]')].map((e) => e.textContent);
        expect(hints).toEqual(['System-wide your desktop uses Ctrl+Shift+V for this']);
        expect(host.querySelector('[data-testid="global-shortcuts-binding-notice"]')?.textContent).toContain('Camera On / Off (Ctrl+Shift+V)');
    });

    it('"Open desktop shortcut settings" asks main to open them; a refusal says where to look', async () => {
        mount(KDE_ELSEWHERE);
        const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Open desktop shortcut settings'))!;
        expect(btn).toBeTruthy();
        await act(async () => { btn.click(); });
        expect(configure).toHaveBeenCalledTimes(1);
        expect(host.textContent).not.toContain('did not open them');
        configure.mockResolvedValueOnce(false);
        await act(async () => { btn.click(); });
        expect(host.textContent).toContain('Look for Cipherline in its System Settings');
    });

    it('controls: no hint and no button when every key matches, or off a portal session', () => {
        mount({ ...KDE_ELSEWHERE, portal: { ...KDE_ELSEWHERE.portal!, elsewhere: [] } });
        expect(host.querySelector('[data-testid="desktop-key-hint"]')).toBeNull();
        expect(host.querySelector('[data-testid="desktop-shortcut-settings"]')).toBeNull();
        mount({ mode: 'native', reason: 'x11', desktop: 'KDE' });
        expect(host.querySelector('[data-testid="desktop-shortcut-settings"]')).toBeNull();
    });
});
