import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ShareLowLayerGate, gateQualities, readShareEncoderTick, installShareLowLayerControl,
    SHARE_LOW_MIN_VIEWERS, SHARE_LOW_MIN_VIEWERS_HEAVY, shareIsHeavy, SHARE_LOW_TRIP_TICKS_GAME, SHARE_LOW_TRIP_TICKS, SHARE_LOW_ENCODE_TRIP_TICKS, SHARE_LOW_RAMP_TICKS,
    type ShareLowTick, type QualityLike,
} from './shareLowLayer';

const tick = (o: Partial<ShareLowTick> = {}): ShareLowTick => ({
    settingOn: true, hardware: true, viewers: 5, cpuLimited: false, topFps: 90, topEncodeMs: 4,
    targetFps: 90, gameRunning: false, lowActive: false, ...o,
});

describe('ShareLowLayerGate — when the lighter copy may run', () => {
    it('setting off → never', () => {
        expect(new ShareLowLayerGate().observe(tick({ settingOn: false }))).toMatchObject({ allow: false, reason: 'off in Settings' });
    });
    it('software encoder → never; unknown encoder → not yet', () => {
        expect(new ShareLowLayerGate().observe(tick({ hardware: false }))).toMatchObject({ allow: false, reason: 'software encoder' });
        expect(new ShareLowLayerGate().observe(tick({ hardware: null }))).toMatchObject({ allow: false, reason: 'encoder not verified yet' });
    });
    // Was ≥ 3 for every share. Now 2 for an ordinary share and 1 for a heavy
    // one: on a heavy share the copy is every viewer's congestion fallback
    // (2026-10-23 freeze reports).
    it(`ordinary share (≤ 1080p, < 60 fps): fewer than ${SHARE_LOW_MIN_VIEWERS} viewers → off (not latched — comes on when people join)`, () => {
        const g = new ShareLowLayerGate();
        const ordinary = { targetFps: 30, topFps: 30, topShort: 1080 };
        expect(SHARE_LOW_MIN_VIEWERS).toBe(2);
        expect(g.observe(tick({ ...ordinary, viewers: 1 }))).toMatchObject({ allow: false, latched: false, reason: '1 viewer(s) — needs 2' });
        expect(g.observe(tick({ ...ordinary, viewers: 2 }))).toMatchObject({ allow: true });
        expect(g.observe(tick({ ...ordinary, viewers: 0, lowActive: true }))).toMatchObject({ allow: false, latched: false });
    });
    it('heavy share (≥ 60 fps, or a ≥ 1440p full layer): on from the first viewer, off with none', () => {
        expect(SHARE_LOW_MIN_VIEWERS_HEAVY).toBe(1);
        for (const heavy of [{ targetFps: 60, topFps: 60, topShort: 1080 }, { targetFps: 90, topFps: 90, topShort: 1440 }, { targetFps: 30, topFps: 30, topShort: 1440 }]) {
            const g = new ShareLowLayerGate();
            expect(g.observe(tick({ ...heavy, viewers: 0 }))).toMatchObject({ allow: false, latched: false, reason: '0 viewer(s) — needs 1' });
            expect(g.observe(tick({ ...heavy, viewers: 1 }))).toMatchObject({ allow: true });
        }
    });
    it('shareIsHeavy boundaries', () => {
        expect(shareIsHeavy(59, 1080)).toBe(false);
        expect(shareIsHeavy(60, 1080)).toBe(true);   // the owner's 1080p60 retest
        expect(shareIsHeavy(30, 1439)).toBe(false);
        expect(shareIsHeavy(30, 1440)).toBe(true);
        expect(shareIsHeavy(30, undefined)).toBe(false); // size unknown yet → by fps only
    });
    it('hardware + enough viewers + no cost → on', () => {
        expect(new ShareLowLayerGate().observe(tick())).toEqual({ allow: true, reason: 'on', latched: false });
    });

    it('CPU limitation → off, latched for the rest of the share', () => {
        const g = new ShareLowLayerGate();
        expect(g.observe(tick({ lowActive: true }))).toMatchObject({ allow: true });
        expect(g.observe(tick({ lowActive: true, cpuLimited: true }))).toMatchObject({ allow: false, latched: true, reason: 'encoder CPU-limited' });
        for (let i = 0; i < 20; i++) expect(g.observe(tick({ lowActive: false })).allow).toBe(false);
    });

    it(`gaming + full layer below 95 % of target for ${SHARE_LOW_TRIP_TICKS_GAME} ticks → latched off`, () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS_GAME - 1; i++) expect(g.observe(tick({ lowActive: true, gameRunning: true, topFps: 80 })).allow).toBe(true);
        expect(g.observe(tick({ lowActive: true, gameRunning: true, topFps: 80 }))).toMatchObject({ allow: false, latched: true });
        expect(g.observe(tick()).allow).toBe(false);
    });

    it('a game that renders below the share target does NOT latch the copy off: the bar is what the full layer delivered with the copy off', () => {
        const g = new ShareLowLayerGate();
        // Copy off: the game holds the share at ~70 fps of a 90 target.
        for (let i = 0; i < 10; i++) g.observe(tick({ lowActive: false, gameRunning: true, topFps: 70 }));
        // Copy on, same 70 fps → not the copy's fault, stays on.
        for (let i = 0; i < 20; i++) expect(g.observe(tick({ lowActive: true, gameRunning: true, topFps: 70 })).allow).toBe(true);
        // The copy then costs real frames (70 → 55): latched.
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS_GAME - 1; i++) g.observe(tick({ lowActive: true, gameRunning: true, topFps: 55 }));
        expect(g.observe(tick({ lowActive: true, gameRunning: true, topFps: 55 }))).toMatchObject({ allow: false, latched: true });
    });

    it(`no game: needs ${SHARE_LOW_TRIP_TICKS} slow ticks; one good tick resets the count`, () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS - 1; i++) g.observe(tick({ lowActive: true, topFps: 70 }));
        expect(g.observe(tick({ lowActive: true, topFps: 90 })).allow).toBe(true);
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS - 1; i++) expect(g.observe(tick({ lowActive: true, topFps: 70 })).allow).toBe(true);
        expect(g.observe(tick({ lowActive: true, topFps: 70 })).latched).toBe(true);
    });

    // Measured against a real SFU (harness/share-e2e): a share's first ~5 s run
    // below target fps while the sender's bandwidth estimate ramps up
    // (qualityLimitationReason 'bandwidth', 4 ms encodes) — that alone used
    // to latch the copy off for the whole share.
    it(`a full layer held back by BANDWIDTH in the copy's first ${SHARE_LOW_RAMP_TICKS} ticks (estimate ramping up) is not blamed on the copy`, () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_RAMP_TICKS; i++) expect(g.observe(tick({ lowActive: true, topFps: 20, topLimit: 'bandwidth' }))).toMatchObject({ allow: true, latched: false });
        expect(g.observe(tick({ lowActive: true, topLimit: 'none' })).allow).toBe(true);
    });
    it('after the ramp, a bandwidth-limited slow full layer counts as before', () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_RAMP_TICKS; i++) g.observe(tick({ lowActive: true }));
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS - 1; i++) expect(g.observe(tick({ lowActive: true, topFps: 20, topLimit: 'bandwidth' })).allow).toBe(true);
        expect(g.observe(tick({ lowActive: true, topFps: 20, topLimit: 'bandwidth' })).latched).toBe(true);
    });
    it('the ramp restarts when the copy turns on again', () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_RAMP_TICKS + 5; i++) g.observe(tick({ lowActive: true }));
        g.observe(tick({ lowActive: false }));
        for (let i = 0; i < SHARE_LOW_RAMP_TICKS; i++) expect(g.observe(tick({ lowActive: true, topFps: 20, topLimit: 'bandwidth' })).allow).toBe(true);
    });
    it('bandwidth-limited ticks neither count nor reset the slow count', () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS - 1; i++) g.observe(tick({ lowActive: true, topFps: 70, topLimit: 'none' }));
        expect(g.observe(tick({ lowActive: true, topFps: 40, topLimit: 'bandwidth' })).allow).toBe(true);
        expect(g.observe(tick({ lowActive: true, topFps: 70, topLimit: 'other' }))).toMatchObject({ allow: false, latched: true, reason: 'full layer below target fps' });
    });

    it('a slow full layer while the copy is OFF is not blamed on the copy', () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < 20; i++) g.observe(tick({ lowActive: false, topFps: 50, viewers: 1 }));
        expect(g.observe(tick()).allow).toBe(true);
    });

    it(`full-layer encode time ≥ 1.3× its copy-off baseline for ${SHARE_LOW_ENCODE_TRIP_TICKS} ticks → latched off`, () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < 5; i++) g.observe(tick({ lowActive: false, topEncodeMs: 4 }));
        expect(g.observe(tick({ lowActive: true, topEncodeMs: 5 })).allow).toBe(true);      // +25 %: fine
        for (let i = 0; i < SHARE_LOW_ENCODE_TRIP_TICKS - 1; i++) expect(g.observe(tick({ lowActive: true, topEncodeMs: 5.4 })).allow).toBe(true);
        expect(g.observe(tick({ lowActive: true, topEncodeMs: 5.4 }))).toMatchObject({ allow: false, latched: true, reason: 'full layer encode time rose' });
    });
});

