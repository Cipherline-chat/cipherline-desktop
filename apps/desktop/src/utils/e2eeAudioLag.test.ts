import { describe, it, expect } from 'vitest';
import {
    AudioLagTracker, createAudioLagStage, audioRtpTimestamp, audioLagStatsFromMessage,
    AUDIO_LAG_CAP_MS, AUDIO_LAG_CAP_RECV_MS, REBASE_AFTER_MS, IMPLAUSIBLE_LAG_MS, AUDIO_LAG_STATS_KIND, AUDIO_LAG_STATS_EVERY_MS, PROBES_TO_REBASE, PASS_PROBES_TO_REBASE,
    type AudioLagStats,
} from './e2eeAudioLag';
import { installAnnexBCanonicalizer } from './e2eeAnnexB';

const TICK = 960; // 20 ms of Opus at 48 kHz

/** Frames every 20 ms of media; `delayAt(i)` = extra queueing delay of frame i (ms). */
function run(tracker: AudioLagTracker, n: number, delayAt: (i: number) => number, ts0 = 1000) {
    const out: ReturnType<AudioLagTracker['observe']>[] = [];
    for (let i = 0; i < n; i++) out.push(tracker.observe((ts0 + i * TICK) >>> 0, 10_000 + i * 20 + delayAt(i)));
    return out;
}

type Verdict = ReturnType<AudioLagTracker['observe']>;
interface Tracker { observe(rtpTs: number, nowMs: number): Verdict }

/**
 * A closed-loop model of the worker stage: the source makes a frame every 20 ms of media (a capture stall delays
 * every later frame by `stallMs` without moving its RTP time), the network adds `jitter(i)` (FIFO: never before
 * the previous packet), and the stage handles frames one at a time: a processed frame costs `svc(i)` ms, a dropped
 * one ~0, and the worker can be blocked for `blockMs` from `blockAtMs`. The tracker sees each frame when the stage
 * gets to it, so a drop really does let the next waiting frame through sooner.
 */
function simulate(tracker: Tracker, o: {
    n: number; stallAt?: number; stallMs?: number; jitter?: (i: number) => number; svc?: (i: number) => number;
    blockAtMs?: number; blockMs?: number; ts0?: number;
}): Verdict[] {
    const out: Verdict[] = [];
    let free = 0, lastArrival = -Infinity, blocked = false;
    for (let i = 0; i < o.n; i++) {
        const made = 10_000 + i * 20 + (o.stallAt !== undefined && i >= o.stallAt ? (o.stallMs ?? 0) : 0);
        const arrival = Math.max(lastArrival, made + (o.jitter?.(i) ?? 0));
        lastArrival = arrival;
        let start = Math.max(arrival, free);
        if (!blocked && o.blockAtMs !== undefined && start >= o.blockAtMs) { blocked = true; start = Math.max(start, o.blockAtMs + (o.blockMs ?? 0)); }
        const v = tracker.observe(((o.ts0 ?? 1000) + i * TICK) >>> 0, start);
        out.push(v);
        free = start + (v.drop ? 0.05 : (o.svc?.(i) ?? 0.5));
    }
    return out;
}

/** Deterministic uniform [0, 1). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The tracker as it shipped until 2026-11-18 (verbatim but for the class name): the positive control. Each scenario
 * below shows this one fails it, so the test is not passing for a reason unrelated to the fix.
 */
