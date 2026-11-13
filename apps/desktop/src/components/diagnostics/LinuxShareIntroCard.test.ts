// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one-time "screen sharing on Linux is new" card, end to end below SidebarConference: the share going live
 * (useLinuxShareIntroTrigger) -> pending -> on screen only once the window is visible AND focused -> the device
 * flag written at that moment and not before. SidebarConference / Dashboard are far too large to mount; their wiring
 * lines are read from source.
 */
const h = vi.hoisted(() => {
    const state = { kv: new Map<string, string>(), writes: [] as Array<[string, string]>, focused: true, reduced: false };
    // Before any import: ClButton's physics module reads matchMedia at load.
    window.matchMedia = ((q: string) => ({
        matches: q.includes('reduced-motion') ? state.reduced : false, media: q,
        addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    return state;
});
vi.mock('../../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => h.kv.get(k) ?? null,
        setItem: (k: string, v: string) => { h.writes.push([k, v]); h.kv.set(k, v); },
    },
}));

import { LinuxShareIntroCard, LinuxShareIntroCardView } from './LinuxShareIntroCard';
import { LINUX_SHARE_INTRO_KEY, useLinuxShareIntroTrigger, __resetLinuxShareIntroForTests } from '../../utils/linuxShareIntro';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

let root: Root;
let host: HTMLDivElement;
let encoder: string | undefined;
const App: React.FC<{ sharing: boolean }> = ({ sharing }) => {
    useLinuxShareIntroTrigger(sharing, () => encoder);
    return React.createElement(LinuxShareIntroCard);
};
const render = (sharing: boolean) => act(() => { root.render(React.createElement(App, { sharing })); });
const card = () => document.body.querySelector('.lsi-card');
const setFocused = (f: boolean) => act(() => { h.focused = f; window.dispatchEvent(new Event(f ? 'focus' : 'blur')); });

beforeEach(() => {
    h.kv.clear();
    h.writes.length = 0;
    h.focused = true;
    h.reduced = false;
    encoder = undefined;
    __resetLinuxShareIntroForTests();
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform: 'linux' };
    vi.spyOn(document, 'hasFocus').mockImplementation(() => h.focused);
    // The clip is fetched into a blob: URL; here it never loads, so the poster stays (the failure path).
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('LinuxShareIntroCard: once per device, Linux only', () => {
    it('shows on the first Linux share and writes the flag at that moment', async () => {
        render(false);
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
        render(true);
        await act(async () => {});
        expect(card()).not.toBeNull();
        expect(h.writes).toEqual([[LINUX_SHARE_INTRO_KEY, '1']]);
        expect(card()!.getAttribute('role')).toBe('dialog');
        expect(card()!.getAttribute('aria-modal')).toBe('false');
        expect(card()!.textContent).toContain('less so on AMD and Intel');
        expect(card()!.textContent).toContain('never your messages');
    });

    it('waits while the window is not focused (sharing a game), and shows when it is focused again', async () => {
        h.focused = false;
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);               // not shown -> not counted
        setFocused(true);
        await act(async () => {});
        expect(card()).not.toBeNull();
        expect(h.writes).toEqual([[LINUX_SHARE_INTRO_KEY, '1']]);
        setFocused(false);                          // once on screen it stays put
        expect(card()).not.toBeNull();
    });

    it('never shows on Windows or macOS', async () => {
        for (const platform of ['win32', 'darwin']) {
            (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform };
            render(false);
            render(true);
            await act(async () => {});
            expect(card()).toBeNull();
        }
        expect(h.writes).toEqual([]);
    });

    it('never shows when this device already showed it', async () => {
        h.kv.set(LINUX_SHARE_INTRO_KEY, '1');
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toEqual([]);
    });

    it('"Got it" closes it and the next share does not bring it back', async () => {
        render(true);
        await act(async () => {});
        const gotIt = [...card()!.querySelectorAll('button')].find(b => b.textContent === 'Got it')!;
        act(() => { gotIt.click(); });
        expect(card()).toBeNull();
        render(false);
        render(true);
        await act(async () => {});
        expect(card()).toBeNull();
        expect(h.writes).toHaveLength(1);
    });

    it('Esc closes it', async () => {
        render(true);
        await act(async () => {});
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(card()).toBeNull();
    });

    it('tailors the encoder line to what engaged (VA-API = the least-tested path)', async () => {
        encoder = 'vaapi';
        render(true);
        await act(async () => {});
        expect(card()!.querySelector('.lsi-backend--vaapi')?.textContent).toContain('AMD or Intel');
    });
});

describe('LinuxShareIntroCardView: the video', () => {
    const view = (props: Partial<React.ComponentProps<typeof LinuxShareIntroCardView>> = {}) =>
        act(() => { root.render(React.createElement(LinuxShareIntroCardView, { backend: 'nvenc', onDismiss: () => {}, videoSrc: 'blob:clip', ...props })); });

    it('plays muted and looping with controls', () => {
        view();
        const v = host.querySelector('video')!;
        expect(v).not.toBeNull();
        expect(v.muted).toBe(true);
        expect(v.loop).toBe(true);
        expect(v.autoplay).toBe(true);
        expect(v.controls).toBe(true);
        expect(v.getAttribute('aria-label')).toMatch(/Report a Quality Problem/);
        expect(host.querySelector('.lsi-play')).toBeNull();
    });

    it('reduced motion: no autoplay, the poster with a play button', () => {
        h.reduced = true;
        view();
        const v = host.querySelector('video')!;
        expect(v.autoplay).toBe(false);
        const play = host.querySelector<HTMLButtonElement>('.lsi-play');
        expect(play?.getAttribute('aria-label')).toBe('Play the how-to video');
        HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
        act(() => { play!.click(); });
        expect(host.querySelector('.lsi-play')).toBeNull();
        expect(host.querySelector('video')!.controls).toBe(true);
    });

    it('a clip that cannot load leaves the poster image with the same description', () => {
        view({ videoSrc: null });
        expect(host.querySelector('video')).toBeNull();
        expect(host.querySelector('img')?.getAttribute('alt')).toMatch(/Report a Quality Problem/);
    });
});

describe('wiring (read from source)', () => {
    it('SidebarConference tells the store when our own share goes live, with the native encoder', () => {
        expect(SRC('SidebarConference.tsx')).toMatch(/useLinuxShareIntroTrigger\(!!localScreenShare, \(\) => nativePipeRef\.current\?\.encoder\)/);
    });
    it('Dashboard mounts the card', () => {
        expect(SRC('Dashboard.tsx')).toMatch(/<LinuxShareIntroCard \/>/);
    });
    it('the clip is allowed by the renderer CSP (blob: media)', () => {
        const main = readFileSync(join(__dirname, '..', '..', '..', 'electron', 'main.ts'), 'utf8');
        expect(main).toMatch(/"media-src 'self' blob:"/);
    });
});
