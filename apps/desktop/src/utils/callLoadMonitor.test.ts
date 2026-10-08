import { describe, it, expect } from 'vitest';
import {
    CallLoadDetector, layerLimitStats,
    WARMUP_MS, GAP_RESET_MS, STRAINED_TICKS, WINDOW_TICKS, type LoadSample, type LayerLimitStats,
} from './callLoadMonitor';

/**
 * Drive the detector with one sample per second. `cpuPerTick(i)` is how many
 * seconds of CPU limitation each layer accrued in tick i (the cumulative
 * qualityLimitationDurations.cpu grows by it).
 */
function run(
    seconds: number,
    cpuPerTick: (i: number) => number,
    opts: { source?: 'camera' | 'share'; reason?: (i: number) => string; rids?: string[]; startAt?: number; step?: (i: number) => number } = {},
) {
    const d = new CallLoadDetector();
    const rids = opts.rids ?? ['q', 'h', 'f'];
    const cum: Record<string, number> = {};
    const verdicts: boolean[] = [];
    let at = opts.startAt ?? 0;
    for (let i = 0; i < seconds; i++) {
        at += opts.step ? opts.step(i) : 1000;
        const layers: LayerLimitStats[] = rids.map(rid => {
            cum[rid] = (cum[rid] ?? 0) + (rid === rids[rids.length - 1] ? cpuPerTick(i) : 0);
            return { rid, cpuSeconds: cum[rid], reason: opts.reason?.(i) ?? (cpuPerTick(i) > 0.5 ? 'cpu' : 'none') };
        });
        const s: LoadSample = { at, [opts.source ?? 'camera']: { layers } };
        verdicts.push(d.observe(s).struggling);
    }
    return verdicts;
}

const firstTrue = (v: boolean[]) => v.indexOf(true);

describe('CallLoadDetector — sustained encoder CPU starvation', () => {
    it('fires once 10 of the last 12 s were CPU-limited, after the warm-up', () => {
        const v = run(40, () => 0.9);
        // Warm-up is 15 s from the first sample: the first verdict can only come at ≥ 15 s.
        expect(firstTrue(v)).toBe(WARMUP_MS / 1000);
        expect(v.slice(WARMUP_MS / 1000).every(Boolean)).toBe(true);
    });

    it('fires for the screen share as well as the camera', () => {
        expect(firstTrue(run(40, () => 1, { source: 'share', rids: ['0'] }))).toBeGreaterThan(0);
    });

    it('the CPU limit starting late needs STRAINED_TICKS consecutive-ish seconds', () => {
        const v = run(60, i => (i >= 30 ? 1 : 0));
        expect(firstTrue(v)).toBe(30 + STRAINED_TICKS - 1);
    });

    it('false positive guard: short bursts (8 s) never fire', () => {
        const v = run(80, i => ((i % 20) < 8 ? 1 : 0));
        expect(v.some(Boolean)).toBe(false);
    });

    it('false positive guard: 9 of 12 seconds is not enough', () => {
        const pattern = [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0]; // 9 / 12
        const v = run(80, i => pattern[i % pattern.length]);
        expect(v.some(Boolean)).toBe(false);
    });

    it('false positive guard: bandwidth limitation is not CPU', () => {
        const v = run(60, () => 0, { reason: () => 'bandwidth' });
        expect(v.some(Boolean)).toBe(false);
    });

    it('false positive guard: a strained window must end on a strained tick (recovered = no offer)', () => {
        const v = run(40, i => (i < 30 ? 1 : 0));
        expect(v[29]).toBe(true);
        expect(v[30]).toBe(false);
    });

    it('false positive guard: a partly limited second (< half of it) does not count', () => {
        const v = run(60, () => 0.4, { reason: () => 'none' });
        expect(v.some(Boolean)).toBe(false);
    });

    it('a sampling gap (window hidden, machine asleep) restarts the window and the warm-up', () => {
        // Strained throughout, but with a 10 s gap at tick 20.
        const v = run(60, () => 1, { step: i => (i === 20 ? 10_000 : 1000) });
        expect(v[19]).toBe(true);
        expect(v[20]).toBe(false);
        expect(firstTrue(v.slice(20)) + 20).toBe(20 + WARMUP_MS / 1000);
        expect(GAP_RESET_MS).toBeLessThan(10_000);
    });

    it('without a duration counter it falls back to the live reason', () => {
        const d = new CallLoadDetector();
        let fired = -1;
        for (let i = 0; i < 40; i++) {
            const r = d.observe({ at: i * 1000, camera: { layers: [{ rid: 'f', reason: 'cpu' }] } });
            if (r.struggling && fired < 0) fired = i;
        }
        expect(fired).toBe(WARMUP_MS / 1000);
    });

    it('a layer paused by dynacast (counter frozen) does not hide a strained one', () => {
        const d = new CallLoadDetector();
        let ok = false;
        for (let i = 0; i < 30; i++) {
            ok = d.observe({ at: i * 1000, camera: { layers: [{ rid: 'q', cpuSeconds: i * 1.0 }, { rid: 'f', cpuSeconds: 3 }] } }).struggling || ok;
        }
        expect(ok).toBe(true);
    });

    it('camera turned off clears its state; turning it back on restarts the warm-up', () => {
        const d = new CallLoadDetector();
        for (let i = 0; i < 30; i++) d.observe({ at: i * 1000, camera: { layers: [{ rid: 'f', cpuSeconds: i }] } });
        expect(d.observe({ at: 30_000, camera: null }).struggling).toBe(false);
        const r = d.observe({ at: 31_000, camera: { layers: [{ rid: 'f', cpuSeconds: 100 }] } });
        expect(r.struggling).toBe(false);
    });

    it('reports which source is struggling', () => {
        const d = new CallLoadDetector();
        let last = { struggling: false, sources: [] as string[] };
        for (let i = 0; i < 30; i++) {
            last = d.observe({
                at: i * 1000,
                camera: { layers: [{ rid: 'f', cpuSeconds: 0 }] },
                share: { layers: [{ rid: '0', cpuSeconds: i }] },
            });
        }
        expect(last).toEqual({ struggling: true, sources: ['share'] });
        expect(WINDOW_TICKS).toBeGreaterThanOrEqual(STRAINED_TICKS);
    });
});

describe('layerLimitStats', () => {
    it('reads rid, reason and cpu seconds from outbound video only', () => {
        const report = new Map<string, Record<string, unknown>>([
            ['a', { type: 'outbound-rtp', kind: 'video', rid: 'f', qualityLimitationReason: 'cpu', qualityLimitationDurations: { cpu: 4.5, bandwidth: 0, none: 10, other: 0 } }],
            ['b', { type: 'outbound-rtp', kind: 'audio' }],
            ['c', { type: 'inbound-rtp', kind: 'video' }],
            ['d', { type: 'outbound-rtp', kind: 'video' }],
        ]);
        expect(layerLimitStats(report)).toEqual([
            { rid: 'f', reason: 'cpu', cpuSeconds: 4.5 },
            { rid: undefined, reason: undefined, cpuSeconds: undefined },
        ]);
    });
});
