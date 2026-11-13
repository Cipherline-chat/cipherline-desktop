import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    resolveSSResolution,
    computeSSBitrate, ssFpsFactor, SS_MAX_BITRATE_VP9_EQUIV, ssTierForPixels, senderCaptureSize,
    applyScreenShareSenderParams,
    retuneScreenShareInPlace,
    chooseScreenShareCodec,
    decideScreenShareCodec,
    isNvidiaOnly,
    nvidiaIsPrimary,
    buildScreenSharePublishOptions,
    shareHasLowerLayer,
    shareLowEncoding,
    probeHardwareEncoders,
    asScreenShareCodec,
    LIVEKIT_H264_CONTENT_TYPE,
    isLiveKitH264High,
    orderCodecsForH264High,
    preferH264HighOnSender,
    installH264HighPreference,
    watchH264HighStart,
    captureFrameRateFor,
    type HardwareEncoderSupport,
    type ScreenShareCodecPref,
    type RtpCodecLike,
} from './screenShare';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

// The full reachable option set for the Adjust Quality control
// (apps/desktop/src/components/ScreenSharePickerModal.tsx's QualityControls
// component, ~lines 320-355): the Resolution dropdown offers
// source/1440p/1080p/720p/480p (1440p is conditional on `has1440p`, but the
// value itself is still a producible ScreenShareOptions['resolution'], not a
// hypothetical one) and the Frame Rate dropdown independently offers
// 90/60/30/15 fps. The two dropdowns are independent selects with no
// cross-linking, so all 5×4 = 20 pairs below are genuinely reachable through
// the UI, not an invented boundary set.
const RESOLUTIONS: ScreenShareOptions['resolution'][] = ['source', '1440p', '1080p', '720p', '480p'];
const FRAME_RATES: ScreenShareOptions['frameRate'][] = [90, 60, 30, 15];

describe('resolveSSResolution', () => {
    it.each([
        // An 8K BOX, not a 4K one: capture never upscales, so this delivers the
        // display's native size — measured in Electron 43, a 3840×2160 box
        // squeezed a 5120×1440 display to 3840×1080.
        ['source', { width: 7680, height: 4320 }],
        ['1440p',  { width: 2560, height: 1440 }],
        ['1080p',  { width: 1920, height: 1080 }],
        ['720p',   { width: 1280, height:  720 }],
        ['480p',   { width:  854, height:  480 }],
    ] as const)('resolves %s to its pixel dimensions', (res, expected) => {
        expect(resolveSSResolution(res)).toEqual(expected);
    });

    it('covers every resolution the Adjust Quality control can produce', () => {
        for (const res of RESOLUTIONS) {
            expect(resolveSSResolution(res)).toBeDefined();
        }
    });
});

