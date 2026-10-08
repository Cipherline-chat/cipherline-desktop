import { describe, expect, it } from 'vitest';
import {
    PCM_RING_PREBUFFER_MS, PCM_RING_TRIM_ABOVE_MS, PCM_RING_WORKLET_SOURCE,
} from './pcmRingWorkletSource';

// Run the real worklet source against a fake AudioWorkletGlobalScope.
const SR = 48000;
const Q = 128;          // render quantum
const CHUNK = 480;      // 10 ms of native capture per IPC chunk

interface Ring {
    available: number;
    started: boolean;
    trims: number;
    port: { onmessage: (e: { data: unknown }) => void; posted: unknown[] };
    process(i: unknown, o: Float32Array[][]): boolean;
}

function makeRing(): Ring {
    let Proc: (new () => Ring) | null = null;
    class FakeAWP {
        // onmessage is replaced by the processor's constructor.
        port = { onmessage: null as unknown, posted:[] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PCM_RING_WORKLET_SOURCE)(
        FakeAWP, (_n: string, c: new () => Ring) => { Proc = c; }, SR,
    );
    return new Proc!();
}

/** Push one stereo chunk whose samples encode a running frame counter. */
let counter = 0;
function push(r: Ring, frames = CHUNK) {
    const pcm = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) { pcm[f * 2] = counter; pcm[f * 2 + 1] = counter; counter++; }
    r.port.onmessage({ data: { type: 'pcm', pcm, channels: 2 } });
}
function pull(r: Ring): Float32Array {
    const out = [[new Float32Array(Q), new Float32Array(Q)]];
    r.process([], out);
    return out[0][0];
}
const ms = (frames: number) => (frames / SR) * 1000;

/** Simulate `seconds` of a steady stream: 10 ms chunks in, quanta out at the same rate. */
function steady(r: Ring, seconds: number, quantaPerBurst = 1) {
    let produced = 0; let consumed = 0;
    const total = seconds * SR;
    while (consumed < total) {
        while (produced <= consumed + CHUNK) { push(r); produced += CHUNK; }
        for (let i = 0; i < quantaPerBurst; i++) { pull(r); consumed += Q; }
    }
}

describe('PCM ring worklet (screen-share system audio)', () => {
    it('primes to the prebuffer before playing (unchanged behaviour)', () => {
        const r = makeRing();
        push(r, 960); // 20 ms < 40 ms prebuffer
        expect(pull(r).every(x => x === 0)).toBe(true);
        expect(r.started).toBe(false);
        push(r, 960);
        pull(r);
        expect(r.started).toBe(true);
    });

    it('a steady stream is never trimmed', () => {
        const r = makeRing();
        push(r, SR * PCM_RING_PREBUFFER_MS / 1000);
        steady(r, 10);
        expect(r.trims).toBe(0);
        expect(ms(r.available)).toBeLessThan(PCM_RING_TRIM_ABOVE_MS);
    });

    it('bursty render pulls (a playback-latency context) are not mistaken for excess', () => {
        const r = makeRing();
        push(r, SR * 0.1); // 100 ms cushion: needed for 85 ms render bursts
        steady(r, 10, 32); // 32 quanta ≈ 85 ms per burst
        expect(r.trims).toBe(0);
    });

    it('a stall backlog is trimmed back to the prebuffer within ~1 s, instead of persisting', () => {
        const r = makeRing();
        push(r, SR * PCM_RING_PREBUFFER_MS / 1000);
        steady(r, 1);
        // Main thread stalled 500 ms, then the queued chunks arrive at once.
        for (let i = 0; i < 50; i++) push(r);
        expect(ms(r.available)).toBeGreaterThan(500);
        steady(r, 2.5);
        expect(r.trims).toBe(1);
        expect(ms(r.available)).toBeLessThan(PCM_RING_TRIM_ABOVE_MS);
        const msg = r.port.posted.find((m): m is { type: string; droppedMs: number } => (m as { type?: string }).type === 'trim');
        expect(msg!.droppedMs).toBeGreaterThan(450);
    });

    it('trim skips the OLDEST audio: output continues from newer frames, in order', () => {
        const r = makeRing();
        push(r, SR * PCM_RING_PREBUFFER_MS / 1000);
        steady(r, 1);
        for (let i = 0; i < 50; i++) push(r);
        const before = pull(r)[0];
        steady(r, 1.5);
        const after = pull(r);
        // Monotonic within a quantum, and the jump over the trim is forward.
        for (let i = 1; i < Q; i++) expect(after[i]).toBe(after[i - 1] + 1);
        expect(after[0]).toBeGreaterThan(before);
    });

    it('a capture clock running 1 % fast stays bounded (no ratchet)', () => {
        const r = makeRing();
        push(r, SR * PCM_RING_PREBUFFER_MS / 1000);
        let produced = 0; let consumed = 0;
        for (let t = 0; t < 30 * SR; t += Q) {
            while (produced <= consumed * 1.01 + CHUNK) { push(r); produced += CHUNK; }
            pull(r); consumed += Q;
        }
        // 30 s at +1 % would have queued ~300 ms; trimmed it stays under the bar.
        expect(ms(r.available)).toBeLessThan(PCM_RING_TRIM_ABOVE_MS + 20);
        expect(r.trims).toBeGreaterThan(0);
    });

    it('underrun still re-arms the prebuffer (unchanged behaviour)', () => {
        const r = makeRing();
        push(r, SR * PCM_RING_PREBUFFER_MS / 1000);
        while (r.available >= Q) pull(r);
        expect(pull(r).every(x => x === 0)).toBe(true);
        expect(r.started).toBe(false);
    });
});