class LegacyAudioLagTracker implements Tracker {
    private lastTs: number | null = null;
    private extTs = 0;
    private baseline: number | null = null;
    private baselineAt = 0;
    private dropSince: number | null = null;
    private dropStartExcess = 0;
    private lastExcess = 0;
    private readonly capMs: number;
    private readonly clockHz: number;
    constructor(capMs = AUDIO_LAG_CAP_MS, clockHz = 48_000) { this.capMs = capMs; this.clockHz = clockHz; }
    observe(rtpTs: number, nowMs: number): Verdict {
        const ts = rtpTs >>> 0;
        if (this.lastTs === null) {
            this.extTs = ts;
        } else {
            let d = (ts - this.lastTs) >>> 0;
            if (d > 0x7fffffff) d -= 0x100000000;
            this.extTs += d;
        }
        this.lastTs = ts;
        const offset = nowMs - (this.extTs / this.clockHz) * 1000;
        if (this.baseline === null) { this.baseline = offset; this.baselineAt = nowMs; return { excessMs: 0, drop: false, rebased: false }; }
        const healthy = this.lastExcess < this.capMs / 2;
        const crept = this.baseline + (healthy ? Math.max(0, nowMs - this.baselineAt) * (500 / 1e6) : 0);
        this.baselineAt = nowMs;
        this.baseline = Math.min(crept, offset);
        const excess = offset - this.baseline;
        if (excess > IMPLAUSIBLE_LAG_MS) { this.baseline = offset; this.dropSince = null; this.lastExcess = 0; return { excessMs: 0, drop: false, rebased: true }; }
        this.lastExcess = excess;
        if (excess <= this.capMs) { this.dropSince = null; return { excessMs: excess, drop: false, rebased: false }; }
        if (this.dropSince === null) {
            this.dropSince = nowMs;
            this.dropStartExcess = excess;
        } else if (nowMs - this.dropSince >= REBASE_AFTER_MS && excess > this.dropStartExcess - this.capMs / 2) {
            this.baseline = offset; this.dropSince = null; this.lastExcess = 0;
            return { excessMs: excess, drop: false, rebased: true };
        }
        return { excessMs: excess, drop: true, rebased: false };
    }
}

const dropped = (v: Verdict[], from = 0, to = v.length) => v.slice(from, to).filter(x => x.drop).length;

describe('a capture stall is a step, not a queue (2026-11-18 round trip: 600 ms stall -> 2180 ms lost)', () => {
    // Send side: a fast worker (0.5 ms a frame), the mic's audio thread stalls; RTP time does not move during it.
    it.each([600, 1500])('send: a %i ms stall costs at most PROBES_TO_REBASE frames and one re-base', (stallMs) => {
        const v = simulate(new AudioLagTracker(AUDIO_LAG_CAP_MS), { n: 1500, stallAt: 500, stallMs, jitter: i => (i * 7919) % 3 });
        expect(dropped(v)).toBeLessThanOrEqual(PROBES_TO_REBASE);
        expect(v.filter(x => x.rebased)).toHaveLength(1);
        expect(dropped(v, 510)).toBe(0);
    });
    it.each([600, 1500])('send: the old tracker dropped ~2 s for the same %i ms stall (control)', (stallMs) => {
        const v = simulate(new LegacyAudioLagTracker(AUDIO_LAG_CAP_MS), { n: 1500, stallAt: 500, stallMs, jitter: i => (i * 7919) % 3 });
        expect(dropped(v)).toBeGreaterThanOrEqual(REBASE_AFTER_MS / 20 - 1);
    });

    // Receive side: the far end's stall arrives as the same step, plus network jitter (0-15 ms, in order).
    const netJitter = (seed: number) => { const r = rng(seed); return () => r() * 15; };
    it('recv: a 1500 ms step through a jittery network costs a handful of frames, not 2 s', () => {
        const v = simulate(new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS), { n: 2000, stallAt: 500, stallMs: 1500, jitter: netJitter(3) });
        expect(dropped(v)).toBeLessThanOrEqual(2 * PROBES_TO_REBASE);
        expect(dropped(v, 520)).toBe(0);
    });
    it('recv: the old tracker dropped ~2 s of it (control)', () => {
        const v = simulate(new LegacyAudioLagTracker(AUDIO_LAG_CAP_RECV_MS), { n: 2000, stallAt: 500, stallMs: 1500, jitter: netJitter(3) });
        expect(dropped(v)).toBeGreaterThanOrEqual(REBASE_AFTER_MS / 20 - 1);
    });
});

