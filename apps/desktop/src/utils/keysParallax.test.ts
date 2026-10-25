import { describe, it, expect } from 'vitest';
import {
    pointerToNorm, tiltAngles, layerShift, stepToward, ParallaxController, DEPTH,
    MAX_TILT_X_DEG, MAX_TILT_Y_DEG, SETTLE_EPS, MAX_FRAME_DT_MS, type Vec,
} from './keysParallax';

const RECT = { left: 100, top: 50, width: 120, height: 100 };

/** A frame scheduler the test steps by hand. */
function harness() {
    let queued: ((t: number) => void) | null = null;
    let id = 0;
    let t = 1000;
    const applied: { v: Vec; active: boolean }[] = [];
    const ctl = new ParallaxController({
        raf: cb => { queued = cb; return ++id; },
        caf: () => { queued = null; },
        now: () => t,
        apply: (v, active) => applied.push({ v: { ...v }, active }),
    });
    const frame = (dt = 16) => { const cb = queued; queued = null; t += dt; cb?.(t); return !!cb; };
    const run = (max = 500) => { let n = 0; while (queued && n < max) { frame(); n++; } return n; };
    return { ctl, applied, frame, run, pending: () => queued !== null };
}

describe('keysParallax: the maths', () => {
    it('maps the pointer to -1..1 from the centre and clamps outside the box', () => {
        expect(pointerToNorm(160, 100, RECT)).toEqual({ x: 0, y: 0 });
        expect(pointerToNorm(220, 150, RECT)).toEqual({ x: 1, y: 1 });
        expect(pointerToNorm(100, 50, RECT)).toEqual({ x: -1, y: -1 });
        expect(pointerToNorm(5000, -5000, RECT)).toEqual({ x: 1, y: -1 });
        expect(pointerToNorm(190, 75, RECT)).toEqual({ x: 0.5, y: -0.5 });
    });

    it('a degenerate rect or a non-finite pointer reads as the centre', () => {
        expect(pointerToNorm(10, 10, { left: 0, top: 0, width: 0, height: 40 })).toEqual({ x: 0, y: 0 });
        expect(pointerToNorm(NaN, 10, RECT)).toEqual({ x: 0, y: 0 });
        expect(pointerToNorm(10, Infinity, RECT)).toEqual({ x: 0, y: 0 });
    });

    it('the tilt never leaves its bounds, for any pointer anywhere', () => {
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 5000; i++) {
            const v = pointerToNorm((rnd() - 0.5) * 1e5, (rnd() - 0.5) * 1e5, RECT);
            const { rx, ry } = tiltAngles(v);
            expect(Math.abs(rx)).toBeLessThanOrEqual(MAX_TILT_X_DEG);
            expect(Math.abs(ry)).toBeLessThanOrEqual(MAX_TILT_Y_DEG);
        }
        // even when handed garbage directly
        for (const v of [{ x: 40, y: -40 }, { x: NaN, y: Infinity }, { x: -Infinity, y: 2 }]) {
            const { rx, ry } = tiltAngles(v);
            expect(Math.abs(rx)).toBeLessThanOrEqual(MAX_TILT_X_DEG);
            expect(Math.abs(ry)).toBeLessThanOrEqual(MAX_TILT_Y_DEG);
        }
        expect(tiltAngles({ x: 1, y: -1 })).toEqual({ rx: MAX_TILT_X_DEG, ry: MAX_TILT_Y_DEG });
    });

    it('layers are ordered by depth: background < floor < body (the TV and envelopes move less than he does)', () => {
        const v = { x: 1, y: 1 };
        const b = layerShift('back', v), f = layerShift('front', v), me = layerShift('body', v);
        expect(Math.abs(b.x)).toBeLessThan(Math.abs(f.x));
        expect(Math.abs(f.x)).toBeLessThan(Math.abs(me.x));
        expect(Math.abs(b.y)).toBeLessThan(Math.abs(me.y));
        expect(layerShift('body', { x: 9, y: -9 })).toEqual({ x: DEPTH.body.x, y: -DEPTH.body.y });
    });

    it('the ease approaches its target without overshooting, and snaps when close', () => {
        let v = 0;
        let prev = -1;
        for (let i = 0; i < 200; i++) {
            v = stepToward(v, 1, 16, 90);
            expect(v).toBeGreaterThan(prev);
            expect(v).toBeLessThanOrEqual(1);
            prev = v;
            if (v === 1) break;
        }
        expect(v).toBe(1);
        expect(stepToward(0.9995, 1, 16, 90)).toBe(1); // within SETTLE_EPS
        expect(SETTLE_EPS).toBeLessThan(0.01);
    });

    it('a long frame gap (a throttled tab) is clamped: no jump in one step', () => {
        const capped = stepToward(0, 1, 10_000, 240);
        expect(capped).toBeCloseTo(stepToward(0, 1, MAX_FRAME_DT_MS, 240), 10);
        expect(capped).toBeLessThan(0.5);
        expect(stepToward(0.3, 1, -50, 90)).toBe(0.3);
    });
});

