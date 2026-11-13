import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retuneScreenShareInPlace, applyScreenShareSenderParams, captureBoxFor } from './screenShare';
import { portalRetuneTouchesCapture } from './portalCapturePlan';
import { retuneTouchesCapture } from './sharePlatformSupport';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

/**
 * A live quality change on a share taken through the Wayland portal: Chromium's PipeWire capturer answers a changed
 * constraint with a new portal session (measured on Electron 43.8.1: 30 -> 60 -> 90 cost two extra ScreenCast.Start
 * calls; the capture really changes, up and down) and the capture stalls while it re-opens (portalCapturePlan.ts has the
 * numbers). So on EVERY desktop the capture is the source's size at the chosen rate and a change is the sender's alone
 * (maxFramerate, scaleResolutionDownBy from the user's box); only a HIGHER frame rate than the capture was opened at
 * re-opens it (the last two describes; an unknown `asked` never touches the capture). Off the portal nothing changed.
 */

function fakeSender(initial: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters) {
    let current = initial;
    const setParameters = vi.fn(async (p: RTCRtpSendParameters) => { current = p; });
    const sender = {
        getParameters: vi.fn(() => current), setParameters,
        // the sender's own track: what it is handed (the portal's capture, native size)
        track: { getSettings: () => ({ width: 3840, height: 2160, frameRate: 75 }) },
    } as unknown as RTCRtpSender;
    return { sender, setParameters, applied: () => current.encodings![0] as RTCRtpEncodingParameters };
}
function fakeTrack(size = { width: 3840, height: 2160 }) {
    const applyConstraints = vi.fn(async () => {});
    const mediaStreamTrack = {
        readyState: 'live', applyConstraints, getSettings: () => ({ ...size, frameRate: 75 }),
    } as unknown as MediaStreamTrack;
    return { mediaStreamTrack, applyConstraints };
}

describe('retuneScreenShareInPlace through the portal', () => {
    beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('never calls applyConstraints, for any frame rate or size (the capture is left exactly as it was started)', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack();
        const { sender } = fakeSender();
        const res: ScreenShareOptions['resolution'][] = ['source', '1440p', '1080p', '720p', '480p'];
        const fps: ScreenShareOptions['frameRate'][] = [15, 30, 60, 90];
        for (const r of res) for (const f of fps) {
            expect(await retuneScreenShareInPlace({ mediaStreamTrack, sender }, r, f, { viaPortal: true })).toBe(true);
        }
        expect(applyConstraints).not.toHaveBeenCalled();
    });

    it('the frame rate is the sender\'s maxFramerate: 30 -> 60 -> 90 -> 30 are four setParameters and no capture change', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack();
        const { sender, setParameters, applied } = fakeSender();
        const seen: Array<number | undefined> = [];
        for (const f of [30, 60, 90, 30] as const) {
            await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', f, { viaPortal: true });
            seen.push(applied().maxFramerate);
        }
        expect(seen).toEqual([30, 60, 90, 30]);
        expect(setParameters).toHaveBeenCalledTimes(4);
        expect(applyConstraints).not.toHaveBeenCalled();
    });

    it('the size is the sender\'s scaleResolutionDownBy, from the capture the share was started with (4K capture -> 1080p / 720p / 480p)', async () => {
        const { mediaStreamTrack } = fakeTrack();
        const { sender, applied } = fakeSender();
        const scales: Record<string, number | undefined> = {};
        for (const r of ['1440p', '1080p', '720p', '480p'] as const) {
            await retuneScreenShareInPlace({ mediaStreamTrack, sender }, r, 30, { viaPortal: true });
            scales[r] = applied().scaleResolutionDownBy;
        }
        expect(scales['1440p']).toBeCloseTo(3840 / 2560, 5);
        expect(scales['1080p']).toBeCloseTo(2, 5);
        expect(scales['720p']).toBeCloseTo(3, 5);
        expect(scales['480p']).toBeCloseTo(Math.max(3840 / 854, 2160 / 480), 5); // the height binds: 4.5
    });

    it('stepping back UP undoes the scale: the capture is still the full size, so nothing stays downscaled', async () => {
        const { mediaStreamTrack } = fakeTrack();
        const { sender, applied } = fakeSender();
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '720p', 30, { viaPortal: true });
        expect(applied().scaleResolutionDownBy).toBeCloseTo(3, 5);
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, 'source', 30, { viaPortal: true });
        expect(applied().scaleResolutionDownBy ?? 1).toBe(1);
    });

    it('a capture smaller than the chosen box is never upscaled', async () => {
        const { mediaStreamTrack } = fakeTrack({ width: 1280, height: 720 });
        const { sender, applied } = fakeSender();
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: 1280, height: 720 }) };
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60, { viaPortal: true });
        expect(applied().scaleResolutionDownBy ?? 1).toBe(1);
    });

    it('keeps the codec clamp: an 8K capture on the "source" setting is still held to 4K UHD', async () => {
        const { mediaStreamTrack } = fakeTrack({ width: 7680, height: 4320 });
        const { sender, applied } = fakeSender();
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: 7680, height: 4320 }) };
        await retuneScreenShareInPlace({ mediaStreamTrack, sender, codec: 'h264' }, 'source', 60, { viaPortal: true });
        expect(applied().scaleResolutionDownBy).toBeCloseTo(2, 5);
    });

    it('still reports false (so the caller republishes) when there is no live track or sender', async () => {
        expect(await retuneScreenShareInPlace(undefined, '1080p', 30, { viaPortal: true })).toBe(false);
        const { mediaStreamTrack } = fakeTrack();
        expect(await retuneScreenShareInPlace({ mediaStreamTrack }, '1080p', 30, { viaPortal: true })).toBe(false);
    });
});

