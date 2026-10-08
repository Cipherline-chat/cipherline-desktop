import { describe, it, expect } from 'vitest';
import {
    parseCameraQualityTier, captureResolutionFor, tierBox, nextStepDown,
    cameraLayerBitrate, cameraLadder, ladderTotalBitrate, cameraPublishPlan,
    decideCameraCodec, parseCameraCodecPref, judgeHardwareCameraStart, effectiveTier,
    CameraLayeringPolicy, initialLayering, LAYERING_UP_MS, LAYERING_DOWN_MS, LAYERING_MIN_GAP_MS,
    CAMERA_FPS,
} from './cameraQuality';

describe('tiers and capture constraints', () => {
    it.each([
        ['auto', 'auto'], ['1440p', '1440p'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'],
        ['4k', 'auto'], ['', 'auto'], [null, 'auto'], [undefined, 'auto'], ['720P', 'auto'],
    ] as const)('parseCameraQualityTier(%s) → %s', (raw, want) => {
        expect(parseCameraQualityTier(raw)).toBe(want);
    });

    it('Auto aims at 1440p30; every tier asks for 30 fps; no aspectRatio (a 4:3 camera keeps its shape)', () => {
        expect(captureResolutionFor('auto')).toEqual({ width: 2560, height: 1440, frameRate: 30 });
        expect(captureResolutionFor('1080p')).toEqual({ width: 1920, height: 1080, frameRate: 30 });
        expect(captureResolutionFor('720p')).toEqual({ width: 1280, height: 720, frameRate: 30 });
        expect(captureResolutionFor('480p')).toEqual({ width: 854, height: 480, frameRate: 30 });
        for (const t of ['auto', '1440p', '1080p', '720p', '480p'] as const) {
            expect(captureResolutionFor(t)).not.toHaveProperty('aspectRatio');
            expect(captureResolutionFor(t).frameRate).toBe(CAMERA_FPS);
        }
        expect(tierBox('auto')).toEqual(tierBox('1440p'));
    });
});

describe('effectiveTier — Auto reaches 1440p only on a hardware encoder', () => {
    it.each([
        ['auto', true, 'auto'], ['auto', false, '1080p'],
        ['1440p', false, '1440p'], ['1080p', true, '1080p'], ['720p', false, '720p'], ['480p', true, '480p'],
    ] as const)('%s with hw=%s → %s', (tier, hw, want) => {
        expect(effectiveTier(tier, hw)).toBe(want);
    });
    it('the codec decision says whether it is hardware', () => {
        expect(decideCameraCodec('auto', { h264: true, vp8: false }, [{ vendor: 'Intel' }]).hardware).toBe(true);
        expect(decideCameraCodec('auto', { h264: false, vp8: false }, null).hardware).toBeFalsy();
        expect(decideCameraCodec('h264', { h264: false, vp8: false }, null).hardware).toBe(false);
        expect(decideCameraCodec('auto', { h264: true, h264High: true, vp8: false }, [{ vendor: 'Intel' }], { hwFailed: true }).hardware).toBeFalsy();
    });
});

describe('nextStepDown — prefer a crisp 30 at a lower resolution over a slideshow', () => {
    it('keeps any mode at ≥ 24 fps', () => {
        expect(nextStepDown({ width: 2560, height: 1440, frameRate: 30 })).toBeNull();
        expect(nextStepDown({ width: 1920, height: 1080, frameRate: 24 })).toBeNull();
    });
    it('steps a slow mode down one tier below the CURRENT capture', () => {
        expect(nextStepDown({ width: 1920, height: 1080, frameRate: 5 })).toBe('720p'); // USB2 YUY2 1080p@5
        expect(nextStepDown({ width: 2560, height: 1440, frameRate: 15 })).toBe('1080p');
        expect(nextStepDown({ width: 1280, height: 720, frameRate: 10 })).toBe('480p');
    });
    it('never goes below 480p, and nothing to do for an unknown capture', () => {
        expect(nextStepDown({ width: 854, height: 480, frameRate: 10 })).toBeNull();
        expect(nextStepDown({ width: 640, height: 360, frameRate: 10 })).toBeNull();
        expect(nextStepDown({})).toBeNull();
    });
    it('does not suggest a tier above what the camera reports it can do', () => {
        // Odd camera: 1080p capture reported, but capabilities say max 600 → skip 720p.
        expect(nextStepDown({ width: 1920, height: 1080, frameRate: 5 }, { height: { max: 600 } })).toBe('480p');
    });
    it('portrait capture compares the short side', () => {
        expect(nextStepDown({ width: 1080, height: 1920, frameRate: 5 })).toBe('720p');
    });
});

describe('bitrates', () => {
    it('hits the anchors exactly (VP8, 30 fps)', () => {
        expect(cameraLayerBitrate(320, 180)).toBe(200_000);
        expect(cameraLayerBitrate(640, 360)).toBe(600_000);
        expect(cameraLayerBitrate(960, 540)).toBe(1_200_000);
        expect(cameraLayerBitrate(1280, 720)).toBe(2_000_000);
        expect(cameraLayerBitrate(1920, 1080)).toBe(3_500_000);
        expect(cameraLayerBitrate(2560, 1440)).toBe(5_500_000);
    });
    it('is monotonic in pixels, interpolates between anchors and clamps above 1440p', () => {
        const sizes: [number, number][] = [[160, 90], [320, 180], [480, 270], [640, 360], [854, 480], [960, 540], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
        const b = sizes.map(([w, h]) => cameraLayerBitrate(w, h));
        for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThanOrEqual(b[i - 1]);
        expect(cameraLayerBitrate(480, 270)).toBeGreaterThan(200_000);
        expect(cameraLayerBitrate(480, 270)).toBeLessThan(600_000);
        expect(cameraLayerBitrate(3840, 2160)).toBe(5_500_000);
    });
    it('H.264 gets 15% more than VP8 for the same picture', () => {
        expect(cameraLayerBitrate(1280, 720, 'h264')).toBe(2_300_000);
    });
});

describe('cameraLadder — built from the ACTUAL capture (never upscaled)', () => {
    it('720p camera → 180 / 360 / 720, all at 30 fps', () => {
        const l = cameraLadder(1280, 720);
        expect(l.top).toEqual({ width: 1280, height: 720, maxBitrate: 2_000_000, maxFramerate: 30 });
        expect(l.lower.map(x => `${x.width}x${x.height}@${x.maxFramerate}`)).toEqual(['320x180@30', '640x360@30']);
        expect(ladderTotalBitrate(l)).toBe(2_800_000);
    });
    it('1080p camera → 270 / 540 / 1080', () => {
        const l = cameraLadder(1920, 1080);
        expect(l.top.maxBitrate).toBe(3_500_000);
        expect(l.lower.map(x => `${x.width}x${x.height}`)).toEqual(['480x270', '960x540']);
    });
    it('1440p camera → 360 / 720 / 1440 at 0.6 / 2.0 / 5.5 Mbps', () => {
        const l = cameraLadder(2560, 1440);
        expect(l.lower.map(x => [x.width, x.height, x.maxBitrate])).toEqual([[640, 360, 600_000], [1280, 720, 2_000_000]]);
        expect(l.top.maxBitrate).toBe(5_500_000);
        expect(ladderTotalBitrate(l)).toBe(8_100_000);
    });
    it('a 4:3 camera keeps its own shape, sizes stay even', () => {
        const l = cameraLadder(1440, 1080);
        expect(l.lower.map(x => `${x.width}x${x.height}`)).toEqual(['360x270', '720x540']);
        expect(cameraLadder(854, 480).lower.map(x => `${x.width}x${x.height}`)).toEqual(['428x240']);
    });
    it('below 960 px long side: two layers (LiveKit builds q + f); below 480: one', () => {
        expect(cameraLadder(854, 480).lower).toHaveLength(1);
        expect(cameraLadder(640, 360).lower).toHaveLength(1);
        expect(cameraLadder(320, 240).lower).toHaveLength(0);
    });
});

describe('cameraPublishPlan', () => {
    it('pins degradation to balanced (LiveKit would pick maintain-resolution at ≥1080p), no backup codec', () => {
        for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]] as const) {
            const p = cameraPublishPlan(w, h, 'vp8');
            expect(p.degradationPreference).toBe('balanced');
            expect(p.backupCodec).toBe(false);
            expect(p.simulcast).toBe(true);
            expect(p.videoEncoding.maxFramerate).toBe(30);
        }
    });
    it('carries the codec and its bitrate factor', () => {
        const p = cameraPublishPlan(1280, 720, 'h264');
        expect(p.videoCodec).toBe('h264');
        expect(p.videoEncoding.maxBitrate).toBe(2_300_000);
    });
});

