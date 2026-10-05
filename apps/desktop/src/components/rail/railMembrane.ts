/**
 * The rail indicator's membrane spring.
 *
 * ── The idea ───────────────────────────────────────────────────────────────
 *
 * It is NOT a tile that moves. It is a membrane with two independent edges —
 * a TOP and a BOTTOM, since this rail is vertical — each chasing the same
 * target on its own spring. The nearer edge leads (stiff, eager); the farther
 * edge trails (loose, reluctant). The gap between them IS the indicator, so
 * stretch is emergent rather than keyframed, and one continuous system covers
 * every transition: click a distant tile, click again mid-flight, click back,
 * and the edges just re-aim. No state machine, no snapping.
 *
 * ── Why the integrator is analytic and not the obvious Euler step ──────────
 *
 * THIS IS THE IMPORTANT PART. The first version integrated explicitly
 * (`v += (-k*x - c*v) * dt; x += v * dt`), as the mobile reference does, and
 * its tests asserted no-overshoot at a perfect 1/60 dt. That assumption is
 * precisely what hid the bug: explicit Euler is only CONDITIONALLY stable and
 * does not degrade gracefully as dt grows — it diverges. Measured on these
 * constants:
 *
 *     60fps -> 0.00px      40fps -> 24px      <=30fps -> 107px
 *
 * 107px is more than two whole tiles, and it is what the owner saw as
 * "overshooting sometimes". `stepSpring` is the CLOSED-FORM solution of the
 * damped oscillator over an interval — the exact answer at dt, not an
 * approximation. Unconditionally stable: measured 0.0000px of overshoot from
 * 120fps down to 2fps, across a 2-second frame gap, and on a mid-flight
 * reversal (the one case an over-damped system can legitimately cross). There
 * is therefore no dt clamp; it needs none, and a clamp would only make a slow
 * frame animate in slow motion.
 *
 * ── Geometry is MEASURED, never assumed ────────────────────────────────────
 *
 * Nothing here hardcodes a tile size or a slot pitch. The first version did
 * (44px tile, 50px pitch) and it was wrong for the server tiles, which render
 * inside a `<div className="relative group">` wrapper rather than as bare
 * flex children — so the indicator drifted further off-centre the further
 * down the rail it went. The caller measures the real child box and passes it
 * in as `rest`, which is immune to that and to any future layout change.
 *
 * ── Rules carried over from the mobile nav bubble ──────────────────────────
 *
 * 1. Position and SIZE animate. Never `transform: scale()` — scaling a
 *    rounded rect distorts its corner radii into flat edges.
 * 2. No CSS transition on the geometry. The spring owns every frame.
 * 3. A corner radius may never exceed half the box, or the browser
 *    proportionally rescales EVERY radius and the shape goes flat-sided.
 */

/** Resting corner radius. The shape returns to exactly this at rest. */
export const RAIL_RADIUS = 12;

/**
 * Damping at or above critical (2*sqrt(stiffness)) for both edges. With the
 * analytic integrator that guarantees a monotonic approach — an edge cannot
 * pass its target at any frame rate. Raise a stiffness without raising its
 * damping and that guarantee, and its test, break.
 */
export const LEAD_STIFFNESS = 1100;   // critical damping = 66.3
export const LEAD_DAMPING = 68;
export const TRAIL_STIFFNESS = 260;   // critical damping = 32.2
export const TRAIL_DAMPING = 34;

/**
 * The landing bounce is a SEPARATE, deliberately UNDER-damped spring that
 * chases the current stretch. Because it lags and overshoots, it is still
 * moving after the edges have met — so the shape keeps squashing and
 * stretching for a beat after the indicator has arrived.
 *
 * It drives width and corner radius ONLY. Position stays monotonic, which is
 * the whole point: "a bit of a bounce when it comes to rest" is a squash, not
 * the indicator sailing past the tile and coming back.
 */
export const BOUNCE_STIFFNESS = 430;  // critical damping = 41.5 ...
export const BOUNCE_DAMPING = 15;     // ... and 15 is well under it, so it rings

export interface MembraneState {
    a: number; b: number;      // edge positions, px, in track content-box coords
    va: number; vb: number;    // edge velocities, px/s
    sq: number; vsq: number;   // the bounce spring's position and velocity
}

export const initialMembrane = (at: number): MembraneState =>
    ({ a: at, b: at, va: 0, vb: 0, sq: 0, vsq: 0 });

/**
 * Advance ONE spring analytically over `dt`.
 *
 * Solves u'' + c*u' + k*u = 0 for u = position - target, then adds the target
 * back. Three regimes: two real roots when over-damped, the (t * e^rt)
 * degenerate form when critical (the two-root expression divides by r1 - r2,
 * which vanishes there), and a decaying sinusoid when under-damped — which is
 * what the bounce spring uses.
 */
