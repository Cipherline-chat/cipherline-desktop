import { describe, it, expect } from 'vitest';
import { PresentProbe, presentProbeFor } from './videoPresentProbe';

function fakeEl() {
    let cb: ((now: number, meta: { presentedFrames?: number }) => void) | null = null;
    return {
        isConnected: true,
        requestVideoFrameCallback(f: (now: number, meta: { presentedFrames?: number }) => void) { cb = f; return 1; },
        cancelVideoFrameCallback() { cb = null; },
        fire(now: number, presented?: number) { const f = cb; cb = null; f?.(now, { presentedFrames: presented }); },
        get armed() { return cb !== null; },
    };
}

describe('PresentProbe', () => {
    it('reports callbacks/s, presented/s and gap percentiles; a hitch shows in late_pct and gap_max', () => {
        const el = fakeEl();
        let clock = 0;
        const p = new PresentProbe(el, () => clock);
        // 60 callbacks over 1 s at 16.7 ms, one 100 ms stall.
        let t = 0, n = 0;
        for (let i = 0; i < 60; i++) { t += i === 30 ? 100 : 16.7; n += 1; el.fire(t, n); }
        clock = 1000;
        const w = p.drain()!;
        expect(w.vf_fps).toBeCloseTo(60, 0);
        expect(w.gap_max_ms).toBe(100);
        expect(w.late_pct).toBeGreaterThan(0);
        expect(w.pres_fps).toBeCloseTo(60, 0);
        expect(el.armed).toBe(true); // re-armed after every callback
    });
    it('returns null with no callbacks (a hidden / paused tile), and a window too short', () => {
        const el = fakeEl();
        let clock = 0;
        const p = new PresentProbe(el, () => clock);
        clock = 10_000;
        expect(p.drain()).toBeNull();
        el.fire(1, 1); clock = 10_100;
        expect(p.drain()).toBeNull();
    });
    it('does not count the idle time between windows as a gap', () => {
        const el = fakeEl();
        let clock = 0;
        const p = new PresentProbe(el, () => clock);
        el.fire(10, 1); el.fire(26, 2); clock = 1000; p.drain();
        el.fire(5000, 3); el.fire(5016, 4); clock = 2000;
        expect(p.drain()!.gap_max_ms).toBe(16);
    });
    it('stop() cancels the chain; an element without rVFC has no probe', () => {
        const el = fakeEl();
        const p = new PresentProbe(el, () => 0);
        p.stop();
        expect(el.armed).toBe(false);
        expect(presentProbeFor({} as never)).toBeNull();
    });
});
