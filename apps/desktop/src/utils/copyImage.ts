/**
 * "Copy image" — put a picture the user is already looking at on the OS
 * clipboard as a PNG.
 *
 * PRIVACY. The bytes come from a `blob:` URL the renderer already holds (a
 * decrypted attachment, or an image the user chose to load). They go
 * renderer → clipboard and nowhere else: no server round-trip, no network,
 * and nothing in here logs pixel data, file names or URLs. Only `blob:` URLs
 * are accepted — a remote `https:` source would turn "copy" into a fetch that
 * tells a third party the user's IP, which the click-to-load embeds exist to
 * prevent.
 *
 * MECHANISM. Two tiers, in order:
 *   1. Web Clipboard API — `navigator.clipboard.write([ClipboardItem])`.
 *   2. The preload bridge `electronAPI.clipboardWriteImage(png)`, which main
 *      validates (electron/clipboard-image.ts) and writes with
 *      `clipboard.writeImage`. Used when the sandboxed renderer is refused the
 *      web permission (main's permission handler denies anything it does not
 *      list), or the API is missing.
 *
 * Non-PNG sources (JPEG/WebP/GIF/BMP/AVIF) are decoded and re-encoded as PNG.
 * An animated GIF yields its FIRST FRAME — callers tell the user so.
 */
import { sanitizeMime } from './crypto';

/** Largest PNG we will hand to the clipboard (mirrors main's validator). */
export const MAX_COPY_IMAGE_PNG_BYTES = 50 * 1024 * 1024;
/** Largest source blob we will try to decode. */
export const MAX_COPY_IMAGE_SOURCE_BYTES = 100 * 1024 * 1024;
/** Decoded-pixel ceiling (decompression-bomb guard). */
export const MAX_COPY_IMAGE_PIXELS = 100_000_000;

/** Raster formats we can decode to PNG. SVG is deliberately absent. */
const COPYABLE_MIMES = new Set([
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
]);

/** True for a (sender-supplied) attachment mime that is a raster image we can copy. */
export function isCopyableImageMime(mime: string | null | undefined): boolean {
    return COPYABLE_MIMES.has(sanitizeMime(mime ?? ''));
}

/**
 * Which local image, if any, the message context menu should offer to copy.
 * Only an image that is actually on screen qualifies: a DECRYPTED attachment
 * (its URL does not exist until decrypt/reveal, so a click-to-decrypt
 * placeholder offers nothing) whose mime is a copyable raster, or a loaded
 * image-link embed (its wrapper carries the local blob: URL). There is no
 * spoiler / NSFW-blur concept on message images; "revealed" is exactly "a URL
 * exists". Anything not a blob: URL is refused.
 */
export function copyImageSourceFor(a: {
    isAttachment: boolean;
    attachmentUrl: string | null | undefined;
    attachmentMime: string | null | undefined;
    embedUrl: string | null | undefined;
}): string | null {
    if (a.isAttachment && a.attachmentUrl && a.attachmentUrl.startsWith('blob:') && isCopyableImageMime(a.attachmentMime)) {
        return a.attachmentUrl;
    }
    if (a.embedUrl && a.embedUrl.startsWith('blob:')) return a.embedUrl;
    return null;
}

/** The local blob: URL of the loaded image-link embed under a right-click target, if any. */
export function embedImageUrlOf(target: EventTarget | null): string | null {
    const el = target as Element | null;
    return el && typeof el.closest === 'function'
        ? el.closest('[data-cl-copy-image]')?.getAttribute('data-cl-copy-image') ?? null
        : null;
}

export function isPngBytes(b: Uint8Array): boolean {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return b.length >= 8 && sig.every((v, i) => b[i] === v);
}

function isGifBytes(b: Uint8Array): boolean {
    return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
}

export interface PngEncodeEnv {
    createImageBitmap: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
    /** Draw the bitmap on a canvas of its own size and encode it as PNG. */
    drawToPng: (bitmap: { width: number; height: number }) => Promise<Blob>;
}

function defaultEncodeEnv(): PngEncodeEnv {
    return {
        createImageBitmap: (b) => createImageBitmap(b),
        drawToPng: async (bitmap) => {
            if (typeof OffscreenCanvas !== 'undefined') {
                const c = new OffscreenCanvas(bitmap.width, bitmap.height);
                const ctx = c.getContext('2d');
                if (!ctx) throw new Error('no 2d context');
                ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
                return c.convertToBlob({ type: 'image/png' });
            }
            const c = document.createElement('canvas');
            c.width = bitmap.width;
            c.height = bitmap.height;
            const ctx = c.getContext('2d');
            if (!ctx) throw new Error('no 2d context');
            ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
            return new Promise<Blob>((resolve, reject) =>
                c.toBlob((out) => (out ? resolve(out) : reject(new Error('toBlob failed'))), 'image/png'));
        },
    };
}

export class CopyImageError extends Error {
    readonly reason: 'too-large' | 'unsupported' | 'decode' | 'clipboard' | 'source';
    constructor(reason: 'too-large' | 'unsupported' | 'decode' | 'clipboard' | 'source', message: string) {
        super(message);
        this.name = 'CopyImageError';
        this.reason = reason;
    }
}

