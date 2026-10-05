/**
 * homeAmbient — deterministic mote field for the home deck's ambient layer
 * (components/HomeAmbient.tsx). The inverse of the seasonal marine snow:
 * bioluminescent motes RISING from the deep, so the two layers read as
 * different phenomena and can coexist in December.
 *
 * Same contract as utils/seasonal.ts's flake generator: NO Math.random —
 * placement, size, timing all derive from the index, so the field is
 * identical every mount (no pop-in variance) and testable. Negative delays
 * start the field mid-drift on frame 1.
 */

export interface Mote {
    /** Horizontal position, % of container width. */
    left: number;
    /** Dot size in px (2–5). */
    size: number;
    /** Full-rise duration, seconds (30–50 — slow; ambience, not weather). */
    duration: number;
    /** Negative start offset, seconds — mid-drift on first frame. */
    delay: number;
    /** Horizontal drift over the rise, px (−26 … +26). */
    drift: number;
    /** Peak opacity (.2–.5 — never competes with content). */
    opacity: number;
}

/** How many motes a pane this wide earns. Sparse by design. */
export function moteCount(width: number): number {
    return Math.max(6, Math.min(14, Math.round(width / 180)));
}

/** Deterministic pseudo-random in [0,1) from an index — mulberry-ish mix,
 *  good enough for scattering dots, stable forever. */
function unit(i: number, salt: number): number {
    let t = (i + 1) * 2654435761 + salt * 40503;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function makeMotes(count: number): Mote[] {
    const motes: Mote[] = [];
    for (let i = 0; i < count; i++) {
        const duration = 30 + unit(i, 1) * 20;             // 30–50s
        motes.push({
            left: Math.round(unit(i, 0) * 96 + 2),          // 2–98%
            size: 2 + Math.round(unit(i, 2) * 3),           // 2–5px
            duration: Math.round(duration * 10) / 10,
            delay: -Math.round(unit(i, 3) * duration * 10) / 10, // mid-drift
            drift: Math.round((unit(i, 4) - 0.5) * 52),     // ±26px
            opacity: Math.round((0.2 + unit(i, 5) * 0.3) * 100) / 100, // .2–.5
        });
    }
    return motes;
}
