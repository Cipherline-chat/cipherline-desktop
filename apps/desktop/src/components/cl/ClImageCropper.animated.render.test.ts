// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * ClImageCropper with an animated pick, rendered for real. The crop MATHS and
 * the worker are covered elsewhere (imageCrop.test, animatedCrop/*); this pins
 * the wiring: which export path runs, what is handed back, and the failures.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:preview';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});

const h = vi.hoisted(() => ({
    animatedAnswer: true,
    cropAnimatedImage: vi.fn(),
    renderCroppedBlob: vi.fn(),
}));

vi.mock('../../utils/animatedImage', async () => {
    const real = await vi.importActual<typeof import('../../utils/animatedImage')>('../../utils/animatedImage');
    return { ...real, isAnimatedFile: async () => h.animatedAnswer };
});
vi.mock('../../utils/imageCrop', async () => {
    const real = await vi.importActual<typeof import('../../utils/imageCrop')>('../../utils/imageCrop');
    return {
        ...real,
        loadImageElement: async () => ({ naturalWidth: 480, naturalHeight: 270 }) as HTMLImageElement,
        renderCroppedBlob: h.renderCroppedBlob,
    };
});
vi.mock('../../utils/animatedCrop/client', async () => {
    const real = await vi.importActual<typeof import('../../utils/animatedCrop/client')>('../../utils/animatedCrop/client');
    return { ...real, supportsAnimatedCrop: () => true, cropAnimatedImage: h.cropAnimatedImage };
});

import { ClImageCropper } from './ClImageCropper';
import { AnimatedCropFailure } from '../../utils/animatedCrop/client';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    h.animatedAnswer = true;
    h.cropAnimatedImage.mockReset();
    h.renderCroppedBlob.mockReset();
    h.renderCroppedBlob.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

/** A job whose result rejects - built lazily so the rejection is born when the cropper awaits it. */
const failing = (err: Error) => ({ get result() { return Promise.reject(err); }, cancel() {} });
const GIF = new File([new Uint8Array([71, 73, 70, 56, 57, 97])], 'a.gif', { type: 'image/gif' });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function open(opts: { allowAnimated?: boolean } = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
        root.render(React.createElement(ClImageCropper, {
            open: true, file: GIF, outputWidth: 512, outputHeight: 512, onConfirm, onCancel, ...opts,
        }));
    });
    await flush();
    return { onConfirm, onCancel };
}
const apply = async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => /Apply|Cropping/.test(b.textContent ?? ''))!;
    await act(async () => { btn.click(); });
    await flush();
};
const text = () => document.body.textContent ?? '';

describe('ClImageCropper with an animated pick', () => {
    it('crops every frame (not the still export) and hands back the animated WebP', async () => {
        const out = new Blob(['webp'], { type: 'image/webp' });
        h.cropAnimatedImage.mockReturnValue({ result: Promise.resolve({ blob: out, frames: 9, width: 320, height: 320, durationMs: 900, trimmed: false }), cancel() {} });
        const { onConfirm } = await open({ allowAnimated: true });
        expect(text()).toContain('every frame is cropped');
        await apply();
        expect(h.cropAnimatedImage).toHaveBeenCalledTimes(1);
        // the same transform / frame / natural size / preset the preview is drawn from
        const a = h.cropAnimatedImage.mock.calls[0];
        expect(a[0]).toBe(GIF);
        expect(a.slice(1, 8)).toEqual([{ scale: 1, x: 0, y: 0 }, 300, 300, 480, 270, 512, 512]);
        expect(h.renderCroppedBlob).not.toHaveBeenCalled();
        expect(onConfirm).toHaveBeenCalledWith(out);
        expect(onConfirm.mock.calls[0][0].type).toBe('image/webp');
    });

    it('without `allowAnimated` an animated pick still flattens to the JPEG, as before', async () => {
        const { onConfirm } = await open();
        expect(text()).not.toContain('every frame is cropped');
        await apply();
        expect(h.cropAnimatedImage).not.toHaveBeenCalled();
        expect(onConfirm.mock.calls[0][0].type).toBe('image/jpeg');
    });

    it('a static pick with `allowAnimated` takes the ordinary still path', async () => {
        h.animatedAnswer = false;
        const { onConfirm } = await open({ allowAnimated: true });
        await apply();
        expect(h.cropAnimatedImage).not.toHaveBeenCalled();
        expect(onConfirm.mock.calls[0][0].type).toBe('image/jpeg');
    });

    it('a one-frame GIF (worker says NOT_ANIMATED) falls back to the still crop', async () => {
        h.cropAnimatedImage.mockReturnValue(failing(new AnimatedCropFailure('NOT_ANIMATED', 'still')));
        const { onConfirm } = await open({ allowAnimated: true });
        await apply();
        expect(h.renderCroppedBlob).toHaveBeenCalledTimes(1);
        expect(onConfirm.mock.calls[0][0].type).toBe('image/jpeg');
    });

    it('a real failure is shown in the dialog and nothing is confirmed', async () => {
        h.cropAnimatedImage.mockReturnValue(failing(new AnimatedCropFailure('TOO_COMPLEX', 'That animation is too detailed to fit.')));
        const { onConfirm } = await open({ allowAnimated: true });
        await apply();
        expect(text()).toContain('too detailed to fit');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(h.renderCroppedBlob).not.toHaveBeenCalled();
    });

    it('Cancel while cropping stops the job and keeps the dialog open', async () => {
        const cancel = vi.fn();
        let rejectJob: (e: Error) => void = () => {};
        const result = new Promise((_, rej) => { rejectJob = rej; });
        cancel.mockImplementation(() => rejectJob(new AnimatedCropFailure('CANCELLED', 'Cancelled')));
        h.cropAnimatedImage.mockReturnValue({ result, cancel });
        const { onConfirm, onCancel } = await open({ allowAnimated: true });
        await apply(); // still "busy": the job has not settled
        const cancelBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!;
        expect((cancelBtn as HTMLButtonElement).disabled).toBe(false);
        await act(async () => { cancelBtn.click(); });
        await flush();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();
    });
});