describe('gateQualities', () => {
    const q = (quality: number, enabled: boolean): QualityLike => ({ quality, enabled });
    it('forces LOW off unless allowed; never touches the others; never turns anything ON', () => {
        expect(gateQualities([q(0, true), q(1, true), q(2, true)], false)).toEqual([q(0, false), q(1, true), q(2, true)]);
        expect(gateQualities([q(0, true), q(1, false)], true)).toEqual([q(0, true), q(1, false)]);
        expect(gateQualities([q(0, false), q(1, true)], true)).toEqual([q(0, false), q(1, true)]);
    });
});

describe('readShareEncoderTick', () => {
    const rep = (layers: Record<string, unknown>[]) => new Map(layers.map((l, i) => [String(i), { type: 'outbound-rtp', kind: 'video', ...l }]));
    it('hardware only when every ACTIVE layer says so; top = largest', () => {
        const r = readShareEncoderTick(rep([
            { rid: 'q', active: false, frameWidth: 1280, frameHeight: 720, encoderImplementation: 'libvpx' },
            { rid: 'h', active: true, frameWidth: 2560, frameHeight: 1440, framesPerSecond: 88, encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', framesEncoded: 900, totalEncodeTime: 3.6 },
        ]));
        expect(r).toMatchObject({ hardware: true, topFps: 88, lowActive: false, topFrames: 900, topEncodeS: 3.6, cpuLimited: false, topLimit: undefined });
        expect(readShareEncoderTick(rep([
            { rid: 'q', active: true, frameWidth: 640, frameHeight: 360, qualityLimitationReason: 'bandwidth' },
            { rid: 'h', active: true, frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'bandwidth' },
        ])).topLimit).toBe('bandwidth');
    });
    it('software on any active layer → not hardware; cpu on any layer → cpuLimited', () => {
        const r = readShareEncoderTick(rep([
            { rid: 'q', active: true, frameWidth: 1280, frameHeight: 720, encoderImplementation: 'OpenH264', qualityLimitationReason: 'cpu' },
            { rid: 'h', active: true, frameWidth: 2560, frameHeight: 1440, encoderImplementation: 'ExternalEncoder' },
        ]));
        expect(r).toMatchObject({ hardware: false, cpuLimited: true, lowActive: true });
    });
});

describe('installShareLowLayerControl', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function fakeTrack(stats: () => Record<string, unknown>[]) {
        const calls: QualityLike[][] = [];
        const track = {
            sender: {
                getParameters: () => ({ encodings: [{ rid: 'q' }, { rid: 'h' }] }),
                getStats: async () => new Map(stats().map((s, i) => [String(i), { type: 'outbound-rtp', kind: 'video', ...s }])),
            } as unknown as RTCRtpSender,
            setPublishingLayers: vi.fn(async (_svc: boolean, q: QualityLike[]) => { calls.push(q); }),
        };
        return { track, calls, orig: track.setPublishingLayers };
    }
    const hw = (lowActive: boolean) => [
        { rid: 'q', active: lowActive, frameWidth: 1280, frameHeight: 720, encoderImplementation: 'ExternalEncoder' },
        { rid: 'h', active: true, frameWidth: 2560, frameHeight: 1440, framesPerSecond: 90, encoderImplementation: 'ExternalEncoder', framesEncoded: 0, totalEncodeTime: 0 },
    ];

    it('starts with the copy OFF, filters LiveKit dynacast updates, turns it on when the gate allows, restores on dispose', async () => {
        let viewers = 1;
        const { track, calls, orig } = fakeTrack(() => hw(false));
        const dispose = installShareLowLayerControl(track, { settingOn: () => true, viewers: () => viewers, gameRunning: () => false, targetFps: 90, log: () => {} });
        expect(calls[0].find(q => q.quality === 0)?.enabled).toBe(false);          // starts OFF
        await track.setPublishingLayers(false, [{ quality: 0, enabled: true }, { quality: 1, enabled: true }]);
        expect(calls[1]).toEqual([{ quality: 0, enabled: false }, { quality: 1, enabled: true }]); // dynacast cannot turn it on
        viewers = 4;
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls[calls.length - 1].find(q => q.quality === 0)?.enabled).toBe(true);
        dispose();
        expect(track.setPublishingLayers).toBe(orig);
    });

    it('a single-layer share is left alone', () => {
        const track = {
            sender: { getParameters: () => ({ encodings: [{}] }) } as unknown as RTCRtpSender,
            setPublishingLayers: vi.fn(async () => {}),
        };
        const orig = track.setPublishingLayers;
        installShareLowLayerControl(track, { settingOn: () => true, viewers: () => 9, gameRunning: () => false, targetFps: 60 })();
        expect(track.setPublishingLayers).toBe(orig);
        expect(orig).not.toHaveBeenCalled();
    });

    it('reports decisions through onChange (for the call log)', async () => {
        const seen: string[] = [];
        const { track } = fakeTrack(() => hw(false));
        installShareLowLayerControl(track, { settingOn: () => true, viewers: () => 0, gameRunning: () => false, targetFps: 90, log: () => {}, onChange: (a, r) => seen.push(`${a}:${r}`) });
        await vi.advanceTimersByTimeAsync(1000);
        expect(seen).toEqual(['false:0 viewer(s) — needs 1']); // 90 fps = heavy
    });
});