describe('off the portal the retune is exactly what it was', () => {
    beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('the routing decision: only the portal leaves the capture alone', () => {
        expect(retuneTouchesCapture(false)).toBe(true);
        expect(retuneTouchesCapture(true)).toBe(false);
    });

    it('applyConstraints with the box and the paced rate, then the sender - with no box on the sender (the capture is already fitted)', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: 1920, height: 1080 });
        const { sender, applied } = fakeSender();
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: 1920, height: 1080 }) };
        expect(await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60)).toBe(true);
        expect(applyConstraints).toHaveBeenCalledWith({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 75 } });
        expect(applied().maxFramerate).toBe(60);
        expect(applied().scaleResolutionDownBy ?? 1).toBe(1);
        // an explicit viaPortal:false is the same thing as leaving it out
        applyConstraints.mockClear();
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60, { viaPortal: false });
        expect(applyConstraints).toHaveBeenCalledTimes(1);
    });
});

describe('applyScreenShareSenderParams with the user\'s box (the portal\'s sender scale)', () => {
    it('is a no-op for a capture that already fits the box, and scales one that does not', async () => {
        const fit = fakeSender();
        await applyScreenShareSenderParams(fit.sender, 60, 6_000_000, { codec: 'vp8', box: { width: 3840, height: 2160 } });
        expect(fit.applied().scaleResolutionDownBy ?? 1).toBe(1);
        const big = fakeSender();
        await applyScreenShareSenderParams(big.sender, 60, 6_000_000, { codec: 'vp8', box: { width: 1280, height: 720 } });
        expect(big.applied().scaleResolutionDownBy).toBeCloseTo(3, 5);
    });
});

describe('through the portal the policy is the same on every desktop, a silently restoring one (GNOME, KDE) included', () => {
    beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    const NATIVE = captureBoxFor('source', 'vp8');
    const opts = (asked: { fps: number; width: number; height: number } | null, onAsked = vi.fn(), onReopen = vi.fn()) =>
        ({ viaPortal: true, restoreListed: true, asked, ceiling: 60, onAsked, onReopen });
    const openedAt75 = { fps: 75, width: NATIVE.width, height: NATIVE.height };

    it('a LOWER resolution and a LOWER frame rate re-open nothing: the sender scales and caps (a re-open stalls the capture ~1 s idle, 10-20 s loaded)', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: NATIVE.width, height: NATIVE.height });
        const { sender, applied } = fakeSender();
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: NATIVE.width, height: NATIVE.height }) };
        const onAsked = vi.fn(); const onReopen = vi.fn();
        expect(await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 30, opts(openedAt75, onAsked, onReopen))).toBe(true);
        expect(applyConstraints).not.toHaveBeenCalled();
        expect(onAsked).not.toHaveBeenCalled();
        expect(onReopen).not.toHaveBeenCalled();
        expect(applied().maxFramerate).toBe(30);
        expect(applied().scaleResolutionDownBy).toBeCloseTo(NATIVE.width / 1920, 5);
    });

    it('a different RESOLUTION at the same rate - up or down - never re-opens it either', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack();
        const { sender } = fakeSender();
        for (const r of ['720p', '1440p', 'source', '480p', '1080p'] as const) {
            await retuneScreenShareInPlace({ mediaStreamTrack, sender }, r, 60, opts(openedAt75));
        }
        expect(applyConstraints).not.toHaveBeenCalled();
    });

    it('negative control (the old listed-mode behaviour): a lower choice DID re-open the capture, smaller', () => {
        // old rule: restoreListed -> any difference between what was asked and what is wanted re-opens it
        const oldRule = (asked: { fps: number; width: number; height: number }, want: { fps: number; width: number; height: number }) =>
            asked.fps !== want.fps || asked.width !== want.width || asked.height !== want.height;
        expect(oldRule(openedAt75, { fps: 30, width: 1920, height: 1080 })).toBe(true);
        expect(portalRetuneTouchesCapture({ restoreListed: true, asked: openedAt75, want: { fps: 30, width: 1920, height: 1080 } })).toBe(false);
    });

    it('a HIGHER frame rate than the capture was opened at re-opens it, at the SOURCE size, and says so first', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: 1920, height: 1080 });
        const { sender } = fakeSender();
        const order: string[] = [];
        applyConstraints.mockImplementation(async () => { order.push('applyConstraints'); });
        const onAsked = vi.fn(); const onReopen = vi.fn(() => { order.push('onReopen'); });
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60, opts({ fps: 30, width: NATIVE.width, height: NATIVE.height }, onAsked, onReopen));
        expect(order).toEqual(['onReopen', 'applyConstraints']);
        expect(applyConstraints).toHaveBeenCalledWith({ width: { max: NATIVE.width }, height: { max: NATIVE.height }, frameRate: { max: 75 } });
        expect(onAsked).toHaveBeenCalledWith({ fps: 75, width: NATIVE.width, height: NATIVE.height });
    });

    it('after that re-open the sender still carries the user\'s box (the capture is the source\'s size, not the pick)', async () => {
        const { mediaStreamTrack } = fakeTrack();
        const { sender, applied } = fakeSender();
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60, opts({ fps: 30, width: NATIVE.width, height: NATIVE.height }));
        expect(applied().scaleResolutionDownBy).toBeCloseTo(2, 5);
        expect(applied().maxFramerate).toBe(60);
    });

    it('what the capture was asked for being unknown is never a re-open', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: 1920, height: 1080 });
        const { sender } = fakeSender();
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 90, opts(null));
        expect(applyConstraints).not.toHaveBeenCalled();
    });

    it('a re-open the portal refuses reports false, so the caller republishes (the old behaviour) instead of leaving a dead share', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack();
        applyConstraints.mockRejectedValueOnce(new Error('Source failed to restart'));
        const { sender } = fakeSender();
        expect(await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 90, opts({ fps: 30, width: NATIVE.width, height: NATIVE.height }))).toBe(false);
    });
});

