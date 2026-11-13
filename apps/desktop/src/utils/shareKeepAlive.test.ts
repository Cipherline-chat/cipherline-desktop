import { describe, it, expect } from 'vitest';
import {
    KeepAliveGate, createKeepAliveTransformer, runKeepAlivePipe, engageKeepAlive, keepAliveDisabled, keepAlivePlatformOk,
    KEEPALIVE_ENGAGE_SUSTAIN_MS, KEEPALIVE_IDLE_MS, KEEPALIVE_REPEAT_MS,
    type KeepAliveFrame, type KeepAliveDeps, type KeepAliveTrackLike,
} from './shareKeepAlive';

// ── the decision ───────────────────────────────────────────────────────────

/** A sender report: capture frames so far, as the media-source stat. */
const report = (frames: number, fps: number) => ({
    forEach(cb: (s: Record<string, unknown>) => void) {
        cb({ type: 'outbound-rtp', kind: 'video', framesSent: frames, framesPerSecond: fps, frameWidth: 2560, frameHeight: 1440 });
        cb({ type: 'media-source', kind: 'video', frames, framesPerSecond: fps });
    },
});

/** Runs the gate over `secs` seconds at `fps` capture, one report a second; returns the second it fired at, or null. */
function run(gate: KeepAliveGate, secs: number, fps: number, startFrames = 0, startAt = 0): { firedAt: number | null; frames: number } {
    let frames = startFrames;
    let firedAt: number | null = null;
    for (let s = 0; s <= secs; s++) {
        if (s > 0) frames += fps;
        if (gate.observe(startAt + s * 1000, report(frames, fps)) && firedAt === null) firedAt = s;
    }
    return { firedAt, frames };
}

describe('KeepAliveGate', () => {
    it('fires once after the capture stays under 5 fps for the sustain period', () => {
        const { firedAt } = run(new KeepAliveGate(), 12, 2);
        expect(firedAt).toBe(KEEPALIVE_ENGAGE_SUSTAIN_MS / 1000);
    });
    it('a healthy capture never fires', () => {
        expect(run(new KeepAliveGate(), 30, 88).firedAt).toBeNull();
    });
    it('a mid rate (the game\'s own frame rate) is not starvation', () => {
        expect(run(new KeepAliveGate(), 30, 24).firedAt).toBeNull();
    });
    it('a recovery inside the sustain period resets the count', () => {
        const g = new KeepAliveGate();
        const a = run(g, 4, 1);
        const b = run(g, 1, 60, a.frames, 5000); // one healthy second at t = 5 s...
        expect(b.firedAt).toBeNull();
        const c = run(g, 5, 1, b.frames, 6000); // ...then 5 s starved is not yet 6 s
        expect(c.firedAt).toBeNull();
    });
    it('says it once, however long the starvation lasts', () => {
        const g = new KeepAliveGate();
        let fired = 0;
        let frames = 0;
        for (let s = 0; s <= 60; s++) { frames += s ? 1 : 0; if (g.observe(s * 1000, report(frames, 1))) fired++; }
        expect(fired).toBe(1);
    });
    it('reset() lets it fire again for the next stretch', () => {
        const g = new KeepAliveGate();
        expect(run(g, 12, 1).firedAt).not.toBeNull();
        g.reset();
        expect(run(g, 12, 1).firedAt).not.toBeNull();
    });
    it('no video stats yet: nothing', () => {
        expect(new KeepAliveGate().observe(0, { forEach() { /* empty */ } })).toBe(false);
        expect(new KeepAliveGate().observe(0, null)).toBe(false);
    });
});

// ── the frame stage ────────────────────────────────────────────────────────

interface FakeFrame extends KeepAliveFrame { id: number; closed: boolean; of?: number }
let nextId = 0;
const frame = (ts: number): FakeFrame => ({ id: ++nextId, timestamp: ts, closed: false, close() { this.closed = true; } });

function harness(over: Partial<KeepAliveDeps<FakeFrame>> = {}) {
    let now = 0;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let tid = 0;
    const made: FakeFrame[] = [];
    const deps: KeepAliveDeps<FakeFrame> = {
        cloneFrame: f => { const c = { ...frame(f.timestamp), of: f.id }; made.push(c); return c; },
        restamp: (f, ts) => { const c = { ...frame(ts), of: f.id }; made.push(c); return c; },
        now: () => now,
        setInterval: (fn, ms) => { timers.set(++tid, { fn, ms }); return tid; },
        clearInterval: h => { timers.delete(h as number); },
        ...over,
    };
    const out: FakeFrame[] = [];
    const t = createKeepAliveTransformer(deps);
    const controller = { enqueue: (f: FakeFrame) => { out.push(f); }, error() { /* n/a */ }, terminate() { /* n/a */ }, desiredSize: 1 } as unknown as TransformStreamDefaultController<FakeFrame>;
    t.start!(controller);
    const advance = (ms: number) => {
        const step = [...timers.values()][0]?.ms ?? 50;
        for (let e = 0; e < ms; e += step) { now += step; for (const tm of [...timers.values()]) tm.fn(); }
    };
    return { t, out, made, timers, advance, setNow: (n: number) => { now = n; }, getNow: () => now, controller };
}