describe('computeSSBitrate', () => {
    // Base values (tuned at 30fps) × ssFpsFactor (linear to 30, (fps/30)^0.6
    // above), held under SS_MAX_BITRATE_VP9_EQUIV × the codec factor, in 10 kbps
    // steps. ≤ 30 fps is unchanged from the old linear table; above 30 every
    // number dropped (old: 60 fps = 2x base, 90 fps = 3x base) — see the
    // 2026-10-23 freeze reports in screenShare.ts.
    const EXPECTED: Record<ScreenShareOptions['resolution'], Record<number, number>> = {
        // 2026-11-02: 1080p and up x0.82 (cap 16.4 Mbps VP9-equivalent) so 1440p90 H.265 is ~18 Mbps (22 until 2026-10-31, then 14).
        source:  { 90: 16_400_000, 60: 16_400_000, 30: 14_760_000, 15: 7_380_000 },
        '1440p': { 90: 16_400_000, 60: 14_910_000, 30:  9_840_000, 15: 4_920_000 },
        '1080p': { 90:  9_510_000, 60:  7_460_000, 30:  4_920_000, 15: 2_460_000 },
        '720p':  { 90:  3_870_000, 60:  3_030_000, 30:  2_000_000, 15: 1_000_000 },
        '480p':  { 90:  1_550_000, 60:  1_210_000, 30:    800_000, 15:   400_000 },
    };

    for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
            it(`computes the bitrate for ${res} @ ${fps}fps`, () => {
                expect(computeSSBitrate(res, fps)).toBe(EXPECTED[res][fps]);
            });
        }
    }

    it('defaults to the VP9 baseline (the table above) when no codec is given', () => {
        expect(computeSSBitrate('1440p', 90)).toBe(computeSSBitrate('1440p', 90, 'vp9'));
    });

    // 1440p90: the uncapped value (9.84 M × 1.933 × factor) is over every
    // codec's absolute cap, so these ARE the caps (16.4 M × factor).
    it.each([
        ['vp9',  16_400_000],
        ['vp8',  20_500_000],
        ['h264', 24_600_000],
        ['h265', 18_040_000],
    ] as const)('gives %s its codec factor at 1440p90 (%d bps)', (codec, expected) => {
        expect(computeSSBitrate('1440p', 90, codec)).toBe(expected);
    });

    it('the 2026-10-23 share (source 1440p90 H.265) is capped at ~18 Mbps, still under the 22 that lost a viewer', () => {
        expect(computeSSBitrate('source', 90, 'h265')).toBe(18_040_000);
        expect(computeSSBitrate('source', 90, 'h265')).toBeLessThan(22_000_000);
        expect(SS_MAX_BITRATE_VP9_EQUIV).toBe(16_400_000);
    });

    it('frame rate scales sub-linearly above 30 fps and linearly below', () => {
        expect(ssFpsFactor(30)).toBe(1);
        expect(ssFpsFactor(15)).toBe(0.5);
        expect(ssFpsFactor(60)).toBeCloseTo(1.516, 3);
        expect(ssFpsFactor(90)).toBeCloseTo(1.933, 3);
        // More fps never lowers the ceiling.
        for (const res of RESOLUTIONS) {
            for (const codec of ['vp9', 'vp8', 'h264', 'h265'] as const) {
                const v = [15, 30, 60, 90].map(f => computeSSBitrate(res, f, codec));
                for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
            }
        }
    });

    it('no ceiling exceeds its codec\'s absolute cap', () => {
        for (const res of RESOLUTIONS) {
            for (const fps of [15, 30, 60, 90, 120]) {
                expect(computeSSBitrate(res, fps, 'h264')).toBeLessThanOrEqual(24_600_000);
                expect(computeSSBitrate(res, fps, 'h265')).toBeLessThanOrEqual(18_040_000);
            }
        }
    });

    it('caps the fps multiplier at 90 for rates beyond 90 (e.g. a future preset)', () => {
        expect(computeSSBitrate('1080p', 120)).toBe(computeSSBitrate('1080p', 90));
    });

    // 'source' is a label, not a size: it is sized by the pixels actually
    // captured (the 1080p 90 fps H.265 share that froze a viewer three times
    // was given the 4K / Retina ceiling, ~18 Mbps against the 1080p tier's ~10.5).
    describe("'source' sized by its captured pixels", () => {
        const codecs = ['vp9', 'vp8', 'h264', 'h265'] as const;

        it('a 1920x1080 source gets exactly the 1080p tier, at every fps and codec', () => {
            for (const codec of codecs) {
                for (const fps of FRAME_RATES) {
                    expect(computeSSBitrate('source', fps, codec, { width: 1920, height: 1080 }))
                        .toBe(computeSSBitrate('1080p', fps, codec));
                }
            }
        });

        it('the reported share: 1080p source, 90 fps, H.265 is 10.46 Mbps, not 18.04', () => {
            expect(computeSSBitrate('source', 90, 'h265')).toBe(18_040_000);
            expect(computeSSBitrate('source', 90, 'h265', { width: 1920, height: 1080 })).toBe(10_460_000);
        });

        it('a 2560x1440 source gets exactly the 1440p tier', () => {
            for (const codec of codecs) {
                for (const fps of FRAME_RATES) {
                    expect(computeSSBitrate('source', fps, codec, { width: 2560, height: 1440 }))
                        .toBe(computeSSBitrate('1440p', fps, codec));
                }
            }
        });

        it('a source larger than the 1440p tier keeps the top ceiling (3024x1964 Mac, 3440x1440, 4K, 8K)', () => {
            for (const size of [
                { width: 3024, height: 1964 }, { width: 3440, height: 1440 },
                { width: 3840, height: 2160 }, { width: 7680, height: 4320 },
            ]) {
                for (const codec of codecs) {
                    for (const fps of FRAME_RATES) {
                        expect(computeSSBitrate('source', fps, codec, size)).toBe(computeSSBitrate('source', fps, codec));
                    }
                }
            }
            expect(computeSSBitrate('source', 90, 'h265', { width: 3024, height: 1964 })).toBe(18_040_000);
        });

        it('unknown or invalid dimensions are exactly today\'s label ceiling', () => {
            const today = computeSSBitrate('source', 90, 'h265');
            expect(computeSSBitrate('source', 90, 'h265', undefined)).toBe(today);
            expect(computeSSBitrate('source', 90, 'h265', {})).toBe(today);
            expect(computeSSBitrate('source', 90, 'h265', { width: 0, height: 0 })).toBe(today);
            expect(computeSSBitrate('source', 90, 'h265', { width: 1920 })).toBe(today);
            expect(computeSSBitrate('source', 90, 'h265', { width: NaN, height: 1080 })).toBe(today);
        });

        it('a named preset ignores the captured size (the user asked for that tier)', () => {
            expect(computeSSBitrate('1080p', 90, 'h265', { width: 3840, height: 2160 })).toBe(computeSSBitrate('1080p', 90, 'h265'));
            expect(computeSSBitrate('1440p', 90, 'h265', { width: 1280, height: 720 })).toBe(computeSSBitrate('1440p', 90, 'h265'));
        });

        it('sizes in-between and smaller screens by the nearest tier, a tie going up', () => {
            expect(ssTierForPixels(1920, 1200)).toBe('1080p');
            expect(ssTierForPixels(1366, 768)).toBe('720p');
            expect(ssTierForPixels(1280, 720)).toBe('720p');
            expect(ssTierForPixels(854, 480)).toBe('480p');
            expect(ssTierForPixels(640, 360)).toBe('480p');
            expect(ssTierForPixels(2560, 1080)).toBe('1440p'); // exact tie between 1080p and 1440p
            expect(ssTierForPixels(2560, 1440)).toBe('1440p');
            expect(ssTierForPixels(2561, 1440)).toBe('source');
            expect(ssTierForPixels(undefined, 1080)).toBe('source');
        });

        it('senderCaptureSize prefers an explicit size, then the track settings, else undefined', () => {
            const sender = { track: { getSettings: () => ({ width: 1920, height: 1080 }) } } as unknown as RTCRtpSender;
            expect(senderCaptureSize(sender)).toEqual({ width: 1920, height: 1080 });
            expect(senderCaptureSize(sender, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
            expect(senderCaptureSize({ track: { getSettings: () => ({}) } } as unknown as RTCRtpSender)).toBeUndefined();
            expect(senderCaptureSize(undefined)).toBeUndefined();
        });

        it('buildScreenSharePublishOptions carries the captured size into the stored encoding', () => {
            const o = buildScreenSharePublishOptions('source', 90, 'h265', { captured: { width: 1920, height: 1080 } });
            expect(o.screenShareEncoding.maxBitrate).toBe(computeSSBitrate('1080p', 90, 'h265'));
            expect(buildScreenSharePublishOptions('source', 90, 'h265').screenShareEncoding.maxBitrate).toBe(18_040_000);
        });
    });
});

// --- Fakes for applyScreenShareSenderParams / retuneScreenShareInPlace ---
// Plain object fakes only — no LiveKit, no DOM/jsdom needed, per the task.

function makeFakeSender(initialParams: RTCRtpSendParameters = {} as RTCRtpSendParameters) {
    let current = initialParams;
    const getParameters = vi.fn(() => current);
    const setParameters = vi.fn(async (p: RTCRtpSendParameters) => {
        current = p;
    });
    const sender = { getParameters, setParameters } as unknown as RTCRtpSender;
    return { sender, getParameters, setParameters };
}