describe('an offset sitting AT the receive cap with jitter around it (b_codec_t30_quiet: 59-92 % dropped for 60 s)', () => {
    // A 990 ms step, then 0-40 ms of network jitter: the offset crosses the 1000 ms cap back and forth for a minute.
    const scenario = (t: Tracker) => { const r = rng(11); return simulate(t, { n: 3200, stallAt: 100, stallMs: 990, jitter: () => r() * 40 }); };
    it('is re-based within a few drops, and nothing is dropped after', () => {
        const v = scenario(new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS));
        expect(dropped(v)).toBeLessThanOrEqual(2 * PROBES_TO_REBASE);
        expect(dropped(v, 200)).toBe(0);
    });
    it('the old tracker never re-based it: every dip restarted its 2 s clock (control)', () => {
        const v = scenario(new LegacyAudioLagTracker(AUDIO_LAG_CAP_RECV_MS));
        expect(dropped(v, 200) / (v.length - 200)).toBeGreaterThan(0.2);
        expect(v.some(x => x.rebased)).toBe(false);
    });
    // Every second packet is held back to arrive with the next one, so a dropped packet is always followed at once by
    // the next one, exactly as if it had been waiting in our queue. Only the pass probes can tell: the packet after a
    // PASSED one comes at once too, so it is not our dropping that makes them come early.
    const clumps = (t: Tracker) => simulate(t, { n: 3200, stallAt: 100, stallMs: 995, jitter: i => (i % 2 === 0 ? 20 : 0) + ((i * 37) % 11) });
    it('packets in clumps of two look like a backlog to a drop; the pass probes see through it', () => {
        const v = clumps(new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS));
        expect(dropped(v)).toBeLessThanOrEqual(20);
        expect(dropped(v, 200)).toBe(0);
    });
    // A step at, under and over the cap through a messy network (jitter, 30 % of packets held 30-60 ms = clumps).
    const messy = (t: Tracker, seed: number) => {
        const r = rng(seed * 101);
        const stallMs = 950 + r() * 300;
        const jitter = () => { const x = r(); return x < 0.3 ? 30 + r() * 30 : r() * 25; };
        return simulate(t, { n: 3000, stallAt: 100, stallMs, jitter });
    };
    const seeds = Array.from({ length: 24 }, (_, s) => s + 1);
    it.each(seeds)('seed %i: a step through a messy network costs well under a second, and nothing after', (seed) => {
        const v = messy(new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS), seed);
        expect(dropped(v)).toBeLessThanOrEqual(40); // measured 3-25 frames over these seeds
        expect(dropped(v, 100 + (REBASE_AFTER_MS + 500) / 20)).toBe(0);
    });
    it('the old tracker lost >= 2 s on every one of those seeds (control)', () => {
        for (const seed of seeds) expect(dropped(messy(new LegacyAudioLagTracker(AUDIO_LAG_CAP_RECV_MS), seed))).toBeGreaterThanOrEqual(REBASE_AFTER_MS / 20 - 1);
    });
    it('the old tracker never got there with clumps either (control)', () => {
        const v = clumps(new LegacyAudioLagTracker(AUDIO_LAG_CAP_RECV_MS));
        expect(dropped(v, 300)).toBeGreaterThan(500);
    });
});