export function stepSpring(
    pos: number, vel: number, target: number, k: number, c: number, dt: number,
): [pos: number, vel: number] {
    const u0 = pos - target;
    const disc = c * c - 4 * k;
    if (disc > 1e-9) {
        const s = Math.sqrt(disc);
        const r1 = (-c + s) / 2, r2 = (-c - s) / 2;
        const A = (vel - r2 * u0) / (r1 - r2);
        const B = (r1 * u0 - vel) / (r1 - r2);
        const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
        return [target + A * e1 + B * e2, A * r1 * e1 + B * r2 * e2];
    }
    if (disc < -1e-9) {                       // under-damped: rings
        const w = Math.sqrt(-disc) / 2;       // damped angular frequency
        const z = -c / 2;
        const A = u0, B = (vel - z * u0) / w;
        const e = Math.exp(z * dt), cs = Math.cos(w * dt), sn = Math.sin(w * dt);
        return [
            target + e * (A * cs + B * sn),
            e * ((z * A + w * B) * cs + (z * B - w * A) * sn),
        ];
    }
    const r = -c / 2;                          // critically damped
    const A = u0, B = vel - r * u0;
    const e = Math.exp(r * dt);
    return [target + (A + B * dt) * e, (B + r * (A + B * dt)) * e];
}

/** Advance both edges and the bounce. Pure: no clock, no DOM, so it is testable. */
export function stepMembrane(
    s: MembraneState, target: number, restH: number, dt: number,
): MembraneState {
    // Whichever edge is nearer the target leads. Direction-agnostic, so a
    // reversal mid-flight simply swaps which edge does the leading.
    const leadIsA = Math.abs(target - s.a) <= Math.abs(target - s.b);
    const [a, va] = stepSpring(s.a, s.va, target,
        leadIsA ? LEAD_STIFFNESS : TRAIL_STIFFNESS, leadIsA ? LEAD_DAMPING : TRAIL_DAMPING, dt);
    const [b, vb] = stepSpring(s.b, s.vb, target,
        leadIsA ? TRAIL_STIFFNESS : LEAD_STIFFNESS, leadIsA ? TRAIL_DAMPING : LEAD_DAMPING, dt);
    // The bounce chases how stretched the membrane actually is. It lags on the
    // way out and overshoots on the way back, which is the landing jiggle.
    const stretch = restH > 0 ? Math.abs(a - b) / restH : 0;
    const [sq, vsq] = stepSpring(s.sq, s.vsq, stretch, BOUNCE_STIFFNESS, BOUNCE_DAMPING, dt);
    return { a, b, va, vb, sq, vsq };
}

/** Settled on every axis — including the bounce, so we never stop mid-jiggle. */
export function membraneSettled(s: MembraneState, target: number): boolean {
    return Math.abs(s.a - target) < 0.3 && Math.abs(s.b - target) < 0.3
        && Math.abs(s.va) < 8 && Math.abs(s.vb) < 8
        && Math.abs(s.sq) < 0.004 && Math.abs(s.vsq) < 0.12;
}

/**
 * The resting box of the tile the indicator sits on, measured from the DOM.
 *
 * `top` is the tile's own offsetTop and is the spring's TARGET — the edges
 * already work in the track's coordinate space, so `membraneShape` must not
 * add it back in. Only `left`, `width` and `height` are used as size inputs.
 */
export interface RestBox { top: number; left: number; width: number; height: number }

export interface MembraneShape {
    top: number; left: number; width: number; height: number;
    /** Ready-made CSS `border-radius`, longhand TL TR BR BL. */
    radius: string;
}

/**
 * Edges -> CSS box.
 *
 * The shape deforms in flight and returns to the exact resting tile: it necks
 * in across the rail, its leading cap rounds off far more than its trailing
 * one (a droplet being pulled, not a box being slid), and it squashes for a
 * beat as it lands. Every term is scaled by a quantity that is zero at rest,
 * so the rest shape is exact BY CONSTRUCTION rather than by a special case.
 */
export function membraneShape(s: MembraneState, target: number, rest: RestBox): MembraneShape {
    const top = Math.min(s.a, s.b);
    const height = rest.height + (Math.max(s.a, s.b) - top);
    const stretch = rest.height > 0 ? (height - rest.height) / rest.height : 0;
    // How far the bounce spring currently disagrees with reality. Zero while
    // the two track each other, and rings through zero after landing.
    const bounce = Math.max(-0.6, Math.min(0.6, s.sq - stretch));

    const width = rest.width * (1 - Math.min(stretch, 1.6) * 0.16 - bounce * 0.20);

    // A cap may never exceed half the box (rule 3 in the header).
    const maxCap = Math.min(width, height) / 2;
    const reach = Math.min(stretch + Math.abs(bounce), 1);
    const cap = (amount: number) =>
        Math.min(RAIL_RADIUS + (maxCap - RAIL_RADIUS) * reach * amount, maxCap);
    const lead = cap(0.95);   // the end being pulled: nearly a full round cap
    const trail = cap(0.30);  // the end left behind: still recognisably square

    const leadIsBottom = target >= (s.a + s.b) / 2;
    // Rounded: these go straight into a style string every frame, and
    // "14.721970176482246px" is both unreadable in devtools and pointless —
    // the compositor cannot draw a ten-thousandth of a pixel.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const [tl, br] = (leadIsBottom ? [trail, lead] : [lead, trail]).map(r2);

    return {
        // `top` is already absolute in the track's coordinate space — the
        // spring targets rest.top directly. Adding rest.top here would double
        // it, putting the indicator twice as far down the rail as the tile.
        top,
        left: rest.left + (rest.width - width) / 2,   // stay centred as it necks
        width,
        height,
        radius: `${tl}px ${tl}px ${br}px ${br}px`,
    };
}