describe('applyScreenShareSenderParams', () => {
    it('creates an encodings array when absent', async () => {
        const { sender, getParameters } = makeFakeSender({} as RTCRtpSendParameters);
        await applyScreenShareSenderParams(sender, 60, 12_000_000);
        const params = getParameters.mock.results[0]!.value as RTCRtpSendParameters;
        expect(Array.isArray(params.encodings)).toBe(true);
        expect(params.encodings!.length).toBeGreaterThan(0);
    });

    it('sets maxFramerate, maxBitrate, priority and networkPriority', async () => {
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);
        await applyScreenShareSenderParams(sender, 30, 6_000_001);
        expect(setParameters).toHaveBeenCalledTimes(1);
        const applied = setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
        const enc = applied.encodings![0] as RTCRtpEncodingParameters & { startBitrate?: number };
        expect(enc.maxFramerate).toBe(30);
        expect(enc.maxBitrate).toBe(6_000_001);
        expect(enc.priority).toBe('high');
        expect(enc.networkPriority).toBe('high');
        // No longer written: Chromium drops unknown encoding members, so it
        // never reached the encoder (getParameters() after the call lacked it).
        expect(enc.startBitrate).toBeUndefined();
    });

    it('sets degradationPreference to maintain-framerate', async () => {
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);
        await applyScreenShareSenderParams(sender, 30, 6_000_000);
        const applied = setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
        expect(applied.degradationPreference).toBe('maintain-framerate');
    });

    it('with the lighter copy: only the LAST encoding is the full layer; the first gets ≤30 fps / its own ceiling / scale from the capture', async () => {
        const { sender, setParameters } = makeFakeSender({ encodings: [{ rid: 'q', active: false }, { rid: 'h' }] } as RTCRtpSendParameters);
        (sender as unknown as { track: unknown }).track = { getSettings: () => ({ width: 2560, height: 1440 }) };
        await applyScreenShareSenderParams(sender, 90, 18_000_000, { codec: 'h264' });
        const [low, top] = (setParameters.mock.calls[0]![0] as RTCRtpSendParameters).encodings!;
        expect(top).toMatchObject({ maxFramerate: 90, maxBitrate: 18_000_000 });
        expect(low).toMatchObject({ maxFramerate: 30, maxBitrate: 3_000_000, scaleResolutionDownBy: 2, active: false });
    });

    it('priority only on encodings[0] (Chromium rejects a per-encoding priority change — measured)', async () => {
        const { sender, setParameters } = makeFakeSender({ encodings: [{ rid: 'q', priority: 'high' }, { rid: 'h', priority: 'low', networkPriority: 'low' }] } as RTCRtpSendParameters);
        await applyScreenShareSenderParams(sender, 60, 12_000_000, { codec: 'vp8' });
        const [a, b] = (setParameters.mock.calls[0]![0] as RTCRtpSendParameters).encodings!;
        expect(a.priority).toBe('high');
        expect(b.priority).toBe('low');
        expect(b.networkPriority).toBe('low');
    });

    it('is idempotent when applied twice', async () => {
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);
        await applyScreenShareSenderParams(sender, 60, 12_000_000);
        const firstApplied = setParameters.mock.calls[0]![0] as RTCRtpSendParameters;

        await applyScreenShareSenderParams(sender, 60, 12_000_000);
        const secondApplied = setParameters.mock.calls[1]![0] as RTCRtpSendParameters;

        expect(secondApplied.encodings!.length).toBe(firstApplied.encodings!.length);
        expect(secondApplied.encodings![0]).toEqual(firstApplied.encodings![0]);
        expect(secondApplied.degradationPreference).toBe(firstApplied.degradationPreference);
    });
});

// --- retuneScreenShareInPlace fakes ---

function makeFakeTrack(overrides: {
    readyState?: MediaStreamTrack['readyState'];
    applyConstraints?: (c: unknown) => Promise<void>;
} = {}) {
    const applyConstraints = vi.fn(overrides.applyConstraints ?? (async () => {}));
    const getSettings = vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 }));
    const mediaStreamTrack = {
        readyState: overrides.readyState ?? 'live',
        applyConstraints,
        getSettings,
    } as unknown as MediaStreamTrack;
    return { mediaStreamTrack, applyConstraints, getSettings };
}

describe('retuneScreenShareInPlace', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let infoSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        infoSpy.mockRestore();
    });

    it('returns false and changes nothing when track is undefined', async () => {
        const result = await retuneScreenShareInPlace(undefined, '1080p', 30);
        expect(result).toBe(false);
    });

    it('returns false and changes nothing when mediaStreamTrack is missing', async () => {
        const { sender, setParameters } = makeFakeSender();
        const result = await retuneScreenShareInPlace({ sender }, '1080p', 30);
        expect(result).toBe(false);
        expect(setParameters).not.toHaveBeenCalled();
    });

    it("returns false and changes nothing when readyState !== 'live'", async () => {
        const { mediaStreamTrack, applyConstraints } = makeFakeTrack({ readyState: 'ended' });
        const { sender, setParameters } = makeFakeSender();
        const result = await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 30);
        expect(result).toBe(false);
        expect(applyConstraints).not.toHaveBeenCalled();
        expect(setParameters).not.toHaveBeenCalled();
    });

    it('returns false and changes nothing when the sender is missing', async () => {
        const { mediaStreamTrack, applyConstraints } = makeFakeTrack();
        const result = await retuneScreenShareInPlace({ mediaStreamTrack }, '1080p', 30);
        expect(result).toBe(false);
        expect(applyConstraints).not.toHaveBeenCalled();
    });

    it('returns false when applyConstraints rejects (OverconstrainedError)', async () => {
        const overconstrained = new Error('OverconstrainedError');
        overconstrained.name = 'OverconstrainedError';
        const { mediaStreamTrack } = makeFakeTrack({
            applyConstraints: async () => { throw overconstrained; },
        });
        const { sender, setParameters } = makeFakeSender();
        const result = await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 30);
        expect(result).toBe(false);
        expect(setParameters).not.toHaveBeenCalled();
    });

    it('returns true and calls applyConstraints then setParameters, in that order, on success', async () => {
        const order: string[] = [];
        const { mediaStreamTrack, applyConstraints } = makeFakeTrack({
            applyConstraints: async () => { order.push('applyConstraints'); },
        });
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);
        setParameters.mockImplementation(async (p: RTCRtpSendParameters) => {
            order.push('setParameters');
            return p as unknown as void;
        });

        const result = await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1080p', 60);

        expect(result).toBe(true);
        expect(applyConstraints).toHaveBeenCalledTimes(1);
        expect(setParameters).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['applyConstraints', 'setParameters']);
    });

    it('passes width/height max constraints from the resolution and a PACED capture frame rate', async () => {
        const { mediaStreamTrack, applyConstraints } = makeFakeTrack();
        const { sender } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);

        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '720p', 15);

        expect(applyConstraints).toHaveBeenCalledWith({
            width:     { max: 1280 },
            height:    { max: 720 },
            frameRate: { max: 19 }, // captureFrameRateFor(15)
        });
    });

    it('keeps the ENCODER at the target while the capturer gets headroom (90 → capture 113, encode 90)', async () => {
        const { mediaStreamTrack, applyConstraints } = makeFakeTrack();
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);

        await retuneScreenShareInPlace({ mediaStreamTrack, sender }, '1440p', 90);

        expect((applyConstraints.mock.calls[0][0] as MediaTrackConstraints).frameRate).toEqual({ max: 113 });
        expect(setParameters.mock.calls[0][0].encodings[0].maxFramerate).toBe(90);
    });
});

