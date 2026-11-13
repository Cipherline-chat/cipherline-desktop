import { describe, it, expect } from 'vitest';
import {
    ShareRxStallRecovery, FLUSH_MAX_MS, RETRY_AFTER_MS, RETRY_MAX_MS, ATTEMPT_WINDOW_MS,
    type StallFlushDetail,
} from './shareRxStallRecovery';
import { RxStallWatch } from './shareRxStall';
import type { ShareRxSnapshot } from './shareRxStats';

function rig(o: { cap?: boolean; h265?: boolean } = {}) {
    const s = {
        t: 0, paused: 0, resumed: 0, caps: 0, withdrawals: 0,
        logs: [] as StallFlushDetail[],
        timers: new Map<number, { at: number; cb: () => void }>(),
    };
    let nextTimer = 1;
    const rec = new ShareRxStallRecovery({
        now: () => s.t,
        pause: () => { s.paused++; return () => { s.resumed++; }; },
        cap: () => { s.caps++; return o.cap ?? false; },
        withdrawH265: () => { s.withdrawals++; return o.h265 ?? true; },
        log: d => s.logs.push(d),
        setTimer: (cb, ms) => { const id = nextTimer++; s.timers.set(id, { at: s.t + ms, cb }); return id; },
        clearTimer: h => { s.timers.delete(h as number); },
    });
    const advance = (ms: number) => {
        s.t += ms;
        for (const [id, x] of [...s.timers]) if (x.at <= s.t) { s.timers.delete(id); x.cb(); }
    };
    return { s, rec, advance };
}

