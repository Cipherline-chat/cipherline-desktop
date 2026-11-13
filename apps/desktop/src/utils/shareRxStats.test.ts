import { describe, it, expect } from 'vitest';
import {
    readShareRxSnapshot, shareRxRates, rxCountersReset, buildShareRxDetail, buildShareRxStartDetail, codecFromMime,
    readPlaybackSnapshot, dispFpsBetween, rxDecoderKey, dispFpsPlausible, pickShareVideoElements, isPresenting, type ShareRxSnapshot, type VideoElLike,
} from './shareRxStats';

const report = (entries: Record<string, unknown>[]) => ({ forEach: (cb: (s: Record<string, unknown>) => void) => entries.forEach(cb) });
const inbound = (o: Record<string, unknown> = {}) => ({
    id: 'RTCInboundRTPVideoStream_1', type: 'inbound-rtp', kind: 'video', timestamp: 10_000,
    framesReceived: 900, framesDecoded: 890, framesDropped: 4, jitterBufferDelay: 18, jitterBufferEmittedCount: 890,
    frameWidth: 2560, frameHeight: 1440, decoderImplementation: 'ExternalDecoder', powerEfficientDecoder: true, codecId: 'C1', ...o,
});
const snap = (o: Partial<ShareRxSnapshot> = {}): ShareRxSnapshot => ({
    at: 10_000, framesReceived: 0, framesDecoded: 0, framesDropped: 0, jbDelay: 0, jbEmitted: 0, ...o,
});

describe('readShareRxSnapshot', () => {
    it('reads the video inbound-rtp, its codec and decoder', () => {
        const s = readShareRxSnapshot(report([inbound(), { id: 'C1', type: 'codec', mimeType: 'video/H264' }]), 1)!;
        expect(s).toMatchObject({ at: 10_000, framesReceived: 900, framesDecoded: 890, framesDropped: 4, width: 2560, height: 1440, decoder: 'ExternalDecoder', hw: true, codec: 'h264' });
        expect(s.jbDelay).toBe(18);
        expect(s.jbEmitted).toBe(890);
    });
    it('uses the caller clock when the report has no timestamp; null without a video inbound', () => {
        expect(readShareRxSnapshot(report([inbound({ timestamp: undefined })]), 777)!.at).toBe(777);
        expect(readShareRxSnapshot(report([{ type: 'inbound-rtp', kind: 'audio' }]), 1)).toBeNull();
        expect(readShareRxSnapshot(null, 1)).toBeNull();
    });
    it('bounds the decoder name to 64 chars and ignores an unknown codec', () => {
        const s = readShareRxSnapshot(report([inbound({ decoderImplementation: 'D'.repeat(200) }), { id: 'C1', type: 'codec', mimeType: 'video/weird' }]), 1)!;
        expect(s.decoder).toHaveLength(64);
        expect(s.codec).toBeUndefined();
    });
    it('codecFromMime maps the codecs we ship and nothing else', () => {
        expect(codecFromMime('video/H265')).toBe('h265');
        expect(codecFromMime('video/VP9')).toBe('vp9');
        expect(codecFromMime('video/AV1')).toBe('av1');
        expect(codecFromMime('audio/opus')).toBeUndefined();
        expect(codecFromMime(42)).toBeUndefined();
    });
});

describe('shareRxRates', () => {
    const prev = snap({ at: 0, framesReceived: 1000, framesDecoded: 990, framesDropped: 5, jbDelay: 10, jbEmitted: 990 });
    it('computes per-second deltas and the mean jitter-buffer delay of the window', () => {
        const cur = snap({ at: 10_000, framesReceived: 1900, framesDecoded: 1880, framesDropped: 15, jbDelay: 10 + 18, jbEmitted: 990 + 890 });
        expect(shareRxRates(prev, cur)).toEqual({ rx_fps: 90, dec_fps: 89, drop_fps: 1, jb_ms: 20.2 });
    });
    it('no jitter-buffer figure when nothing was emitted', () => {
        const cur = snap({ at: 10_000, framesReceived: 1000, framesDecoded: 990, framesDropped: 5, jbDelay: 10, jbEmitted: 990 });
        expect(shareRxRates(prev, cur)).toEqual({ rx_fps: 0, dec_fps: 0, drop_fps: 0 });
    });
    it('a counter reset (new stream) yields null, never a negative or zero rate', () => {
        const reset = snap({ at: 10_000, framesReceived: 30, framesDecoded: 28, framesDropped: 0, jbDelay: 0.5, jbEmitted: 28 });
        expect(rxCountersReset(prev, reset)).toBe(true);
        expect(shareRxRates(prev, reset)).toBeNull();
        // ...and each counter on its own is enough
        for (const k of ['framesReceived', 'framesDecoded', 'framesDropped', 'jbEmitted', 'jbDelay'] as const) {
            expect(shareRxRates(prev, { ...snap({ at: 10_000, framesReceived: 2000, framesDecoded: 2000, framesDropped: 50, jbDelay: 99, jbEmitted: 2000 }), [k]: 0 })).toBeNull();
        }
    });
    it('too short or backwards windows are unusable', () => {
        expect(shareRxRates(prev, { ...prev, at: 200 })).toBeNull();
        expect(shareRxRates(prev, { ...prev, at: -5 })).toBeNull();
    });
});

