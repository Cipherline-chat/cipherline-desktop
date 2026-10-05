import { describe, it, expect } from 'vitest';
import {
    stepSpring, stepMembrane, membraneSettled, membraneShape, initialMembrane,
    RAIL_RADIUS, LEAD_STIFFNESS, LEAD_DAMPING, TRAIL_STIFFNESS, TRAIL_DAMPING,
    BOUNCE_STIFFNESS, BOUNCE_DAMPING, type RestBox,
} from './railMembrane';

const TILE: RestBox = { top: 0, left: 6, width: 44, height: 44 };
const at = (top: number): RestBox => ({ ...TILE, top });

/**
 * Fly the membrane and report everything the feel depends on.
 *
 * `fps` is the KEY parameter and the reason this helper exists. The original
 * suite hardcoded 1/60 and therefore asserted no-overshoot only on a machine
 * that never drops a frame — which is precisely the assumption that hid a
 * 107px overshoot from the owner's actual build.
 */
function fly(from: number, to: number, fps = 60, frames = 1200) {
    let s = initialMembrane(from);
    const dt = 1 / fps;
    const dir = Math.sign(to - from) || 1;
    let overshoot = 0, maxStretch = 0, maxBounceWidth = 0, settleMs: number | null = null;
    for (let f = 0; f < frames; f++) {
        s = stepMembrane(s, to, TILE.height, dt);
        overshoot = Math.max(overshoot, (s.a - to) * dir, (s.b - to) * dir);
        maxStretch = Math.max(maxStretch, Math.abs(s.a - s.b));
        const box = membraneShape(s, to, at(to));
        maxBounceWidth = Math.max(maxBounceWidth, box.width);
        if (settleMs === null && membraneSettled(s, to)) settleMs = (f / fps) * 1000;
    }
    return { s, overshoot, maxStretch, maxBounceWidth, settleMs };
}

