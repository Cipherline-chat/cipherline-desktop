// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { captureHeldFrame, heldFrameSize, releaseHeldFrame } from './shareHoldFrame';

function video(over: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
    return { readyState: 4, videoWidth: 1920, videoHeight: 1080, ...over } as HTMLVideoElement;
}

function withCanvas(draw: (...args: unknown[]) => void = () => {}) {
    const ctx = { drawImage: vi.fn(draw) };
    return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never) && ctx;
}

describe('heldFrameSize', () => {
    it('never upscales past the source', () => {
        expect(heldFrameSize(1280, 720, 3000, 2000, 2)).toEqual({ width: 1280, height: 720 });
    });
    it('draws at the tile size on screen, keeping the shape', () => {
        expect(heldFrameSize(3840, 2160, 960, 540, 1)).toEqual({ width: 960, height: 540 });
        expect(heldFrameSize(3840, 2160, 960, 540, 2)).toEqual({ width: 1920, height: 1080 });
    });
    it('keeps the shape when the tile is a different shape from the picture', () => {
        expect(heldFrameSize(3840, 1080, 800, 800, 1)).toEqual({ width: 800, height: 225 });
    });
    it('has a ceiling whatever the tile claims, and survives an unmeasured tile', () => {
        expect(heldFrameSize(7680, 2160, 4000, 4000, 2)).toEqual({ width: 2560, height: 720 });
        expect(heldFrameSize(3840, 2160, 0, 0, 1)).toEqual({ width: 2560, height: 1440 });
    });
    it('never returns an empty canvas size', () => {
        expect(heldFrameSize(4000, 2, 100, 100, 1).height).toBeGreaterThanOrEqual(1);
    });
});

describe('captureHeldFrame', () => {
    it('takes one frame and reports the picture\'s real size', () => {
        const ctx = withCanvas();
        const v = video();
        const frame = captureHeldFrame(v, { width: 960, height: 540 }, 1)!;
        expect(ctx.drawImage).toHaveBeenCalledTimes(1);
        expect(ctx.drawImage).toHaveBeenCalledWith(v, 0, 0, 960, 540);
        expect(frame).toMatchObject({ width: 1920, height: 1080 });
        expect(frame.canvas.width).toBe(960);
        vi.restoreAllMocks();
    });

    it('does not hold the blank frames the SFU closes a track with', () => {
        const ctx = withCanvas();
        expect(captureHeldFrame(video({ videoWidth: 8, videoHeight: 8 } as Partial<HTMLVideoElement>), null, 1)).toBeNull();
        expect(captureHeldFrame(video({ videoWidth: 2, videoHeight: 2 } as Partial<HTMLVideoElement>), null, 1)).toBeNull();
        expect(ctx.drawImage).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('returns null, drawing nothing, when there is no decoded frame', () => {
        const ctx = withCanvas();
        expect(captureHeldFrame(null, null, 1)).toBeNull();
        expect(captureHeldFrame(video({ readyState: 1 } as Partial<HTMLVideoElement>), null, 1)).toBeNull();
        expect(captureHeldFrame(video({ videoWidth: 0 } as Partial<HTMLVideoElement>), null, 1)).toBeNull();
        expect(ctx.drawImage).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('a draw that throws is the fallback, not an error', () => {
        withCanvas(() => { throw new Error('tainted'); });
        expect(captureHeldFrame(video(), null, 1)).toBeNull();
        vi.restoreAllMocks();
    });

    it('release lets go of the pixels and is safe on nothing', () => {
        withCanvas();
        const frame = captureHeldFrame(video(), { width: 100, height: 100 }, 1)!;
        releaseHeldFrame(frame);
        expect(frame.canvas.width).toBe(0);
        expect(frame.canvas.height).toBe(0);
        releaseHeldFrame(null);
        vi.restoreAllMocks();
    });
});
