import { describe, it, expect, vi } from 'vitest';
import {
    readSentCodecs, driftedCodec, codecOfMime, ShareCodecDriftWatch, CodecDriftWatch, codecDriftNotice, cameraCodecDriftNotice,
    DRIFT_CONFIRM, DRIFT_REPUBLISH_COOLDOWN_MS, driftRepublishAllowed, sentEncoderKey, type StatsLike,
} from './shareCodecDrift';

type Row = Record<string, unknown>;
const report = (rows: Row[]): StatsLike => ({ forEach: cb => rows.forEach(cb) });

const codec = (id: string, mimeType: string): Row => ({ type: 'codec', id, mimeType });
const out = (codecId: string | undefined, o: Row = {}): Row => ({ type: 'outbound-rtp', kind: 'video', codecId, frameWidth: 2560, frameHeight: 1440, ...o });

// The friend's share after the source swap (report e951243d, t -62.2):
// published H.265, the stats say VP8 on libvpx in software.
const AFTER_SWAP = report([
    codec('C1', 'video/H265'), codec('C2', 'video/VP8'),
    out('C2', { rid: 'q', frameWidth: 1280, frameHeight: 720, encoderImplementation: 'libvpx' }),
    out('C2', { rid: 'h', encoderImplementation: 'SimulcastEncoderAdapter (libvpx, libvpx)' }),
    { type: 'media-source', kind: 'video', frames: 5000 },
]);
const HEALTHY_H265 = report([
    codec('C1', 'video/H265'),
    out('C1', { rid: 'q', frameWidth: 1280, frameHeight: 720 }),
    out('C1', { rid: 'h', encoderImplementation: 'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (' }),
]);

describe('readSentCodecs / driftedCodec', () => {
    it('reads the codec each active layer is REALLY sending', () => {
        const s = readSentCodecs(AFTER_SWAP);
        expect(s.codecs).toEqual(['vp8']);
        expect(s.layers).toBe(2);
        expect(s.encoder).toBe('SimulcastEncoderAdapter (libvpx, libvpx)'); // the largest layer's
        expect(driftedCodec('h265', s)).toBe('vp8');
    });

    it('no drift when the sender sends what was published', () => {
        expect(driftedCodec('h265', readSentCodecs(HEALTHY_H265))).toBeNull();
    });

    it('a fresh publish that fell back from its first frame (H.265 -> OpenH264) is a drift too', () => {
        const r = report([codec('A', 'video/H264'), out('A', { encoderImplementation: 'SimulcastEncoderAdapter (OpenH264, OpenH264)' })]);
        expect(driftedCodec('h265', readSentCodecs(r))).toBe('h264');
    });

    it('unknown is never a drift: no codec id yet, no codec stats, no published codec', () => {
        expect(driftedCodec('h265', readSentCodecs(report([out(undefined)])))).toBeNull();
        expect(driftedCodec('h265', readSentCodecs(report([out('missing')])))).toBeNull();
        expect(driftedCodec(undefined, readSentCodecs(AFTER_SWAP))).toBeNull();
        expect(driftedCodec('h265', readSentCodecs(null))).toBeNull();
    });

    it('a layer dynacast paused (active:false) is not judged', () => {
        const r = report([codec('A', 'video/H265'), codec('B', 'video/VP8'), out('A'), out('B', { active: false })]);
        expect(driftedCodec('h265', readSentCodecs(r))).toBeNull();
    });

    it('audio and inbound stats are ignored', () => {
        const r = report([codec('A', 'audio/opus'), { type: 'outbound-rtp', kind: 'audio', codecId: 'A' }, { type: 'inbound-rtp', kind: 'video', codecId: 'A' }]);
        expect(readSentCodecs(r)).toEqual({ codecs: [], layers: 0 });
    });

    it('codecOfMime', () => {
        expect(codecOfMime('video/H265')).toBe('h265');
        expect(codecOfMime('VP8')).toBe('vp8');
        expect(codecOfMime('')).toBeUndefined();
        expect(codecOfMime(42)).toBeUndefined();
    });
});

