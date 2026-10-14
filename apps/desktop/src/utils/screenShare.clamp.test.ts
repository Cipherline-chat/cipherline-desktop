import { describe, it, expect, vi } from 'vitest';
import {
    applyScreenShareSenderParams, retuneScreenShareInPlace, captureBoxFor, buildScreenSharePublishOptions,
    computeSSBitrate, captureFrameRateFor,
} from './screenShare';

/** A sender whose track reports `settings`, with `encodings` as LiveKit left them. */
function sender(encodings: RTCRtpEncodingParameters[], settings?: { width?: number; height?: number }) {
    let params = { encodings } as RTCRtpSendParameters;
    const setParameters = vi.fn(async (p: RTCRtpSendParameters) => { params = p; });
    const s = {
        getParameters: () => params, setParameters,
        track: settings ? { getSettings: () => settings } : undefined,
    } as unknown as RTCRtpSender;
    return { s, setParameters, applied: () => setParameters.mock.calls.at(-1)![0] as RTCRtpSendParameters };
}

describe('applyScreenShareSenderParams - holds the encode to the codec\'s limits (scaleResolutionDownBy)', () => {
    it('a 7680x1440 track on H.264 is scaled by 2 (-> 3840x720); frame rate / bitrate untouched', async () => {
        const { s, applied } = sender([{}], { width: 7680, height: 1440 });
        await applyScreenShareSenderParams(s, 90, 40_000_000, { codec: 'h264' });
        const enc = applied().encodings![0];
        expect(enc.scaleResolutionDownBy).toBe(2);
        expect(enc.maxFramerate).toBe(90);
        expect(enc.maxBitrate).toBe(40_000_000);
        expect(applied().degradationPreference).toBe('maintain-framerate');
    });

    it('a capture already inside the limits gets no scale at all (1440p90 is left exactly as it was)', async () => {
        const { s, applied } = sender([{}], { width: 2560, height: 1440 });
        await applyScreenShareSenderParams(s, 90, 40_000_000, { codec: 'h264' });
        expect(applied().encodings![0].scaleResolutionDownBy).toBeUndefined();
    });

    it('works for every codec and for a track that reports nothing (no scale, no throw)', async () => {
        for (const codec of ['h264', 'h265', 'vp8', 'vp9'] as const) {
            const big = sender([{}], { width: 7680, height: 2160 });
            await applyScreenShareSenderParams(big.s, 60, 1, { codec });
            expect(big.applied().encodings![0].scaleResolutionDownBy).toBe(2);
        }
        const none = sender([{}]);
        await expect(applyScreenShareSenderParams(none.s, 60, 1)).resolves.toBeUndefined();
        expect(none.applied().encodings![0].scaleResolutionDownBy).toBeUndefined();
    });

    it('undoes OUR earlier downscale once the capture no longer needs it (display mode changed)', async () => {
        const { s, applied } = sender([{ scaleResolutionDownBy: 2 }], { width: 1920, height: 1080 });
        await applyScreenShareSenderParams(s, 60, 1, { codec: 'h264' });
        expect(applied().encodings![0].scaleResolutionDownBy).toBe(1);
    });

    it('a cropped (generated) track reports no size: sourceSize + box stand in', async () => {
        const { s, applied } = sender([{}]);
        // one 2560x1440 screen of a Surround display, picker box 1080p -> scaled to fit it
        await applyScreenShareSenderParams(s, 90, 1, { codec: 'h264', sourceSize: { width: 2560, height: 1440 }, box: { width: 1920, height: 1080 } });
        expect(applied().encodings![0].scaleResolutionDownBy).toBeCloseTo(2560 / 1920, 5);
        // native: no scale
        const native = sender([{}]);
        await applyScreenShareSenderParams(native.s, 90, 1, { codec: 'h264', sourceSize: { width: 2560, height: 1440 }, box: { width: 3840, height: 2160 } });
        expect(native.applied().encodings![0].scaleResolutionDownBy).toBeUndefined();
    });

    it('switching a cropped share to the WHOLE display scales the uncropped 7680-wide frames before the encoder sees them', async () => {
        const { s, applied } = sender([{}]);
        await applyScreenShareSenderParams(s, 90, 1, { codec: 'h264', sourceSize: { width: 7680, height: 1440 }, box: captureBoxFor('source', 'h264') });
        expect(applied().encodings![0].scaleResolutionDownBy).toBe(2);
    });

    it('fallback step cuts the pixel budget on top of the clamp', async () => {
        const { s, applied } = sender([{}], { width: 2560, height: 1440 });
        await applyScreenShareSenderParams(s, 60, 1, { codec: 'h264', step: 1 });
        expect(applied().encodings![0].scaleResolutionDownBy).toBeCloseTo(2560 / 1920, 3);
        const s2 = sender([{}], { width: 2560, height: 1440 });
        await applyScreenShareSenderParams(s2.s, 60, 1, { codec: 'h264', step: 2 });
        expect(s2.applied().encodings![0].scaleResolutionDownBy).toBeCloseTo(2560 / 1280, 3);
    });

    it('with a lighter copy, a clamped full layer keeps the lighter copy lighter', async () => {
        const { s, applied } = sender([{ rid: 'q', active: false }, { rid: 'h' }], { width: 7680, height: 1440 });
        await applyScreenShareSenderParams(s, 90, 1, { codec: 'h264' });
        const [low, top] = applied().encodings!;
        expect(top.scaleResolutionDownBy).toBe(2);
        expect(low.scaleResolutionDownBy).toBeGreaterThan(top.scaleResolutionDownBy!);
        expect(low.maxFramerate).toBe(30);
    });
});