describe('decideCameraCodec — decision table', () => {
    const intel = [{ vendor: 'Intel' }];
    const nvidia = [{ vendor: 'NVIDIA' }];
    const nvPlusIntel = [{ vendor: 'NVIDIA' }, { vendor: 'Intel' }];
    const allHw = { h264: true, h264High: true, vp8: false };
    const highOnly = { h264: false, h264High: true, vp8: false };
    const none = { h264: false, h264High: false, vp8: false };

    it.each([
        // pref, hw, gpus, hwFailed, codec, profile
        ['auto', allHw, intel, false, 'h264', 'cb'],
        ['auto', allHw, nvidia, false, 'h264', 'high'],       // MF skips NVIDIA for CB
        ['auto', allHw, nvPlusIntel, false, 'h264', 'cb'],    // Intel's encoder takes CB
        ['auto', highOnly, nvidia, false, 'h264', 'high'],    // the owner's RTX 2080 Ti
        ['auto', highOnly, intel, false, 'h264', 'high'],     // CB not HW, High is
        ['auto', none, intel, false, 'vp8', undefined],
        ['auto', null, null, false, 'vp8', undefined],        // probe unavailable
        ['auto', allHw, intel, true, 'vp8', undefined],       // failed earlier this session
        ['vp8', allHw, intel, false, 'vp8', undefined],       // explicit wins
        ['h264', none, intel, false, 'h264', 'cb'],           // explicit H.264, software CB
        ['h264', highOnly, nvidia, false, 'h264', 'high'],    // explicit gets the HW profile
    ] as const)('%s / hw=%j / %j / failed=%s → %s %s', (pref, hw, gpus, failed, codec, profile) => {
        const d = decideCameraCodec(pref, hw, gpus, { hwFailed: failed });
        expect(d.codec).toBe(codec);
        expect(d.h264Profile).toBe(profile);
        expect(d.reason.length).toBeGreaterThan(0);
    });

    it('never picks VP9 or AV1 (VP9 is software on NVIDIA/AMD; AV1 breaks LiveKit E2EE)', () => {
        const hw = { h264: false, h264High: false, vp8: false, vp9: true, av1: true };
        expect(decideCameraCodec('auto', hw, intel).codec).toBe('vp8');
        expect(parseCameraCodecPref('vp9')).toBe('auto');
        expect(parseCameraCodecPref('av1')).toBe('auto');
    });

    it('Microsoft Basic Render Driver does not make a machine "not NVIDIA-only"', () => {
        expect(decideCameraCodec('auto', allHw, [{ vendor: 'NVIDIA' }, { vendor: 'Microsoft' }]).h264Profile).toBe('high');
    });
});

