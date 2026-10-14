import { describe, it, expect, vi } from 'vitest';
import {
    isCopyableImageMime, copyImageSourceFor, isPngBytes, imageBlobToPng, copyImageBlob, copyImageFromBlobUrl,
    copyImageWithToast, CopyImageError, MAX_COPY_IMAGE_PNG_BYTES, MAX_COPY_IMAGE_PIXELS,
    COPY_IMAGE_TOAST_OK, COPY_IMAGE_TOAST_OK_GIF, type PngEncodeEnv, type ClipboardEnv,
} from './copyImage';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBlob = (extra = 8) => new Blob([new Uint8Array([...PNG_HEAD, ...new Array(extra).fill(0)])], { type: 'image/png' });
const jpegBlob = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], { type: 'image/jpeg' });
const gifBlob = () => new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], { type: 'image/gif' });

function encodeEnv(over: Partial<{ w: number; h: number; png: Blob; decodeFails: boolean }> = {}) {
    const close = vi.fn();
    const decoded = vi.fn();
    const env: PngEncodeEnv = {
        createImageBitmap: async (b) => {
            decoded(b);
            if (over.decodeFails) throw new Error('bad');
            return { width: over.w ?? 10, height: over.h ?? 10, close };
        },
        drawToPng: async () => over.png ?? pngBlob(),
    };
    return { env, close, decoded };
}

describe('menu gate: which images get "Copy image"', () => {
    it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])('%s attachment is offered', (mime) => {
        expect(copyImageSourceFor({ isAttachment: true, attachmentUrl: 'blob:a', attachmentMime: mime, embedUrl: null })).toBe('blob:a');
    });

    it.each(['application/pdf', 'text/plain', 'video/mp4', 'audio/mpeg', 'application/zip', 'application/x-weird', 'image/svg+xml', ''])(
        'non-image / non-raster %j is NOT offered', (mime) => {
            expect(copyImageSourceFor({ isAttachment: true, attachmentUrl: 'blob:a', attachmentMime: mime, embedUrl: null })).toBeNull();
        });

    it('NOT offered before the attachment is decrypted/revealed (no URL yet)', () => {
        expect(copyImageSourceFor({ isAttachment: true, attachmentUrl: null, attachmentMime: 'image/png', embedUrl: null })).toBeNull();
        expect(copyImageSourceFor({ isAttachment: true, attachmentUrl: undefined, attachmentMime: 'image/png', embedUrl: null })).toBeNull();
    });

    it('NOT offered for a non-attachment message even if a stale URL is passed', () => {
        expect(copyImageSourceFor({ isAttachment: false, attachmentUrl: 'blob:a', attachmentMime: 'image/png', embedUrl: null })).toBeNull();
    });

    it('a remote (non-blob) URL is never offered, for attachment or embed', () => {
        expect(copyImageSourceFor({ isAttachment: true, attachmentUrl: 'https://x/y.png', attachmentMime: 'image/png', embedUrl: null })).toBeNull();
        expect(copyImageSourceFor({ isAttachment: false, attachmentUrl: null, attachmentMime: null, embedUrl: 'https://x/y.png' })).toBeNull();
    });

    it('a loaded image-link embed is offered via its blob URL', () => {
        expect(copyImageSourceFor({ isAttachment: false, attachmentUrl: null, attachmentMime: null, embedUrl: 'blob:e' })).toBe('blob:e');
    });

    it('mime is clamped like the renderer does (mime parameters, case)', () => {
        expect(isCopyableImageMime('IMAGE/PNG; charset=binary')).toBe(true);
        expect(isCopyableImageMime(undefined)).toBe(false);
    });
});