describe('the 90 fps request reaches the capturer and the encoder', () => {
    it('the capture frame rate asked of Chromium is 25% above the target (113 for 90), so timer lateness cannot cost frames', () => {
        expect(captureFrameRateFor(90)).toBe(113);
        expect(captureFrameRateFor(60)).toBe(75);
        expect(captureFrameRateFor(240)).toBe(240); // capped
    });

    it('a capturer with a fixed ceiling (Wayland/PipeWire 60) is asked for headroom over the CEILING, not over a target it cannot meet', () => {
        expect(captureFrameRateFor(90, 60)).toBe(75);   // not 113
        expect(captureFrameRateFor(144, 60)).toBe(75);
        expect(captureFrameRateFor(30, 60)).toBe(38);   // below the ceiling: unchanged behaviour
        expect(captureFrameRateFor(60, 60)).toBe(75);
    });

    it.each([null, undefined, 0, -1])('no usable ceiling (%j) is exactly the old behaviour', (c) => {
        expect(captureFrameRateFor(90, c)).toBe(113);
        expect(captureFrameRateFor(60, c)).toBe(75);
    });

    it('publish options: maxFramerate = the request, maintain-framerate, a ceiling that scales with fps', () => {
        for (const codec of ['h264', 'vp8', 'vp9', 'h265'] as const) {
            const o = buildScreenSharePublishOptions('source', 90, codec);
            expect(o.screenShareEncoding.maxFramerate).toBe(90);
            expect(o.degradationPreference).toBe('maintain-framerate');
            expect(o.screenShareEncoding.maxBitrate).toBe(computeSSBitrate('source', 90, codec));
            expect(o.screenShareEncoding.maxBitrate).toBeGreaterThan(computeSSBitrate('source', 60, codec));
        }
    });
});

describe('retuneScreenShareInPlace - the live capture box is clamped too', () => {
    it('applyConstraints never asks the capturer for more than 4K, even for "source"', async () => {
        const applyConstraints = vi.fn(async () => {});
        const track = {
            mediaStreamTrack: { readyState: 'live', applyConstraints, getSettings: () => ({ width: 3840, height: 720, frameRate: 90 }) } as unknown as MediaStreamTrack,
            sender: sender([{}], { width: 3840, height: 720 }).s,
            codec: 'h264',
        };
        vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await retuneScreenShareInPlace(track, 'source', 90)).toBe(true);
        expect(applyConstraints).toHaveBeenCalledWith({ width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: 113 } });
    });
});