describe('the protection the cap exists for is unchanged: a real, growing queue is still dropped', () => {
    it.each([['new', () => new AudioLagTracker()], ['old', () => new LegacyAudioLagTracker()]] as const)('%s: a worker at 26 ms a frame stays bounded, never re-based', (_n, mk) => {
        const v = simulate(mk(), { n: 20_000, svc: () => 26 });
        expect(v.some(x => x.rebased)).toBe(false);
        expect(dropped(v)).toBeGreaterThan(3000); // ~23 % must go for 26 ms of work per 20 ms of audio
        // At most one frame's work over the cap: the couple of pass probes that told it is a backlog.
        expect(Math.max(...v.filter(x => !x.drop).map(x => x.excessMs))).toBeLessThanOrEqual(AUDIO_LAG_CAP_MS + 26);
        expect(v.filter(x => !x.drop && x.excessMs > AUDIO_LAG_CAP_MS).length).toBeLessThanOrEqual(PASS_PROBES_TO_REBASE);
    });
    it('a worker blocked 1 s and then slower than real time: the backlog it starts with is not mistaken for a step', () => {
        const v = simulate(new AudioLagTracker(), { n: 10_000, blockAtMs: 20_000, blockMs: 1000, svc: () => 22 });
        expect(v.some(x => x.rebased)).toBe(false);
        expect(Math.max(...v.filter(x => !x.drop).map(x => x.excessMs))).toBeLessThanOrEqual(AUDIO_LAG_CAP_MS + 22);
    });
    it('a 2 s worker block: the stale frames it releases at once are dropped, fresh ones after are not', () => {
        const v = simulate(new AudioLagTracker(), { n: 1000, blockAtMs: 10_000 + 200 * 20, blockMs: 2000 });
        expect(dropped(v, 200, 300)).toBeGreaterThan(80);
        expect(v.some(x => x.rebased)).toBe(false);
        expect(dropped(v, 320)).toBe(0);
    });
});

describe('AudioLagTracker', () => {
    it('on-time frames: zero excess, nothing dropped', () => {
        const v = run(new AudioLagTracker(), 500, () => 0);
        expect(v.every(x => !x.drop && x.excessMs < 1)).toBe(true);
    });

    it('ordinary jitter below the cap passes', () => {
        const v = run(new AudioLagTracker(), 500, i => (i % 7) * 30);
        expect(v.some(x => x.drop)).toBe(false);
    });

    it('a worker slower than real time: the lag is capped instead of growing (dropping drains the queue)', () => {
        // Frames arrive every 20 ms; the starved worker needs 26 ms per frame it
        // actually processes and ~0 for one it drops. Without the cap the lag grows
        // 6 ms per frame forever (a minute in ~3.5 min); with it, it stays bounded.
        const t = new AudioLagTracker();
        let free = 0;
        let maxPassedExcess = 0;
        let dropped = 0;
        for (let i = 0; i < 20_000; i++) {
            const arrival = i * 20;
            const start = Math.max(arrival, free);
            const v = t.observe((i * TICK) >>> 0, start);
            if (v.drop) { dropped++; free = start + 0.1; } else { maxPassedExcess = Math.max(maxPassedExcess, v.excessMs); free = start + 26; }
            expect(v.rebased).toBe(false);
        }
        expect(dropped).toBeGreaterThan(0);
        // + one frame's work: the pass probes that tell this backlog from packets arriving in clumps
        expect(maxPassedExcess).toBeLessThanOrEqual(AUDIO_LAG_CAP_MS + 26);
        // Without the cap the last frame would be (26-20)*20000 = 120 s late.
        expect(free - 20_000 * 20).toBeLessThan(AUDIO_LAG_CAP_MS + 30);
    });

    it('a backlog that drains when we drop stops being dropped once fresh frames arrive', () => {
        // 2 s stall then the queue flushes: frames 100..199 arrive late by a shrinking amount.
        const delay = (i: number) => (i < 100 ? 0 : i < 200 ? Math.max(0, 2000 - (i - 100) * 40) : 0);
        const v = run(new AudioLagTracker(), 300, delay);
        expect(v.slice(100, 140).some(x => x.drop)).toBe(true);
        expect(v.slice(200).every(x => !x.drop)).toBe(true);
    });

    it('a constant offset jump that dropping cannot drain is re-based after PROBES_TO_REBASE drops, not dropped forever', () => {
        // The source paused 5 s without advancing its timestamp: every later frame is "5 s late" at real-time pace.
        const v = run(new AudioLagTracker(), 600, i => (i >= 100 ? 5000 : 0));
        const rebased = v.findIndex(x => x.rebased);
        expect(rebased).toBe(100 + PROBES_TO_REBASE);
        expect(v.filter(x => x.drop)).toHaveLength(PROBES_TO_REBASE);
        expect(v.slice(rebased + 1).every(x => !x.drop)).toBe(true);
    });

    describe('a timestamp jump of hours is a new RTP timeline, not a queue (staging.178-187: "lag 41,566,318 ms")', () => {
        // The jump the field reports show, as RTP ticks BACKWARDS (offset up => "late").
        const jumpTicks = (ms: number) => Math.round((ms / 1000) * 48_000);

        it.each([4_824_165, 11_085_787, 19_328_278, 34_908_048, 41_566_318])('a %i ms step is re-based on the spot and not one frame is dropped', (ms) => {
            const t = new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS);
            const v: ReturnType<AudioLagTracker['observe']>[] = [];
            for (let i = 0; i < 400; i++) {
                const ts = (1000 + i * TICK - (i >= 100 ? jumpTicks(ms) : 0)) >>> 0;
                v.push(t.observe(ts, 10_000 + i * 20));
            }
            expect(v.filter(x => x.drop)).toHaveLength(0);
            expect(v.filter(x => x.rebased)).toHaveLength(1);
            expect(v.findIndex(x => x.rebased)).toBe(100);
            // And the lag it reports is not the jump (the stats window must not say "41 million ms").
            expect(v[100].excessMs).toBe(0);
        });

        it('a step just under the limit takes the probe path: PROBES_TO_REBASE frames, not the old 2 s hole', () => {
            const t = new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS);
            const v: ReturnType<AudioLagTracker['observe']>[] = [];
            for (let i = 0; i < 400; i++) {
                const ts = (1000 + i * TICK - (i >= 100 ? jumpTicks(IMPLAUSIBLE_LAG_MS - 1000) : 0)) >>> 0;
                v.push(t.observe(ts, 10_000 + i * 20));
            }
            expect(v.filter(x => x.drop).length).toBe(PROBES_TO_REBASE);
        });

        it('a genuine multi-second backlog is still dropped to catch up', () => {
            // The worker stalls 8 s; the 400 frames that queued meanwhile are then handed over back to back.
            const v = simulate(new AudioLagTracker(AUDIO_LAG_CAP_RECV_MS), { n: 1000, blockAtMs: 10_000 + 100 * 20, blockMs: 8000 });
            const queued = v.slice(100, 500);
            expect(queued.filter(x => x.drop).length).toBeGreaterThan(300);
            expect(v.some(x => x.rebased)).toBe(false);
        });
    });

    it('clock drift within 500 ppm never trips the cap over an hour', () => {
        const t = new AudioLagTracker();
        let dropped = 0;
        // Sender clock 300 ppm slow: arrivals drift later by 0.3 ms per second.
        for (let i = 0; i < 180_000; i++) {
            const v = t.observe((i * TICK) >>> 0, i * 20 * 1.0003);
            if (v.drop) dropped++;
        }
        expect(dropped).toBe(0);
    });

    it('handles the 32-bit RTP timestamp wrap', () => {
        const v = run(new AudioLagTracker(), 200, () => 0, 0xffffffff - 50 * TICK);
        expect(v.every(x => !x.drop && x.excessMs < 1)).toBe(true);
    });
});