describe('retuneScreenShareInPlace — codec factor', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let infoSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => { warnSpy.mockRestore(); infoSpy.mockRestore(); });

    it("keeps the published codec's headroom: an H.264 share retunes to the H.264 ceiling", async () => {
        const { mediaStreamTrack } = makeFakeTrack();
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);
        await retuneScreenShareInPlace({ mediaStreamTrack, sender, codec: 'h264' }, '1440p', 90);
        const applied = setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
        expect(applied.encodings![0]!.maxBitrate).toBe(computeSSBitrate('1440p', 90, 'h264'));
    });

    it('falls back to the VP9 baseline for an unknown codec string', async () => {
        const { mediaStreamTrack } = makeFakeTrack();
        const { sender, setParameters } = makeFakeSender({ encodings: [{}] } as RTCRtpSendParameters);
        await retuneScreenShareInPlace({ mediaStreamTrack, sender, codec: 'av1' }, '1080p', 60);
        const applied = setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
        expect(applied.encodings![0]!.maxBitrate).toBe(computeSSBitrate('1080p', 60));
    });
});

describe('asScreenShareCodec', () => {
    it.each([['h264', 'h264'], ['vp9', 'vp9'], ['vp8', 'vp8'], ['av1', undefined], [undefined, undefined], ['', undefined]] as const)(
        'maps %s to %s', (input, expected) => {
            expect(asScreenShareCodec(input)).toBe(expected);
        });
});

describe('chooseScreenShareCodec', () => {
    const NONE: HardwareEncoderSupport = { h264: false, vp9: false, vp8: false };
    // Decision table: an explicit preference always wins; 'auto' takes the
    // first HARDWARE codec in H.264 → VP9 order, and VP8 (cheapest in
    // software) when there is none or the probe could not run.
    it.each<[ScreenShareCodecPref, HardwareEncoderSupport | null, string]>([
        ['auto', { h264: true, vp9: true, vp8: true }, 'h264'],
        ['auto', { h264: true, vp9: false, vp8: false }, 'h264'],
        ['auto', { h264: false, vp9: true, vp8: false }, 'vp9'],
        ['auto', { h264: false, vp9: false, vp8: true }, 'vp8'],
        ['auto', NONE, 'vp8'],
        ['auto', null, 'vp8'],
        ['vp9', { h264: true, vp9: false, vp8: false }, 'vp9'],
        ['h264', NONE, 'h264'],
        ['vp8', { h264: true, vp9: true, vp8: false }, 'vp8'],
    ])('pref=%s hw=%j → %s', (pref, hw, expected) => {
        expect(chooseScreenShareCodec(pref, hw)).toBe(expected);
    });
});

describe('isNvidiaOnly', () => {
    it.each<[Array<{ vendor: string }> | null | undefined, boolean]>([
        [[{ vendor: 'NVIDIA' }], true],
        [[{ vendor: 'NVIDIA' }, { vendor: 'Microsoft (software)' }], true],
        [[{ vendor: 'NVIDIA' }, { vendor: 'Intel' }], false],
        [[{ vendor: 'AMD' }], false],
        [[{ vendor: 'Microsoft (software)' }], false],
        [[], false],
        [null, false],
        [undefined, false],
    ])('%j → %s', (gpus, expected) => {
        expect(isNvidiaOnly(gpus)).toBe(expected);
    });
});