describe('through the portal where a re-open may be a dialog: only a raise past what the capture was asked for re-opens it', () => {
    beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    const NATIVE = captureBoxFor('source', 'vp8');
    const asked1080p30 = { fps: 30, width: NATIVE.width, height: NATIVE.height };

    it('a lower choice, and a raise of the size, are the sender\'s alone: no portal session, no getDisplayMedia', async () => {
        const getDisplayMedia = vi.fn();
        vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: 1920, height: 1080 });
        const { sender, applied } = fakeSender();
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: 1920, height: 1080 }) };
        const onAsked = vi.fn();
        for (const [res, fps] of [['720p', 30], ['480p', 15], ['1080p', 30], ['720p', 15]] as const) {
            expect(await retuneScreenShareInPlace({ mediaStreamTrack, sender }, res, fps, { viaPortal: true, restoreListed: false, asked: asked1080p30, ceiling: 60, onAsked })).toBe(true);
        }
        expect(applyConstraints).not.toHaveBeenCalled();
        expect(getDisplayMedia).not.toHaveBeenCalled();
        expect(onAsked).not.toHaveBeenCalled();
        expect(applied().maxFramerate).toBe(15);
    });

    it('a lower size is the sender\'s scale from the (unchanged) capture', async () => {
        const { mediaStreamTrack } = fakeTrack({ width: 1920, height: 1080 });
        const { sender, applied } = fakeSender();
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: 1920, height: 1080 }) };
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '720p', 30, { viaPortal: true, restoreListed: false, asked: asked1080p30, ceiling: 60 });
        expect(applied().scaleResolutionDownBy).toBeCloseTo(1.5, 5);
    });

    it('a raise past what the capture was asked for re-opens it (and says what it asked for): the only way to those frames', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: 1920, height: 1080 });
        const { sender } = fakeSender();
        const onAsked = vi.fn();
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60, { viaPortal: true, restoreListed: false, asked: asked1080p30, ceiling: 60, onAsked });
        expect(applyConstraints).toHaveBeenCalledWith({ width: { max: NATIVE.width }, height: { max: NATIVE.height }, frameRate: { max: 75 } });
        expect(onAsked).toHaveBeenCalledWith({ fps: 75, width: NATIVE.width, height: NATIVE.height });
    });

    it('control: the same raise on a share that does not know what its capture was asked for never re-opens it', async () => {
        const { mediaStreamTrack, applyConstraints } = fakeTrack({ width: 1920, height: 1080 });
        const { sender } = fakeSender();
        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60, { viaPortal: true, restoreListed: false, asked: null, ceiling: 60 });
        expect(applyConstraints).not.toHaveBeenCalled();
    });
});
