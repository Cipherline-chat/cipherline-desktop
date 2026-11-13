/**
 * Re-encode a cover image as a small JPEG, in the renderer (canvas). Used for
 * the friend-visible Spotify cover (<= 160 px, a few KB) and the report
 * evidence thumbnail. Re-encoding through a canvas keeps only pixels: no
 * EXIF / XMP / ICC / comment from the source survives.
 *
 * Returns null when the platform cannot decode / encode (tests, a broken
 * image) - callers then simply share no cover.
 */

/** Pixels on the longer side of a friend-visible cover. */
export const COVER_MAX_PX = 160;
/** The publisher's own target (the hard cap is COVER_MAX_IMAGE_BYTES). */
export const COVER_TARGET_BYTES = 16 * 1024;
const QUALITIES = [0.8, 0.65, 0.5] as const;

export async function reencodeJpeg(src: Blob, maxPx: number, quality: number): Promise<Uint8Array | null> {
    try {
        if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
        const bmp = await createImageBitmap(src);
        const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height, 1));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) { bmp.close(); return null; }
        // JPEG has no alpha: a transparent PNG cover lands on black, not on garbage.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        return new Uint8Array(await out.arrayBuffer());
    } catch { return null; }
}

/** A data:image/... URI (what the main process hands the renderer) -> Blob, or null. */
export function dataUriToBlob(uri: string): Blob | null {
    const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if (!m) return null;
    try {
        const bin = atob(m[2]);
        const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        return new Blob([b], { type: m[1] });
    } catch { return null; }
}

/** The friend-visible cover: <= 160 px JPEG under the byte target, trying lower qualities. */
export async function downscaleCover(dataUri: string, maxBytes = COVER_TARGET_BYTES): Promise<Uint8Array | null> {
    const blob = dataUriToBlob(dataUri);
    if (!blob) return null;
    for (const q of QUALITIES) {
        const jpeg = await reencodeJpeg(blob, COVER_MAX_PX, q);
        if (!jpeg) return null;
        if (jpeg.length <= maxBytes) return jpeg;
    }
    return null;
}