describe('installShareLowLayerControl with native deps (the Linux hardware share)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    // The sender stats describe the tiny dummy track: SOFTWARE-looking encoder, 240p. Only the native facts may decide hardware / size.
    const dummyStats = (lowActive: boolean) => [
        { rid: 'q', active: lowActive, frameWidth: 240, frameHeight: 135, encoderImplementation: 'OpenH264' },
        { rid: 'h', active: true, frameWidth: 480, frameHeight: 270, framesPerSecond: 60, encoderImplementation: 'OpenH264', framesEncoded: 0, totalEncodeTime: 0 },
    ];
    function setup(facts: () => { hardware: boolean; topShort?: number; topEncodeMs?: number; blocked?: string | null }, viewers: () => number, targetFps = 60) {
        const calls: QualityLike[][] = []; const lows: boolean[] = [];
        const track = {
            sender: { getParameters: () => ({ encodings: [{ rid: 'q' }, { rid: 'h' }] }), getStats: async () => new Map(dummyStats(lows[lows.length - 1] === true).map((s, i) => [String(i), { type: 'outbound-rtp', kind: 'video', ...s }])) } as unknown as RTCRtpSender,
            setPublishingLayers: vi.fn(async (_s: boolean, q: QualityLike[]) => { calls.push(q); }),
        };
        const dispose = installShareLowLayerControl(track, { settingOn: () => true, viewers, gameRunning: () => false, targetFps, log: () => {}, native: { facts, setLow: (on) => { lows.push(on); } } });
        return { calls, lows, dispose };
    }
    it('uses the native facts: a "software" dummy encoder does not block the copy; same viewer rule (1 on a 60 fps share)', async () => {
        let viewers = 0;
        const { calls, lows, dispose } = setup(() => ({ hardware: true, topShort: 1080 }), () => viewers);
        await vi.advanceTimersByTimeAsync(1000);
        expect(lows).toEqual([]);                                                    // no viewers: the helper's second session is never opened
        viewers = 1;
        await vi.advanceTimersByTimeAsync(1000);
        expect(lows).toEqual([true]);
        expect(calls[calls.length - 1].find((q) => q.quality === 0)?.enabled).toBe(true);
        dispose();
    });
    it('an ordinary share (30 fps, 1080p) needs 2 viewers, exactly like the Chromium share', async () => {
        let viewers = 1;
        const { lows, dispose } = setup(() => ({ hardware: true, topShort: 1080 }), () => viewers, 30);
        await vi.advanceTimersByTimeAsync(1000);
        expect(lows).toEqual([]);
        viewers = 2; await vi.advanceTimersByTimeAsync(1000);
        expect(lows).toEqual([true]);
        dispose();
    });
    it('turning off closes the helper session AFTER the layer is switched off', async () => {
        let viewers = 1; const order: string[] = [];
        const track = {
            sender: { getParameters: () => ({ encodings: [{ rid: 'q' }, { rid: 'h' }] }), getStats: async () => new Map(dummyStats(true).map((s, i) => [String(i), { type: 'outbound-rtp', kind: 'video', ...s }])) } as unknown as RTCRtpSender,
            setPublishingLayers: vi.fn(async (_s: boolean, q: QualityLike[]) => { order.push(`layer:${q.find((x) => x.quality === 0)?.enabled}`); }),
        };
        const d = installShareLowLayerControl(track, { settingOn: () => true, viewers: () => viewers, gameRunning: () => false, targetFps: 60, log: () => {}, native: { facts: () => ({ hardware: true, topShort: 1080 }), setLow: (on) => { order.push(`helper:${on}`); } } });
        await vi.advanceTimersByTimeAsync(1000);
        viewers = 0; await vi.advanceTimersByTimeAsync(1000);
        expect(order.slice(-4)).toEqual(['helper:true', 'layer:true', 'layer:false', 'helper:false']);
        d();
    });
    it('NEGATIVE: a helper that could not run the copy (blocked) keeps it off for the rest of the share, however many viewers', async () => {
        let blocked: string | null = null; const seen: string[] = [];
        const { lows, dispose } = setup(() => ({ hardware: true, topShort: 1440, blocked }), () => 9);
        blocked = 'lighter copy failed (low_session_limit)';
        await vi.advanceTimersByTimeAsync(3000);
        expect(lows).toEqual([]);
        void seen; dispose();
    });
    it('NEGATIVE CONTROL: without native deps the same dummy-looking stats DO block it (software encoder) - the facts are what changes it', async () => {
        const calls: QualityLike[][] = [];
        const track = {
            sender: { getParameters: () => ({ encodings: [{ rid: 'q' }, { rid: 'h' }] }), getStats: async () => new Map(dummyStats(false).map((s, i) => [String(i), { type: 'outbound-rtp', kind: 'video', ...s }])) } as unknown as RTCRtpSender,
            setPublishingLayers: vi.fn(async (_s: boolean, q: QualityLike[]) => { calls.push(q); }),
        };
        const d = installShareLowLayerControl(track, { settingOn: () => true, viewers: () => 9, gameRunning: () => false, targetFps: 60, log: () => {} });
        await vi.advanceTimersByTimeAsync(2000);
        expect(calls.every((q) => q.find((x) => x.quality === 0)?.enabled === false)).toBe(true);
        d();
    });
});
