import { describe, it, expect } from 'vitest';
import {
    VideoFreezeDetector, outboundCountersFromReport, inboundCountersFromReport, FREEZE_MS,
    type OutboundVideoSample, type InboundVideoSample, type VideoStreamSample,
} from './videoFreezeDetector';

const out = (framesSent: number, over: Partial<OutboundVideoSample> = {}): OutboundVideoSample => ({
    direction: 'out', key: 'out:cam', kind: 'camera', eligible: true, framesSent, bandwidthLimited: false, ...over,
});
const inn = (framesDecoded: number, bytesReceived: number, over: Partial<InboundVideoSample> = {}): InboundVideoSample => ({
    direction: 'in', key: 'in:a', kind: 'camera', eligible: true, framesDecoded, bytesReceived,
    packetsReceived: bytesReceived / 1000, packetsLost: 0, ...over,
});

/** Feed one sample per second; returns every tick's events. */
function run(seq: Array<VideoStreamSample | VideoStreamSample[]>, opts: { bg?: boolean[]; decrypt?: boolean[] } = {}) {
    const d = new VideoFreezeDetector();
    return seq.map((s, i) => d.observe(Array.isArray(s) ? s : [s], {
        at: i * 1000,
        backgrounded: opts.bg?.[i] ?? true,
        decryptError: opts.decrypt?.[i] ?? false,
    }));
}
const firstFreezeTick = (events: ReturnType<typeof run>) => events.findIndex(e => e.length > 0);

describe('outgoing camera', () => {
    it('steady frames → never a freeze', () => {
        const ev = run([0, 30, 60, 90, 120, 150, 180].map(n => out(n)));
        expect(ev.flat()).toEqual([]);
    });

    it('frames stalled for ≥ FREEZE_MS while live → one freeze, once per stall', () => {
        const ev = run([out(0), out(30), out(60), out(60), out(60), out(60), out(60), out(60)]);
        // progress at t=2s; stalled 2.5 s is reached at t=5s (3 s) → tick 5.
        expect(firstFreezeTick(ev)).toBe(5);
        expect(ev[5]).toEqual([{ at: 5000, direction: 'out', kind: 'camera', stalledMs: 3000 }]);
        expect(ev.flat()).toHaveLength(1);
    });

    it('a stall shorter than FREEZE_MS is not a freeze', () => {
        expect(FREEZE_MS).toBe(2500);
        const ev = run([out(0), out(30), out(30), out(30), out(90), out(120)]);
        expect(ev.flat()).toEqual([]);
    });

    it('recovers and can report a SECOND, separate stall', () => {
        const ev = run([out(0), out(30), out(30), out(30), out(30), out(30), out(60), out(60), out(60), out(60), out(60)]);
        expect(ev.flat()).toHaveLength(2);
    });

    it('camera muted (ineligible) during the stall → not a freeze, and the history resets', () => {
        const ev = run([out(0), out(30), out(30, { eligible: false }), out(30, { eligible: false }), out(30, { eligible: false }), out(30, { eligible: false })]);
        expect(ev.flat()).toEqual([]);
        // After unmute the stream must produce a frame before a stall can count.
        const ev2 = run([out(0), out(30, { eligible: false }), out(30), out(30), out(30), out(30), out(30)]);
        expect(ev2.flat()).toEqual([]);
    });

    it('bandwidth-limited at any point in the stall → network, not a freeze', () => {
        const ev = run([out(0), out(30), out(30), out(30, { bandwidthLimited: true }), out(30), out(30), out(30)]);
        expect(ev.flat()).toEqual([]);
    });

    it('a stream that never produced a frame since it became eligible is start-up, not a freeze', () => {
        const ev = run([out(0), out(0), out(0), out(0), out(0), out(0)]);
        expect(ev.flat()).toEqual([]);
    });

    it('a counter that goes backwards (new sender) starts over instead of reading as a stall', () => {
        const ev = run([out(500), out(530), out(10), out(10), out(10), out(40)]);
        expect(ev.flat()).toEqual([]);
    });

    it('a stall that was ever in the FOREGROUND is not a gaming freeze', () => {
        const seq = [out(0), out(30), out(30), out(30), out(30), out(30), out(30)];
        expect(run(seq, { bg: [true, true, false, true, true, true, true] }).flat()).toEqual([]);
        expect(run(seq, { bg: [true, true, true, false, true, true, true] }).flat()).toEqual([]);
        expect(run(seq).flat()).toHaveLength(1); // positive control: same sequence, all background
    });
});

describe('outgoing screen share', () => {
    const ss = (framesSent: number, sourceFrames: number | undefined, over: Partial<OutboundVideoSample> = {}) =>
        out(framesSent, { key: 'out:ss', kind: 'screen', sourceFrames, ...over });

    it('capturer still delivering but nothing sent → freeze (our encode is starved)', () => {
        const ev = run([ss(0, 0), ss(60, 60), ss(60, 120), ss(60, 180), ss(60, 240), ss(60, 300)]);
        expect(ev.flat()).toEqual([{ at: 4000, direction: 'out', kind: 'screen', stalledMs: 3000 }]);
    });

    it('capturer delivering nothing (static screen, 0 Hz capture) → not a freeze', () => {
        const ev = run([ss(0, 0), ss(60, 60), ss(60, 60), ss(60, 60), ss(60, 60), ss(60, 60)]);
        expect(ev.flat()).toEqual([]);
    });

    it('no media-source stat at all → cannot tell → not a freeze', () => {
        const ev = run([ss(0, undefined), ss(60, undefined), ss(60, undefined), ss(60, undefined), ss(60, undefined), ss(60, undefined)]);
        expect(ev.flat()).toEqual([]);
    });
});