describe('judgeHardwareCameraStart', () => {
    const L = (active: boolean, framesEncoded: number, hardware: boolean | null) => ({ active, framesEncoded, hardware });
    it('ok when hardware is encoding every live layer', () => {
        expect(judgeHardwareCameraStart([L(true, 150, true), L(true, 150, true), L(true, 150, true)])).toBe('ok');
    });
    it('no-frames when any LIVE layer encoded nothing (High has no software fallback; NVENC session limit)', () => {
        expect(judgeHardwareCameraStart([L(true, 150, true), L(true, 150, true), L(true, 0, null)])).toBe('no-frames');
    });
    it('a dynacast-paused layer with 0 frames is not a failure', () => {
        expect(judgeHardwareCameraStart([L(true, 150, true), L(false, 0, null), L(false, 0, null)])).toBe('ok');
        expect(judgeHardwareCameraStart([L(false, 0, null)])).toBe('ok');
    });
    it('software when every live layer reports a software encoder', () => {
        expect(judgeHardwareCameraStart([L(true, 150, false), L(true, 150, false)])).toBe('software');
    });
    it('mixed or unknown never triggers a fallback by itself', () => {
        expect(judgeHardwareCameraStart([L(true, 150, false), L(true, 150, true)])).toBe('ok');
        expect(judgeHardwareCameraStart([L(true, 150, null), L(true, 150, null)])).toBe('ok');
    });
});