describe('keep-alive transformer', () => {
    it('passes real frames through untouched and unclosed', () => {
        const h = harness();
        const f = frame(1000);
        h.t.transform!(f, h.controller);
        expect(h.out).toEqual([f]);
        expect(f.closed).toBe(false);
        expect(h.t.stats.real).toBe(1);
    });
    it('a quiet source gets the last frame back at least ~5 times a second, with rising timestamps', () => {
        const h = harness();
        h.t.transform!(frame(5_000_000), h.controller);
        h.out.length = 0;
        h.advance(2000);
        const repeats = h.out.length;
        expect(repeats).toBeGreaterThanOrEqual(8);   // 2 s at >= ~5/s, minus the idle wait
        expect(repeats).toBeLessThanOrEqual(2000 / KEEPALIVE_REPEAT_MS + 1);
        const ts = h.out.map(f => f.timestamp);
        expect([...ts].sort((a, b) => a - b)).toEqual(ts);
        expect(new Set(ts).size).toBe(ts.length);
        expect(ts[0]).toBeGreaterThan(5_000_000);
        expect(h.out.every(f => f.of !== undefined)).toBe(true);
        expect(h.t.stats.repeated).toBe(repeats);
    });
    it('does not repeat while real frames keep arriving', () => {
        const h = harness();
        for (let i = 0; i < 40; i++) { h.t.transform!(frame(i * 11_000), h.controller); h.advance(11); }
        expect(h.t.stats.repeated).toBe(0);
    });
    it('a real frame ends the repetition at once and becomes the new picture', () => {
        const h = harness();
        h.t.transform!(frame(0), h.controller);
        h.advance(1000);
        const before = h.t.stats.repeated;
        expect(before).toBeGreaterThan(0);
        const live = frame(9_000_000);
        h.t.transform!(live, h.controller);
        h.out.length = 0;
        h.advance(KEEPALIVE_IDLE_MS - 60);
        expect(h.out).toHaveLength(0);
        h.advance(1000);
        expect(h.out.length).toBeGreaterThan(0);
        expect(h.out.every(f => f.of !== undefined && f.timestamp >= 9_000_000)).toBe(true);
    });
    it('emits nothing before the first real frame (there is no picture to repeat)', () => {
        const h = harness();
        h.advance(3000);
        expect(h.out).toHaveLength(0);
    });
    it('closes every frame it owns: the superseded copy on each new frame, the last one on dispose', () => {
        const h = harness();
        h.t.transform!(frame(1), h.controller);
        h.t.transform!(frame(2), h.controller);
        h.t.transform!(frame(3), h.controller);
        const copies = h.made.filter(m => m.of !== undefined);
        expect(copies.map(c => c.closed)).toEqual([true, true, false]);
        h.t.dispose();
        expect(copies[2].closed).toBe(true);
        expect(h.timers.size).toBe(0);
        h.advance(1000);
        expect(h.out.filter(f => f.of !== undefined && f.id > copies[2].id)).toHaveLength(0);
    });
    it('a frame that cannot be handed on is closed rather than leaked', () => {
        const h = harness();
        const bad = { ...h.controller, enqueue: () => { throw new Error('sink gone'); } } as unknown as TransformStreamDefaultController<FakeFrame>;
        const f = frame(1);
        h.t.transform!(f, bad);
        expect(f.closed).toBe(true);
        expect(h.t.stats.errors).toBe(1);
    });
    it('NEGATIVE CONTROL: with the repeat stage disabled (idle never reached) a quiet source stays silent', () => {
        const h = harness({ idleMs: 10_000_000 });
        h.t.transform!(frame(1), h.controller);
        h.out.length = 0;
        h.advance(5000);
        expect(h.out).toHaveLength(0);
    });
});

describe('runKeepAlivePipe (real streams)', () => {
    it('real frames flow through, then repeats fill the quiet, and stop() releases everything', async () => {
        let now = 0;
        const timers: Array<() => void> = [];
        const deps: KeepAliveDeps<FakeFrame> = {
            cloneFrame: f => frame(f.timestamp), restamp: (f, ts) => ({ ...frame(ts), of: f.id }),
            now: () => now, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval: () => { timers.length = 0; },
        };
        const src = new TransformStream<FakeFrame, FakeFrame>();
        const sinkGot: FakeFrame[] = [];
        const sink = new WritableStream<FakeFrame>({ write(f) { sinkGot.push(f); } });
        const pipe = runKeepAlivePipe(src.readable, sink, deps);
        const w = src.writable.getWriter();
        await w.write(frame(100));
        await new Promise(r => setTimeout(r, 5));
        expect(sinkGot.map(f => f.timestamp)).toEqual([100]);
        now += 400;
        timers.forEach(fn => fn());
        await new Promise(r => setTimeout(r, 5));
        expect(sinkGot.length).toBeGreaterThanOrEqual(2);
        expect(pipe.stats.repeated).toBeGreaterThanOrEqual(1);
        pipe.stop();
        await pipe.done;
        expect(timers).toHaveLength(0);
    });
});