describe('decideScreenShareCodec — GPU vendor and profile rules', () => {
    const CB = { h264: true, vp9: false, vp8: false, h264High: true };
    const HIGH_ONLY = { h264: false, vp9: false, vp8: false, h264High: true };
    const NV = [{ vendor: 'NVIDIA' }];
    const NV_INTEL = [{ vendor: 'NVIDIA' }, { vendor: 'Intel' }];

    // Decision table for 'auto'. NVIDIA-only + a "yes" for Constrained
    // Baseline is the case MediaCapabilities gets wrong: Chromium's MF encoder
    // skips NVIDIA for that profile (crbug.com/1088650), so H.264 would be
    // OpenH264 in software.
    // The owner's RTX 2080 Ti + Radeon Pro WX 2100: CB ✗, High ✓, nothing else.
    const OWNER = { h264: false, vp9: false, vp8: false, h264High: true };
    const OWNER_GPUS = [{ vendor: 'NVIDIA' }, { vendor: 'AMD' }, { vendor: 'Microsoft (software)' }];
    it.each<[string, HardwareEncoderSupport | null, Array<{ vendor: string }> | undefined, string, 'cb' | 'high' | undefined, RegExp]>([
        ['CB HW, Intel/AMD', CB, [{ vendor: 'AMD' }], 'h264', 'cb', /HW H\.264$/],
        ['CB "HW", NVIDIA primary + iGPU → High (MF skips NVIDIA for CB; nothing else took over on the owner\'s box)', CB, NV_INTEL, 'h264', 'high', /High \(NVIDIA skips CB\)/],
        ['CB HW, Optimus (iGPU primary, NVIDIA second) → the primary\'s CB', CB, [{ vendor: 'Intel' }, { vendor: 'NVIDIA' }], 'h264', 'cb', /HW H\.264$/],
        // staging.174, 2026-10-24: at 1080p the probe said CB is hardware on the
        // RTX 2080 Ti + WX 2100, and the share ran on OpenH264 for its whole life.
        ['the owner\'s 1080p probe: CB "HW" + High HW, NVIDIA + AMD → High', CB, OWNER_GPUS, 'h264', 'high', /High \(NVIDIA skips CB\)/],
        ['CB HW, GPU list unknown → trust the probe', CB, undefined, 'h264', 'cb', /HW H\.264$/],
        ['CB "HW", NVIDIA only → High (MF skips NVIDIA for CB, not for High)', CB, NV, 'h264', 'high', /High \(NVIDIA skips CB\)/],
        ['CB "HW", NVIDIA only, VP9 HW → still High first', { ...CB, vp9: true }, NV, 'h264', 'high', /High/],
        ['H.264 High only (the Windows CBP gate)', HIGH_ONLY, NV, 'h264', 'high', /High \(CB not HW\)/],
        ['the owner\'s HUD: High ✓ CB ✗, NVIDIA + AMD', OWNER, OWNER_GPUS, 'h264', 'high', /High \(CB not HW\)/],
        ['CB "HW" on NVIDIA only and NO High → VP8', { h264: true, vp9: false, vp8: false, h264High: false }, NV, 'vp8', undefined, /NVIDIA skips H\.264 CB/],
        ['nothing', { h264: false, vp9: false, vp8: false }, NV, 'vp8', undefined, /no HW/],
        ['no probe', null, NV, 'vp8', undefined, /no probe/],
    ])('%s', (_label, hw, gpus, codec, profile, reason) => {
        const d = decideScreenShareCodec('auto', hw, gpus);
        expect(d.codec).toBe(codec);
        expect(d.h264Profile).toBe(profile);
        expect(d.reason).toMatch(reason);
    });

    it('after a CB share ran in software this session, CB is not trusted again: High if HW, else VP8', () => {
        const opts = { cbSoftware: true };
        expect(decideScreenShareCodec('auto', CB, [{ vendor: 'AMD' }], opts)).toEqual({
            codec: 'h264', h264Profile: 'high', reason: 'auto: HW H.264 High (CB ran in software)',
        });
        expect(decideScreenShareCodec('auto', { ...CB, h264High: false }, [{ vendor: 'AMD' }], opts)).toEqual({
            codec: 'vp8', reason: 'auto: H.264 CB ran in software → VP8',
        });
        // Without the flag the same AMD machine keeps its CB.
        expect(decideScreenShareCodec('auto', CB, [{ vendor: 'AMD' }])).toMatchObject({ codec: 'h264', h264Profile: 'cb' });
    });

    it('nvidiaIsPrimary: only the FIRST real adapter decides; Microsoft\'s software adapter is skipped', () => {
        expect(nvidiaIsPrimary([{ vendor: 'NVIDIA' }, { vendor: 'AMD' }])).toBe(true);
        expect(nvidiaIsPrimary([{ vendor: 'Microsoft (software)' }, { vendor: 'NVIDIA' }])).toBe(true);
        expect(nvidiaIsPrimary([{ vendor: 'Intel' }, { vendor: 'NVIDIA' }])).toBe(false);
        expect(nvidiaIsPrimary([])).toBe(false);
        expect(nvidiaIsPrimary(null)).toBe(false);
    });

    it('after a High encoder failed to start, auto never picks High again (VP8, or HW VP9 if present)', () => {
        const opts = { h264HighFailed: true };
        expect(decideScreenShareCodec('auto', OWNER, OWNER_GPUS, opts)).toEqual({
            codec: 'vp8', reason: 'auto: H.264 High HW encoder failed → VP8',
        });
        expect(decideScreenShareCodec('auto', { ...HIGH_ONLY, vp9: true }, NV, opts).codec).toBe('vp9');
        // CB hardware is unaffected by a High failure.
        expect(decideScreenShareCodec('auto', CB, [{ vendor: 'AMD' }], opts)).toMatchObject({ codec: 'h264', h264Profile: 'cb' });
    });

    it('an explicit preference ignores the GPU for the CODEC; explicit H.264 still gets the hardware profile', () => {
        expect(decideScreenShareCodec('h264', null, NV)).toEqual({ codec: 'h264', h264Profile: 'cb', reason: 'set in Settings' });
        expect(decideScreenShareCodec('h264', OWNER, OWNER_GPUS)).toEqual({ codec: 'h264', h264Profile: 'high', reason: 'set in Settings · High (HW)' });
        expect(decideScreenShareCodec('h264', OWNER, OWNER_GPUS, { h264HighFailed: true }))
            .toEqual({ codec: 'h264', h264Profile: 'cb', reason: 'set in Settings · High HW failed → CB' });
        expect(decideScreenShareCodec('vp9', CB, NV_INTEL).codec).toBe('vp9');
        expect(decideScreenShareCodec('vp8', OWNER, OWNER_GPUS)).toEqual({ codec: 'vp8', reason: 'set in Settings' });
    });
});

// Real sender capabilities from Electron 43 (Chromium 150) with a hardware
// H.264 encoder that does High but not Constrained Baseline — the harness's
// VAAPI run with PlatformH264CbpEncoding disabled, i.e. the NVIDIA shape.
const CAPS_HW_HIGH = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=4d001f' },
    { mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'level-idx=5;profile=0;tier=0' },
    { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640033' },
    { mimeType: 'video/red', clockRate: 90000 },
    { mimeType: 'video/ulpfec', clockRate: 90000 },
];

describe('isLiveKitH264High — what LiveKit v1.9.12 (pion) will match against its 640032', () => {
    const h = (fmtp: string, mime = 'video/H264') => isLiveKitH264High({ mimeType: mime, sdpFmtpLine: fmtp });
    it.each<[string, boolean]>([
        ['level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640033', true],
        ['packetization-mode=1;profile-level-id=64001f', true],  // level is ignored by the match
        ['profile-level-id=640034;packetization-mode=1', true],
        ['level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640033', false], // pm 0
        ['packetization-mode=1;profile-level-id=640c33', false], // Constrained High: constraint byte differs
        ['packetization-mode=1;profile-level-id=42e01f', false],
        ['packetization-mode=1;profile-level-id=4d0032', false], // Main: LiveKit has no Main
        ['profile-level-id=640033', false],                        // no packetization-mode
        ['', false],
    ])('%s → %s', (fmtp, expected) => {
        expect(h(fmtp)).toBe(expected);
    });
    it('only for H.264', () => {
        expect(h('packetization-mode=1;profile-level-id=640033', 'video/VP8')).toBe(false);
        expect(h('packetization-mode=1;profile-level-id=640033', 'video/h264')).toBe(true);
    });
});

describe('orderCodecsForH264High', () => {
    it('puts High first and keeps EVERYTHING else, in order (CB/VP8 stay as fallbacks)', () => {
        const out = orderCodecsForH264High(CAPS_HW_HIGH)!;
        expect(out).toHaveLength(CAPS_HW_HIGH.length);
        expect(out[0].sdpFmtpLine).toMatch(/profile-level-id=640033/);
        expect(out.slice(1)).toEqual(CAPS_HW_HIGH.filter(c => !/640033/.test(c.sdpFmtpLine ?? '')));
    });
    it('returns null when this machine cannot send High (software-only capabilities)', () => {
        expect(orderCodecsForH264High(CAPS_HW_HIGH.filter(c => !/6400/.test(c.sdpFmtpLine ?? '')))).toBeNull();
        expect(orderCodecsForH264High([])).toBeNull();
    });
});