describe('1:1 calls: one camera layer, with hysteresis', () => {
    it('initial: 0 or 1 other person → single; 2+ → simulcast', () => {
        expect(initialLayering(0)).toBe('single');
        expect(initialLayering(1)).toBe('single');
        expect(initialLayering(2)).toBe('simulcast');
    });
    it('plan: single = one full layer, same top bitrate', () => {
        const single = cameraPublishPlan(1920, 1080, 'h264', { single: true });
        const multi = cameraPublishPlan(1920, 1080, 'h264');
        expect(single.simulcast).toBe(false);
        expect(single.lower).toEqual([]);
        expect(single.videoEncoding).toEqual(multi.videoEncoding);
        // the upload saving: the lower layers' share of the ladder
        const saved = multi.lower.reduce((a, l) => a + l.maxBitrate, 0) / (multi.videoEncoding.maxBitrate + multi.lower.reduce((a, l) => a + l.maxBitrate, 0));
        expect(saved).toBeGreaterThan(0.25);
        expect(saved).toBeLessThan(0.35);
    });
    it(`a third person present ≥ ${LAYERING_UP_MS} ms → simulcast`, () => {
        const p = new CameraLayeringPolicy('single', 0);
        expect(p.observe(2, 1000)).toBeNull();
        expect(p.observe(2, 1000 + LAYERING_UP_MS - 1)).toBeNull();
        expect(p.observe(2, 1000 + LAYERING_UP_MS)).toBe('simulcast');
    });
    it('no oscillation: someone joining for 2 s and leaving never switches', () => {
        const p = new CameraLayeringPolicy('single', 0);
        const seen: (string | null)[] = [];
        for (let t = 0; t < 60_000; t += 1000) seen.push(p.observe(t >= 10_000 && t < 12_000 ? 2 : 1, t));
        expect(seen.every(x => x === null)).toBe(true);
    });
    it(`back to 1:1 → single only after ${LAYERING_DOWN_MS} ms, and never within ${LAYERING_MIN_GAP_MS} ms of the last switch`, () => {
        const p = new CameraLayeringPolicy('single', 0);
        p.observe(2, 0);
        expect(p.observe(2, LAYERING_UP_MS)).toBe('simulcast');
        p.applied('simulcast', LAYERING_UP_MS);
        expect(p.observe(1, LAYERING_UP_MS + 1000)).toBeNull();
        expect(p.observe(1, LAYERING_UP_MS + 1000 + LAYERING_DOWN_MS - 1)).toBeNull();
        expect(p.observe(1, LAYERING_UP_MS + 1000 + LAYERING_DOWN_MS)).toBe('single');
        p.applied('single', LAYERING_UP_MS + 1000 + LAYERING_DOWN_MS);
        const t0 = LAYERING_UP_MS + 1000 + LAYERING_DOWN_MS;
        p.observe(3, t0 + 1);
        expect(p.observe(3, t0 + LAYERING_UP_MS + 1)).toBeNull();       // inside the min gap
        expect(p.observe(3, t0 + LAYERING_MIN_GAP_MS)).toBe('simulcast');
    });
    it('a failed switch is asked again (applied() not called)', () => {
        const p = new CameraLayeringPolicy('single', 0);
        p.observe(2, 0);
        expect(p.observe(2, LAYERING_UP_MS)).toBe('simulcast');
        expect(p.observe(2, LAYERING_UP_MS + 1000)).toBe('simulcast');
    });
    it('reset() follows a republish made elsewhere (fresh camera-on, HW fallback)', () => {
        const p = new CameraLayeringPolicy('single', 0);
        p.reset('simulcast', 5000);
        expect(p.mode).toBe('simulcast');
        expect(p.observe(2, 6000)).toBeNull();
    });
});