describe('dispFpsBetween (the tile presented frames)', () => {
    const q = (o: Partial<{ at: number; total: number; dropped: number }>) => ({ at: 0, total: 0, dropped: 0, ...o });
    it('presented = total - dropped, per second', () => {
        expect(dispFpsBetween(q({ at: 0, total: 100, dropped: 2 }), q({ at: 10_000, total: 790, dropped: 12 }))).toBe(68);
    });
    it('undefined for a missing side, a reset, an impossible drop count or a short window', () => {
        expect(dispFpsBetween(null, q({ at: 10_000 }))).toBeUndefined();
        expect(dispFpsBetween(q({ at: 0, total: 500 }), q({ at: 10_000, total: 20 }))).toBeUndefined();
        expect(dispFpsBetween(q({ at: 0, total: 0, dropped: 9 }), q({ at: 10_000, total: 10, dropped: 0 }))).toBeUndefined();
        expect(dispFpsBetween(q({ at: 0, total: 0 }), q({ at: 10_000, total: 5, dropped: 50 }))).toBeUndefined();
        expect(dispFpsBetween(q({ at: 0 }), q({ at: 100, total: 5 }))).toBeUndefined();
    });
    it('readPlaybackSnapshot tolerates an element that cannot say', () => {
        expect(readPlaybackSnapshot(null, 1)).toBeNull();
        expect(readPlaybackSnapshot({}, 1)).toBeNull();
        expect(readPlaybackSnapshot({ getVideoPlaybackQuality: () => { throw new Error('x'); } }, 1)).toBeNull();
        expect(readPlaybackSnapshot({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 9, droppedVideoFrames: 1 }) }, 5)).toEqual({ at: 5, total: 9, dropped: 1 });
    });
});

describe('event details', () => {
    const prev = snap({ at: 0, framesReceived: 0, framesDecoded: 0, jbDelay: 0, jbEmitted: 0 });
    const cur = snap({ at: 10_000, framesReceived: 700, framesDecoded: 690, framesDropped: 3, jbDelay: 12, jbEmitted: 690, width: 2560, height: 1440, decoder: 'ExternalDecoder', hw: true, codec: 'h264' });

    it('share_rx_fps carries every requested field in <= 11 keys (the log keeps a 12th for repeat)', () => {
        const d = buildShareRxDetail(prev, cur, { shareRef: 'a1b2c3d4', track: 'remote-video-2', dispFps: 66.5, tile: 540.4, layer: 2, focus: true })!;
        expect(d).toEqual({
            share_ref: 'a1b2c3d4', track: 'remote-video-2', rx_fps: 70, dec_fps: 69, drop_fps: 0.3, disp_fps: 66.5,
            jb_ms: 17.4, res: '2560x1440', layer: 2, focus: true, tile: 540,
        });
        expect(Object.keys(d).length).toBeLessThanOrEqual(11);
    });
    it('omits what is unknown, and is null on the first sample or a reset', () => {
        const d = buildShareRxDetail(prev, { ...cur, width: undefined, height: undefined }, { focus: false })!;
        expect(Object.keys(d).sort()).toEqual(['dec_fps', 'drop_fps', 'focus', 'jb_ms', 'rx_fps']);
        expect(buildShareRxDetail(null, cur, { focus: true })).toBeNull();
        expect(buildShareRxDetail(cur, prev, { focus: true })).toBeNull();
    });
    it('share_rx_start names the codec, decoder and hardware flag', () => {
        expect(buildShareRxStartDetail(cur, { shareRef: 'a1b2c3d4', track: 'remote-video-2', layer: 1 })).toEqual({
            share_ref: 'a1b2c3d4', track: 'remote-video-2', codec: 'h264', decoder: 'ExternalDecoder', hw: true, res: '2560x1440', layer: 1,
        });
    });
    it('rxDecoderKey changes with the decoder, is null before anything is known', () => {
        expect(rxDecoderKey(snap())).toBeNull();
        expect(rxDecoderKey(cur)).not.toBe(rxDecoderKey({ ...cur, decoder: 'libvpx', hw: false }));
    });
});