describe('format conversion', () => {
    it('a PNG passes through untouched and is not decoded', async () => {
        const { env, decoded } = encodeEnv();
        const src = pngBlob();
        const r = await imageBlobToPng(src, env);
        expect(r.png).toBe(src);
        expect(r.flattenedAnimation).toBe(false);
        expect(decoded).not.toHaveBeenCalled();
    });

    it('a PNG is recognised by its bytes, not its declared type', async () => {
        const { env, decoded } = encodeEnv();
        const mislabelled = new Blob([await pngBlob().arrayBuffer()], { type: 'image/jpeg' });
        const r = await imageBlobToPng(mislabelled, env);
        expect(r.png.type).toBe('image/png');
        expect(decoded).not.toHaveBeenCalled();
    });

    it('a JPEG is decoded and re-encoded as PNG, and the bitmap is released', async () => {
        const out = pngBlob(100);
        const { env, decoded, close } = encodeEnv({ png: out });
        const r = await imageBlobToPng(jpegBlob(), env);
        expect(decoded).toHaveBeenCalledTimes(1);
        expect(r.png).toBe(out);
        expect(r.flattenedAnimation).toBe(false);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('a GIF is converted and flagged as flattened to its first frame', async () => {
        const { env } = encodeEnv();
        const r = await imageBlobToPng(gifBlob(), env);
        expect(r.flattenedAnimation).toBe(true);
    });

    it('negative control: an undecodable image is a decode error, not a silent success', async () => {
        const { env } = encodeEnv({ decodeFails: true });
        await expect(imageBlobToPng(jpegBlob(), env)).rejects.toMatchObject({ reason: 'decode' });
    });

    it('refuses an empty blob and an absurd pixel count (decompression bomb)', async () => {
        await expect(imageBlobToPng(new Blob([]), encodeEnv().env)).rejects.toMatchObject({ reason: 'decode' });
        const bomb = encodeEnv({ w: 20000, h: Math.ceil(MAX_COPY_IMAGE_PIXELS / 20000) + 1 });
        await expect(imageBlobToPng(jpegBlob(), bomb.env)).rejects.toMatchObject({ reason: 'too-large' });
        expect(bomb.close).toHaveBeenCalled();
    });

    it('refuses a re-encoded PNG over the size cap', async () => {
        const big = { size: MAX_COPY_IMAGE_PNG_BYTES + 1 } as unknown as Blob;
        await expect(imageBlobToPng(jpegBlob(), encodeEnv({ png: big }).env)).rejects.toMatchObject({ reason: 'too-large' });
    });

    it('isPngBytes sniffs the signature', () => {
        expect(isPngBytes(new Uint8Array(PNG_HEAD))).toBe(true);
        expect(isPngBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false);
        expect(isPngBytes(new Uint8Array([]))).toBe(false);
    });
});

describe('clipboard write path', () => {
    it('uses the web Clipboard API first, with a PNG', async () => {
        const writeWeb = vi.fn(async () => {});
        const writeBridge = vi.fn(async () => {});
        const r = await copyImageBlob(jpegBlob(), { encode: encodeEnv().env, clipboard: { writeWeb, writeBridge } });
        expect(r.via).toBe('web');
        expect(writeWeb).toHaveBeenCalledTimes(1);
        expect((writeWeb.mock.calls[0] as unknown as [Blob])[0].type).toBe('image/png');
        expect(writeBridge).not.toHaveBeenCalled();
    });

    it('falls back to the preload bridge (PNG bytes) when the web write is refused', async () => {
        const writeWeb = vi.fn(async () => { throw new Error('NotAllowedError'); });
        const writeBridge = vi.fn(async (b: Uint8Array) => { void b; });
        const r = await copyImageBlob(jpegBlob(), { encode: encodeEnv().env, clipboard: { writeWeb, writeBridge } });
        expect(r.via).toBe('bridge');
        const sent = writeBridge.mock.calls[0][0];
        expect(sent).toBeInstanceOf(Uint8Array);
        expect(isPngBytes(sent)).toBe(true);
    });

    it('uses the bridge when there is no web API at all', async () => {
        const writeBridge = vi.fn(async (b: Uint8Array) => { void b; });
        const r = await copyImageBlob(pngBlob(), { clipboard: { writeBridge } });
        expect(r.via).toBe('bridge');
    });

    it('negative control: both tiers failing is an error, never a fake success', async () => {
        const fail = async () => { throw new Error('no'); };
        await expect(copyImageBlob(pngBlob(), { clipboard: { writeWeb: fail, writeBridge: fail } as ClipboardEnv }))
            .rejects.toMatchObject({ reason: 'clipboard' });
        await expect(copyImageBlob(pngBlob(), { clipboard: {} })).rejects.toBeInstanceOf(CopyImageError);
    });

    it('does not even touch the clipboard when conversion fails', async () => {
        const writeWeb = vi.fn(async () => {});
        await expect(copyImageBlob(jpegBlob(), { encode: encodeEnv({ decodeFails: true }).env, clipboard: { writeWeb } })).rejects.toBeTruthy();
        expect(writeWeb).not.toHaveBeenCalled();
    });
});

describe('source URL gate (privacy: never a network fetch)', () => {
    it('refuses every non-blob scheme before fetching anything', async () => {
        const fetchBlob = vi.fn(async () => pngBlob());
        for (const u of ['https://example.com/a.png', 'http://x/y', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
            await expect(copyImageFromBlobUrl(u, { fetchBlob })).rejects.toMatchObject({ reason: 'source' });
        }
        expect(fetchBlob).not.toHaveBeenCalled();
    });

    it('reads the blob: URL and copies it', async () => {
        const writeWeb = vi.fn(async () => {});
        const fetchBlob = vi.fn(async () => pngBlob());
        const r = await copyImageFromBlobUrl('blob:abc', { fetchBlob, clipboard: { writeWeb } });
        expect(fetchBlob).toHaveBeenCalledWith('blob:abc');
        expect(r.via).toBe('web');
    });

    it('a revoked blob URL is a "source" error', async () => {
        const fetchBlob = async () => { throw new TypeError('Failed to fetch'); };
        await expect(copyImageFromBlobUrl('blob:gone', { fetchBlob })).rejects.toMatchObject({ reason: 'source' });
    });
});

describe('toasts', () => {
    it('success says "Image copied"', async () => {
        const push = vi.fn();
        await copyImageWithToast('blob:a', { push }, { fetchBlob: async () => pngBlob(), clipboard: { writeWeb: async () => {} } });
        expect(push).toHaveBeenCalledWith({ kind: 'success', message: COPY_IMAGE_TOAST_OK });
    });

    it('GIF success says it was the first frame', async () => {
        const push = vi.fn();
        await copyImageWithToast('blob:a', { push }, { fetchBlob: async () => gifBlob(), encode: encodeEnv().env, clipboard: { writeWeb: async () => {} } });
        expect(push).toHaveBeenCalledWith({ kind: 'success', message: COPY_IMAGE_TOAST_OK_GIF });
    });

    it('failure toasts an error and does not throw', async () => {
        const push = vi.fn();
        await expect(copyImageWithToast('blob:a', { push }, { fetchBlob: async () => pngBlob(), clipboard: {} })).resolves.toBeUndefined();
        expect(push).toHaveBeenCalledTimes(1);
        expect(push.mock.calls[0][0].kind).toBe('error');
    });

    it('never logs the image (no console output on success or failure)', async () => {
        const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(k => vi.spyOn(console, k).mockImplementation(() => {}));
        await copyImageWithToast('blob:a', { push: () => {} }, { fetchBlob: async () => pngBlob(), clipboard: { writeWeb: async () => {} } });
        await copyImageWithToast('blob:a', { push: () => {} }, { fetchBlob: async () => pngBlob(), clipboard: {} });
        spies.forEach(s => { expect(s).not.toHaveBeenCalled(); s.mockRestore(); });
    });
});
