import { describe, it, expect } from 'vitest';
import { estimateHzFromTimestamps, measureDisplayHz } from './displayRefresh';

const frames = (hz: number, n = 31, jitter = 0, start = 1000) => {
    const out: number[] = [];
    let t = start;
    for (let i = 0; i < n; i++) { out.push(t); t += 1000 / hz + (i % 2 ? jitter : -jitter); }
    return out;
};

describe('estimateHzFromTimestamps', () => {
    it('snaps a clean rAF stream to the panel\'s rate', () => {
        for (const hz of [30, 60, 75, 90, 120, 144, 165, 240]) expect(estimateHzFromTimestamps(frames(hz))).toBe(hz);
    });
    it('is robust to jitter and to a couple of dropped frames (trimmed mean)', () => {
        const stamps = frames(144, 31, 0.8);
        stamps.splice(10, 2); // two missed vsyncs
        expect(estimateHzFromTimestamps(stamps)).toBe(144);
    });
    it('reports an unusual rate as a rounded number rather than forcing a snap', () => {
        expect(estimateHzFromTimestamps(frames(57.3))).toBe(57);
    });
    it('null with too little or nonsensical data', () => {
        expect(estimateHzFromTimestamps([])).toBeNull();
        expect(estimateHzFromTimestamps(frames(60, 5))).toBeNull();
        expect(estimateHzFromTimestamps(Array.from({ length: 20 }, () => 5))).toBeNull(); // zero deltas
        expect(estimateHzFromTimestamps(frames(2))).toBeNull(); // a throttled 2 Hz stream is not a display
    });
});

describe('measureDisplayHz', () => {
    /** A fake rAF that fires at `hz`, on a virtual clock. */
    function fakeRaf(hz: number) {
        let now = 1000;
        let pending: ((t: number) => void) | null = null;
        let calls = 0;
        const raf = (cb: (t: number) => void) => { calls++; pending = cb; return calls; };
        const pump = () => { while (pending) { const cb = pending; pending = null; now += 1000 / hz; cb(now); } };
        return { raf, pump, now: () => now, get calls() { return calls; } };
    }

    it('measures a bounded burst of frames - then stops scheduling (no continuous loop)', async () => {
        const f = fakeRaf(120);
        const p = measureDisplayHz({ raf: f.raf, caf: () => {}, visible: () => true, now: f.now, frames: 31 });
        f.pump();
        expect(await p).toBe(120);
        expect(f.calls).toBe(31);
        f.pump();
        expect(f.calls).toBe(31);
    });

    it('does not start for a hidden window, and gives up (null) if it becomes hidden or too slow', async () => {
        expect(await measureDisplayHz({ raf: () => 1, visible: () => false })).toBeNull();
        const f = fakeRaf(60);
        let visible = true;
        const p = measureDisplayHz({ raf: f.raf, caf: () => {}, visible: () => visible, now: f.now, frames: 31 });
        visible = false;
        f.pump();
        expect(await p).toBeNull();
        const slow = fakeRaf(1); // throttled: 1 frame per second
        const p2 = measureDisplayHz({ raf: slow.raf, caf: () => {}, visible: () => true, now: slow.now, frames: 31, timeoutMs: 2500 });
        slow.pump();
        expect(await p2).toBeNull();
        expect(slow.calls).toBeLessThan(10);
    });

    it('no rAF in the environment, or one that throws: null, never an exception', async () => {
        expect(await measureDisplayHz({ raf: undefined, visible: () => true })).toBeNull();
        expect(await measureDisplayHz({ raf: () => { throw new Error('no'); }, caf: () => {}, visible: () => true })).toBeNull();
    });
});