describe('preferH264HighOnSender / installH264HighPreference', () => {
    const makeParticipant = (senders: RTCRtpSender[]) => {
        const transceivers = senders.map(sender => ({ sender, setCodecPreferences: vi.fn() }));
        const listeners = new Map<string, (s: RTCRtpSender, t: { source?: string }) => void>();
        const participant = {
            engine: { pcManager: { publisher: { getTransceivers: () => transceivers as unknown as RTCRtpTransceiver[] } } },
            on: vi.fn((e: string, cb: (s: RTCRtpSender, t: { source?: string }) => void) => { listeners.set(e, cb); }),
            off: vi.fn((e: string) => { listeners.delete(e); }),
        };
        return { participant, transceivers, listeners };
    };
    const caps = () => CAPS_HW_HIGH;

    it('sets High-first preferences on the transceiver that owns the sender, and only that one', () => {
        const a = {} as RTCRtpSender;
        const b = {} as RTCRtpSender;
        const { participant, transceivers } = makeParticipant([a, b]);
        expect(preferH264HighOnSender(participant, b, caps)).toBe('applied');
        expect(transceivers[0].setCodecPreferences).not.toHaveBeenCalled();
        const prefs = transceivers[1].setCodecPreferences.mock.calls[0][0] as RtpCodecLike[];
        expect(prefs[0].sdpFmtpLine).toMatch(/640033/);
    });

    it('does nothing when the machine has no High, or the transceiver is not found, and never throws', () => {
        const a = {} as RTCRtpSender;
        const { participant, transceivers } = makeParticipant([a]);
        expect(preferH264HighOnSender(participant, a, () => CAPS_HW_HIGH.slice(0, 5))).toBe('no-high');
        expect(preferH264HighOnSender(participant, {} as RTCRtpSender, caps)).toBe('no-transceiver');
        expect(preferH264HighOnSender({}, a, caps)).toBe('no-transceiver');
        expect(transceivers[0].setCodecPreferences).not.toHaveBeenCalled();
        transceivers[0].setCodecPreferences.mockImplementation(() => { throw new Error('InvalidModificationError'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(preferH264HighOnSender(participant, a, caps)).toBe('failed');
        warn.mockRestore();
    });

    it('applies on EVERY screen-share sender while wanted (first publish and each republish), never on camera', () => {
        const share1 = {} as RTCRtpSender;
        const share2 = {} as RTCRtpSender;
        const cam = {} as RTCRtpSender;
        const { participant, transceivers, listeners } = makeParticipant([share1, share2, cam]);
        let want = true;
        const log = vi.fn();
        const off = installH264HighPreference(participant, () => want, log);
        const fire = listeners.get('localSenderCreated')!;
        // The real capabilities call is swapped for the test ones via the global.
        const orig = globalThis.RTCRtpSender;
        (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender = { getCapabilities: () => ({ codecs: CAPS_HW_HIGH }) };
        try {
            fire(share1, { source: 'screen_share' });
            fire(cam, { source: 'camera' });
            fire(share2, { source: 'screen_share' }); // republish after a reconnect
            want = false;
            fire(share1, { source: 'screen_share' });
        } finally {
            (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender = orig;
        }
        expect(transceivers[0].setCodecPreferences).toHaveBeenCalledTimes(1);
        expect(transceivers[1].setCodecPreferences).toHaveBeenCalledTimes(1);
        expect(transceivers[2].setCodecPreferences).not.toHaveBeenCalled();
        off();
        expect(participant.off).toHaveBeenCalledWith('localSenderCreated', expect.any(Function));
        expect(listeners.has('localSenderCreated')).toBe(false);
    });
});

describe('watchH264HighStart', () => {
    const report = (framesEncoded: number | undefined) =>
        [{ type: 'outbound-rtp', kind: 'video', framesEncoded }, { type: 'outbound-rtp', kind: 'audio', framesEncoded: 99 }];
    const sleep = vi.fn(async () => {});

    it('ok as soon as a frame was encoded', async () => {
        const stats = vi.fn()
            .mockResolvedValueOnce(report(0))
            .mockResolvedValueOnce(report(3));
        expect(await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000 })).toBe('ok');
        expect(stats).toHaveBeenCalledTimes(2);
    });

    it('per layer: a dead full layer next to a working 720p copy is a failure; a dynacast-paused layer is not judged', async () => {
        const two = (q: number, h: number, hActive = true) => [
            { type: 'outbound-rtp', kind: 'video', framesEncoded: q, active: true },
            { type: 'outbound-rtp', kind: 'video', framesEncoded: h, active: hActive },
        ];
        expect(await watchH264HighStart(vi.fn(async () => two(30, 0)), { sleep, timeoutMs: 2000, intervalMs: 1000 })).toBe('failed');
        expect(await watchH264HighStart(vi.fn(async () => two(30, 0, false)), { sleep, timeoutMs: 2000, intervalMs: 1000 })).toBe('ok');
        expect(await watchH264HighStart(vi.fn(async () => two(30, 12)), { sleep })).toBe('ok');
    });

    it('failed when the video encoder is still at 0 frames after the timeout (the dead-HW-encoder case) — audio frames do not count', async () => {
        const stats = vi.fn(async () => report(0));
        expect(await watchH264HighStart(stats, { sleep, timeoutMs: 3000, intervalMs: 1000 })).toBe('failed');
        expect(stats).toHaveBeenCalledTimes(4); // t = 0, 1, 2, 3 s
    });

    it('gone when the sender stops answering (share ended) — never a false "failed"', async () => {
        const stats = vi.fn(async () => { throw new Error('closed'); });
        expect(await watchH264HighStart(stats, { sleep })).toBe('gone');
    });

    // Reports 479af6c7 / 438f97a1 (1.0.24-staging.178): 1440p90 H.264 High on an
    // RTX 2080 Ti. share_fps 3 s in: limit=bandwidth enc_fps=27.1 sent_fps=30
    // (the 720p copy), share_net avail_kbps=369 - the full layer had no bits yet.
    // The 6 s check said `failed`, marked High dead for the session, and every
    // later share was software VP8 clamped to 30 fps.
    describe('a bandwidth-starved full layer next to a working 720p copy (reports 479af6c7 / 438f97a1)', () => {
        const starvedPair = { type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 369_000 };
        const rtp = (framesEncoded: number, extra: Record<string, unknown> = {}) =>
            ({ type: 'outbound-rtp', kind: 'video', active: true, framesEncoded, qualityLimitationReason: 'bandwidth', ...extra });

        it('does not call the encoder dead at the 6 s timeout while the estimate is still ~369 kbps', async () => {
            // q (720p copy) encoding, h (full layer) not started - for the first 12 polls; then the estimate has climbed and h wakes up.
            let n = 0;
            const stats = vi.fn(async () => {
                n++;
                return n <= 12
                    ? [rtp(30 * n), rtp(0), starvedPair]
                    : [rtp(30 * n, { qualityLimitationReason: 'none' }), rtp(5, { qualityLimitationReason: 'none' }), { ...starvedPair, availableOutgoingBitrate: 7_119_000 }];
            });
            expect(await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000 })).toBe('ok');
            expect(stats).toHaveBeenCalledTimes(13); // t = 0..12 s: well past the old 6 s verdict
        });

        it('gives up WAITING (not on the encoder) after the starved wait: "limited", never "failed"', async () => {
            const stats = vi.fn(async () => [rtp(500), rtp(0), starvedPair]);
            const res = await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000, starvedWaitMs: 30_000 });
            expect(res).toBe('limited');
            expect(stats).toHaveBeenCalledTimes(31); // t = 0..30 s
        });

        it('starvation is also recognised from the estimate alone (the layer reports no limitation reason)', async () => {
            const stats = vi.fn(async () => [rtp(500, { qualityLimitationReason: 'none' }), rtp(0, { qualityLimitationReason: 'none' }), starvedPair]);
            expect(await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000, starvedWaitMs: 8000 })).toBe('limited');
        });

        it('still a failure once the estimate is healthy: a dead full layer on a good link (NVENC session limit)', async () => {
            const healthy = { ...starvedPair, availableOutgoingBitrate: 66_468_000 };
            const stats = vi.fn(async () => [rtp(500, { qualityLimitationReason: 'none' }), rtp(0, { qualityLimitationReason: 'none' }), healthy]);
            expect(await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000 })).toBe('failed');
            expect(stats).toHaveBeenCalledTimes(7);
        });

        it('starvation never excuses an encoder that produced NOTHING on any layer', async () => {
            const stats = vi.fn(async () => [rtp(0), rtp(0), starvedPair]);
            expect(await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000 })).toBe('failed');
        });

        it('the estimate recovering mid-wait while the layer stays silent turns it back into a failure at once', async () => {
            let n = 0;
            const stats = vi.fn(async () => {
                n++;
                const pair = n <= 8 ? starvedPair : { ...starvedPair, availableOutgoingBitrate: 30_000_000 };
                return [rtp(300, { qualityLimitationReason: n <= 8 ? 'bandwidth' : 'none' }), rtp(0, { qualityLimitationReason: n <= 8 ? 'bandwidth' : 'none' }), pair];
            });
            expect(await watchH264HighStart(stats, { sleep, timeoutMs: 6000, intervalMs: 1000 })).toBe('failed');
            expect(stats).toHaveBeenCalledTimes(9);
        });
    });
});

