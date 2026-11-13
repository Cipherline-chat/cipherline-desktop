/**
 * Animated-image crop worker: the cropper's "Apply" for a GIF / animated WebP
 * avatar, profile banner, server icon or server banner. Runs off the UI
 * thread - decoding a long GIF and encoding up to 100 WebP frames is real work.
 *
 *   animated GIF / WebP + the cropper's frame rectangle
 *     -> every frame cropped to that rectangle (ImageDecoder + OffscreenCanvas)
 *     -> animated WebP, <= 4 MiB, <= 15 s, <= 100 frames (utils/animatedCrop/pipeline)
 *
 * Re-encoding through a canvas also strips metadata (EXIF, XMP, comments, ICC):
 * only pixels survive the draw.
 *
 * Decoding is `ImageDecoder` (WebCodecs); encoding is
 * `OffscreenCanvas.convertToBlob` per frame, assembled by the pure muxer in
 * utils/personalEmoji/process/webpMux.ts. No new dependency. A single-frame
 * file answers NOT_ANIMATED and the page crops it as a plain still instead.
 *
 * Protocol: utils/animatedCrop/protocol.ts. No dynamic imports (they break the
 * worker build); everything here is static.
 */
import { AnimatedCropError, runAnimatedCrop, type PipelineDeps } from '../utils/animatedCrop/pipeline';
import {
    ANIM_CROP_INPUT_MAX_BYTES, type AnimatedCropRequest, type AnimatedCropResponse,
} from '../utils/animatedCrop/protocol';

interface WorkerScope {
    onmessage: ((e: MessageEvent<AnimatedCropRequest>) => void) | null;
    postMessage(message: AnimatedCropResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** GIF or WebP, from the magic bytes (the declared type is only ever a claim). */
function sniff(b: Uint8Array): 'image/gif' | 'image/webp' | null {
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
}

function canvas2d(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
    const canvas = new OffscreenCanvas(w, h);
    // willReadFrequently: false is the default; we only draw and encode.
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new AnimatedCropError('UNSUPPORTED', 'Canvas is not available.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx };
}

async function run(req: AnimatedCropRequest): Promise<AnimatedCropResponse> {
    const progress = (fraction: number) => scope.postMessage({ type: 'progress', fraction });
    if (req.file.size > ANIM_CROP_INPUT_MAX_BYTES) {
        throw new AnimatedCropError('INPUT_TOO_LARGE', `That file is bigger than ${ANIM_CROP_INPUT_MAX_BYTES / 1024 / 1024} MB.`);
    }
    if (typeof ImageDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') {
        throw new AnimatedCropError('UNSUPPORTED', 'Cropping an animation is not available here.');
    }
    const bytes = new Uint8Array(await req.file.arrayBuffer());
    const type = sniff(bytes);
    if (!type) throw new AnimatedCropError('NOT_AN_IMAGE', 'That file is not an animated GIF or WebP.');
    if (!(await ImageDecoder.isTypeSupported(type))) throw new AnimatedCropError('UNSUPPORTED', 'This system cannot read that animation.');

    const decoder = new ImageDecoder({ data: bytes, type });
    try {
        try {
            await decoder.completed;
            await decoder.tracks.ready;
        } catch {
            throw new AnimatedCropError('NOT_AN_IMAGE', 'That animation could not be read.');
        }
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 2) throw new AnimatedCropError('NOT_ANIMATED', 'That picture is not animated.');

        // One reusable surface for cropping (the bitmap copy detaches each frame from it).
        const crop = canvas2d(req.outW, req.outH);
        const scratch = { w: 0, h: 0, c: null as ReturnType<typeof canvas2d> | null };

        const deps: PipelineDeps<ImageBitmap> = {
            frameCount: track.frameCount,
            progress,
            async readFrame(i, keep) {
                let image: VideoFrame;
                try {
                    ({ image } = await decoder.decode({ frameIndex: i }));
                } catch {
                    throw new AnimatedCropError('NOT_AN_IMAGE', 'That animation could not be read.');
                }
                try {
                    const frame = { width: image.displayWidth, height: image.displayHeight, durationUs: image.duration ?? null };
                    if (!keep) return { frame, bitmap: null };
                    // The rectangle was computed against the <img>'s natural size; a decoder that
                    // reports a different canvas size gets it scaled, never silently misframed.
                    const kx = req.naturalW > 0 ? image.displayWidth / req.naturalW : 1;
                    const ky = req.naturalH > 0 ? image.displayHeight / req.naturalH : 1;
                    const { sx, sy, sw, sh } = req.rect;
                    crop.ctx.clearRect(0, 0, req.outW, req.outH);
                    crop.ctx.drawImage(image, sx * kx, sy * ky, sw * kx, sh * ky, 0, 0, req.outW, req.outH);
                    return { frame, bitmap: await createImageBitmap(crop.canvas) };
                } finally {
                    image.close();
                }
            },
            async encodeFrame(bitmap, quality, width, height) {
                if (!scratch.c || scratch.w !== width || scratch.h !== height) {
                    scratch.c = canvas2d(width, height); scratch.w = width; scratch.h = height;
                }
                const { canvas, ctx } = scratch.c;
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, width, height);
                const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
                if (blob.type !== 'image/webp') throw new AnimatedCropError('UNSUPPORTED', 'This system cannot encode WebP.');
                return new Uint8Array(await blob.arrayBuffer());
            },
            release(bitmap) { bitmap.close(); },
        };

        const r = await runAnimatedCrop(deps, req.outW, req.outH);
        return { type: 'done', mime: 'image/webp', ...r };
    } finally {
        decoder.close();
    }
}

scope.onmessage = (e) => {
    if (e.data?.type !== 'crop') return;
    run(e.data).then(
        (res) => scope.postMessage(res, res.type === 'done' ? [res.bytes.buffer] : []),
        (err) => {
            const known = err instanceof AnimatedCropError;
            scope.postMessage({
                type: 'error',
                code: known ? err.code : 'FAILED',
                message: known ? err.message : 'Something went wrong cropping that animation.',
            });
        },
    );
};