/**
 * Normalise any supported raster blob to PNG. PNG input is passed through
 * (identified by its signature, not by the blob's declared type).
 */
export async function imageBlobToPng(
    blob: Blob,
    env: PngEncodeEnv = defaultEncodeEnv(),
): Promise<{ png: Blob; flattenedAnimation: boolean }> {
    if (blob.size === 0) throw new CopyImageError('decode', 'empty image');
    if (blob.size > MAX_COPY_IMAGE_SOURCE_BYTES) throw new CopyImageError('too-large', 'image too large');
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (isPngBytes(head)) {
        if (blob.size > MAX_COPY_IMAGE_PNG_BYTES) throw new CopyImageError('too-large', 'image too large');
        return { png: blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' }), flattenedAnimation: false };
    }
    let bitmap: Awaited<ReturnType<PngEncodeEnv['createImageBitmap']>>;
    try {
        bitmap = await env.createImageBitmap(blob);
    } catch {
        throw new CopyImageError('decode', 'could not decode image');
    }
    try {
        if (!(bitmap.width > 0 && bitmap.height > 0) || bitmap.width * bitmap.height > MAX_COPY_IMAGE_PIXELS) {
            throw new CopyImageError('too-large', 'image dimensions out of range');
        }
        let png: Blob;
        try {
            png = await env.drawToPng(bitmap);
        } catch {
            throw new CopyImageError('decode', 'could not encode image');
        }
        if (png.size > MAX_COPY_IMAGE_PNG_BYTES) throw new CopyImageError('too-large', 'image too large');
        return { png, flattenedAnimation: isGifBytes(head) };
    } finally {
        bitmap.close?.();
    }
}

export interface ClipboardEnv {
    /** Web Clipboard write; undefined when the API does not exist here. */
    writeWeb?: (png: Blob) => Promise<void>;
    /** Preload bridge; undefined when this build's main/preload lacks it. */
    writeBridge?: (png: Uint8Array) => Promise<void>;
}

function defaultClipboardEnv(): ClipboardEnv {
    const env: ClipboardEnv = {};
    if (typeof ClipboardItem !== 'undefined' && typeof navigator !== 'undefined' && navigator.clipboard?.write) {
        env.writeWeb = (png) => navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    }
    const bridge = typeof window !== 'undefined' ? window.electronAPI?.clipboardWriteImage : undefined;
    if (bridge) env.writeBridge = (bytes) => bridge(bytes);
    return env;
}

export interface CopyImageResult {
    via: 'web' | 'bridge';
    /** True when an animated GIF was copied as its first frame only. */
    flattenedAnimation: boolean;
}

/** Convert `blob` to PNG and put it on the clipboard (web API first, bridge second). */
export async function copyImageBlob(
    blob: Blob,
    deps: { encode?: PngEncodeEnv; clipboard?: ClipboardEnv } = {},
): Promise<CopyImageResult> {
    const { png, flattenedAnimation } = await imageBlobToPng(blob, deps.encode);
    const cb = deps.clipboard ?? defaultClipboardEnv();
    if (cb.writeWeb) {
        try {
            await cb.writeWeb(png);
            return { via: 'web', flattenedAnimation };
        } catch {
            // Refused (permission / focus) — fall through to the bridge.
        }
    }
    if (cb.writeBridge) {
        try {
            await cb.writeBridge(new Uint8Array(await png.arrayBuffer()));
            return { via: 'bridge', flattenedAnimation };
        } catch {
            // fall through
        }
    }
    throw new CopyImageError('clipboard', 'clipboard write failed');
}

/** Copy the image behind a `blob:` URL. Any other scheme is refused. */
export async function copyImageFromBlobUrl(
    url: string,
    deps: Parameters<typeof copyImageBlob>[1] & { fetchBlob?: (u: string) => Promise<Blob> } = {},
): Promise<CopyImageResult> {
    if (typeof url !== 'string' || !url.startsWith('blob:')) {
        throw new CopyImageError('source', 'only local images can be copied');
    }
    let blob: Blob;
    try {
        blob = await (deps.fetchBlob ?? (async (u: string) => (await fetch(u)).blob()))(url);
    } catch {
        throw new CopyImageError('source', 'image is no longer available');
    }
    return copyImageBlob(blob, deps);
}

export const COPY_IMAGE_TOAST_OK = 'Image copied';
export const COPY_IMAGE_TOAST_OK_GIF = 'Image copied (first frame of the GIF)';

/** Copy + toast. Never throws; never logs anything about the image. */
export async function copyImageWithToast(
    url: string,
    toast: { push: (t: { kind: 'success' | 'error'; message: string }) => void },
    deps?: Parameters<typeof copyImageFromBlobUrl>[1],
): Promise<void> {
    try {
        const r = await copyImageFromBlobUrl(url, deps);
        toast.push({ kind: 'success', message: r.flattenedAnimation ? COPY_IMAGE_TOAST_OK_GIF : COPY_IMAGE_TOAST_OK });
    } catch (err) {
        const reason = err instanceof CopyImageError ? err.reason : 'clipboard';
        const message = reason === 'too-large' ? 'Could not copy — the image is too large.'
            : reason === 'source' ? 'Could not copy — the image is no longer available.'
            : 'Could not copy the image.';
        toast.push({ kind: 'error', message });
    }
}
