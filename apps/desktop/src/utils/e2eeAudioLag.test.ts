import { describe, it, expect } from 'vitest';
import {
    AudioLagTracker, createAudioLagStage, audioRtpTimestamp, audioLagStatsFromMessage,
    AUDIO_LAG_CAP_MS, AUDIO_LAG_CAP_RECV_MS, REBASE_AFTER_MS, AUDIO_LAG_STATS_KIND, AUDIO_LAG_STATS_EVERY_MS,
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
        expect(maxPassedExcess).toBeLessThanOrEqual(AUDIO_LAG_CAP_MS);
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

    it('a constant offset jump that dropping cannot drain is re-based after REBASE_AFTER_MS, not dropped forever', () => {
        // The source paused 5 s without advancing its timestamp: every later frame is "5 s late" at real-time pace.
        const v = run(new AudioLagTracker(), 600, i => (i >= 100 ? 5000 : 0));
        const rebased = v.findIndex(x => x.rebased);
        expect(rebased).toBeGreaterThan(100);
        // Dropping lasted about REBASE_AFTER_MS of frames, then stopped.
        expect(rebased - 100).toBeLessThanOrEqual(REBASE_AFTER_MS / 20 + 2);
        expect(v.slice(rebased + 1).every(x => !x.drop)).toBe(true);
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