describe('audioRtpTimestamp', () => {
    it('reads metadata.rtpTimestamp, falls back to timestamp, ignores video frames', () => {
        expect(audioRtpTimestamp({ getMetadata: () => ({ rtpTimestamp: 42 }), timestamp: 7 })).toBe(42);
        expect(audioRtpTimestamp({ timestamp: 7 })).toBe(7);
        expect(audioRtpTimestamp({ type: 'key', timestamp: 7 })).toBeNull();
        expect(audioRtpTimestamp(null)).toBeNull();
    });
});

async function pump<T>(stage: TransformStream<T, T>, frames: T[]): Promise<T[]> {
    const out: T[] = [];
    const reader = stage.readable.getReader();
    const reading = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; out.push(r.value); } })();
    const w = stage.writable.getWriter();
    for (const f of frames) await w.write(f);
    await w.close();
    await reading;
    return out;
}

describe('createAudioLagStage', () => {
    it('drops over-cap audio, passes video untouched, reports a window', async () => {
        let t = 0;
        const windows: AudioLagStats[] = [];
        const stage = createAudioLagStage<Record<string, unknown>>('send', s => windows.push(s), () => t);
        const frames: Record<string, unknown>[] = [];
        for (let i = 0; i < 1000; i++) {
            frames.push({ timestamp: i * TICK, at: i < 500 ? i * 20 : i * 20 + 600 });
            if (i % 10 === 0) frames.push({ type: 'delta', timestamp: i * 90, video: true });
        }
        const out: Record<string, unknown>[] = [];
        const reader = stage.readable.getReader();
        const reading = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; out.push(r.value); } })();
        const w = stage.writable.getWriter();
        for (const f of frames) { if (typeof f.at === 'number') t = f.at; await w.write(f); }
        await w.close();
        await reading;
        expect(out.filter(f => f.video).length).toBe(100);
        const audioOut = out.filter(f => !f.video).length;
        expect(audioOut).toBeLessThan(1000);
        expect(windows.some(s => s.dir === 'send' && s.dropped > 0 && s.maxMs > AUDIO_LAG_CAP_MS)).toBe(true);
    });

    it('incoming uses the looser cap (network jitter lands in the offset too)', async () => {
        let t = 0;
        const stage = createAudioLagStage<Record<string, unknown>>('recv', () => {}, () => t);
        const frames = Array.from({ length: 300 }, (_, i) => ({ timestamp: i * TICK, at: i * 20 + (i === 150 ? AUDIO_LAG_CAP_MS + 200 : 0) }));
        const out: unknown[] = [];
        const reader = stage.readable.getReader();
        const reading = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; out.push(r.value); } })();
        const w = stage.writable.getWriter();
        for (const f of frames) { t = f.at; await w.write(f); }
        await w.close();
        await reading;
        expect(AUDIO_LAG_CAP_RECV_MS).toBeGreaterThan(AUDIO_LAG_CAP_MS + 200);
        expect(out.length).toBe(300);
    });

    it('never throws on odd frames', async () => {
        const out = await pump(createAudioLagStage<unknown>('send', () => {}), [{}, 'x', { timestamp: NaN }]);
        expect(out.length).toBe(3);
    });
});

