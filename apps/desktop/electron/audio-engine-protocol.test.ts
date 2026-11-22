import { describe, it, expect } from 'vitest';
import { parseWorkletMessage, FrameGate, STALE_MS, NATIVE_FRAME, MAX_SEQ } from './audio-engine-protocol';

const frame = (seq: unknown, pcm: unknown = new Float32Array(NATIVE_FRAME), ts: unknown = 1) => ({ t: 'f', seq, ts, pcm });

describe('parseWorkletMessage: only PCM frames, settings and numbers get through', () => {
    it('accepts a well-formed frame, settings, device change, gain and stats', () => {
        expect(parseWorkletMessage(frame(0))?.t).toBe('f');
        expect(parseWorkletMessage(frame(MAX_SEQ - 1))?.t).toBe('f');
        expect(parseWorkletMessage({ t: 's', id: 3, noise: 2, autoGain: true, manualGainDb: 0, originalSound: false })).toMatchObject({ t: 's', noise: 2 });
        expect(parseWorkletMessage({ t: 'dc', hasGain: true, gainDb: 5 })).toEqual({ t: 'dc', hasGain: true, gainDb: 5 });
        expect(parseWorkletMessage({ t: 'g', db: -3 })).toEqual({ t: 'g', db: -3 });
        expect(parseWorkletMessage({ t: 'gate', enabled: true, thresholdDb: -42 })).toEqual({ t: 'gate', enabled: true, thresholdDb: -42 });
        expect(parseWorkletMessage({ t: 'gate', enabled: false, thresholdDb: 50 })).toEqual({ t: 'gate', enabled: false, thresholdDb: 0 });
        expect(parseWorkletMessage({ t: 'gate', enabled: true, thresholdDb: -500 })).toMatchObject({ thresholdDb: -100 });
        for (const bad of [{ enabled: 1, thresholdDb: -40 }, { enabled: true, thresholdDb: NaN }, { enabled: true, thresholdDb: '-40' }, { enabled: true }]) expect(parseWorkletMessage({ t: 'gate', ...bad })).toBeNull();
        expect(parseWorkletMessage({ t: 'stats' })).toEqual({ t: 'stats' });
        expect(parseWorkletMessage({ t: 'bye' })).toEqual({ t: 'bye' });
    });

    it('rejects a frame that is not exactly 480 floats of a Float32Array', () => {
        for (const len of [0, 1, 128, 479, 481, 960, 4800]) expect(parseWorkletMessage(frame(1, new Float32Array(len))), `len ${len}`).toBeNull();
        expect(parseWorkletMessage(frame(1, new Float64Array(NATIVE_FRAME)))).toBeNull();
        expect(parseWorkletMessage(frame(1, new Int16Array(NATIVE_FRAME)))).toBeNull();
        expect(parseWorkletMessage(frame(1, new Array(NATIVE_FRAME).fill(0)))).toBeNull();
        expect(parseWorkletMessage(frame(1, new Uint8Array(NATIVE_FRAME * 4)))).toBeNull();
        expect(parseWorkletMessage(frame(1, 'x'.repeat(NATIVE_FRAME)))).toBeNull();
        expect(parseWorkletMessage(frame(1, null))).toBeNull();
    });

    it('rejects bad sequence numbers and timestamps', () => {
        for (const seq of [-1, 1.5, NaN, Infinity, MAX_SEQ, 2 ** 60, '1', null, undefined, {}]) expect(parseWorkletMessage(frame(seq)), String(seq)).toBeNull();
        for (const ts of [NaN, Infinity, 'x', null]) expect(parseWorkletMessage(frame(1, new Float32Array(NATIVE_FRAME), ts))).toBeNull();
    });

    it('settings: enum, booleans and a finite gain (clamped to +-40 dB) or nothing', () => {
        const ok = { t: 's', id: 1, noise: 2, autoGain: false, manualGainDb: 99, originalSound: false };
        expect(parseWorkletMessage(ok)).toMatchObject({ manualGainDb: 40 });
        expect(parseWorkletMessage({ ...ok, manualGainDb: -99 })).toMatchObject({ manualGainDb: -40 });
        for (const bad of [{ noise: 4 }, { noise: -1 }, { noise: 1.5 }, { noise: '2' }, { autoGain: 1 }, { originalSound: 'no' }, { manualGainDb: NaN }, { manualGainDb: '3' }, { id: -1 }, { id: 1.2 }]) {
            expect(parseWorkletMessage({ ...ok, ...bad }), JSON.stringify(bad)).toBeNull();
        }
        expect(parseWorkletMessage({ t: 'dc', hasGain: 1, gainDb: 1 })).toBeNull();
        expect(parseWorkletMessage({ t: 'dc', hasGain: true, gainDb: NaN })).toBeNull();
        expect(parseWorkletMessage({ t: 'g', db: Infinity })).toBeNull();
    });

    it('drops everything else: unknown types, junk, prototype tricks, extra payload fields never reach the host', () => {
        for (const m of [null, undefined, 1, 'f', [], {}, { t: 'x' }, { t: 'eval', code: '1' }, { t: ['f'] }, { type: 'f' }, () => 1, Symbol.iterator]) expect(parseWorkletMessage(m)).toBeNull();
        const parsed = parseWorkletMessage({ t: 'stats', extra: 'x', __proto__: { t: 'f' } } as unknown);
        expect(parsed).toEqual({ t: 'stats' });
        const f = parseWorkletMessage({ ...frame(7), evil: 'rm -rf', path: '/etc/passwd' }) as unknown as Record<string, unknown>;
        expect(Object.keys(f).sort()).toEqual(['pcm', 'seq', 't', 'ts']);
    });
});