describe('ShareCodecDriftWatch', () => {
    const run = async (reports: (StatsLike | Error)[], published = 'h265') => {
        let i = 0;
        const onDrift = vi.fn();
        const w = new ShareCodecDriftWatch({
            getStats: async () => {
                const r = reports[Math.min(i++, reports.length - 1)];
                if (r instanceof Error) throw r;
                return r;
            },
            published, onDrift, sleep: async () => { if (i > 50) w.dispose(); },
        });
        await w.start();
        return { onDrift, polls: i };
    };

    it(`reports a drift once it has been seen on ${DRIFT_CONFIRM} consecutive polls, then stops`, async () => {
        const { onDrift, polls } = await run([HEALTHY_H265, HEALTHY_H265, AFTER_SWAP, AFTER_SWAP, AFTER_SWAP]);
        expect(onDrift).toHaveBeenCalledTimes(1);
        expect(onDrift).toHaveBeenCalledWith({ published: 'h265', sent: 'vp8', layers: 2, encoder: 'SimulcastEncoderAdapter (libvpx, libvpx)' });
        expect(polls).toBe(4);
    });

    it('a single odd sample is not a drift', async () => {
        const { onDrift } = await run([AFTER_SWAP, HEALTHY_H265, AFTER_SWAP, HEALTHY_H265, HEALTHY_H265]);
        expect(onDrift).not.toHaveBeenCalled();
    });

    it('stops quietly when the sender is gone (share ended)', async () => {
        const { onDrift, polls } = await run([HEALTHY_H265, new Error('closed')]);
        expect(onDrift).not.toHaveBeenCalled();
        expect(polls).toBe(2);
    });

    it('dispose() before a confirmed drift reports nothing', async () => {
        const onDrift = vi.fn();
        let n = 0;
        const w = new ShareCodecDriftWatch({
            getStats: async () => { if (++n === 2) w.dispose(); return AFTER_SWAP; },
            published: 'h265', onDrift, sleep: async () => {},
        });
        await w.start();
        expect(onDrift).not.toHaveBeenCalled();
    });
});

describe('CodecDriftWatch paused() (camera muted / deliberate republish)', () => {
    it('is the same implementation the share uses', () => { expect(CodecDriftWatch).toBe(ShareCodecDriftWatch); });

    it('while paused nothing counts toward a drift, and a streak in progress is forgotten', async () => {
        const onDrift = vi.fn();
        let n = 0;
        // drifted, paused, drifted: never two CONSECUTIVE judged samples -> no report
        const w = new CodecDriftWatch({
            getStats: async () => { n++; if (n >= 8) w.dispose(); return AFTER_SWAP; },
            published: 'h265', onDrift, sleep: async () => {},
            paused: () => n === 2 || n === 4 || n === 6,
        });
        await w.start();
        expect(onDrift).not.toHaveBeenCalled();
    });

    it('resumes judging once unpaused and then reports', async () => {
        const onDrift = vi.fn();
        let n = 0;
        const w = new CodecDriftWatch({
            getStats: async () => { n++; if (n > 20) w.dispose(); return AFTER_SWAP; },
            published: 'h265', onDrift, sleep: async () => {}, paused: () => n < 4,
        });
        await w.start();
        expect(onDrift).toHaveBeenCalledTimes(1);
    });

    it('no drift when the camera sends the codec it published (nothing fires)', async () => {
        const onDrift = vi.fn();
        let n = 0;
        const w = new CodecDriftWatch({
            getStats: async () => { if (++n > 10) w.dispose(); return HEALTHY_H265; },
            published: 'h265', onDrift, sleep: async () => {}, paused: () => false,
        });
        await w.start();
        expect(onDrift).not.toHaveBeenCalled();
    });
});

describe('cameraCodecDriftNotice', () => {
    it('is short and plain', () => { expect(cameraCodecDriftNotice()).toBe('Camera encoder stopped working \u2014 restarting your camera.'); });
});

describe('codecDriftNotice', () => {
    it('names the codec in plain words', () => {
        expect(codecDriftNotice('h265')).toMatch(/H\.265 encoder stopped working/);
        expect(codecDriftNotice('h264')).toMatch(/H\.264/);
        expect(codecDriftNotice('vp9')).toMatch(/VP9/);
    });
});