describe('rail membrane', () => {
    describe('overshoot — the bug the first version shipped', () => {
        it('never passes the target AT ANY FRAME RATE', () => {
            // THE REGRESSION. With the old explicit-Euler integrator this was
            // 0.00px at 60fps, 24px at 40fps and 107px at 30fps or worse —
            // over two whole tiles. Dashboard is ~7.4k lines and drops frames
            // routinely, so the slow cases are the real ones, not the corner.
            for (const fps of [120, 60, 50, 40, 30, 20, 15, 10, 5]) {
                for (const slots of [1, 3, 6]) {
                    expect(fly(0, slots * 50, fps).overshoot,
                        `${slots} slots at ${fps}fps`).toBeLessThan(0.01);
                    expect(fly(slots * 50, 0, fps).overshoot,
                        `${slots} slots up at ${fps}fps`).toBeLessThan(0.01);
                }
            }
        });

        it('survives a single absurd frame — a backgrounded tab', () => {
            // The old version needed a dt clamp to avoid being flung off the
            // rail. The analytic solution is exact at any dt, so it needs none.
            let s = initialMembrane(0);
            s = stepMembrane(s, 300, TILE.height, 2.5);   // one 2.5-SECOND frame
            expect(s.a).toBeLessThanOrEqual(300.01);
            expect(s.b).toBeLessThanOrEqual(300.01);
        });

        it('both travel springs are damped at or past critical', () => {
            // The property behind the simulations above.
            expect(LEAD_DAMPING).toBeGreaterThanOrEqual(2 * Math.sqrt(LEAD_STIFFNESS));
            expect(TRAIL_DAMPING).toBeGreaterThanOrEqual(2 * Math.sqrt(TRAIL_STIFFNESS));
        });

        it('the mobile constants WOULD overshoot — the difference is real', () => {
            expect(30).toBeLessThan(2 * Math.sqrt(360));
            expect(16).toBeLessThan(2 * Math.sqrt(92));
        });
    });

    describe('stepSpring covers all three damping regimes', () => {
        it('over-damped approaches monotonically from rest', () => {
            let [p, v] = [0, 0];
            let last = -1;
            for (let i = 0; i < 200; i++) {
                [p, v] = stepSpring(p, v, 100, 1100, 68, 1 / 60);
                expect(p).toBeGreaterThanOrEqual(last);
                expect(p).toBeLessThanOrEqual(100.001);
                last = p;
            }
        });

        it('critically damped does not divide by zero', () => {
            const k = 400, c = 2 * Math.sqrt(400);   // discriminant exactly 0
            const [p, v] = stepSpring(0, 0, 50, k, c, 1 / 60);
            expect(Number.isFinite(p)).toBe(true);
            expect(Number.isFinite(v)).toBe(true);
            expect(p).toBeGreaterThan(0);
        });

        it('under-damped rings — which is what the bounce spring is for', () => {
            let [p, v] = [0, 0];
            let crossings = 0, prev = 0;
            for (let i = 0; i < 400; i++) {
                [p, v] = stepSpring(p, v, 1, BOUNCE_STIFFNESS, BOUNCE_DAMPING, 1 / 60);
                if ((prev - 1) * (p - 1) < 0) crossings++;
                prev = p;
            }
            expect(crossings).toBeGreaterThanOrEqual(2);   // it really oscillates
            expect(BOUNCE_DAMPING).toBeLessThan(2 * Math.sqrt(BOUNCE_STIFFNESS));
        });
    });

    describe('it stretches, deforms, and comes back to the tile', () => {
        it('stretches visibly, and more the further it goes', () => {
            const one = fly(0, 50).maxStretch;
            const five = fly(0, 250).maxStretch;
            expect(one).toBeGreaterThan(10);
            expect(five).toBeGreaterThan(one);
        });

        it('deforms in flight — the caps stop being the resting radius', () => {
            let s = initialMembrane(0);
            for (let f = 0; f < 8; f++) s = stepMembrane(s, 250, TILE.height, 1 / 60);
            const box = membraneShape(s, 250, at(250));
            expect(box.width).toBeLessThan(TILE.width);          // necks in
            expect(box.radius).not.toBe(
                `${RAIL_RADIUS}px ${RAIL_RADIUS}px ${RAIL_RADIUS}px ${RAIL_RADIUS}px`);
        });

        it('rounds the LEADING cap more than the trailing one, both directions', () => {
            const caps = (target: number, from: number) => {
                let s = initialMembrane(from);
                for (let f = 0; f < 8; f++) s = stepMembrane(s, target, TILE.height, 1 / 60);
                const [tl, , br] = membraneShape(s, target, at(target)).radius
                    .split(' ').map(v => parseFloat(v));
                return { tl, br };
            };
            const down = caps(250, 0);
            expect(down.br).toBeGreaterThan(down.tl);   // leading edge is the bottom
            const up = caps(0, 250);
            expect(up.tl).toBeGreaterThan(up.br);       // leading edge is the top
        });

        it('a cap never exceeds half the box, at any point in the flight', () => {
            // Rule 3: over half and the browser rescales EVERY radius and the
            // shape goes flat-sided — the exact failure the mobile spec warns
            // about twice.
            let s = initialMembrane(0);
            for (let f = 0; f < 400; f++) {
                s = stepMembrane(s, 300, TILE.height, 1 / 60);
                const box = membraneShape(s, 300, at(300));
                const half = Math.min(box.width, box.height) / 2 + 0.001;
                for (const r of box.radius.split(' ').map(v => parseFloat(v))) {
                    expect(r).toBeLessThanOrEqual(half);
                }
            }
        });

        it('returns to EXACTLY the resting tile', () => {
            const box = membraneShape(initialMembrane(100), 100, at(100));
            expect(box.top).toBeCloseTo(100, 5);
            expect(box.left).toBeCloseTo(TILE.left, 5);
            expect(box.width).toBeCloseTo(TILE.width, 5);
            expect(box.height).toBeCloseTo(TILE.height, 5);
            expect(box.radius).toBe(
                `${RAIL_RADIUS}px ${RAIL_RADIUS}px ${RAIL_RADIUS}px ${RAIL_RADIUS}px`);
        });
    });

    describe('the landing bounce', () => {
        it('overshoots the resting WIDTH after landing — visible squash', () => {
            // The bounce is a shape effect, so it shows up as the box going
            // WIDER than the tile for a beat, never as the position passing it.
            const { maxBounceWidth, overshoot } = fly(0, 150);
            expect(maxBounceWidth).toBeGreaterThan(TILE.width + 0.5);
            expect(overshoot).toBeLessThan(0.01);
        });

        it('settle waits for the bounce, so we never stop mid-jiggle', () => {
            const mid = { ...initialMembrane(100), sq: 0.25, vsq: 4 };
            expect(membraneSettled(mid, 100)).toBe(false);
            expect(membraneSettled(initialMembrane(100), 100)).toBe(true);
        });

        it('still settles, and quickly enough to feel like a click', () => {
            expect(fly(0, 50).settleMs).not.toBeNull();
            expect(fly(0, 50).settleMs!).toBeLessThan(1400);
            expect(fly(0, 300).settleMs!).toBeLessThan(1600);
        });
    });

    describe('geometry comes from the caller, never from a constant', () => {
        it('a differently-sized tile produces a correspondingly-sized rest shape', () => {
            // The server tiles are wrapped in a <div className="relative group">
            // and are not guaranteed to match the RailTile buttons. Hardcoding
            // 44/50 is what put the indicator off-centre on them.
            const tall: RestBox = { top: 10, left: 3, width: 52, height: 60 };
            const box = membraneShape(initialMembrane(10), 10, tall);
            expect(box.height).toBeCloseTo(60, 5);
            expect(box.width).toBeCloseTo(52, 5);
            expect(box.left).toBeCloseTo(3, 5);
            expect(box.top).toBeCloseTo(10, 5);
        });

        it('stays horizontally centred on its tile while it necks', () => {
            let s = initialMembrane(0);
            for (let f = 0; f < 8; f++) s = stepMembrane(s, 250, TILE.height, 1 / 60);
            const box = membraneShape(s, 250, at(250));
            expect(box.left + box.width / 2).toBeCloseTo(TILE.left + TILE.width / 2, 5);
        });

        it('re-aiming mid-flight carries velocity through — no snap', () => {
            let s = initialMembrane(0);
            for (let f = 0; f < 10; f++) s = stepMembrane(s, 200, TILE.height, 1 / 60);
            expect(Math.min(s.a, s.b)).toBeGreaterThan(0);
            for (let f = 0; f < 900; f++) s = stepMembrane(s, 0, TILE.height, 1 / 60);
            expect(Math.abs(s.a)).toBeLessThan(0.3);
            expect(Math.abs(s.b)).toBeLessThan(0.3);
        });
    });
});
