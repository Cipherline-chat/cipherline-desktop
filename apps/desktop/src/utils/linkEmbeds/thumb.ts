/**
 * Link-preview thumbnails: decode → re-encode on the SENDER, sniff on the
 * receiver (docs/plans/embeds.md §5).
 *
 * The image a page names is untrusted bytes from the internet. Before it goes
 * into a message the sender's renderer decodes it (createImageBitmap) and
 * draws it onto a fresh canvas, then encodes a NEW WebP from the pixels. That
 * drops everything that is not pixels: EXIF / GPS / XMP / ICC text, comments,
 * trailing data, and any payload aimed at a decoder bug on the receiving side
 * (receivers only ever decode our own encoder's output). Animated GIFs become
 * their first frame. The result is at most LINK_EMBED_THUMB_MAX_BYTES (and
 * usually far less), scaled down to what a card shows at 2x.
 */
import { LINK_EMBED_THUMB_MAX_BYTES, type LinkEmbedThumbMime } from '@cipherline/shared';
import { decodeIco, isIco } from './ico';

/** Longest edge of a re-encoded thumbnail (an Island hero is 460 px wide; 2x for HiDPI). */
export const THUMB_MAX_EDGE = 920;
/** An author's picture (phase 4): drawn at 34 px, so 128 px is plenty (and rides inline). */
export const AVATAR_MAX_EDGE = 128;
/** A site's icon on a web card (its favicon): drawn at 16-32 px, so 64 px (2x) is plenty, and rides inline. */
export const SITE_ICON_MAX_EDGE = 64;
/** A page SNAPSHOT (electron/unfurl/page-snapshot.ts, 1200x675): kept at its size, the YouTube-like big picture. */
export const SNAPSHOT_MAX_EDGE = 1200;
const QUALITIES = [0.82, 0.72, 0.6, 0.5, 0.4];

export interface EncodedThumb {
    blob: Blob;
    mime: LinkEmbedThumbMime;
    width: number;
    height: number;
    /**
     * The picture is unusable as a preview: one flat colour, or nearly all
     * black / white (2026-11-24: Medal's og:image is the clip's FIRST frame,
     * pure black for every clip that fades in). The sender's chain then looks
     * further (frame grab, snapshot, the designed picture).
     */
    flat?: true;
    /** The designed card picture (designedThumb.ts): no real picture was found. */
    designed?: true;
}

// ── Is a picture worth showing? ────────────────────────────────────────────

/** Mean and standard deviation of the luma (0-255) of RGBA pixels. */
export function lumaStats(rgba: ArrayLike<number>): { mean: number; std: number } {
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i + 3 < rgba.length; i += 4) {
        const y = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
        sum += y; sq += y * y; n++;
    }
    if (!n) return { mean: 0, std: 0 };
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/**
 * A picture nobody would call a thumbnail: one flat colour (std < 6), or
 * nearly all black (mean < 14) or all white (mean > 245).
 */
export function isFlatPicture(s: { mean: number; std: number }): boolean {
    return s.std < 6 || s.mean < 14 || s.mean > 245;
}

/** How good a candidate frame is: detail, discounted when it is very dark or very bright. Higher is better. */
export function pictureScore(s: { mean: number; std: number }): number {
    if (isFlatPicture(s)) return s.std / 100;
    const exposure = s.mean < 32 || s.mean > 228 ? 0.4 : 1;
    return s.std * exposure + s.mean / 64;
}

export const STATS_W = 32;
export const STATS_H = 18;

/** The luma stats of anything drawable, from a STATS_W x STATS_H sample. Null when it cannot be read (no canvas, a tainted source). */
export function statsOf(src: CanvasImageSource): { mean: number; std: number } | null {
    try {
        const c = makeCanvas(STATS_W, STATS_H);
        const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
        if (!ctx) return null;
        ctx.drawImage(src, 0, 0, STATS_W, STATS_H);
        return lumaStats(ctx.getImageData(0, 0, STATS_W, STATS_H).data);
    } catch {
        return null;
    }
}