describe('ShareRxStallRecovery', () => {
    it('does nothing while the share is healthy', () => {
        const { s, rec } = rig();
        rec.tick(false, 100);
        expect(s.paused).toBe(0);
        expect(s.logs).toEqual([]);
    });

    it('first attempt: pauses the input only, and resumes as soon as the drain shows', () => {
        const { s, rec, advance } = rig();
        rec.tick(true, 500);
        expect(rec.flushing).toBe(true);
        expect(s).toMatchObject({ paused: 1, resumed: 0, caps: 0, withdrawals: 0 });
        expect(s.logs[0]).toEqual({ phase: 'start', attempt: 1, cap: false, h264: false });

        advance(1000);
        rec.decoded(500); // not yet
        expect(s.resumed).toBe(0);
        advance(1000);
        rec.decoded(510); // the last 10 frames came out
        expect(rec.flushing).toBe(false);
        expect(s.resumed).toBe(1);
        expect(s.logs[1]).toEqual({ phase: 'end', attempt: 1, drained: true, ms: 2000 });
        expect(s.timers.size).toBe(0);
    });

    it('never holds the pause past FLUSH_MAX_MS, even if stats never answer', () => {
        const { s, rec, advance } = rig();
        rec.tick(true, 500);
        advance(FLUSH_MAX_MS - 1);
        expect(s.resumed).toBe(0);
        advance(1);
        expect(s.resumed).toBe(1);
        expect(s.logs[1]).toEqual({ phase: 'end', attempt: 1, drained: false, ms: FLUSH_MAX_MS });
    });

    it('an unreadable stats reading is not a drain', () => {
        const { s, rec } = rig();
        rec.tick(true, 500);
        rec.decoded(undefined);
        expect(rec.flushing).toBe(true);
        expect(s.resumed).toBe(0);
    });

    it('does not start a second flush on top of one', () => {
        const { s, rec } = rig();
        rec.tick(true, 500);
        rec.tick(true, 500);
        expect(s.paused).toBe(1);
    });

    it('gives the resume RETRY_AFTER_MS to work before trying again', () => {
        const { s, rec, advance } = rig();
        rec.tick(true, 500);
        advance(1000);
        rec.decoded(510);
        advance(RETRY_AFTER_MS - 1);
        rec.tick(true, 510);
        expect(s.paused).toBe(1);
        advance(1);
        rec.tick(true, 510);
        expect(s.paused).toBe(2);
    });

    /** Run attempts one after another until `n` have started; returns the rig. */
    function attempts(n: number, o: { cap?: boolean; h265?: boolean } = {}) {
        const r = rig(o);
        let frames = 500;
        for (let i = 0; i < n; i++) {
            r.rec.tick(true, frames);
            if (i < n - 1) { frames += 10; r.advance(1000); r.rec.decoded(frames); r.advance(RETRY_MAX_MS); }
        }
        return r;
    }

    it('second attempt in the window: also asks for the lighter copy', () => {
        const { s } = attempts(2, { cap: true });
        expect(s.caps).toBe(1);
        expect(s.withdrawals).toBe(0);
        expect(s.logs.at(-1)).toEqual({ phase: 'start', attempt: 2, cap: true, h264: false });
    });

    it('third attempt, lighter copy granted: stays on H.265', () => {
        const { s } = attempts(3, { cap: true });
        expect(s.withdrawals).toBe(0);
        expect(s.logs.at(-1)).toMatchObject({ attempt: 3, cap: true, h264: false });
    });

    it('third attempt, no lighter copy to go to: withdraws H.265 decode, once', () => {
        const { s, rec, advance } = attempts(3, { cap: false });
        expect(s.withdrawals).toBe(1);
        expect(s.logs.at(-1)).toMatchObject({ attempt: 3, cap: false, h264: true });
        advance(1000);
        rec.decoded(9999);
        advance(RETRY_MAX_MS);
        rec.tick(true, 9999);
        expect(s.withdrawals).toBe(1);
    });

    it('a share that is not H.265 reports no withdrawal, and may ask again', () => {
        const { s } = attempts(3, { cap: false, h265: false });
        expect(s.logs.at(-1)).toMatchObject({ h264: false });
    });

    it('a quiet spell forgets the trouble: the next stall is a first attempt again', () => {
        const { s, rec, advance } = rig({ cap: true });
        rec.tick(true, 500);
        advance(1000);
        rec.decoded(510);
        advance(ATTEMPT_WINDOW_MS);
        rec.tick(true, 510);
        expect(s.logs.at(-1)).toEqual({ phase: 'start', attempt: 1, cap: false, h264: false });
        expect(s.caps).toBe(0);
    });

    it('backs off on a decoder that never recovers, up to RETRY_MAX_MS', () => {
        const { s, rec, advance } = rig();
        const gaps: number[] = [];
        let lastEnd = 0;
        for (let i = 0; i < 9; i++) {
            let waited = 0;
            while (!rec.flushing && waited <= RETRY_MAX_MS) {
                rec.tick(true, 500);
                if (!rec.flushing) { advance(100); waited += 100; }
            }
            if (i > 0) gaps.push(s.t - lastEnd);
            advance(FLUSH_MAX_MS);
            lastEnd = s.t;
        }
        expect(gaps.slice(0, 2)).toEqual([RETRY_AFTER_MS, RETRY_AFTER_MS]);
        expect(gaps[2]).toBe(RETRY_AFTER_MS);
        expect(gaps[3]).toBe(RETRY_AFTER_MS * 2);
        expect(gaps[4]).toBe(RETRY_AFTER_MS * 4);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(RETRY_MAX_MS);
        // Every pause was resumed.
        expect(s.resumed).toBe(s.paused);
    });

    it('stop() resumes a share that went away mid-flush, logs nothing and cancels the timer', () => {
        const { s, rec, advance } = rig();
        rec.tick(true, 500);
        rec.stop();
        expect(s.resumed).toBe(1);
        expect(rec.flushing).toBe(false);
        expect(s.logs).toHaveLength(1);
        expect(s.timers.size).toBe(0);
        advance(FLUSH_MAX_MS);
        expect(s.resumed).toBe(1);
        rec.stop();
        expect(s.resumed).toBe(1);
    });
});

/**
 * The stall as the reports describe it, end to end through the real watch and the
 * real recovery, on a MODEL of the browser built from its source: an unbounded queue
 * in front of a decoder of fixed throughput (RTCVideoDecoderAdapter, HEVC: no
 * overflow guard), and libwebrtc's memory of the last 10 frames (generic_decoder.cc).
 * It proves the logic against that description; it is not a hardware reproduction.
 */
class BrowserModel {
    received = 0; decoded = 0; dropped = 0; emitted = 0; kfRequests = 0;
    private nextFrame = 0;
    private queue: number[] = [];
    private memory: number[] = [];
    private credit = 0;
    private readonly capacityFps: number;
    constructor(capacityFps: number) { this.capacityFps = capacityFps; }

    /** One millisecond: maybe a frame arrives, maybe the decoder finishes one. */
    step(inputFps: number, slowFps?: number): void {
        if (inputFps > 0 && Math.floor((this.ms + 1) * inputFps / 1000) > Math.floor(this.ms * inputFps / 1000)) {
            const f = this.nextFrame++;
            this.received++;
            this.emitted++;
            if (this.memory.length === 10) { this.memory.shift(); this.dropped++; }
            this.memory.push(f);
            this.queue.push(f);
        }
        this.credit += (slowFps ?? this.capacityFps) / 1000;
        while (this.credit >= 1 && this.queue.length) {
            this.credit -= 1;
            const out = this.queue.shift() as number;
            const at = this.memory.indexOf(out);
            if (at >= 0) { this.dropped += at; this.memory.splice(0, at + 1); this.decoded++; }
        }
        if (!this.queue.length) this.credit = Math.min(this.credit, 1);
        this.ms++;
    }
    ms = 0;
    get depth(): number { return this.queue.length; }
    snapshot(at: number): ShareRxSnapshot {
        return {
            at, framesReceived: this.received, framesDecoded: this.decoded, framesDropped: this.dropped,
            jbDelay: 0, jbEmitted: this.emitted, keyFrames: 1, kfRequests: this.kfRequests,
            width: 2560, height: 1440, decoder: 'ExternalDecoder (D3D11VideoDecoder)', codec: 'h265',
        };
    }
}

