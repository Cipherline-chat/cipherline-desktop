import { describe, it, expect } from 'vitest';
import {
    ReceiveLoadDetector, classifyReceiveTick, inboundVideoStats, parseProcessCpu,
    type InboundVideoStats,
} from './receiveLoadMonitor';
import { WARMUP_MS, STRAINED_TICKS } from './callLoadMonitor';

/** Per-second behaviour of one incoming camera. */
interface PerSec { fps?: number; dropped?: number; decodeMs?: number; packets?: number; lost?: number; nacks?: number; freezes?: number; jbMs?: number }

/**
 * Drive the detector with `tracks` incoming cameras for `seconds`, each
 * behaving per `f(i, trackIndex)`; returns the per-second verdicts.
 */
function run(seconds: number, tracks: number, f: (i: number, t: number) => PerSec, cpu?: (i: number) => number | null) {
    const d = new ReceiveLoadDetector();
    const cum: Required<Omit<InboundVideoStats, 'id'>>[] = Array.from({ length: tracks }, () => ({
        framesDecoded: 0, framesDropped: 0, totalDecodeTime: 0, packetsReceived: 0, packetsLost: 0,
        nackCount: 0, freezeCount: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0,
    }));
    const out: { decode: boolean; network: boolean }[] = [];
    for (let i = 0; i < seconds; i++) {
        const sample = cum.map((c, t) => {
            const p = f(i, t);
            const fps = p.fps ?? 30;
            c.framesDecoded += fps;
            c.framesDropped += p.dropped ?? 0;
            c.totalDecodeTime += (fps * (p.decodeMs ?? 4)) / 1000;
            c.packetsReceived += p.packets ?? 200;
            c.packetsLost += p.lost ?? 0;
            c.nackCount += p.nacks ?? 0;
            c.freezeCount += p.freezes ?? 0;
            c.jitterBufferDelay += (fps * (p.jbMs ?? 40)) / 1000;
            c.jitterBufferEmittedCount += fps;
            return { id: `t${t}`, ...c };
        });
        const v = d.observe({ at: i * 1000, tracks: sample, rendererCpuPct: cpu?.(i) });
        out.push({ decode: v.decodeBound, network: v.networkBound });
    }
    return out;
}
const firstDecode = (v: { decode: boolean }[]) => v.findIndex(x => x.decode);

