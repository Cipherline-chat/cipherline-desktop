/**
 * Shared geometry for avatar decorations. A decoration is drawn in a 100x100
 * box that IS the avatar (centre 50,50, radius 50); art may overflow it.
 *
 * STATUS-DOT SAFE ZONE: the status dot sits on the avatar's bottom-right
 * (profile card: a 20px dot + 4px ring at right/bottom 3px on a 92px avatar ->
 * centre ~85.9%, radius ~15.2%). No decoration may draw there: every layer is
 * masked with `SAFE_ZONE` cut out (ProfileCosmetics.tsx), AND every
 * decoration's own geometry is composed to stay clear of it - checked by
 * cosmetics/decorationSafeZone.test.ts.
 */
export const SAFE_ZONE = { cx: 85.5, cy: 85.5, r: 17.5 } as const;

/** A point `r` from (cx, cy) at `deg` degrees clockwise from twelve o'clock. */
export const polar = (r: number, deg: number, cx = 50, cy = 50): [number, number] => {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
export const f1 = (n: number) => (Math.round(n * 100) / 100).toString();
export const pt = (p: [number, number]) => `${f1(p[0])} ${f1(p[1])}`;

/** The status dot's direction from the avatar centre (degrees from twelve, clockwise). */
export const DOT_DEG = 135;
const D0 = Math.hypot(SAFE_ZONE.cx - 50, SAFE_ZONE.cy - 50);

/**
 * Half the angular gap (degrees, around DOT_DEG) a ring of radius `r` and
 * half-width `pad` must leave so it stays at least 1 unit outside the safe
 * zone. `capPad` adds the angle a round line cap reaches past its end.
 */
export function gapHalf(r: number, pad: number, capPad = 0): number {
    const R = SAFE_ZONE.r + pad + 1;
    const c = (r * r + D0 * D0 - R * R) / (2 * r * D0);
    const base = c >= 1 ? 0 : c <= -1 ? 180 : Math.acos(c) * 180 / Math.PI;
    return base + (capPad / r) * 180 / Math.PI;
}

/** An arc path from `a0` to `a1` degrees (clockwise), radius r, about (50, 50). */
export function arcPath(r: number, a0: number, a1: number): string {
    const large = (a1 - a0) % 360 > 180 ? 1 : 0;
    return `M${pt(polar(r, a0))} A${f1(r)} ${f1(r)} 0 ${large} 1 ${pt(polar(r, a1))}`;
}

/** A ring that opens around the status dot. Returns the path and the angles it spans. */
export function gappedRing(r: number, pad: number, capPad = 0): { d: string; a0: number; a1: number; len: number } {
    const g = gapHalf(r, pad, capPad);
    const a0 = DOT_DEG + g, a1 = DOT_DEG + 360 - g;
    return { d: arcPath(r, a0, a1), a0, a1, len: r * (a1 - a0) * Math.PI / 180 };
}

/** Is the angle (degrees) inside the status-dot gap of a ring of radius r? */
export const inGap = (deg: number, r: number, pad: number): boolean => {
    const g = gapHalf(r, pad);
    const d = Math.abs((((deg - DOT_DEG) % 360) + 540) % 360 - 180);
    return d < g;
};

/** Point on a cubic Bezier. */
export function bez(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], t: number): [number, number] {
    const u = 1 - t;
    return [
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
}

/** Deterministic PRNG (mulberry32): same seed, same art, every render. */
export function rng(seed: number): () => number {
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
 * A tapered ribbon (kelp blade, seagrass) along a cubic Bezier centreline:
 * width w0 at the base narrowing to w1 at the tip. Returns a closed path.
 */
export function ribbon(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], w0: number, w1: number, steps = 18): string {
    const L: string[] = [], R: string[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const [x, y] = bez(p0, p1, p2, p3, t);
        const [xa, ya] = bez(p0, p1, p2, p3, Math.min(1, t + 0.01));
        const [xb, yb] = bez(p0, p1, p2, p3, Math.max(0, t - 0.01));
        let nx = -(ya - yb), ny = xa - xb;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        const w = (w0 + (w1 - w0) * t) / 2;
        L.push(`${f1(x + nx * w)} ${f1(y + ny * w)}`);
        R.push(`${f1(x - nx * w)} ${f1(y - ny * w)}`);
    }
    return `M${L.join(' L')} L${R.reverse().join(' L')} Z`;
}
