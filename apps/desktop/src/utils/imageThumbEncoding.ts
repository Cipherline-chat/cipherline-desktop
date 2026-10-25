/**
 * How an inline image thumbnail is encoded (FileViewer).
 *
 * A thumbnail is drawn onto a canvas and re-encoded. JPEG has no alpha channel,
 * so encoding a transparent PNG/WebP as JPEG flattens every transparent pixel
 * to BLACK — the reported "images with no background appear black". Opaque
 * images keep the small lossy JPEG; an image that actually uses transparency is
 * encoded with an alpha-capable format so the chat background shows through.
 *
 * Pure (no DOM): the canvas work stays in FileViewer; the decisions live here
 * so they are unit-testable in the node test environment.
 */

/** Formats that CAN carry an alpha channel and are worth scanning. JPEG and
 *  BMP-style opaque formats are never scanned (no cost for the common photo);
 *  GIF and SVG never reach the thumbnail path at all (they are shown as-is). */
const ALPHA_CAPABLE = new Set(['image/png', 'image/webp', 'image/avif', 'image/apng', 'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon']);

export function mayHaveAlpha(mime: string): boolean {
    return ALPHA_CAPABLE.has(mime.toLowerCase());
}

/**
 * True when any pixel is not fully opaque. `rgba` is canvas ImageData order
 * (R,G,B,A per pixel). Exits on the first non-opaque pixel; a fully opaque
 * image costs one linear pass over the (already down-scaled) thumbnail.
 */
export function hasTransparentPixel(rgba: ArrayLike<number>): boolean {
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] < 255) return true;
    }
    return false;
}

export interface ThumbEncoding { type: 'image/jpeg' | 'image/webp'; quality: number }

export const THUMB_JPEG_QUALITY = 0.75;
export const THUMB_ALPHA_QUALITY = 0.85;

/** Opaque → JPEG (small); transparent → WebP (lossy, keeps alpha). */
export function pickThumbEncoding(hasAlpha: boolean): ThumbEncoding {
    return hasAlpha
        ? { type: 'image/webp', quality: THUMB_ALPHA_QUALITY }
        : { type: 'image/jpeg', quality: THUMB_JPEG_QUALITY };
}

/**
 * `canvas.toBlob` silently falls back to PNG when it can't produce the
 * requested type — still alpha-capable, so it is accepted. The one result that
 * must never be shown for a transparent source is a JPEG.
 */
export function thumbPreservesAlpha(blobType: string): boolean {
    return blobType === 'image/webp' || blobType === 'image/png';
}
