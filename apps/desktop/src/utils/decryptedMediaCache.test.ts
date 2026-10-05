import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    acquireDecryptedMedia,
    peekDecryptedMedia,
    peekDecryptedMediaBlob,
    putDecryptedMediaBlob,
    releaseDecryptedMedia,
    clearDecryptedMediaCache,
    __decryptedMediaStats,
    __decryptedMediaBudget,
} from './decryptedMediaCache';
import { dropSessionMedia } from './sessionMedia';
import { loadRemoteImage, peekRemoteImage, releaseRemoteImage } from './remoteImageCache';

const { MAX_BYTES, MAX_ENTRIES } = __decryptedMediaBudget;

/** A Blob-shaped value with an arbitrary reported size (so the byte budget is reachable without allocating it). */
const blob = (bytes: number) => ({ size: bytes } as Blob);

let live: Set<string>;
let n = 0;
beforeEach(() => {
    live = new Set();
    URL.createObjectURL = vi.fn(() => { const u = `blob:test/${++n}`; live.add(u); return u; });
    URL.revokeObjectURL = vi.fn((u: string) => { live.delete(u); });
    clearDecryptedMediaCache();
    live.clear();
});

describe('decrypted media cache — the single owner of decrypted attachment / saved-GIF object URLs', () => {
    it('budget: one byte constant and one entry cap, and the shipped values are the measured lane-C ones', () => {
        expect(MAX_BYTES).toBe(64 * 1024 * 1024);
        expect(MAX_ENTRIES).toBe(200);
    });

    it('a remount reuses the URL instead of minting (and leaking) a new one', () => {
        const u1 = putDecryptedMediaBlob('att-1', blob(1000));
        releaseDecryptedMedia('att-1');                 // pane unmounts
        expect(acquireDecryptedMedia('att-1')).toBe(u1); // pane remounts
        expect(live.size).toBe(1);
    });

    it('over the byte budget it revokes the least recently used UNHELD entries and keeps held ones', () => {
        const big = Math.floor(MAX_BYTES / 2) + 1;
        const a = putDecryptedMediaBlob('a', blob(big));
        const b = putDecryptedMediaBlob('b', blob(big));
        const c = putDecryptedMediaBlob('c', blob(10)); // stays held
        releaseDecryptedMedia('a');
        releaseDecryptedMedia('b'); // a + b exceed the budget → the older (a) goes
        expect(live.has(a)).toBe(false);
        expect(live.has(b)).toBe(true);
        expect(live.has(c)).toBe(true);
        expect(acquireDecryptedMedia('a')).toBeNull();
    });

    it('never revokes a URL that is still held, however far over budget (an on-screen video keeps playing)', () => {
        const held = putDecryptedMediaBlob('video', blob(MAX_BYTES * 3));
        for (let i = 0; i < MAX_ENTRIES + 20; i++) {
            putDecryptedMediaBlob(`x${i}`, blob(10));
            releaseDecryptedMedia(`x${i}`);
        }
        expect(live.has(held)).toBe(true);
        expect(__decryptedMediaStats().held).toBe(1);
    });

    it('bounds the number of entries and revokes what it drops', () => {
        for (let i = 0; i < MAX_ENTRIES * 2; i++) {
            putDecryptedMediaBlob(`k${i}`, blob(1));
            releaseDecryptedMedia(`k${i}`);
        }
        expect(live.size).toBe(MAX_ENTRIES);
        expect(__decryptedMediaStats().entries).toBe(MAX_ENTRIES);
    });

    it('LRU: touching an entry protects it from the next eviction', () => {
        for (let i = 0; i < MAX_ENTRIES; i++) { putDecryptedMediaBlob(`k${i}`, blob(1)); releaseDecryptedMedia(`k${i}`); }
        const first = acquireDecryptedMedia('k0')!; releaseDecryptedMedia('k0'); // now most recent
        putDecryptedMediaBlob('new', blob(1)); releaseDecryptedMedia('new');
        expect(live.has(first)).toBe(true);
        expect(acquireDecryptedMedia('k1')).toBeNull();
    });

    it('a second decrypt of the same attachment reuses the first URL and revokes the duplicate', () => {
        const u1 = putDecryptedMediaBlob('dup', blob(5));
        const u2 = putDecryptedMediaBlob('dup', blob(5));
        expect(u2).toBe(u1);
        expect(live.size).toBe(1);
        expect(__decryptedMediaStats().held).toBe(1);
        releaseDecryptedMedia('dup'); releaseDecryptedMedia('dup'); releaseDecryptedMedia('dup'); // over-release is harmless
        expect(__decryptedMediaStats().held).toBe(0);
    });

    it('keeps the Blob beside the URL so a saved GIF re-sends without a second file read + decrypt', () => {
        const b = new Blob(['GIF89a'], { type: 'image/gif' });
        putDecryptedMediaBlob('gif:1', b);
        releaseDecryptedMedia('gif:1');
        expect(peekDecryptedMediaBlob('gif:1')).toBe(b);
        expect(peekDecryptedMediaBlob('gif:missing')).toBeNull();
    });

    it("the sender's own just-uploaded File is registered as-is, so it shows with no download or decrypt", () => {
        const file = new File(['x'], 'cat.png', { type: 'image/png' });
        const url = putDecryptedMediaBlob('att-own', file);
        expect(URL.createObjectURL).toHaveBeenCalledWith(file);
        expect(acquireDecryptedMedia('att-own')).toBe(url);   // a later visit finds it already cached
        expect(peekDecryptedMediaBlob('att-own')).toBe(file);
    });

    it('sign-out revokes everything, held entries included, and leaves nothing to peek', () => {
        putDecryptedMediaBlob('p', blob(1));                                  // still held by a mounted pane
        putDecryptedMediaBlob('q', blob(1)); releaseDecryptedMedia('q');      // warm
        clearDecryptedMediaCache();
        expect(live.size).toBe(0);
        expect(peekDecryptedMedia('p')).toBeNull();
        expect(__decryptedMediaStats()).toEqual({ entries: 0, bytes: 0, held: 0 });
    });

    it('dropSessionMedia (what every sign-out path calls) clears decrypted media AND remote images', async () => {
        putDecryptedMediaBlob('att', blob(1));
        const e = await loadRemoteImage('https://x/a.png', async () => ({ mimeType: 'image/png', b64: btoa('png') }));
        releaseRemoteImage('https://x/a.png');
        expect(peekRemoteImage('https://x/a.png')).not.toBeNull();
        dropSessionMedia();
        expect(live.size).toBe(0);
        expect(peekDecryptedMedia('att')).toBeNull();
        expect(peekRemoteImage('https://x/a.png')).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(e.url);
    });
});