/** The real format of image bytes from their magic numbers (never the declared type). */
export function sniffImageMime(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif' | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69) return 'image/avif';
    return null;
}

/** Target size: fit inside THUMB_MAX_EDGE (and `scale` of that), never upscale. */
export function fitSize(w: number, h: number, scale = 1, maxEdge = THUMB_MAX_EDGE): { width: number; height: number } {
    const edge = Math.max(1, Math.round(maxEdge * scale));
    const k = Math.min(1, edge / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export type Canvas = { width: number; height: number; getContext(t: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null };

export function makeCanvas(w: number, h: number): Canvas {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as unknown as Canvas;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c as unknown as Canvas;
}

async function encode(canvas: Canvas, quality: number): Promise<Blob | null> {
    const off = canvas as unknown as OffscreenCanvas;
    if (typeof off.convertToBlob === 'function') return off.convertToBlob({ type: 'image/webp', quality });
    return new Promise((ok) => (canvas as unknown as HTMLCanvasElement).toBlob((b) => ok(b), 'image/webp', quality));
}

/**
 * Untrusted image bytes → pixels. The real format comes from the magic bytes;
 * an .ico (a site's /favicon.ico) is opened here (ico.ts): its PNG picture goes
 * to the PNG decoder, a bitmap picture is decoded to RGBA by ico.ts. SVG / HTML
 * / anything else: null.
 */
async function decodeBitmap(bytes: Uint8Array, want: number): Promise<ImageBitmap | null> {
    if (isIco(bytes)) {
        const ico = decodeIco(bytes, Math.min(want, 256));
        if (!ico) return null;
        if (ico.kind === 'png') {
            if (sniffImageMime(ico.bytes) !== 'image/png') return null;
            return createImageBitmap(new Blob([ico.bytes as BlobPart], { type: 'image/png' }));
        }
        return createImageBitmap(new ImageData(ico.data as unknown as Uint8ClampedArray<ArrayBuffer>, ico.width, ico.height));
    }
    const kind = sniffImageMime(bytes);
    if (!kind) return null;
    return createImageBitmap(new Blob([bytes as BlobPart], { type: kind }));
}

/**
 * Bytes from the unfurler → a fresh WebP within the cap, or null (not an
 * image we decode, or it will not fit). Throws nothing.
 */
export async function reencodeThumb(bytes: Uint8Array, maxEdge = THUMB_MAX_EDGE): Promise<EncodedThumb | null> {
    let bitmap: ImageBitmap;
    try {
        const decoded = await decodeBitmap(bytes, maxEdge);
        if (!decoded) return null;
        bitmap = decoded;
    } catch {
        return null;
    }
    try {
        if (!bitmap.width || !bitmap.height) return null;
        const out = await encodeWebpThumb(bitmap, bitmap.width, bitmap.height, maxEdge);
        if (!out) return null;
        const stats = statsOf(bitmap);
        return stats && isFlatPicture(stats) ? { ...out, flat: true } : out;
    } finally {
        bitmap.close();
    }
}

/**
 * Any drawable (a decoded picture, a video frame, a canvas) of `w` x `h` → a
 * fresh WebP within LINK_EMBED_THUMB_MAX_BYTES, scaled into `maxEdge`; null
 * when there is no WebP encoder or it will not fit.
 */
export async function encodeWebpThumb(src: CanvasImageSource, w: number, h: number, maxEdge = THUMB_MAX_EDGE): Promise<EncodedThumb | null> {
    for (const scale of [1, 0.75, 0.5]) {
        const { width, height } = fitSize(w, h, scale, maxEdge);
        const canvas = makeCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(src, 0, 0, width, height);
        for (const q of QUALITIES) {
            const blob = await encode(canvas, q);
            if (!blob || blob.type !== 'image/webp') return null; // no WebP encoder: send no thumbnail
            if (blob.size <= LINK_EMBED_THUMB_MAX_BYTES) return { blob, mime: 'image/webp', width, height };
        }
    }
    return null;
}

/** Standard base64 of bytes (chunked; no stack blow-up on 12 KB). */
export function bytesToBase64(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}
