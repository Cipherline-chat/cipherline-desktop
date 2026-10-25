/**
 * keysParallax — the 3D hover tilt for Keys on the Home deck.
 *
 * Owner, 2026-10-20: "a cool 3d parallax animation that reacts to your mouse
 * hovering over him", in every state he mirrors.
 *
 * The pointer's position over his hit zone becomes two numbers in -1..1
 * (x: left/right of his centre, y: above/below). Those are eased toward (a
 * spring-like exponential approach, so a fast flick still glides) and handed
 * to the host as two CSS custom properties. home-keys.css turns them into:
 *
 *   - one rotateX / rotateY with perspective on the whole scene (the tilt),
 *   - a different translate per layer (the parallax): the things behind and
 *     beside him (TV, ring light, safe, sign) move least, the floor and the
 *     bubbles a little more, his body most, and his eyes track the pointer
 *     on top of that.
 *
 * Cost: transform only. One requestAnimationFrame per frame WHILE the values
 * are moving, and none once they settle (a still pointer costs nothing). No
 * layout reads in the frame loop: the hit zone's rect is read once when the
 * pointer arrives (and again only after a scroll or resize) and cached. Off
 * entirely under reduced motion, and parked at rest while the window is
 * hidden.
 *
 * Pure apart from the injected clock / frame scheduler / sink, so vitest can
 * drive it frame by frame.
 */

/** Largest tilt, degrees. rotateY follows x, rotateX follows -y. */
export const MAX_TILT_Y_DEG = 13;
export const MAX_TILT_X_DEG = 9;
/** Easing time constants (ms): toward the pointer, and back to rest. */
export const FOLLOW_TAU_MS = 90;
export const RELAX_TAU_MS = 240;
/** Below this the values snap to their target and the frame loop stops. */
export const SETTLE_EPS = 0.002;
/** A frame gap longer than this is clamped (a tab that was throttled must
 *  not jump the spring in one step). */
export const MAX_FRAME_DT_MS = 64;

/**
 * Parallax depths, in px per unit of x / y. Background < floor < body: the
 * TV and the envelopes move less than he does. Mirrored in home-keys.css
 * (`--hk-d-*`), which is where they are applied; exported for the tests and
 * for anyone tuning them.
 */
export const DEPTH = {
    back: { x: 2.5, y: 1.5 },
    front: { x: 4, y: 2.5 },
    body: { x: 7, y: 4 },
    /** The eyes, in his own svg units, on top of the body. */
    eyes: { x: 2.6, y: 1.8 },
} as const;

export interface Rect { left: number; top: number; width: number; height: number }
export interface Vec { x: number; y: number }

const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

/** The pointer at (cx, cy) over `rect`, as -1..1 from its centre (clamped;
 *  a degenerate rect or a non-finite input reads as the centre). */
export function pointerToNorm(cx: number, cy: number, rect: Rect): Vec {
    const hw = rect.width / 2, hh = rect.height / 2;
    if (!(hw > 0) || !(hh > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return { x: 0, y: 0 };
    return {
        x: clamp1((cx - (rect.left + hw)) / hw),
        y: clamp1((cy - (rect.top + hh)) / hh),
    };
}

/** The tilt for a normalised position: always within the MAX_* bounds. */
export function tiltAngles(v: Vec): { rx: number; ry: number } {
    const x = clamp1(Number.isFinite(v.x) ? v.x : 0);
    const y = clamp1(Number.isFinite(v.y) ? v.y : 0);
    return { rx: -y * MAX_TILT_X_DEG, ry: x * MAX_TILT_Y_DEG };
}

/** A layer's parallax shift (px) for a normalised position. */
export function layerShift(layer: keyof typeof DEPTH, v: Vec): Vec {
    const d = DEPTH[layer];
    return { x: clamp1(v.x) * d.x, y: clamp1(v.y) * d.y };
}

/** One frame of the exponential approach: `cur` moves toward `target` by
 *  the fraction a time constant `tau` covers in `dt`. Never overshoots. */
export function stepToward(cur: number, target: number, dtMs: number, tauMs: number): number {
    const dt = Math.min(Math.max(0, dtMs), MAX_FRAME_DT_MS);
    if (tauMs <= 0) return target;
    const k = 1 - Math.exp(-dt / tauMs);
    const next = cur + (target - cur) * k;
    return Math.abs(target - next) < SETTLE_EPS ? target : next;
}

export interface ParallaxDeps {
    raf: (cb: (t: number) => void) => number;
    caf: (id: number) => void;
    now: () => number;
    /** Write the eased position. `active` false = at rest (the host drops
     *  the 3D transform entirely, so no layer is left promoted). */
    apply: (v: Vec, active: boolean) => void;
}

/**
 * Pointer in → eased position out. `enter` caches the rect, `move` sets the
 * target, `leave` sends it home; frames run only while something moves.
 * `setEnabled(false)` (reduced motion, a hidden window) parks it at rest and
 * ignores the pointer until enabled again.
 */
export class ParallaxController {
    private rect: Rect | null = null;
    private target: Vec = { x: 0, y: 0 };
    private cur: Vec = { x: 0, y: 0 };
    private frame = 0;
    private last = 0;
    private enabled = true;
    private over = false;
    private readonly deps: ParallaxDeps;
    constructor(deps: ParallaxDeps) { this.deps = deps; }

    /** The current eased position (tests, and the host's hit-test math). */
    get position(): Vec { return { ...this.cur }; }
    get running(): boolean { return this.frame !== 0; }
    get hovering(): boolean { return this.over; }

    enter(rect: Rect): void {
        this.rect = rect;
        this.over = true;
    }
    /** The cached rect is stale (a scroll, a resize): re-read on the next move. */
    invalidate(): void { this.rect = null; }
    needsRect(): boolean { return this.rect === null; }

    move(cx: number, cy: number, rect?: Rect): void {
        if (rect) this.rect = rect;
        if (!this.enabled || !this.rect) return;
        this.over = true;
        this.target = pointerToNorm(cx, cy, this.rect);
        this.kick();
    }

    leave(): void {
        this.over = false;
        this.target = { x: 0, y: 0 };
        if (this.enabled) this.kick();
    }

    setEnabled(on: boolean): void {
        if (on === this.enabled) return;
        this.enabled = on;
        if (!on) {
            if (this.frame) this.deps.caf(this.frame);
            this.frame = 0;
            this.target = { x: 0, y: 0 };
            this.cur = { x: 0, y: 0 };
            this.over = false;
            this.deps.apply(this.cur, false);
        }
    }

    destroy(): void {
        if (this.frame) this.deps.caf(this.frame);
        this.frame = 0;
    }

    private kick(): void {
        if (this.frame) return;
        this.last = this.deps.now();
        this.frame = this.deps.raf(t => this.tick(t));
    }

    private tick(t: number): void {
        this.frame = 0;
        const now = Number.isFinite(t) && t > 0 ? t : this.deps.now();
        const dt = now - this.last;
        this.last = now;
        const tau = this.over ? FOLLOW_TAU_MS : RELAX_TAU_MS;
        this.cur = {
            x: stepToward(this.cur.x, this.target.x, dt, tau),
            y: stepToward(this.cur.y, this.target.y, dt, tau),
        };
        const settled = this.cur.x === this.target.x && this.cur.y === this.target.y;
        const atRest = settled && this.cur.x === 0 && this.cur.y === 0;
        this.deps.apply(this.cur, !atRest);
        if (!settled) this.frame = this.deps.raf(tt => this.tick(tt));
    }
}
