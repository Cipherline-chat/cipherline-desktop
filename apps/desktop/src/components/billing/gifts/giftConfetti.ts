/**
 * The purchase-success burst: a fixed, seeded set of ribbon strips and dots
 * (deterministic, so the screenshot harness frames are stable and nothing
 * calls Math.random during render). Rendered by GiftBox's `burst` layer and
 * animated purely in CSS (gifts.css, `gft-fly`).
 */

export type ConfettiShape = 'strip' | 'dot' | 'curl';

export interface ConfettiPiece {
    shape: ConfettiShape;
    /** CSS colour (design tokens). */
    color: string;
    /** Peak offset from the box centre, px (y is up = negative). */
    dx: number;
    dy: number;
    /** Extra fall after the peak, px. */
    fall: number;
    /** Total spin, degrees. */
    rot: number;
    /** Start offset inside the burst, ms. */
    delay: number;
    /** Size scale, 0.7..1.3. */
    scale: number;
}

/** Lume, Glow, Flash and white: the house confetti palette (BillingTab's celebrate()). */
export const CONFETTI_COLORS = ['var(--cl-glow)', 'var(--cl-lume)', 'var(--cl-flash)', '#F4F7FF', 'var(--cl-lume-hi)', 'var(--cl-glow)'] as const;

/** mulberry32: tiny, seedable, good enough for scattering paper. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * `count` pieces fanned upward around the box (a 200 degree arc, never straight
 * down into the text below), spread evenly with jitter so no two clump.
 */
export function confettiPieces(count = 18, seed = 7, radius = 110): ConfettiPiece[] {
    const r = rng(seed);
    const shapes: ConfettiShape[] = ['strip', 'dot', 'curl', 'strip'];
    const out: ConfettiPiece[] = [];
    const n = Math.max(0, Math.floor(count));
    for (let i = 0; i < n; i++) {
        // -190deg .. 10deg (0 = right, -90 = straight up)
        const base = -190 + (200 * (i + 0.5)) / Math.max(1, n);
        const ang = ((base + (r() - 0.5) * 14) * Math.PI) / 180;
        const dist = radius * (0.55 + r() * 0.5);
        out.push({
            shape: shapes[i % shapes.length],
            color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            dx: Math.round(Math.cos(ang) * dist),
            dy: Math.round(Math.sin(ang) * dist * 0.85),
            fall: Math.round(36 + r() * 40),
            rot: Math.round((r() - 0.5) * 720),
            delay: Math.round(r() * 90),
            scale: Math.round((0.7 + r() * 0.6) * 100) / 100,
        });
    }
    return out;
}