describe('FrameGate: sequence numbers and staleness (age = host Date.now() - the worklet\'s send stamp)', () => {
    it('processes strictly increasing frames; duplicates and older frames are dropped, gaps are counted', () => {
        const g = new FrameGate();
        expect(g.judge(0, 1000, 1000)).toEqual({ act: 'process', gap: 0 });
        expect(g.judge(1, 1010, 1010)).toEqual({ act: 'process', gap: 0 });
        expect(g.judge(1, 1011, 1010)).toEqual({ act: 'drop', why: 'dup' });
        expect(g.judge(0, 1012, 1000)).toEqual({ act: 'drop', why: 'old' });
        expect(g.judge(5, 1050, 1050)).toEqual({ act: 'process', gap: 3 });
        expect(g.lost).toBe(3);
        expect(g.dropped).toEqual({ dup: 1, old: 1, stale: 0 });
    });

    it('a frame older than 60 ms is stale and does not advance the sequence; a fresh one right after is processed with a gap', () => {
        const g = new FrameGate();
        g.judge(0, 1000, 1000); g.judge(1, 1010, 1010); g.judge(2, 1020, 1020);
        expect(g.judge(3, 1030 + STALE_MS + 5, 1030)).toEqual({ act: 'drop', why: 'stale' });
        expect(g.lastSeq).toBe(2);
        expect(g.judge(3 + 7, 1100, 1099)).toEqual({ act: 'process', gap: 7 });
        expect(g.judge(11, 1110, 1000 + 110 - STALE_MS)).toEqual({ act: 'process', gap: 0 }); // exactly at the limit is still fresh
    });

    it('a backlog after a long block (a 1 s model rebuild) is dropped as stale, not processed', () => {
        const g = new FrameGate();
        for (let s = 0; s < 50; s++) g.judge(s, 1000 + s * 10, 1000 + s * 10);
        let processed = 0;
        for (let s = 50; s < 150; s++) if (g.judge(s, 2500, 1000 + s * 10).act === 'process') processed++;    // queued during the block, all arrive at t = 2.5 s
        expect(processed).toBeLessThan(8);
        expect(g.dropped.stale).toBeGreaterThan(90);
    });

    it('there is no clock to drift: a stream whose audio clock runs slow, or races ahead then settles, is never judged stale', () => {
        const g = new FrameGate();
        let stale = 0;
        for (let s = 0; s < 360_000; s++) {
            const sent = 1_000_000 + s * 10 * 1.0003;   // the audio clock 300 ppm slow against the wall clock
            if (g.judge(s, sent + 1, sent).act === 'drop') stale++; // ... one-way delay 1 ms
        }
        expect(stale).toBe(0);
        // the audio thread starved, then rendered 200 ms of frames in a burst: their stamps are the (late) send times, so the ages are small
        const h = new FrameGate();
        for (let s = 0; s < 100; s++) h.judge(s, 5000 + s * 10, 5000 + s * 10);
        for (let s = 100; s < 120; s++) expect(h.judge(s, 6200 + s, 6200 + s - 1).act).toBe('process');
        for (let s = 120; s < 400; s++) expect(h.judge(s, 6400 + s * 10, 6400 + s * 10).act).toBe('process');
    });

    it('a stepped system clock (stamp far in the past or the future) never kills the stream', () => {
        const g = new FrameGate();
        expect(g.judge(0, 1_000_000, 1_000_000).act).toBe('process');
        expect(g.judge(1, 1_000_010 + 3_600_000, 1_000_010).act).toBe('process');   // clock stepped forward an hour: age > CLOCK_JUMP_MS
        expect(g.judge(2, 1_000_020, 1_000_020 + 3_600_000).act).toBe('process');   // stamp ahead: age negative
    });

    it('reset starts a new stream', () => {
        const g = new FrameGate();
        g.judge(100, 1000, 1000);
        g.reset();
        expect(g.judge(0, 1005, 1005)).toEqual({ act: 'process', gap: 0 });
    });
});
