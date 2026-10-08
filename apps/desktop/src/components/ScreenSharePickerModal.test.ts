// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// clPhysics (pulled in by ClButton) calls matchMedia at module load, which is
// before any statement in this file runs — hence vi.hoisted.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

/**
 * The screen-share picker opens on the Entire Screen tab, and shows each tab's
 * list as soon as the NAMES are in — previews fill in afterwards.
 */
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import { __resetDesktopSourceCacheForTests, storePreviews, markPickerRequested, prefetchDesktopSources } from '../utils/desktopSourceCache';
import { getCallEvents, clearCallEvents } from '../utils/callEventLog';

type Src = { id: string; name: string; thumbnailDataUrl: string };
const SCREENS: Src[] = [{ id: 'screen:1:0', name: 'Screen 1', thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' }];
const WINDOWS: Src[] = [
    { id: 'window:11:0', name: 'Game', thumbnailDataUrl: 'data:image/jpeg;base64,BBBB' },
    { id: 'window:12:0', name: 'Browser', thumbnailDataUrl: 'data:image/jpeg;base64,CCCC' },
];

let root: Root;
let host: HTMLDivElement;
let calls: Array<{ types: string[]; thumbs: boolean }>;
let pending: Array<() => void>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

beforeEach(() => {
    __resetDesktopSourceCacheForTests();
    clearCallEvents();
    calls = []; pending = [];
    // The preview pass is held until the test releases it, so "names first" is observable.
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        platform: 'windows',
        getDisplayRefreshRates: async () => [],
        getScreenCaptureAccess: async () => 'not-applicable',
        getDesktopSources: vi.fn(async (types: string[], opts?: { thumbnails?: boolean }) => {
            const thumbs = opts?.thumbnails !== false;
            calls.push({ types, thumbs });
            const list = types[0] === 'screen' ? SCREENS : WINDOWS;
            if (thumbs) {
                const d = deferred();
                pending.push(d.resolve);
                await d.promise;
                return list;
            }
            return list.map(s => ({ ...s, thumbnailDataUrl: '' }));
        }),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const body = () => document.body;

describe('ScreenSharePickerModal — first tab and fast paint', () => {
    it('opens on Entire Screen, not Application Window', async () => {
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        expect(calls[0]).toEqual({ types: ['screen'], thumbs: false });
        expect(calls.some(c => c.types[0] === 'window')).toBe(false);
        expect(body().textContent).toContain('Screen 1');
    });

    it('shows the list from the names pass (placeholders), then fills in the previews', async () => {
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        // Names are in, previews are not: the tile is there, with a placeholder.
        expect(body().textContent).toContain('Screen 1');
        expect(body().querySelectorAll('[data-testid="thumb-pending"]').length).toBe(1);
        expect(body().querySelector('img')).toBeNull();
        // The preview pass was requested after the names pass.
        expect(calls.map(c => c.thumbs)).toEqual([false, true]);
        await act(async () => { pending.forEach(r => r()); });
        await flush();
        expect(body().querySelectorAll('[data-testid="thumb-pending"]').length).toBe(0);
        expect(body().querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    });

    it('the Application Window tab uses the same two passes, and only when opened', async () => {
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        const tab = Array.from(body().querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Application Window'))!;
        act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await flush();
        const winCalls = calls.filter(c => c.types[0] === 'window');
        expect(winCalls.map(c => c.thumbs)).toEqual([false, true]);
        expect(body().textContent).toContain('Game');
        expect(body().textContent).toContain('Browser');
    });

    it('a failed preview pass leaves the named list usable instead of erroring', async () => {
        const api = (window as unknown as { electronAPI: { getDesktopSources: ReturnType<typeof vi.fn> } }).electronAPI;
        api.getDesktopSources.mockImplementation(async (_types: string[], opts?: { thumbnails?: boolean }) => {
            if (opts?.thumbnails === false) return SCREENS.map(s => ({ ...s, thumbnailDataUrl: '' }));
            throw new Error('capture failed');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        expect(body().textContent).toContain('Screen 1');
        expect(body().textContent).not.toContain('No screens found');
    });

    it('a picker closed before the names arrive starts no preview capture', async () => {
        const api = (window as unknown as { electronAPI: { getDesktopSources: ReturnType<typeof vi.fn> } }).electronAPI;
        const names = deferred();
        api.getDesktopSources.mockImplementation(async (types: string[], opts?: { thumbnails?: boolean }) => {
            const thumbs = opts?.thumbnails !== false;
            calls.push({ types, thumbs });
            if (!thumbs) await names.promise;
            return SCREENS.map(s => ({ ...s, thumbnailDataUrl: thumbs ? s.thumbnailDataUrl : '' }));
        });
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        expect(calls).toEqual([{ types: ['screen'], thumbs: false }]);
        act(() => { root.unmount(); });
        root = createRoot(host); // afterEach unmounts again
        await act(async () => { names.resolve(); });
        await flush();
        // Positive control is the test above: an OPEN picker does issue the preview pass.
        expect(calls).toEqual([{ types: ['screen'], thumbs: false }]);
    });
});

describe('ScreenSharePickerModal — instant open (cached grid, refreshed underneath)', () => {
    it('a reopen paints the last grid WITH previews on its first frame, before any IPC answers', async () => {
        storePreviews('screen', SCREENS);
        // Hold every IPC: nothing may be needed for the first paint.
        const api = (window as unknown as { electronAPI: { getDesktopSources: ReturnType<typeof vi.fn> } }).electronAPI;
        api.getDesktopSources.mockImplementation((types: string[], opts?: { thumbnails?: boolean }) => {
            calls.push({ types, thumbs: opts?.thumbnails !== false });
            return new Promise(() => {});
        });
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        expect(body().textContent).toContain('Screen 1');
        expect(body().querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
        expect(body().querySelectorAll('[data-testid="thumb-pending"]').length).toBe(0);
        // ...and it still refreshes underneath (names first).
        expect(calls[0]).toEqual({ types: ['screen'], thumbs: false });
    });

    it('the refresh drops a cached source that has gone and keeps the preview of one still there', async () => {
        storePreviews('screen', [
            ...SCREENS,
            { id: 'screen:2:0', name: 'Screen 2', thumbnailDataUrl: 'data:image/jpeg;base64,ZZZZ' },
        ]);
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        expect(body().textContent).toContain('Screen 2');
        await flush(); // names pass: only Screen 1 exists now
        expect(body().textContent).not.toContain('Screen 2');
        expect(body().querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    });

    it('hover warm-up then click: the first open is already a full grid, and the timing is logged', async () => {
        const api = (window as unknown as { electronAPI: { getDesktopSources: (t: string[], o?: { thumbnails?: boolean }) => Promise<Src[]> } }).electronAPI;
        const warm = prefetchDesktopSources('screen', api.getDesktopSources);
        await flush();
        await act(async () => { pending.forEach(r => r()); });
        await warm;
        markPickerRequested(performance.now());
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        expect(body().querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
        // First frame → the share_picker event (durations + flags only).
        await act(async () => { await new Promise(r => setTimeout(r, 40)); });
        await flush();
        const ev = getCallEvents().find(e => e.kind === 'share_picker');
        expect(ev?.detail).toMatchObject({ cached: true, tab: 'screen' });
        expect(typeof ev?.detail?.open_ms).toBe('number');
        expect(typeof ev?.detail?.preview_ms).toBe('number');
    });

    it('positive control: a cold first open has no previews until the preview pass answers', async () => {
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        expect(body().querySelector('img')).toBeNull();
        await flush();
        expect(body().querySelectorAll('[data-testid="thumb-pending"]').length).toBe(1);
    });

    it('after the default tab\'s previews, the other tab\'s NAMES are warmed (never its previews)', async () => {
        act(() => { root.render(React.createElement(ScreenSharePickerModal, { onSelect: () => {} })); });
        await flush();
        await act(async () => { pending.forEach(r => r()); });
        await flush();
        expect(calls).toEqual([
            { types: ['screen'], thumbs: false },
            { types: ['screen'], thumbs: true },
            { types: ['window'], thumbs: false },
        ]);
    });
});
