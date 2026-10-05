import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadRemoteImage, releaseRemoteImage, peekRemoteImage, acquireRemoteImage, clearRemoteImageCache, __remoteImageStats } from './remoteImageCache';
import { acquireDecryptedMedia, putDecryptedMedia, releaseDecryptedMedia, peekDecryptedMedia, clearDecryptedMediaCache, __decryptedMediaStats, putMediaThumb, peekMediaThumb, acquireMediaThumb, releaseMediaThumb } from './decryptedMediaCache';

let n = 0;
beforeEach(() => {
    clearRemoteImageCache();
    clearDecryptedMediaCache();
    vi.restoreAllMocks();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

describe('remoteImageCache', () => {
    it('one fetch per URL: concurrent embeds share it, a remount reuses it', async () => {
        const fetchBinary = vi.fn(async () => ({ mimeType: 'image/gif', b64: btoa('GIF89a') }));
        const [a, b] = await Promise.all([
            loadRemoteImage('https://x/y.gif', fetchBinary),
            loadRemoteImage('https://x/y.gif', fetchBinary),
        ]);
        expect(fetchBinary).toHaveBeenCalledTimes(1);
        expect(a.url).toBe(b.url);
        expect(__remoteImageStats()).toMatchObject({ entries: 1, held: 1 });
        expect(a.refs).toBe(2);
        // Both embeds unmount (channel switch) — stays cached, not revoked.
        releaseRemoteImage('https://x/y.gif'); releaseRemoteImage('https://x/y.gif');
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        // Switching back: the render-time seed and the effect's hold both hit.
        expect(peekRemoteImage('https://x/y.gif')?.url).toBe(a.url);
        expect(acquireRemoteImage('https://x/y.gif')?.url).toBe(a.url);
        await loadRemoteImage('https://x/y.gif', fetchBinary);
        expect(fetchBinary).toHaveBeenCalledTimes(1);
    });

    it('keeps the Blob for "save GIF" and the decoded bytes are right', async () => {
        const e = await loadRemoteImage('https://x/z.gif', async () => ({ mimeType: 'image/gif', b64: btoa('GIF89a') }));
        expect(e.blob?.type).toBe('image/gif');
        expect(new TextDecoder().decode(new Uint8Array(await e.blob!.arrayBuffer()))).toBe('GIF89a');
    });

    it('a failed fetch is not cached and does not wedge later attempts', async () => {
        const bad = vi.fn(async () => { throw new Error('blocked'); });
        await expect(loadRemoteImage('https://x/bad.png', bad)).rejects.toThrow('blocked');
        const good = vi.fn(async () => ({ mimeType: 'image/png', b64: btoa('png') }));
        await expect(loadRemoteImage('https://x/bad.png', good)).resolves.toMatchObject({ refs: 1 });
    });
});

describe('decryptedMediaCache', () => {
    it('a remounted pane gets the same decrypted URL back without decrypting', () => {
        expect(putDecryptedMedia('att-1', 'blob:A', 1000)).toBe('blob:A');
        releaseDecryptedMedia('att-1');                     // pane unmounts
        expect(peekDecryptedMedia('att-1')).toBe('blob:A'); // new pane's first render
        expect(acquireDecryptedMedia('att-1')).toBe('blob:A');
        expect(__decryptedMediaStats().held).toBe(1);
    });

    it('two panes decrypting the same file converge on one URL', () => {
        putDecryptedMedia('att-2', 'blob:first', 10);
        expect(putDecryptedMedia('att-2', 'blob:second', 10)).toBe('blob:first');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
    });

    it('sign-out clears and revokes everything, thumbnails included', () => {
        putDecryptedMedia('att-3', 'blob:C', 10);
        putMediaThumb('blob:C', 'blob:C-thumb', 5, 500, 375);
        clearDecryptedMediaCache();
        expect(peekDecryptedMedia('att-3')).toBeNull();
        expect(peekMediaThumb('blob:C')).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:C');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:C-thumb');
    });

    it('a remounted FileViewer gets its thumbnail (and its size) back without re-encoding', () => {
        putMediaThumb('blob:full', 'blob:thumb', 40_000, 500, 375);
        releaseMediaThumb('blob:full');
        expect(peekMediaThumb('blob:full')).toEqual({ url: 'blob:thumb', width: 500, height: 375 });
        expect(acquireMediaThumb('blob:full')?.url).toBe('blob:thumb');
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:thumb');
    });
});