describe('captureFrameRateFor — capture headroom above the send rate', () => {
    it.each<[number, number]>([[90, 113], [60, 75], [30, 38], [15, 19], [120, 150], [240, 240], [200, 240]])(
        '%s fps → capture %s', (target, capture) => {
            expect(captureFrameRateFor(target)).toBe(capture);
        });
    it('90 → a Chromium capture period of 8 ms (floor(1000/113)) instead of 11', () => {
        expect(Math.floor(1000 / captureFrameRateFor(90))).toBe(8);
        expect(Math.floor(1000 / 90)).toBe(11);
    });
    it('passes nonsense through unchanged', () => {
        expect(captureFrameRateFor(0)).toBe(0);
        expect(Number.isNaN(captureFrameRateFor(NaN))).toBe(true);
    });
});

describe('the lighter copy (lower layer) — off unless asked for', () => {
    it('default: one layer, exactly as before', () => {
        for (const res of ['source', '1440p', '1080p'] as const) {
            const o = buildScreenSharePublishOptions(res, 90, 'h264');
            expect(o.simulcast).toBe(false);
            expect(o.screenShareSimulcastLayers).toBeUndefined();
        }
    });
    it('asked for: H.264 / VP8 / H.265 at ≥ 1080p get a 720p ≤ 30 fps layer; the full layer is unchanged', () => {
        const o = buildScreenSharePublishOptions('1440p', 90, 'h264', { lowerLayer: true });
        expect(o.simulcast).toBe(true);
        expect(o.screenShareEncoding).toEqual(buildScreenSharePublishOptions('1440p', 90, 'h264').screenShareEncoding);
        expect(o.screenShareSimulcastLayers!.map(p => [p.width, p.height, p.encoding.maxBitrate, p.encoding.maxFramerate])).toEqual([[1280, 720, 3_000_000, 30]]);
        expect(buildScreenSharePublishOptions('1080p', 60, 'vp8', { lowerLayer: true }).screenShareSimulcastLayers![0].encoding.maxBitrate).toBe(2_500_000);
        expect(buildScreenSharePublishOptions('1080p', 60, 'h265', { lowerLayer: true }).simulcast).toBe(true);
    });
    it('never for VP9 (LiveKit forces L1T3) or ≤ 720p shares', () => {
        expect(buildScreenSharePublishOptions('1440p', 90, 'vp9', { lowerLayer: true }).simulcast).toBe(false);
        expect(buildScreenSharePublishOptions('720p', 60, 'h264', { lowerLayer: true }).simulcast).toBe(false);
        expect(shareHasLowerLayer('480p', 'vp8')).toBe(false);
    });
    it('shareLowEncoding: 720p from big captures, half size from small windows, never upscaled, bitrate by area', () => {
        expect(shareLowEncoding(2560, 1440, 90, 'h264')).toEqual({ scaleResolutionDownBy: 2, maxFramerate: 30, maxBitrate: 3_000_000 });
        expect(shareLowEncoding(5120, 1440, 60, 'vp8')).toMatchObject({ scaleResolutionDownBy: 2, maxFramerate: 30 });
        expect(shareLowEncoding(1920, 1080, 15, 'vp8')).toEqual({ scaleResolutionDownBy: 1.5, maxFramerate: 15, maxBitrate: computeSSBitrate('720p', 15, 'vp8') });
        const small = shareLowEncoding(1000, 600, 60, 'vp8');
        expect(small.scaleResolutionDownBy).toBe(2);
        expect(small.maxBitrate).toBeLessThan(2_500_000);
        expect(shareLowEncoding(undefined, undefined, 30, 'vp8').scaleResolutionDownBy).toBe(2);
    });
    it('shareLowEncoding: an ultra-wide share is sized by its real pixels, not by its short side (Surround 3840x720)', () => {
        // 3840x720 -> 1920x360 = 0.75 of a 1280x720 frame. By the short side alone it was 0.25: 550 kbps
        // for an H.265 racing game, which the hardware encoder met by dropping to 9-12 fps (report 6b3ddab6).
        const low = shareLowEncoding(3840, 720, 90, 'h265');
        expect(low.scaleResolutionDownBy).toBe(2);
        const full720 = computeSSBitrate('720p', 30, 'h265');
        expect(low.maxBitrate).toBeCloseTo(full720 * 0.75, -5);
        expect(low.maxBitrate).toBeGreaterThan(full720 * 0.7);
        // 16:9 is unchanged: a half-size 1280x720 capture is a quarter of 720p either way.
        expect(shareLowEncoding(1280, 720, 30, 'h265').maxBitrate).toBe(Math.max(300_000, Math.round((full720 * 0.25) / 10_000) * 10_000));
        expect(shareLowEncoding(2560, 1440, 90, 'h264').maxBitrate).toBe(3_000_000);
    });
    it('H.265 ceiling is ~27 % under H.264', () => {
        // At 1080p30 (under the cap; 10 kbps rounding allows ~3 decimals); the absolute caps keep the same ratio exactly.
        expect(computeSSBitrate('1080p', 30, 'h265') / computeSSBitrate('1080p', 30, 'h264')).toBeCloseTo(1.1 / 1.5, 2);
        expect(computeSSBitrate('1440p', 90, 'h265') / computeSSBitrate('1440p', 90, 'h264')).toBeCloseTo(1.1 / 1.5, 5);
        expect(asScreenShareCodec('h265')).toBe('h265');
        expect(asScreenShareCodec('av1')).toBeUndefined();
    });
});

