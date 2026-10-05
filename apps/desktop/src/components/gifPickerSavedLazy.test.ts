// @vitest-environment jsdom
/**
 * The GIF picker's "Saved" grid used to read and decrypt EVERY saved GIF file
 * on every open, in parallel, before showing any. Each tile now decrypts only
 * when it comes near the visible grid, four at a time. The decrypted URL lives
 * in the shared decrypted-media cache: re-opening the picker reuses it (no file
 * read, no decrypt), and it is revoked on cache eviction / sign-out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// jsdom has no matchMedia; GifPicker's imports read it at module load.
vi.hoisted(() => {
    if (typeof window !== 'undefined' && !window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

const loadGifFile = vi.fn(async (fav: { id: string }) => new Blob(['GIF89a:' + fav.id], { type: 'image/gif' }));
vi.mock('../utils/gifStorage', async (orig) => ({ ...(await orig() as object), loadGifFile: (fav: { id: string }) => loadGifFile(fav) }));

import { SavedLocalThumb } from './GifPicker';
import type { FavoriteGif } from '../utils/gifStorage';
import { clearDecryptedMediaCache, peekDecryptedMediaBlob, __decryptedMediaStats } from '../utils/decryptedMediaCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type IOCb = (entries: Array<{ isIntersecting: boolean }>) => void;
const observers: Array<{ cb: IOCb; el?: Element; disconnected: boolean }> = [];
beforeEach(() => {
    observers.length = 0;
    loadGifFile.mockClear();
    clearDecryptedMediaCache();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
        rec: { cb: IOCb; el?: Element; disconnected: boolean };
        constructor(cb: IOCb) { this.rec = { cb, disconnected: false }; observers.push(this.rec); }
        observe(el: Element) { this.rec.el = el; }
        disconnect() { this.rec.disconnected = true; }
    };
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:t${++n}`);
    URL.revokeObjectURL = vi.fn();
});

const flush = async () => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); }); };

describe('SavedLocalThumb', () => {
    const mount = (favs: Array<{ id: string; fileName: string; source: string; mimeType: string }>) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => root.render(React.createElement('div', null,
            favs.map(f => React.createElement(SavedLocalThumb, { key: f.id, fav: f as unknown as FavoriteGif })))));
        return { host, root };
    };
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, fileName: `g${i}.gif.enc`, source: 'local', mimeType: 'image/gif' }));

    it('does not touch the file until the tile is near the viewport, then decrypts once; the URL outlives the tile and is revoked on sign-out', async () => {
        const { host, root } = mount(mk(30));
        await flush();
        expect(loadGifFile).not.toHaveBeenCalled();              // opening the picker decrypts nothing
        expect(observers.length).toBe(30);

        // The first 6 tiles scroll into (near) view.
        act(() => { for (const o of observers.slice(0, 6)) o.cb([{ isIntersecting: true }]); });
        await flush();
        expect(loadGifFile).toHaveBeenCalledTimes(6);
        expect(host.querySelectorAll('img').length).toBe(6);
        expect(observers.slice(0, 6).every(o => o.disconnected)).toBe(true);

        act(() => root.unmount());
        // Closing the picker only releases the holds: the 6 previews stay warm in the shared cache…
        expect(vi.mocked(URL.revokeObjectURL).mock.calls.length).toBe(0);
        expect(__decryptedMediaStats()).toMatchObject({ entries: 6, held: 0 });
        // …and the Blob is kept so sending one needs no second read + decrypt.
        expect(peekDecryptedMediaBlob('gif:g0')).toBeInstanceOf(Blob);
        // Sign-out frees them.
        clearDecryptedMediaCache();
        expect(vi.mocked(URL.revokeObjectURL).mock.calls.length).toBe(6);
    });

    it('re-opening the picker reuses the cached previews: no new file read, no decrypt, no new URL', async () => {
        const first = mount(mk(3));
        await flush();
        act(() => { for (const o of observers.slice(0, 3)) o.cb([{ isIntersecting: true }]); });
        await flush();
        expect(loadGifFile).toHaveBeenCalledTimes(3);
        act(() => first.root.unmount());
        const minted = vi.mocked(URL.createObjectURL).mock.calls.length;

        const second = mount(mk(3));
        await flush();
        expect(second.host.querySelectorAll('img').length).toBe(3);   // painted without scrolling into view
        expect(loadGifFile).toHaveBeenCalledTimes(3);                 // still just the first three
        expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(minted);
        expect(__decryptedMediaStats().held).toBe(3);
        act(() => second.root.unmount());
    });

    it('an already-decrypted preview paints immediately even while every decode slot is busy', async () => {
        const warm = mount(mk(1));                       // g0 decrypted and cached, then the picker closes
        await flush();
        act(() => { observers[0].cb([{ isIntersecting: true }]); });
        await flush();
        act(() => warm.root.unmount());
        loadGifFile.mockClear();
        const gates: Array<() => void> = [];
        loadGifFile.mockImplementation(async (fav: { id: string }) => {
            await new Promise<void>(r => gates.push(r));
            return new Blob(['GIF89a:' + fav.id], { type: 'image/gif' });
        });
        // g1..g4 are uncached and take all four slots…
        const { host, root } = mount(mk(5).slice(1));
        await flush();
        act(() => { for (const o of observers.slice(-4)) o.cb([{ isIntersecting: true }]); });
        await flush();
        expect(loadGifFile).toHaveBeenCalledTimes(4);    // slots full, nothing finished
        expect(host.querySelectorAll('img').length).toBe(0);
        // …then the cached g0 scrolls in: it must not queue behind them.
        act(() => root.render(React.createElement('div', null,
            mk(5).map(f => React.createElement(SavedLocalThumb, { key: f.id, fav: f as unknown as FavoriteGif })))));
        await flush();
        expect(loadGifFile).toHaveBeenCalledTimes(4);
        expect(host.querySelectorAll('img').length).toBe(1); // the cached one is already showing
        for (const g of gates.splice(0)) g();
        await flush();
        act(() => root.unmount());
        loadGifFile.mockImplementation(async (fav: { id: string }) => new Blob(['GIF89a:' + fav.id], { type: 'image/gif' }));
    });

    it('decodes at most four saved GIFs at a time', async () => {
        let active = 0; let peak = 0;
        const gates: Array<() => void> = [];
        loadGifFile.mockImplementation(async (fav: { id: string }) => {
            active++; peak = Math.max(peak, active);
            await new Promise<void>(r => gates.push(r));
            active--;
            return new Blob(['GIF89a:' + fav.id], { type: 'image/gif' });
        });
        const { root } = mount(mk(12));
        await flush();
        act(() => { for (const o of observers) o.cb([{ isIntersecting: true }]); });
        await flush();
        expect(peak).toBe(4);
        for (let i = 0; i < 12; i++) { await act(async () => { gates.shift()?.(); await Promise.resolve(); }); await flush(); }
        expect(loadGifFile).toHaveBeenCalledTimes(12);
        expect(peak).toBe(4);
        act(() => root.unmount());
        loadGifFile.mockImplementation(async (fav: { id: string }) => new Blob(['GIF89a:' + fav.id], { type: 'image/gif' }));
    });
});