describe('incoming video', () => {
    it('bytes arriving, frames not decoding, low loss → freeze (local decode starvation)', () => {
        const ev = run([inn(0, 0), inn(30, 100_000), inn(30, 200_000), inn(30, 300_000), inn(30, 400_000), inn(30, 500_000)]);
        expect(ev.flat()).toEqual([{ at: 4000, direction: 'in', kind: 'camera', stalledMs: 3000 }]);
    });

    it('no bytes arriving (sender stopped / network / remote pause) → not a freeze', () => {
        const ev = run([inn(0, 0), inn(30, 100_000), inn(30, 100_000), inn(30, 100_000), inn(30, 100_000), inn(30, 100_000)]);
        expect(ev.flat()).toEqual([]);
    });

    it('heavy packet loss during the stall → network, not a freeze', () => {
        const lossy = (f: number, b: number, lost: number) => inn(f, b, { packetsReceived: b / 1000, packetsLost: lost });
        const ev = run([lossy(0, 0, 0), lossy(30, 100_000, 0), lossy(30, 200_000, 20), lossy(30, 300_000, 40), lossy(30, 400_000, 60), lossy(30, 500_000, 80)]);
        expect(ev.flat()).toEqual([]);
    });

    it('a little loss (≤ 5%) still counts as a freeze', () => {
        const ev = run([inn(0, 0), inn(30, 100_000), inn(30, 200_000, { packetsLost: 1 }), inn(30, 300_000, { packetsLost: 2 }), inn(30, 400_000, { packetsLost: 3 }), inn(30, 500_000, { packetsLost: 4 })]);
        expect(ev.flat()).toHaveLength(1);
    });

    it('an E2EE decryption error during the stall → not a freeze', () => {
        const seq = [inn(0, 0), inn(30, 100_000), inn(30, 200_000), inn(30, 300_000), inn(30, 400_000), inn(30, 500_000)];
        expect(run(seq, { decrypt: [false, false, false, true, false, false] }).flat()).toEqual([]);
    });

    it('paused at the SFU / muted / stream state paused (ineligible) → not a freeze', () => {
        const ev = run([inn(0, 0), inn(30, 100_000), ...[2, 3, 4, 5, 6].map(i => inn(30, i * 100_000, { eligible: false }))]);
        expect(ev.flat()).toEqual([]);
    });

    it('streams are tracked independently', () => {
        const a = (f: number, b: number) => inn(f, b, { key: 'in:a' });
        const b = (f: number, by: number) => inn(f, by, { key: 'in:b' });
        const ev = run([
            [a(0, 0), b(0, 0)],
            [a(30, 1e5), b(30, 1e5)],
            [a(60, 2e5), b(30, 2e5)],
            [a(90, 3e5), b(30, 3e5)],
            [a(120, 4e5), b(30, 4e5)],
        ]);
        expect(ev.flat()).toEqual([{ at: 4000, direction: 'in', kind: 'camera', stalledMs: 3000 }]);
    });

    it('a stream missing from a tick is forgotten (no stale stall carried over)', () => {
        const ev = run([inn(0, 0), inn(30, 1e5), [], inn(30, 3e5), inn(30, 4e5), inn(30, 5e5)]);
        // Re-tracked from t=3 with no progress yet → never counts.
        expect(ev.flat()).toEqual([]);
    });

    it('malformed numbers make a stream ineligible rather than throwing', () => {
        const d = new VideoFreezeDetector();
        expect(() => d.observe([inn(NaN, 0)], { at: 0, backgrounded: true, decryptError: false })).not.toThrow();
    });
});

/** RTCStatsReport.forEach passes (value, key). */
const report = (...stats: Array<Record<string, unknown>>) => new Map(stats.map((s, i) => [String(i), s]));

describe('stats extraction', () => {
    it('sums framesSent across simulcast layers and reads media-source frames', () => {
        const r = report(
            { type: 'outbound-rtp', kind: 'video', rid: 'q', framesSent: 100, qualityLimitationReason: 'none' },
            { type: 'outbound-rtp', kind: 'video', rid: 'h', framesSent: 90, qualityLimitationReason: 'cpu' },
            { type: 'outbound-rtp', kind: 'video', rid: 'f', framesSent: 80 },
            { type: 'media-source', kind: 'video', frames: 300 },
            { type: 'outbound-rtp', kind: 'audio', packetsSent: 5 },
        );
        expect(outboundCountersFromReport(r)).toEqual({ framesSent: 270, sourceFrames: 300, bandwidthLimited: false });
    });

    it('flags bandwidth limitation on any layer', () => {
        const r = report({ type: 'outbound-rtp', kind: 'video', framesSent: 1, qualityLimitationReason: 'bandwidth' });
        expect(outboundCountersFromReport(r)).toEqual({ framesSent: 1, bandwidthLimited: true });
    });

    it('no video outbound-rtp → null', () => {
        expect(outboundCountersFromReport(report({ type: 'outbound-rtp', kind: 'audio' }))).toBeNull();
        expect(outboundCountersFromReport(undefined)).toBeNull();
    });

    it('reads inbound counters and never lets negative packetsLost subtract', () => {
        const r = report(
            { type: 'inbound-rtp', kind: 'video', framesDecoded: 50, bytesReceived: 9000, packetsReceived: 12, packetsLost: -1 },
            { type: 'inbound-rtp', kind: 'audio', framesDecoded: 999 },
        );
        expect(inboundCountersFromReport(r)).toEqual({ framesDecoded: 50, bytesReceived: 9000, packetsReceived: 12, packetsLost: 0 });
        expect(inboundCountersFromReport(report())).toBeNull();
    });
});