describe('buildScreenSharePublishOptions', () => {
    // These exact objects are what the measurement harness published as "new"
    // (see the branch commit message) — keep them in step.
    it('1440p @ 90 fps, H.264: single layer, 90 fps encoding, H.264 ceiling, maintain-framerate', () => {
        expect(buildScreenSharePublishOptions('1440p', 90, 'h264')).toEqual({
            simulcast: false,
            videoCodec: 'h264',
            backupCodec: false,
            screenShareEncoding: { maxBitrate: 24_600_000, maxFramerate: 90, priority: 'high' },
            degradationPreference: 'maintain-framerate',
        });
    });

    it('source @ 90 fps, VP9', () => {
        expect(buildScreenSharePublishOptions('source', 90, 'vp9')).toEqual({
            simulcast: false,
            videoCodec: 'vp9',
            backupCodec: false,
            screenShareEncoding: { maxBitrate: 16_400_000, maxFramerate: 90, priority: 'high' },
            degradationPreference: 'maintain-framerate',
        });
    });

    // Every reachable picker pair: the encoding's frame rate IS the requested
    // rate (LiveKit's default would be 15), and the bitrate is the same number
    // the sender override re-asserts, so the two can never disagree.
    for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
            it(`${res} @ ${fps}fps carries maxFramerate ${fps} and the shared bitrate ceiling`, () => {
                for (const codec of ['h264', 'vp9', 'vp8'] as const) {
                    const o = buildScreenSharePublishOptions(res, fps, codec);
                    expect(o.screenShareEncoding.maxFramerate).toBe(fps);
                    expect(o.screenShareEncoding.maxBitrate).toBe(computeSSBitrate(res, fps, codec));
                    expect(o.simulcast).toBe(false);
                    expect(o.degradationPreference).toBe('maintain-framerate');
                }
            });
        }
    }
});

describe('probeHardwareEncoders', () => {
    type Cfg = { video: { contentType: string; width: number; height: number; framerate: number; scalabilityMode?: string } };
    const fakeInfo = (hw: Record<string, boolean>, supported = true) => vi.fn(async (c: Cfg) => ({
        supported,
        powerEfficient: !!hw[`${c.video.contentType}|${c.video.scalabilityMode}`],
    }));

    it('returns null when the MediaCapabilities API is unavailable', async () => {
        expect(await probeHardwareEncoders(2560, 1440, 90, undefined)).toBeNull();
    });

    const HIGH = 'video/H264;profile-level-id=640032;packetization-mode=1';

    it('asks about VP9 as L1T3 (what LiveKit publishes), H.264/VP8 as L1T1, and H.264 in the NEGOTIATED profile', async () => {
        const info = fakeInfo({ 'video/VP9|L1T3': true });
        const r = await probeHardwareEncoders(2560, 1440, 90, info);
        expect(r).toEqual({ h264: false, vp9: true, vp8: false, h264High: false });
        const asked = info.mock.calls.map(([c]) => `${c.video.contentType}|${c.video.scalabilityMode}`).sort();
        expect(asked).toEqual([`${HIGH}|L1T1`, `${LIVEKIT_H264_CONTENT_TYPE}|L1T1`, 'video/VP8|L1T1', 'video/VP9|L1T3'].sort());
    });

    it('the decisive H.264 question is Constrained Baseline 42e01f — LiveKit\'s only non-High H.264', () => {
        expect(LIVEKIT_H264_CONTENT_TYPE).toMatch(/profile-level-id=42e01f/);
        expect(LIVEKIT_H264_CONTENT_TYPE).toMatch(/packetization-mode=1/);
    });

    it('a GPU that encodes H.264 High but not Constrained Baseline is NOT "hardware H.264" (the Windows CBP gate)', async () => {
        const r = await probeHardwareEncoders(2560, 1440, 90, fakeInfo({ [`${HIGH}|L1T1`]: true }));
        expect(r).toEqual({ h264: false, vp9: false, vp8: false, h264High: true });
    });

    it('does not count a hardware VP9 encoder that only does L1T1', async () => {
        const r = await probeHardwareEncoders(2560, 1440, 90, fakeInfo({ 'video/VP9|L1T1': true }));
        expect(r!.vp9).toBe(false);
    });

    it('requires supported AND powerEfficient', async () => {
        const r = await probeHardwareEncoders(2560, 1440, 90, fakeInfo({ [`${LIVEKIT_H264_CONTENT_TYPE}|L1T1`]: true }, false));
        expect(r).toEqual({ h264: false, vp9: false, vp8: false, h264High: false });
    });

    it('clamps the probe to 4K so the 8K "source" box cannot hide a 4K-capable encoder', async () => {
        const info = fakeInfo({ [`${LIVEKIT_H264_CONTENT_TYPE}|L1T1`]: true });
        const r = await probeHardwareEncoders(7680, 4320, 90, info);
        expect(r!.h264).toBe(true);
        for (const [c] of info.mock.calls) {
            expect(c.video.width).toBe(3840);
            expect(c.video.height).toBe(2160);
            expect(c.video.framerate).toBe(90);
        }
    });

    it('treats a rejecting query as "no hardware" rather than failing the share', async () => {
        const info = vi.fn(async () => { throw new TypeError('bad config'); });
        expect(await probeHardwareEncoders(1920, 1080, 60, info)).toEqual({ h264: false, vp9: false, vp8: false, h264High: false });
    });
});
