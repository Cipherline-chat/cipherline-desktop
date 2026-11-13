// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

/**
 * Linux on an X11 session (Debian 13 / KDE on Xorg, 2026-11-04): there is no desktop chooser, so the
 * picker's own grid IS the picker - every screen and window, listed by one getSources call. The grid
 * sat on skeleton tiles for ever (no previews, nothing to pick) because the Linux fetch never cleared
 * the `loading` flag that only the classic tabs cleared.
 */
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import { __resetDesktopSourceCacheForTests } from '../utils/desktopSourceCache';
import { resetCaptureViaPortalForTests } from '../utils/sharePlatformSupport';

type Src = { id: string; name: string; thumbnailDataUrl: string };
const SOURCES: Src[] = [
    { id: 'screen:0:0', name: 'Entire screen', thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' },
    { id: 'window:11:0', name: 'Terminal', thumbnailDataUrl: 'data:image/jpeg;base64,BBBB' },
    { id: 'window:12:0', name: 'Browser', thumbnailDataUrl: 'data:image/jpeg;base64,CCCC' },
];

let root: Root;
let host: HTMLDivElement;

function installApi(getDesktopSources: () => Promise<Src[]>) {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        platform: 'linux',
        getDisplayRefreshRates: async () => [],
        getScreenCaptureAccess: async () => 'not-applicable',
        getShareCapturePath: async () => ({ viaPortal: false }),
        isAudioCaptureSupported: async () => true,
        getDesktopSources: vi.fn(getDesktopSources),
    };
}

beforeEach(() => {
    __resetDesktopSourceCacheForTests();
    resetCaptureViaPortalForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const tile = (name: string) => document.body.querySelector(`[title="${name}"]`) as HTMLElement | null;
const skeletons = () => document.body.querySelectorAll('.animate-pulse').length;
const buttonNamed = (label: string) => Array.from(document.body.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === label);

describe('ScreenSharePickerModal on Linux X11 — the grid is the picker', () => {
    it('lists every screen and window as tiles with their previews, not skeletons', async () => {
        installApi(async () => SOURCES);
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        expect(tile('Entire screen')).not.toBeNull();
        expect(tile('Terminal')).not.toBeNull();
        expect(tile('Browser')).not.toBeNull();
        expect(document.body.querySelectorAll('img').length).toBeGreaterThanOrEqual(3);
        expect(skeletons()).toBe(0);
    });

    it('a tile can be picked, and double-clicking it goes on to the quality step', async () => {
        installApi(async () => SOURCES);
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        act(() => { tile('Terminal')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(tile('Terminal')!.style.boxShadow).toContain('14,165,233');
        expect(tile('Browser')!.style.boxShadow).not.toContain('14,165,233');
        act(() => { tile('Terminal')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
        await flush();
        expect(buttonNamed('Share')).toBeTruthy();
    });

    it('while the list is still being fetched it shows the waiting step, and a failure shows the error step (no skeleton either way)', async () => {
        let release!: (v: Src[]) => void;
        installApi(() => new Promise<Src[]>(r => { release = r; }));
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        expect(document.body.textContent).toContain('Looking for windows and screens');
        await act(async () => { release(SOURCES); });
        await flush();
        expect(tile('Browser')).not.toBeNull();
        expect(skeletons()).toBe(0);
    });

    it('a listing that fails ends in the error step with Try again, which lists again', async () => {
        let fail = true;
        installApi(async () => { if (fail) throw new Error('Failed to get sources.'); return SOURCES; });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        expect(document.body.textContent).toContain('couldn');
        fail = false;
        act(() => { (buttonNamed('Try again') as HTMLButtonElement).click(); });
        await flush();
        expect(tile('Terminal')).not.toBeNull();
        expect(skeletons()).toBe(0);
    });
});
