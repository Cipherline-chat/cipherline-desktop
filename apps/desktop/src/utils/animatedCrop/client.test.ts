import { describe, it, expect, vi } from 'vitest';
import { cropAnimatedImage, AnimatedCropFailure } from './client';
import type { AnimatedCropResponse } from './protocol';
import { IDENTITY_CROP } from '../imageCrop';

function fakeWorker() {
    const w = {
        onmessage: null as ((e: MessageEvent<AnimatedCropResponse>) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
        reply(m: AnimatedCropResponse) { w.onmessage?.({ data: m } as MessageEvent<AnimatedCropResponse>); },
    };
    return w;
}
const done = { type: 'done', bytes: new Uint8Array([1, 2]), mime: 'image/webp', frames: 9, width: 320, height: 320, durationMs: 900, trimmed: false } as const;
const args = (file: Blob, w: ReturnType<typeof fakeWorker>, on?: (f: number) => void) =>
    cropAnimatedImage(file, IDENTITY_CROP, 300, 300, 480, 270, 512, 512, on, () => w);

describe('cropAnimatedImage client', () => {
    it('sends the crop rectangle in source pixels and the capped output size', () => {
        const w = fakeWorker();
        const file = new Blob(['x']);
        args(file, w);
        const sent = w.postMessage.mock.calls[0][0];
        expect(sent).toMatchObject({ type: 'crop', file, naturalW: 480, naturalH: 270, outW: 320, outH: 320 });
        expect(sent.rect.sh).toBeCloseTo(270);
        expect(sent.rect.sw).toBeCloseTo(270);
    });

    it('relays progress, resolves with an animated WebP blob and ends the worker', async () => {
        const w = fakeWorker();
        const seen: number[] = [];
        const h = args(new Blob(['x']), w, f => seen.push(f));
        w.reply({ type: 'progress', fraction: 0.4 });
        w.reply(done);
        const r = await h.result;
        expect(r.blob.type).toBe('image/webp');
        expect(r.blob.size).toBe(2);
        expect(r).toMatchObject({ frames: 9, durationMs: 900, trimmed: false });
        expect(seen).toEqual([0.4]);
        expect(w.terminate).toHaveBeenCalledTimes(1);
    });

    it('surfaces a worker error code (and NOT_ANIMATED, which the cropper falls back on)', async () => {
        const w = fakeWorker();
        const h = args(new Blob(['x']), w);
        w.reply({ type: 'error', code: 'NOT_ANIMATED', message: 'still' });
        await expect(h.result).rejects.toMatchObject({ code: 'NOT_ANIMATED' });
        await expect(h.result).rejects.toBeInstanceOf(AnimatedCropFailure);
    });

    it('cancel terminates the worker and rejects CANCELLED, once', async () => {
        const w = fakeWorker();
        const h = args(new Blob(['x']), w);
        h.cancel(); h.cancel();
        await expect(h.result).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(w.terminate).toHaveBeenCalledTimes(1);
    });

    it('a crashing worker rejects FAILED; an unavailable one rejects UNSUPPORTED', async () => {
        const w = fakeWorker();
        const h = args(new Blob(['x']), w);
        w.onerror?.({} as ErrorEvent);
        await expect(h.result).rejects.toMatchObject({ code: 'FAILED' });
        const h2 = cropAnimatedImage(new Blob(['x']), IDENTITY_CROP, 300, 300, 480, 270, 512, 512, undefined, () => { throw new Error('no worker'); });
        await expect(h2.result).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });

    it('refuses an image with no usable size without starting a worker', async () => {
        const make = vi.fn();
        const h = cropAnimatedImage(new Blob(['x']), IDENTITY_CROP, 300, 300, 0, 0, 512, 512, undefined, make);
        await expect(h.result).rejects.toMatchObject({ code: 'NOT_AN_IMAGE' });
        expect(make).not.toHaveBeenCalled();
    });
});
