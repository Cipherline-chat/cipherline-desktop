import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ShareLowLayerGate, gateQualities, readShareEncoderTick, installShareLowLayerControl,
    SHARE_LOW_MIN_VIEWERS, SHARE_LOW_TRIP_TICKS_GAME, SHARE_LOW_TRIP_TICKS, SHARE_LOW_ENCODE_TRIP_TICKS,
    type ShareLowTick, type QualityLike,
} from './shareLowLayer';

const tick = (o: Partial<ShareLowTick> = {}): ShareLowTick => ({
    settingOn: true, hardware: true, viewers: 5, cpuLimited: false, topFps: 90, topEncodeMs: 4,
    targetFps: 90, gameRunning: false, lowActive: false, ...o,
});

describe('ShareLowLayerGate — when the lighter copy may run', () => {
    it('setting off (the default) → never', () => {
        expect(new ShareLowLayerGate().observe(tick({ settingOn: false }))).toMatchObject({ allow: false, reason: 'off in Settings' });
    });
    it('software encoder → never; unknown encoder → not yet', () => {
        expect(new ShareLowLayerGate().observe(tick({ hardware: false }))).toMatchObject({ allow: false, reason: 'software encoder' });
        expect(new ShareLowLayerGate().observe(tick({ hardware: null }))).toMatchObject({ allow: false, reason: 'encoder not verified yet' });
    });
    it(`fewer than ${SHARE_LOW_MIN_VIEWERS} viewers → off (not latched — comes on when people join)`, () => {
        const g = new ShareLowLayerGate();
        expect(g.observe(tick({ viewers: 2 }))).toMatchObject({ allow: false, latched: false });
        expect(g.observe(tick({ viewers: 3 }))).toMatchObject({ allow: true });
        expect(g.observe(tick({ viewers: 1, lowActive: true }))).toMatchObject({ allow: false, latched: false });
    });
    it('hardware + ≥ 3 viewers + no cost → on', () => {
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

    it(`no game: needs ${SHARE_LOW_TRIP_TICKS} slow ticks; one good tick resets the count`, () => {
        const g = new ShareLowLayerGate();
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS - 1; i++) g.observe(tick({ lowActive: true, topFps: 70 }));
        expect(g.observe(tick({ lowActive: true, topFps: 90 })).allow).toBe(true);
        for (let i = 0; i < SHARE_LOW_TRIP_TICKS - 1; i++) expect(g.observe(tick({ lowActive: true, topFps: 70 })).allow).toBe(true);
        expect(g.observe(tick({ lowActive: true, topFps: 70 })).latched).toBe(true);
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
        expect(r).toMatchObject({ hardware: true, topFps: 88, lowActive: false, topFrames: 900, topEncodeS: 3.6, cpuLimited: false });
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
        expect(seen).toEqual(['false:0 viewer(s) — needs 3']);
    });
});
