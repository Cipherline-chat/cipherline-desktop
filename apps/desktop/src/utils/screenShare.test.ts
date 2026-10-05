import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    resolveSSResolution,
    computeSSBitrate,
    applyScreenShareSenderParams,
    retuneScreenShareInPlace,
    chooseScreenShareCodec,
    decideScreenShareCodec,
    isNvidiaOnly,
    buildScreenSharePublishOptions,
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
    // Base values (tuned at 30fps) × min(fps/30, 3), from the source.
    const EXPECTED: Record<ScreenShareOptions['resolution'], Record<number, number>> = {
        source:  { 90: 54_000_000, 60: 36_000_000, 30: 18_000_000, 15: 9_000_000 },
        '1440p': { 90: 36_000_000, 60: 24_000_000, 30: 12_000_000, 15: 6_000_000 },
        '1080p': { 90: 18_000_000, 60: 12_000_000, 30:  6_000_000, 15: 3_000_000 },
        '720p':  { 90:  6_000_000, 60:  4_000_000, 30:  2_000_000, 15: 1_000_000 },
        '480p':  { 90:  2_400_000, 60:  1_600_000, 30:    800_000, 15:   400_000 },
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

    it.each([
        ['vp9',  36_000_000],
        ['vp8',  45_000_000],
        ['h264', 54_000_000],
    ] as const)('gives %s its codec factor at 1440p90 (%d bps)', (codec, expected) => {
        expect(computeSSBitrate('1440p', 90, codec)).toBe(expected);
    });

    it('caps the fps multiplier at 3x for rates beyond 90 (e.g. a future preset)', () => {
        // 30fps is the multiplier's baseline (1x); doubling past 90 must not
        // scale past the 3x ceiling the comment documents.
        expect(computeSSBitrate('1080p', 120)).toBe(computeSSBitrate('1080p', 90));
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

    it('applies every field to every encoding when multiple are present', async () => {
        const { sender, setParameters } = makeFakeSender({ encodings: [{}, {}] } as RTCRtpSendParameters);
        await applyScreenShareSenderParams(sender, 90, 18_000_000);
        const applied = setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
        for (const enc of applied.encodings!) {
            expect(enc.maxFramerate).toBe(90);
            expect(enc.maxBitrate).toBe(18_000_000);
        }
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
        ['CB HW, NVIDIA + iGPU → iGPU encodes CB', CB, NV_INTEL, 'h264', 'cb', /HW H\.264$/],
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

    it('failed when the video encoder is still at 0 frames after the timeout (the dead-HW-encoder case) — audio frames do not count', async () => {
        const stats = vi.fn(async () => report(0));
        expect(await watchH264HighStart(stats, { sleep, timeoutMs: 3000, intervalMs: 1000 })).toBe('failed');
        expect(stats).toHaveBeenCalledTimes(4); // t = 0, 1, 2, 3 s
    });

    it('gone when the sender stops answering (share ended) — never a false "failed"', async () => {
        const stats = vi.fn(async () => { throw new Error('closed'); });
        expect(await watchH264HighStart(stats, { sleep })).toBe('gone');
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

describe('buildScreenSharePublishOptions', () => {
    // These exact objects are what the measurement harness published as "new"
    // (see the branch commit message) — keep them in step.
    it('1440p @ 90 fps, H.264: single layer, 90 fps encoding, H.264 ceiling, maintain-framerate', () => {
        expect(buildScreenSharePublishOptions('1440p', 90, 'h264')).toEqual({
            simulcast: false,
            videoCodec: 'h264',
            backupCodec: false,
            screenShareEncoding: { maxBitrate: 54_000_000, maxFramerate: 90, priority: 'high' },
            degradationPreference: 'maintain-framerate',
        });
    });

    it('source @ 90 fps, VP9', () => {
        expect(buildScreenSharePublishOptions('source', 90, 'vp9')).toEqual({
            simulcast: false,
            videoCodec: 'vp9',
            backupCodec: false,
            screenShareEncoding: { maxBitrate: 54_000_000, maxFramerate: 90, priority: 'high' },
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
