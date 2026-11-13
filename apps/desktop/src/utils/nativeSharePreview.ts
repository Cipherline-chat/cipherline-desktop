/**
 * The sharer's own picture of a NATIVE (Linux hardware) share.
 *
 * The tile's track is the stand-in the encoder's access units ride on, so it cannot be drawn, and the real frames only exist as encoded
 * bytes in the E2EE flow. Decoding them again just for a thumbnail (a second decoder at 3440x1440 x 90 fps, software on NVIDIA/Linux) is
 * not worth it; instead the helper, which already holds every captured frame, hands the page a small downscaled copy of it - and ONLY
 * while a tile is actually showing (native/share-encoder/preview.h). The cost while on: one strided read of ~110k pixels per picture,
 * PREVIEW_FPS pictures a second, ~0.4 MB each over the existing helper pipe. While off (tile not mounted, window unfocused/hidden): none.
 *
 * Like Windows, where the tile draws the live capture track: a picture while Cipherline is focused, "Preview paused" when it is not (the
 * tile component owns that rule, LocalScreenShareTile). Nothing here is sent to the room; pictures stay in this window.
 */

/** Worker -> page message carrying one picture. */
export const NATIVE_PREVIEW_FRAME_KIND = 'cl:native-preview-frame';
/** What the tile asks the helper for: wide enough to read the layout in the focused view, small enough to be cheap. */
export const PREVIEW_W = 512;
export const PREVIEW_FPS = 6;
const MAX_DIM = 1280;

export interface PreviewPicture { w: number; h: number; rgba: Uint8ClampedArray }

/**
 * A helper preview record's payload (u16 w | u16 h | w*h*4 bytes R,G,B,255) -> a picture, or null for anything malformed (wrong length,
 * zero or oversized dimensions). The bytes come from our own helper but cross a process boundary, so the length is checked exactly.
 */
export function readPreviewPayload(data: Uint8Array): { w: number; h: number; rgba: Uint8Array } | null {
    if (data.length < 4 + 4) return null;
    const w = data[0] | (data[1] << 8), h = data[2] | (data[3] << 8);
    if (w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) return null;
    if (data.length !== 4 + w * h * 4) return null;
    return { w, h, rgba: data.slice(4) };   // an exactly-sized fresh buffer: the worker transfers it
}

export interface PreviewSource { request(on: boolean): void }

/**
 * One hub per window: the pipeline registers itself as the source while a native share runs; tiles subscribe. The helper is asked for
 * pictures when the FIRST tile subscribes and told to stop when the LAST one leaves (a docked strip and a focused stage can both show
 * your share at once; they share one stream of pictures). The last picture is dropped the moment nobody is watching.
 */
export function createNativePreviewHub() {
    let source: PreviewSource | null = null;
    let latest: PreviewPicture | null = null;
    const subs = new Set<(p: PreviewPicture | null) => void>();
    const ask = (on: boolean) => { try { source?.request(on); } catch { /* helper gone: the share is ending anyway */ } };
    return {
        setSource(s: PreviewSource | null): void {
            source = s;
            if (!s) { latest = null; for (const cb of [...subs]) cb(null); return; }
            if (subs.size > 0) ask(true);
        },
        subscribe(cb: (p: PreviewPicture | null) => void): () => void {
            subs.add(cb);
            if (subs.size === 1) ask(true);
            if (latest) cb(latest);
            return () => {
                if (!subs.delete(cb)) return;
                if (subs.size === 0) { latest = null; ask(false); }
            };
        },
        push(p: PreviewPicture): void { if (subs.size === 0) return; latest = p; for (const cb of [...subs]) cb(p); },
        hasSource(): boolean { return source !== null; },
        subscriberCount(): number { return subs.size; },
    };
}

export const nativePreviewHub = createNativePreviewHub();