describe('H.265 camera codec', () => {
    it('ladder at 0.85× VP8 (≈26 % under H.264)', () => {
        expect(cameraLayerBitrate(1920, 1080, 'h265')).toBe(2_970_000); // 3.5 Mbps × 0.85, to 10 kbps
        expect(cameraLayerBitrate(1920, 1080, 'h265') / cameraLayerBitrate(1920, 1080, 'h264')).toBeCloseTo(0.74, 2);
    });
    it('the "H.265" encoder preference decides the BASE codec like Auto (H.265 itself only via negotiation)', () => {
        expect(parseCameraCodecPref('h265')).toBe('h265');
        const hw = { h264: true, h264High: true, vp8: false };
        expect(decideCameraCodec('h265', hw, [{ vendor: 'Intel' }])).toEqual(decideCameraCodec('auto', hw, [{ vendor: 'Intel' }]));
        expect(decideCameraCodec('h265', null, null).codec).toBe('vp8');
    });
});

describe('AMD (and mixed-vendor) machines get a sane camera encoder', () => {
    const AMD = [{ vendor: 'AMD' }];
    const HW_CB = { h264: true, h264High: true, vp8: false };
    it('AMD with hardware Constrained Baseline (AMF) → H.264 CB in hardware, the same route Intel takes', () => {
        const d = decideCameraCodec('auto', HW_CB, AMD);
        expect(d).toMatchObject({ codec: 'h264', h264Profile: 'cb', hardware: true });
    });
    it('AMD + a Microsoft software adapter listed alongside is still not "NVIDIA only"', () => {
        const d = decideCameraCodec('auto', HW_CB, [{ vendor: 'AMD' }, { vendor: 'Microsoft (software)' }]);
        expect(d).toMatchObject({ h264Profile: 'cb', hardware: true });
    });
    it('NVIDIA + AMD (the owner\'s box) with CB not in hardware but High is → High, with the VP8 fallback armed by cameraPublish', () => {
        const d = decideCameraCodec('auto', { h264: false, h264High: true, vp8: false }, [{ vendor: 'NVIDIA' }, { vendor: 'AMD' }]);
        expect(d).toMatchObject({ codec: 'h264', h264Profile: 'high', hardware: true });
    });
    it('NVIDIA + AMD where CB IS hardware (AMD\'s encoder) → CB, not the High-only route', () => {
        const d = decideCameraCodec('auto', HW_CB, [{ vendor: 'NVIDIA' }, { vendor: 'AMD' }]);
        expect(d).toMatchObject({ h264Profile: 'cb', hardware: true });
    });
    it('an AMD card with no usable hardware H.264 → VP8, exactly what every camera did before', () => {
        expect(decideCameraCodec('auto', { h264: false, h264High: false, vp8: false }, AMD)).toMatchObject({ codec: 'vp8' });
    });
    it('an AMD machine whose hardware H.264 already failed this session → VP8 for the rest of it', () => {
        expect(decideCameraCodec('auto', HW_CB, AMD, { hwFailed: true })).toMatchObject({ codec: 'vp8' });
    });
    it('a unknown / failed GPU report never lands on the NVIDIA-only High path', () => {
        for (const gpus of [null, undefined, [], [{ vendor: 'Unknown' }]]) {
            expect(decideCameraCodec('auto', { h264: true, h264High: true, vp8: false }, gpus)).toMatchObject({ h264Profile: 'cb' });
        }
    });
    it('and the post-start check sends any vendor\'s dead or software H.264 camera to VP8', () => {
        expect(judgeHardwareCameraStart([{ active: true, framesEncoded: 0, hardware: null }])).toBe('no-frames');
        expect(judgeHardwareCameraStart([{ active: true, framesEncoded: 90, hardware: false }])).toBe('software');
    });
});