describe('disp_fps: presented 0 while the decoder works is unknown, not 0 (report 7d1f7abe)', () => {
    const prev = snap({ at: 0 });
    const cur = (dec: number) => snap({ at: 10_000, framesReceived: dec * 10, framesDecoded: dec * 10, jbDelay: 1, jbEmitted: dec * 10, width: 3024, height: 1964 });

    it('dispFpsPlausible: 0 is implausible at >= 5 decoded fps, fine for a slow decode; any other number stays', () => {
        expect(dispFpsPlausible(0, 90)).toBe(false);
        expect(dispFpsPlausible(0, 5)).toBe(false);
        expect(dispFpsPlausible(0, 4.9)).toBe(true);
        expect(dispFpsPlausible(56.3, 90)).toBe(true);
        expect(dispFpsPlausible(undefined, 90)).toBe(false);
        expect(dispFpsPlausible(Number.NaN, 90)).toBe(false);
    });
    it('the share_rx_fps / share_rx_snap detail leaves disp_fps OUT when it read 0 against dec_fps 90', () => {
        const d = buildShareRxDetail(prev, cur(90), { dispFps: 0, focus: true, tile: 453, layer: 1, track: 'remote-share-2', shareRef: 'fd63281e' })!;
        expect('disp_fps' in d).toBe(false);
        expect(d.dec_fps).toBe(90);
    });
    it('a measured 60 fps and a real 0 against a near-idle decode are kept', () => {
        expect(buildShareRxDetail(prev, cur(90), { dispFps: 60, focus: true })!.disp_fps).toBe(60);
        expect(buildShareRxDetail(prev, cur(1), { dispFps: 0, focus: true })!.disp_fps).toBe(0);
    });
});

describe('which <video> are the playback counters read from', () => {
    const el = (o: Partial<VideoElLike> & { w?: number; h?: number } = {}): VideoElLike => ({
        clientWidth: o.w ?? 800, clientHeight: o.h ?? 450, isConnected: true, paused: false,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 450 }), ...o,
    });
    const vp = { width: 1920, height: 1080 };

    it('largest decides the tile size; presenting decides the counters', () => {
        const big = el({ w: 1200, h: 700, checkVisibility: () => false }); // hidden / crossfaded copy
        const small = el({ w: 400, h: 225 });
        const { largest, presenting } = pickShareVideoElements([big, small], vp);
        expect(largest).toBe(big);
        expect(presenting).toBe(small);
    });
    it('none presenting -> presenting is null (presented frames are UNKNOWN, not the hidden copy\'s zeros)', () => {
        const hidden = el({ checkVisibility: () => false });
        const offscreen = el({ getBoundingClientRect: () => ({ left: 5000, top: 0, right: 5800, bottom: 450 }) });
        const paused = el({ paused: true });
        const detached = el({ isConnected: false });
        const empty = el({ w: 0, h: 0 });
        const r = pickShareVideoElements([hidden, offscreen, paused, detached, empty], vp);
        expect(r.presenting).toBeNull();
        expect(r.largest).not.toBeNull();
    });
    it('the largest presenting one wins; an element that throws is not presenting', () => {
        const a = el({ w: 300, h: 200 });
        const b = el({ w: 900, h: 500 });
        const bad = el({ w: 2000, h: 1000, getBoundingClientRect: () => { throw new Error('detached'); } });
        expect(pickShareVideoElements([a, b, bad], vp).presenting).toBe(b);
        expect(isPresenting(bad, vp)).toBe(false);
    });
    it('no elements at all', () => {
        expect(pickShareVideoElements([], vp)).toEqual({ largest: null, presenting: null });
    });
});