// ── switching the sender ───────────────────────────────────────────────────

function fakeTrack() {
    const state = { readyState: 'live', stopped: false };
    const raw = Object.assign(state, { stop() { state.stopped = true; state.readyState = 'ended'; } }) as unknown as MediaStreamTrack & { stopped: boolean };
    const calls: Array<{ t: unknown; userProvided: unknown }> = [];
    const track: KeepAliveTrackLike & { calls: typeof calls } = {
        mediaStreamTrack: raw, calls,
        async replaceTrack(t, userProvided) { calls.push({ t, userProvided }); track.mediaStreamTrack = t; },
    };
    return { raw, track, calls };
}
class FakeProcessor { readable = new ReadableStream<VideoFrame>({ start() { /* never produces */ } }); }
const makeGenerator = () => {
    const gens: Array<MediaStreamTrack & { writable: WritableStream<VideoFrame>; stopped?: boolean }> = [];
    class FakeGenerator {
        readyState = 'live'; stopped = false; contentHint = '';
        writable = new WritableStream<VideoFrame>();
        stop() { this.stopped = true; }
        constructor() { gens.push(this as never); }
    }
    return { Generator: FakeGenerator as never, gens };
};

describe('engageKeepAlive', () => {
    it('swaps the generated track onto the sender (user-provided: LiveKit must not stop the capture) and back', async () => {
        const { raw, track, calls } = fakeTrack();
        const { Generator, gens } = makeGenerator();
        const h = await engageKeepAlive(track, { Processor: FakeProcessor as never, Generator });
        expect(h).not.toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0].t).toBe(gens[0]);
        expect(calls[0].userProvided).toBe(true);
        await h!.stop();
        expect(calls).toHaveLength(2);
        expect(calls[1].t).toBe(raw);
        expect(calls[1].userProvided).toBe(true);
        expect((raw as unknown as { stopped: boolean }).stopped).toBe(false); // back on the sender: still live
        expect((gens[0] as unknown as { stopped: boolean }).stopped).toBe(true);
        await h!.stop(); // idempotent
        expect(calls).toHaveLength(2);
    });
    it('when the share already moved on (a swap or the end), stop() does not put the old capture back and releases it', async () => {
        const { raw, track, calls } = fakeTrack();
        const { Generator } = makeGenerator();
        const h = await engageKeepAlive(track, { Processor: FakeProcessor as never, Generator });
        track.mediaStreamTrack = { readyState: 'live' } as MediaStreamTrack; // somebody else's track now
        await h!.stop();
        expect(calls).toHaveLength(1);
        expect((raw as unknown as { stopped: boolean }).stopped).toBe(true);
    });
    it('when the share was stopped (our generated track ended), the capture is released, not re-attached', async () => {
        const { raw, track, calls } = fakeTrack();
        const { Generator, gens } = makeGenerator();
        const h = await engageKeepAlive(track, { Processor: FakeProcessor as never, Generator });
        (gens[0] as unknown as { readyState: string }).readyState = 'ended';
        await h!.stop();
        expect(calls).toHaveLength(1);
        expect((raw as unknown as { stopped: boolean }).stopped).toBe(true);
    });
    it('replaceTrack refusing leaves the share exactly as it was', async () => {
        const { raw, track } = fakeTrack();
        track.replaceTrack = async () => { throw new Error('nope'); };
        const { Generator, gens } = makeGenerator();
        expect(await engageKeepAlive(track, { Processor: FakeProcessor as never, Generator })).toBeNull();
        expect(track.mediaStreamTrack).toBe(raw);
        expect((raw as unknown as { stopped: boolean }).stopped).toBe(false);
        expect((gens[0] as unknown as { stopped: boolean }).stopped).toBe(true);
    });
    it('no live capture or no breakout-box support: null, nothing touched', async () => {
        const { raw, track, calls } = fakeTrack();
        (raw as unknown as { readyState: string }).readyState = 'ended';
        const { Generator } = makeGenerator();
        expect(await engageKeepAlive(track, { Processor: FakeProcessor as never, Generator })).toBeNull();
        const live = fakeTrack();
        expect(await engageKeepAlive(live.track, { Processor: undefined, Generator: undefined })).toBeNull();
        expect(calls).toHaveLength(0);
        expect(live.calls).toHaveLength(0);
    });
});

describe('kill switch', () => {
    it('is off only for the exact value, and a throwing store never disables it', () => {
        expect(keepAliveDisabled(() => 'off')).toBe(true);
        expect(keepAliveDisabled(() => null)).toBe(false);
        expect(keepAliveDisabled(() => 'on')).toBe(false);
        expect(keepAliveDisabled(() => { throw new Error('locked'); })).toBe(false);
    });
});

describe('platforms', () => {
    it('engages on every desktop OS, and on nothing unknown', () => {
        for (const p of ['windows', 'linux', 'mac']) expect(keepAlivePlatformOk(p)).toBe(true);
        for (const p of [undefined, '', 'darwin', 'win32', 'android']) expect(keepAlivePlatformOk(p)).toBe(false);
    });
});
