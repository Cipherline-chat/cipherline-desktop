/**
 * Crop geometry + canvas export — the maths behind `ClImageCropper`.
 *
 * Framework-free and DOM-only (Image + canvas, no Electron, no app state), so
 * the website imports it through the same desktop source tree the `cl/`
 * primitives come from.
 *
 * The model is one frame (the crop viewport, in CSS pixels) with the image
 * drawn behind it:
 *
 *   • `coverScale` is the scale at which the image exactly covers the frame —
 *     the zoomed-all-the-way-out baseline. `CropTransform.scale` multiplies it,
 *     so scale 1 always means "covering, no gutters" regardless of how the
 *     source image is shaped.
 *   • `CropTransform.x/y` pan the image CENTRE away from the frame centre, in
 *     frame pixels. `clampCrop` keeps that pan inside the range where the image
 *     still covers the frame, so the user can never expose an empty corner —
 *     which is why the export never needs to letterbox.
 *
 * Everything downstream (preview transform, canvas export) is derived from
 * those three numbers, so what the user positions is exactly what is encoded.
 */

/** Where the image sits behind the crop frame. */
export interface CropTransform {
    /** Zoom multiplier over the cover-fit baseline. 1 = exactly covering. */
    scale: number;
    /** Pan of the image centre from the frame centre, in frame pixels. */
    x: number;
    y: number;
}

/** Centred, zoomed all the way out — the state every crop session opens in. */
export const IDENTITY_CROP: CropTransform = { scale: 1, x: 0, y: 0 };

/** Avatars, server icons and group icons — square, 512px. */
export const AVATAR_OUTPUT = { width: 512, height: 512 } as const;

/** Profile and server banners — 2.5:1, matching the display surfaces. */
export const BANNER_OUTPUT = { width: 1500, height: 600 } as const;

/**
 * One JPEG quality for every cropped upload. Replaces the 0.8/0.85 split that
 * the four hand-rolled resize copies had drifted into for no stated reason.
 */
export const CROP_JPEG_QUALITY = 0.85;

/** Zoom ceiling. Past ~5x a 512px export is visibly mush, so the slider stops. */
export const MAX_ZOOM = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The scale at which the image exactly covers the frame. Guards against a zero
 * natural dimension (a decode that produced nothing) so callers never divide
 * by zero downstream.
 */
export function coverScale(
    naturalW: number, naturalH: number, frameW: number, frameH: number,
): number {
    if (!naturalW || !naturalH) return 1;
    return Math.max(frameW / naturalW, frameH / naturalH);
}

/**
 * Constrain a transform so the image still covers the frame: zoom into
 * [1, MAX_ZOOM], pan into the slack the zoom actually created. At scale 1 the
 * slack on the tight axis is 0, so the image pins to centre on that axis —
 * exactly the behaviour the old hard-coded centre-crops had, now as the
 * starting point rather than the only option.
 */
export function clampCrop(
    t: CropTransform,
    naturalW: number, naturalH: number,
    frameW: number, frameH: number,
): CropTransform {
    const scale = clamp(t.scale, 1, MAX_ZOOM);
    const s = coverScale(naturalW, naturalH, frameW, frameH) * scale;
    const maxX = Math.max(0, (naturalW * s - frameW) / 2);
    const maxY = Math.max(0, (naturalH * s - frameH) / 2);
    return {
        scale,
        x: clamp(t.x, -maxX, maxX),
        y: clamp(t.y, -maxY, maxY),
    };
}

/**
 * Zoom about a fixed point instead of the frame centre, so wheel and pinch
 * gestures keep the image detail under the cursor/fingers pinned in place.
 * `px`/`py` are relative to the frame centre, in frame pixels.
 */
export function zoomAbout(
    t: CropTransform, nextScale: number,
    px: number, py: number,
    naturalW: number, naturalH: number,
    frameW: number, frameH: number,
): CropTransform {
    const base = coverScale(naturalW, naturalH, frameW, frameH);
    const from = base * t.scale;
    const to = base * clamp(nextScale, 1, MAX_ZOOM);
    if (!from) return clampCrop({ ...t, scale: nextScale }, naturalW, naturalH, frameW, frameH);
    // The image-space point under (px,py) must land back under (px,py).
    const ratio = to / from;
    return clampCrop(
        { scale: nextScale, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio },
        naturalW, naturalH, frameW, frameH,
    );
}

/**
 * Decode a picked file (or an existing URL) into an <img>. Object URLs created
 * here are revoked once decoding settles — the decoded element keeps its own
 * copy of the bitmap, so the URL is dead weight after load.
 *
 * Note on EXIF: Chromium applies orientation metadata when decoding, and both
 * `naturalWidth/Height` and `drawImage` then see the upright image, so rotated
 * phone photos crop the way the user sees them with no extra handling.
 */
export function loadImageElement(src: File | Blob | string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const objectUrl = typeof src === 'string' ? null : URL.createObjectURL(src);
        const img = new Image();
        const done = (fn: () => void) => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            fn();
        };
        img.onload = () => {
            if (!img.naturalWidth || !img.naturalHeight) {
                done(() => reject(new Error('Image decoded with no dimensions')));
                return;
            }
            done(() => resolve(img));
        };
        img.onerror = () => done(() => reject(new Error('Failed to decode image')));
        img.src = objectUrl ?? (src as string);
    });
}

/**
 * Render the framed region to a JPEG blob at the output preset's exact pixel
 * size. The frame and the output share an aspect ratio by construction (the
 * cropper derives its frame from these dimensions), so this is a straight
 * source-rect blit with no letterboxing.
 *
 * GIFs flatten to their first frame here — the same thing the resize helpers
 * this replaces already did, since every avatar surface stores JPEG.
 */
export function renderCroppedBlob(
    img: HTMLImageElement,
    t: CropTransform,
    frameW: number, frameH: number,
    outW: number, outH: number,
    quality = CROP_JPEG_QUALITY,
): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const { naturalWidth: nw, naturalHeight: nh } = img;
        const safe = clampCrop(t, nw, nh, frameW, frameH);
        const s = coverScale(nw, nh, frameW, frameH) * safe.scale;
        if (!s) { reject(new Error('Image has no usable dimensions')); return; }

        // Frame rect expressed in the source image's own pixels.
        const sw = frameW / s;
        const sh = frameH / s;
        const sx = (nw - sw) / 2 - safe.x / s;
        const sy = (nh - sh) / 2 - safe.y / s;

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas unavailable')); return; }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Flatten onto white: JPEG has no alpha, and an unpainted canvas would
        // encode transparent PNG pixels as black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

        canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error('Failed to encode image')),
            'image/jpeg',
            quality,
        );
    });
}