// 2026-11-21 report 07939bfa: a 3440x1440 90 fps share published H.265, the sender switched to libvpx.
const ULTRAWIDE_DRIFT = report([
    codec('C1', 'video/H265'), codec('C2', 'video/VP8'),
    out('C2', { rid: 'q', frameWidth: 1720, frameHeight: 720, encoderImplementation: 'libvpx', powerEfficientEncoder: false }),
    out('C2', { rid: 'h', frameWidth: 3440, frameHeight: 1440, encoderImplementation: 'SimulcastEncoderAdapter (libvpx, libvpx)', powerEfficientEncoder: false }),
]);

describe('readSentCodecs: hardware flag and top-layer size (share_encoder diagnostics)', () => {
    it('the reported ultrawide drift reads as VP8, software, 3440x1440 top layer', () => {
        const s = readSentCodecs(ULTRAWIDE_DRIFT);
        expect(s).toMatchObject({ codecs: ['vp8'], layers: 2, hardware: false, topRes: '3440x1440' });
    });
    it('hardware true when the top layer says powerEfficientEncoder; absent when not reported', () => {
        const hw = readSentCodecs(report([codec('C1', 'video/H265'), out('C1', { powerEfficientEncoder: true })]));
        expect(hw.hardware).toBe(true);
        expect(readSentCodecs(HEALTHY_H265).hardware).toBeUndefined();
    });
    it('sentEncoderKey changes exactly when codec / implementation / hardware / layers change', () => {
        const a = sentEncoderKey('h265', readSentCodecs(HEALTHY_H265));
        expect(sentEncoderKey('h265', readSentCodecs(HEALTHY_H265))).toBe(a);
        expect(sentEncoderKey('h265', readSentCodecs(ULTRAWIDE_DRIFT))).not.toBe(a);
        expect(sentEncoderKey('h265', { codecs: ['h265'], layers: 2, hardware: true })).not.toBe(sentEncoderKey('h265', { codecs: ['h265'], layers: 2, hardware: false }));
    });
    it('the watch hands every poll to onSample (judged or paused)', async () => {
        const seen: string[] = [];
        let i = 0;
        const w = new ShareCodecDriftWatch({
            getStats: async () => (i++ < 1 ? HEALTHY_H265 : ULTRAWIDE_DRIFT),
            published: 'h265', onDrift: () => {}, onSample: s => seen.push(s.codecs.join('+')),
            paused: () => i === 1, sleep: async () => { if (i > 10) w.dispose(); },
        });
        await w.start();
        expect(seen.slice(0, 3)).toEqual(['h265', 'vp8', 'vp8']);
    });
    it('a throwing onSample never stops the drift watch', async () => {
        const onDrift = vi.fn();
        const w = new ShareCodecDriftWatch({
            getStats: async () => ULTRAWIDE_DRIFT, published: 'h265', onDrift,
            onSample: () => { throw new Error('log full'); }, sleep: async () => {},
        });
        await w.start();
        expect(onDrift).toHaveBeenCalledTimes(1);
    });
});

describe('driftRepublishAllowed: per source AND published codec', () => {
    const t0 = 1_000_000;
    it('first drift, or another source: allowed', () => {
        expect(driftRepublishAllowed(null, 'screen:1', 'h265', t0)).toBe(true);
        expect(driftRepublishAllowed({ sourceId: 'screen:2', at: t0, codec: 'h265' }, 'screen:1', 'h265', t0 + 1)).toBe(true);
    });
    it('H.265 drifted, republished as H.264 High, High drifts 5 s later: allowed (used to leave viewers on nothing)', () => {
        expect(driftRepublishAllowed({ sourceId: 'screen:1', at: t0, codec: 'h265' }, 'screen:1', 'h264', t0 + 5_000)).toBe(true);
    });
    it('the SAME codec drifting again inside the cooldown: held; at the cooldown boundary: allowed', () => {
        const last = { sourceId: 'screen:1', at: t0, codec: 'h264' };
        expect(driftRepublishAllowed(last, 'screen:1', 'h264', t0 + DRIFT_REPUBLISH_COOLDOWN_MS - 1)).toBe(false);
        expect(driftRepublishAllowed(last, 'screen:1', 'h264', t0 + DRIFT_REPUBLISH_COOLDOWN_MS)).toBe(true);
    });
    it('an older record without a codec keeps the old per-source rule', () => {
        expect(driftRepublishAllowed({ sourceId: 'screen:1', at: t0 }, 'screen:1', 'h264', t0 + 1)).toBe(false);
    });
});