describe('ReceiveLoadDetector — decode-bound (local CPU) vs network-bound', () => {
    it('decode-bound: many cameras dropping frames with a clean network', () => {
        const v = run(40, 6, () => ({ dropped: 4 })); // 4 / 34 ≈ 12 %
        expect(firstDecode(v)).toBe(WARMUP_MS / 1000);
        expect(v.some(x => x.network)).toBe(false);
    });

    it('decode-bound: slow decode (≥ 16 ms a frame) with no drops yet', () => {
        expect(firstDecode(run(40, 4, () => ({ decodeMs: 20 })))).toBe(WARMUP_MS / 1000);
    });

    it('decode-bound: freezes plus modest drops', () => {
        expect(firstDecode(run(40, 3, () => ({ dropped: 1, freezes: 1 })))).toBeGreaterThan(0);
    });

    it('NETWORK, not decode: the same drops with 5 % packet loss', () => {
        const v = run(40, 6, () => ({ dropped: 4, lost: 10 }));
        expect(v.some(x => x.decode)).toBe(false);
        expect(v.findIndex(x => x.network)).toBe(WARMUP_MS / 1000);
    });

    it('NETWORK, not decode: heavy NACKs', () => {
        const v = run(40, 6, () => ({ dropped: 4, nacks: 20 }));
        expect(v.some(x => x.decode)).toBe(false);
        expect(v.some(x => x.network)).toBe(true);
    });

    it('NETWORK, not decode: the jitter buffer growing ≥ 80 ms over its best level', () => {
        const v = run(40, 6, i => ({ dropped: 4, jbMs: i < 5 ? 40 : 160 }));
        expect(v.slice(5).some(x => x.decode)).toBe(false);
        expect(v.some(x => x.network)).toBe(true);
    });

    it('false positive: one camera only (a single slow stream is not "lots of video")', () => {
        expect(run(40, 1, () => ({ dropped: 10, decodeMs: 30 })).some(x => x.decode)).toBe(false);
    });

    it('false positive: healthy cameras (4 ms decode, no drops)', () => {
        expect(run(60, 9, () => ({})).some(x => x.decode)).toBe(false);
    });

    it('false positive: short bursts never fire', () => {
        expect(run(80, 6, i => ((i % 20) < 8 ? { dropped: 6 } : {})).some(x => x.decode)).toBe(false);
    });

    it('false positive: 2 % drops alone (below 5 %, no freeze) do not count', () => {
        expect(run(60, 6, () => ({ dropped: 0.6 })).some(x => x.decode)).toBe(false);
    });

    it('false positive: an idle renderer (CPU < 15 % of a core) vetoes; unknown CPU never does', () => {
        expect(run(40, 6, () => ({ dropped: 4 }), () => 8).some(x => x.decode)).toBe(false);
        expect(firstDecode(run(40, 6, () => ({ dropped: 4 }), () => 180))).toBe(WARMUP_MS / 1000);
        expect(firstDecode(run(40, 6, () => ({ dropped: 4 }), () => null))).toBe(WARMUP_MS / 1000);
    });

    it('needs STRAINED_TICKS of the window and recovers immediately', () => {
        const v = run(60, 6, i => (i >= 30 && i < 50 ? { dropped: 4 } : {}));
        expect(firstDecode(v)).toBe(30 + STRAINED_TICKS - 1);
        expect(v[50].decode).toBe(false);
    });

    it('a replaced track (counters reset) is skipped, not read as negative load', () => {
        const d = new ReceiveLoadDetector();
        const mk = (n: number) => ({ id: 'a', framesDecoded: n, totalDecodeTime: n * 0.004, packetsReceived: n * 7 });
        d.observe({ at: 0, tracks: [mk(300), { ...mk(300), id: 'b' }] });
        const v = d.observe({ at: 1000, tracks: [mk(10), { ...mk(330), id: 'b' }] });
        expect(v.tick?.decodingTracks).toBe(1);
    });

    it('no incoming video: no tick, no verdict', () => {
        const d = new ReceiveLoadDetector();
        expect(d.observe({ at: 0, tracks: [] })).toEqual({ decodeBound: false, networkBound: false, tick: null });
    });
});

describe('classifyReceiveTick', () => {
    const z = { framesDecoded: 0, framesDropped: 0, totalDecodeTime: 0, packetsReceived: 0, packetsLost: 0, nackCount: 0, freezeCount: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 };
    it('a paused (non-decoding) stream does not count toward the 2-stream minimum', () => {
        const t = classifyReceiveTick([{ ...z, framesDecoded: 30, framesDropped: 10, packetsReceived: 200 }, z], null);
        expect(t.decodingTracks).toBe(1);
        expect(t.decode).toBe(false);
    });
    it('negative lost deltas (late arrivals) never produce negative loss', () => {
        const t = classifyReceiveTick([{ ...z, framesDecoded: 30, packetsReceived: 200, packetsLost: -3 }], null);
        expect(t.lossRatio).toBe(0);
    });
});

describe('stats readers', () => {
    it('inboundVideoStats reads the first inbound video entry', () => {
        const rep = new Map<string, Record<string, unknown>>([
            ['a', { type: 'inbound-rtp', kind: 'audio', framesDecoded: 1 }],
            ['b', { type: 'inbound-rtp', kind: 'video', framesDecoded: 90, framesDropped: 3, totalDecodeTime: 0.4, packetsLost: 1, freezeCount: 0 }],
        ]);
        expect(inboundVideoStats('sid', rep)).toMatchObject({ id: 'sid', framesDecoded: 90, framesDropped: 3, totalDecodeTime: 0.4, packetsLost: 1 });
        expect(inboundVideoStats('sid', new Map())).toBeNull();
    });
    it('parseProcessCpu sums renderer + GPU, null when unknown', () => {
        expect(parseProcessCpu({ renderer: 40, gpu: 12 })).toBe(52);
        expect(parseProcessCpu({ renderer: 40, gpu: null })).toBe(40);
        expect(parseProcessCpu({ renderer: null, gpu: 12 })).toBeNull();
        expect(parseProcessCpu(null)).toBeNull();
        expect(parseProcessCpu({ renderer: -1 })).toBeNull();
        expect(parseProcessCpu('x')).toBeNull();
    });
});
