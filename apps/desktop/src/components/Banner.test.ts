// @vitest-environment jsdom
/**
 * The profile banner never shows a blank box and never pops.
 *
 *   - The default Cipherline banner is ALWAYS underneath — before, during and
 *     after a load, and after a failed one.
 *   - A banner already decrypted in memory paints SOLID on the first frame.
 *   - A banner that arrives later (download + decrypt) cross-fades in: it is
 *     attached at opacity 0 and goes to 1 only once the image has decoded.
 *   - An id that arrives AFTER mount but is already in memory is picked up in
 *     that same render (no one-frame flash of the default).
 *   - A decrypted blob that fails to decode is evicted and the default stays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

const keyStore = new Map<string, { keyB64: string; nonceB64: string }>();
vi.mock('../utils/avatarKeyStore', () => ({
    loadAvatarKey: async (id: string) => keyStore.get(id) ?? null,
    saveAvatarKey: async (id: string, keyB64: string, nonceB64: string) => { keyStore.set(id, { keyB64, nonceB64 }); return true; },
    deleteAvatarKey: async (id: string) => { keyStore.delete(id); },
}));

const blobStore = new Map<string, { blob: Blob; kind?: string }>();
vi.mock('../utils/attachmentCache', () => ({
    getAvatarBlob: async (id: string) => blobStore.get(id)?.blob ?? null,
    putAvatarBlob: async (id: string, blob: Blob, opts?: { kind?: string }) => { blobStore.set(id, { blob, kind: opts?.kind }); },
    deleteAvatarBlob: async (id: string) => { blobStore.delete(id); },
}));

vi.mock('../utils/crypto', () => ({
    importKeyFromBase64: async (k: string) => ({ k }),
    decryptBlob: async () => new Blob(['plain']),
}));

vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));

import { Banner } from './Banner';
import { preloadAvatar, peekAvatarUrl, __resetAvatarCaches } from '../hooks/useEncryptedAvatar';

const TOKEN = 't';
let root: Root;
let release: Array<() => void> = [];

const el = () => document.getElementById('root') as HTMLElement;
const img = () => el().querySelector('.cipherline-banner-img') as HTMLImageElement | null;
const defaultBanner = () => el().querySelector('.cipherline-banner-default');

function render(attachmentId: string | null) {
    act(() => { root.render(React.createElement(Banner, { attachmentId, token: TOKEN, bypassFriendGate: true })); });
}

async function flush() {
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetAvatarCaches();
    keyStore.clear(); blobStore.clear(); release = [];
    let n = 0;
    (globalThis as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => `blob:u${++n}`);
    (globalThis as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
    // Network answers are held until the test releases them, so "before the
    // banner arrives" is a state the test can look at.
    axiosGet.mockReset();
    axiosGet.mockImplementation((u: string) => new Promise(resolve => {
        const answer = () => {
            if (u.includes('/key')) resolve({ data: { file_key_b64: 'K', file_nonce_b64: 'n' } });
            else if (u.includes('/download')) resolve({ data: { download_url: 'https://media/x', mime_type: 'image/jpeg' } });
            else resolve({ data: new Blob(['cipher']) });
        };
        release.push(answer);
    }));
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(el());
});

afterEach(() => { act(() => root.unmount()); });

async function releaseAll() {
    for (let i = 0; i < 6; i++) {
        const r = release; release = [];
        r.forEach(f => f());
        await flush();
    }
}

describe('Banner', () => {
    it('no banner at all: the default banner, and no image', () => {
        render(null);
        expect(defaultBanner()).not.toBeNull();
        expect(img()).toBeNull();
    });

    it('a cold banner: default underneath the whole time, then a cross-fade (never a pop)', async () => {
        render('bn-1');
        await flush();
        // Still downloading: the default is there and nothing else is.
        expect(defaultBanner()).not.toBeNull();
        expect(img()).toBeNull();

        await releaseAll();
        const i = img()!;
        expect(i).not.toBeNull();
        expect(defaultBanner()).not.toBeNull();
        // Attached, but transparent until the browser has decoded it…
        expect(i.style.opacity).toBe('0');
        expect(i.style.transition).toContain('opacity');
        // …then faded up.
        act(() => { i.dispatchEvent(new Event('load')); });
        expect(img()!.style.opacity).toBe('1');
        // And persisted under the banner prune class.
        expect(blobStore.get('bn-1')?.kind).toBe('banner');
    });

    it('a banner already in memory paints solid on the FIRST frame', async () => {
        const warm = preloadAvatar('bn-2', TOKEN, { kind: 'banner' });
        await releaseAll();
        await warm;
        expect(peekAvatarUrl('bn-2')).toMatch(/^blob:/);

        render('bn-2');
        const i = img();
        expect(i?.getAttribute('src')).toBe(peekAvatarUrl('bn-2'));
        expect(i?.style.opacity ?? '').toBe(''); // no fade for an instant hit
        expect(axiosGet).toHaveBeenCalledTimes(3); // the warm only — the render cost nothing
    });

    it('an id that ARRIVES after mount but is already in memory is shown in that same render', async () => {
        const warm = preloadAvatar('bn-3', TOKEN, { kind: 'banner' });
        await releaseAll();
        await warm;

        render(null);                // the profile card before its fetch answers
        expect(img()).toBeNull();
        render('bn-3');              // the fetch answered with this id
        // Synchronously — no effect turn in between.
        expect(img()?.getAttribute('src')).toBe(peekAvatarUrl('bn-3'));
    });

    it('a blob that fails to decode is evicted and the default banner stays', async () => {
        render('bn-4');
        await releaseAll();
        const i = img()!;
        expect(blobStore.has('bn-4')).toBe(true);
        act(() => { i.dispatchEvent(new Event('error')); });
        expect(img()).toBeNull();
        expect(defaultBanner()).not.toBeNull();
        expect(blobStore.has('bn-4')).toBe(false);
        expect(peekAvatarUrl('bn-4')).toBeNull();
    });
});
