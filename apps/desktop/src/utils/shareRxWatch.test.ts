import { describe, it, expect } from 'vitest';
import { ShareRxWatch, RX_FPS_WINDOW_MS, HZ_MAX_ATTEMPTS, HZ_RETRY_MS, type ShareRxObserveContext } from './shareRxWatch';

const report = (o: Record<string, unknown> = {}) => ({
    forEach: (cb: (s: Record<string, unknown>) => void) => {
        cb({ id: 'IN', type: 'inbound-rtp', kind: 'video', codecId: 'C', framesReceived: 0, framesDecoded: 0, framesDropped: 0,
            jitterBufferDelay: 0, jitterBufferEmittedCount: 0, frameWidth: 1920, frameHeight: 1080,
            decoderImplementation: 'ExternalDecoder', powerEfficientDecoder: true, ...o });
        cb({ id: 'C', type: 'codec', mimeType: 'video/VP9' });
    },
});
const el = {};
const ctx = (o: Partial<ShareRxObserveContext> = {}): ShareRxObserveContext => ({
    track: 'remote-video-1', layer: 2, tile: 600, focus: true, playback: null, playbackKey: el, ...o,
});
const at = (sec: number, frames: number, extra: Record<string, unknown> = {}) =>
    report({ timestamp: sec * 1000, framesReceived: frames, framesDecoded: frames - 2, framesDropped: 1, jitterBufferDelay: frames * 0.02, jitterBufferEmittedCount: frames - 2, ...extra });

describe('ShareRxWatch', () => {
    it('logs share_rx_start once the decoder is known (and again when it changes), then share_rx_fps every window', () => {
        const w = new ShareRxWatch();
        w.setRef('a1b2c3d4');
        const first = w.observe(0, at(0, 0), ctx());
        expect(first.start).toEqual({ share_ref: 'a1b2c3d4', track: 'remote-video-1', codec: 'vp9', decoder: 'ExternalDecoder', hw: true, res: '1920x1080', layer: 2 });
        expect(first.fps).toBeUndefined();
        expect(w.observe(2_000, at(2, 180), ctx())).toEqual({});
        expect(w.observe(8_000, at(8, 720), ctx())).toEqual({});
        const win = w.observe(RX_FPS_WINDOW_MS, at(10, 900), ctx());
        expect(win.start).toBeUndefined();
        expect(win.fps).toMatchObject({ share_ref: 'a1b2c3d4', track: 'remote-video-1', rx_fps: 90, dec_fps: 90, drop_fps: 0, res: '1920x1080', layer: 2, focus: true, tile: 600 });
        // the next window is measured from the previous one, not from the start
        expect(w.observe(20_000, at(20, 1_700), ctx()).fps).toMatchObject({ rx_fps: 80 });
        // decoder swap -> a new start event
        expect(w.observe(22_000, at(22, 1_880, { decoderImplementation: 'libvpx', powerEfficientDecoder: false }), ctx()).start).toMatchObject({ decoder: 'libvpx', hw: false });
    });

    it('presented frames (disp_fps) come from the same tile only: a different <video> means none for that window', () => {
        const w = new ShareRxWatch();
        const q = (t: number, total: number, dropped = 0) => ({ at: t, total, dropped });
        w.observe(0, at(0, 0), ctx({ playback: q(0, 0), playbackKey: el }));
        const same = w.observe(10_000, at(10, 900), ctx({ playback: q(10_000, 700, 10), playbackKey: el }));
        expect(same.fps!.disp_fps).toBe(69);
        const other = {};
        const moved = w.observe(20_000, at(20, 1_800), ctx({ playback: q(20_000, 40), playbackKey: other }));
        expect(moved.fps!.disp_fps).toBeUndefined();
        expect(w.observe(30_000, at(30, 2_700), ctx({ playback: q(30_000, 740), playbackKey: other })).fps!.disp_fps).toBe(70);
    });

    it('a counter reset inside a window logs nothing for it and re-baselines (no negative or bogus rate)', () => {
        const w = new ShareRxWatch();
        w.observe(0, at(0, 0), ctx());
        w.observe(10_000, at(10, 900), ctx());
        const afterReset = w.observe(20_000, at(20, 30, { jitterBufferDelay: 0.4, jitterBufferEmittedCount: 28 }), ctx());
        expect(afterReset.fps).toBeUndefined();
        expect(w.observe(30_000, at(30, 930), ctx()).fps).toMatchObject({ rx_fps: 90 });
    });

    it('nothing from a report without a video inbound', () => {
        const w = new ShareRxWatch();
        expect(w.observe(0, { forEach: () => {} }, ctx())).toEqual({});
        expect(w.observe(0, null, ctx())).toEqual({});
    });

    it('the display rate: measured once the ref is known, retried (spaced) when throttled, given up after HZ_MAX_ATTEMPTS, never twice', () => {
        const w = new ShareRxWatch();
        expect(w.claimHzMeasurement(0)).toBe(false); // no share_ref yet: the event could not be matched
        w.setRef('a1b2c3d4');
        expect(w.claimHzMeasurement(0)).toBe(true);
        expect(w.claimHzMeasurement(0)).toBe(false); // in flight
        expect(w.finishHz(null, 1_000)).toBeNull();
        expect(w.claimHzMeasurement(2_000)).toBe(false); // too soon after a throttled attempt
        expect(w.claimHzMeasurement(1_000 + HZ_RETRY_MS)).toBe(true); // retried on a later sample
        expect(w.finishHz(144, 30_000)).toEqual({ share_ref: 'a1b2c3d4', role: 'viewer', hz: 144, hz_src: 'raf' });
        expect(w.claimHzMeasurement(1e9)).toBe(false); // once per watched share

        const g = new ShareRxWatch();
        g.setRef('deadbeef');
        let t = 0;
        for (let i = 0; i < HZ_MAX_ATTEMPTS; i++) { expect(g.claimHzMeasurement(t)).toBe(true); g.finishHz(null, t); t += HZ_RETRY_MS; }
        expect(g.claimHzMeasurement(t + 1e9)).toBe(false);
    });
});