describe('ParallaxController', () => {
    it('follows the pointer only while it moves, then stops scheduling frames', () => {
        const h = harness();
        h.ctl.enter(RECT);
        h.ctl.move(220, 150);
        expect(h.pending()).toBe(true);
        const frames = h.run();
        expect(frames).toBeGreaterThan(3);
        expect(h.ctl.position).toEqual({ x: 1, y: 1 });
        expect(h.pending()).toBe(false); // settled: a still pointer costs nothing
        expect(h.applied[h.applied.length - 1]).toEqual({ v: { x: 1, y: 1 }, active: true });
        // every intermediate value is inside the box
        for (const a of h.applied) {
            expect(Math.abs(a.v.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(a.v.y)).toBeLessThanOrEqual(1);
        }
    });

    it('rests on leave: eases back to exactly zero and reports inactive', () => {
        const h = harness();
        h.ctl.enter(RECT);
        h.ctl.move(100, 50);
        h.run();
        h.ctl.leave();
        expect(h.ctl.hovering).toBe(false);
        h.run();
        expect(h.ctl.position).toEqual({ x: 0, y: 0 });
        expect(h.applied[h.applied.length - 1]).toEqual({ v: { x: 0, y: 0 }, active: false });
        expect(h.pending()).toBe(false);
    });

    it('relaxing is gentler than following (a longer time constant)', () => {
        const a = harness();
        a.ctl.enter(RECT); a.ctl.move(220, 100); a.frame();
        const followStep = a.ctl.position.x;
        const b = harness();
        b.ctl.enter(RECT); b.ctl.move(220, 100); b.run(); b.ctl.leave(); b.frame();
        const relaxStep = 1 - b.ctl.position.x;
        expect(relaxStep).toBeLessThan(followStep);
    });

    it('one rAF at a time, however many pointer events arrive', () => {
        let requested = 0;
        const ctl = new ParallaxController({ raf: () => ++requested, caf: () => {}, now: () => 0, apply: () => {} });
        ctl.enter(RECT);
        for (let i = 0; i < 50; i++) ctl.move(110 + i, 60 + i);
        expect(requested).toBe(1);
    });

    it('reduced motion / hidden window: parks at rest, ignores the pointer', () => {
        const h = harness();
        h.ctl.enter(RECT);
        h.ctl.move(220, 150);
        h.frame();
        h.ctl.setEnabled(false);
        expect(h.applied[h.applied.length - 1]).toEqual({ v: { x: 0, y: 0 }, active: false });
        expect(h.pending()).toBe(false);
        h.ctl.move(220, 150);
        h.ctl.move(100, 50);
        expect(h.pending()).toBe(false);
        expect(h.ctl.position).toEqual({ x: 0, y: 0 });
        // and back on: follows again
        h.ctl.setEnabled(true);
        h.ctl.move(220, 150, RECT);
        h.run();
        expect(h.ctl.position).toEqual({ x: 1, y: 1 });
    });

    it('needs a rect before it can follow; a scroll invalidates the cached one', () => {
        const h = harness();
        h.ctl.move(220, 150);
        expect(h.pending()).toBe(false);
        expect(h.ctl.needsRect()).toBe(true);
        h.ctl.enter(RECT);
        expect(h.ctl.needsRect()).toBe(false);
        h.ctl.invalidate();
        expect(h.ctl.needsRect()).toBe(true);
        h.ctl.move(220, 150, RECT);
        expect(h.pending()).toBe(true);
    });
});