describe('the stall on a model of the browser', () => {
    // An assumed decoder: the reports bound its throughput from below (91 fps decoded), nothing measures it.
    const CAPACITY = 90;

    function run(recover: boolean, INPUT = 88) {
        const b = new BrowserModel(CAPACITY);
        const watch = new RxStallWatch();
        const events: Array<{ t: number; d: Record<string, string | number | boolean> }> = [];
        let paused = false;
        const r = rig();
        const rec = new ShareRxStallRecovery({
            now: () => b.ms,
            pause: () => { paused = true; return () => { paused = false; }; },
            cap: () => false,
            withdrawH265: () => false,
            log: d => r.s.logs.push(d),
            setTimer: (cb, ms) => { const at = b.ms + ms; timers.push({ at, cb }); return at; },
            clearTimer: h => { timers = timers.filter(t => t.at !== h); },
        });
        let timers: Array<{ at: number; cb: () => void }> = [];
        const END_MS = 60_000;
        let stalledAt = -1, movingAt = -1;
        const rates: Array<{ t: number; dec: number; drop: number; rx: number }> = [];
        let last = b.snapshot(0);
        for (let t = 0; t < END_MS; t++) {
            // A burst at t = 10 s: the decoder manages 40 fps for one second, as a keyframe and a big frame might.
            b.step(paused ? 0 : INPUT, t >= 10_000 && t < 11_000 ? 40 : undefined);
            for (const x of [...timers]) if (x.at <= b.ms) { timers = timers.filter(y => y !== x); x.cb(); }
            if (b.ms % 1000 === 0 && rec.flushing) rec.decoded(b.decoded);
            if (b.ms % 2000 === 0) {
                const cur = b.snapshot(b.ms);
                const d = watch.observe(b.ms, cur, 'remote-share-1');
                if (d) events.push({ t: b.ms, d });
                rates.push({ t: b.ms, dec: (cur.framesDecoded - last.framesDecoded) / 2, drop: (cur.framesDropped - last.framesDropped) / 2, rx: (cur.framesReceived - last.framesReceived) / 2 });
                if (watch.stalled && stalledAt < 0) stalledAt = b.ms;
                if (stalledAt >= 0 && movingAt < 0 && !paused && rates[rates.length - 1].dec > 80) movingAt = b.ms;
                last = cur;
                if (recover) rec.tick(watch.stalled, cur.framesDecoded);
            }
        }
        return { b, events, rates, stalledAt, movingAt, logs: r.s.logs };
    }

    it('88 fps, a one-second slowdown, no recovery: the reported shape, for as long as the thin margin takes to drain', () => {
        const { events, rates, b } = run(false);
        expect(events.map(e => e.d.phase)).toEqual(['start', 'end']);
        expect(events[0].d).toMatchObject({ pli: 0 });
        expect(events[1].d.ms).toBeGreaterThan(15_000); // 38 frames over the limit, 2 fps of margin: ~19 s
        const mid = rates.find(r => r.t === 20_000)!;
        expect(mid.dec).toBe(0);
        expect(Math.abs(mid.drop - mid.rx)).toBeLessThanOrEqual(1);
        expect(b.kfRequests).toBe(0);
    });

    it('the same slowdown at 60 fps never becomes a stall: the frame rate sets the margin', () => {
        const { events } = run(false, 60);
        expect(events).toEqual([]);
    });

    it('with recovery: one pause, the backlog gone, the picture moving within seconds of the detection', () => {
        const { events, rates, stalledAt, movingAt, logs, b } = run(true);
        expect(logs.map(l => l.phase)).toEqual(['start', 'end']);
        expect(logs[1]).toMatchObject({ drained: true });
        expect(events.map(e => e.d.phase)).toEqual(['start', 'end']);
        expect(movingAt - stalledAt).toBeLessThanOrEqual(4000);
        expect(rates.find(r => r.t === 40_000)!.dec).toBeGreaterThan(80);
        expect(b.depth).toBeLessThan(10);
    });
});