describe('audioLagStatsFromMessage', () => {
    it('parses only its own kind', () => {
        expect(audioLagStatsFromMessage({ kind: AUDIO_LAG_STATS_KIND, data: { dir: 'recv', frames: 5, dropped: 1, maxMs: 300, rebases: 0 } }))
            .toEqual({ dir: 'recv', frames: 5, dropped: 1, maxMs: 300, rebases: 0 });
        expect(audioLagStatsFromMessage({ kind: 'cl:annexb-stats', data: {} })).toBeNull();
        expect(audioLagStatsFromMessage({ kind: AUDIO_LAG_STATS_KIND, data: { dir: 'sideways' } })).toBeNull();
    });
});

describe('wiring into the E2EE worker wrapper', () => {
    it('encode AND decode streams get the audio-lag stage before LiveKit sees them', () => {
        const seen: unknown[] = [];
        const scope = { onmessage: ((ev: MessageEvent) => { seen.push(ev.data); }) as ((ev: MessageEvent) => unknown) | null, postMessage: () => {} };
        expect(installAnnexBCanonicalizer(scope)).toBe(true);
        const enc = new ReadableStream();
        const dec = new ReadableStream();
        scope.onmessage!({ data: { kind: 'encode', data: { readableStream: enc, trackId: 't' } } } as MessageEvent);
        scope.onmessage!({ data: { kind: 'decode', data: { readableStream: dec, trackId: 'r' } } } as MessageEvent);
        const [e, d] = seen as Array<{ data: { readableStream: ReadableStream } }>;
        expect(e.data.readableStream).not.toBe(enc);
        expect(d.data.readableStream).not.toBe(dec);
        expect(enc.locked).toBe(true);
        expect(dec.locked).toBe(true);
    });
    it('stats window is reported at most every AUDIO_LAG_STATS_EVERY_MS', () => {
        expect(AUDIO_LAG_STATS_EVERY_MS).toBeGreaterThanOrEqual(5000);
    });
});
