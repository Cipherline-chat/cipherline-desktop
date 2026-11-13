import React from 'react';
import type { ItemOptions } from '../../utils/profileCosmetics';
import {
    AURORA_RING_COLOURS, PEARL_COLOURS, SEA_FAN_COLOURS,
} from '../../utils/profileCosmetics';
import { hexToHsl, itemTint, shade, type HSL } from './colour';
import { arcPath, bez, f1, gapHalf, gappedRing, inGap, polar, pt, ribbon, rng } from './geometry';
import { KeysHead, KeysPaws, Lin, Rad } from './svgParts';
import { HALO_ART } from './halos';

/**
 * Avatar decoration ART (SVG). Ids + unlock rules: utils/profileCosmetics.ts.
 *
 * Direction: specimen plates lit from the surface. Every item is drawn as a
 * small lit object - a body colour, a darker shadow side, a rim of light on
 * the upper edges and, where the creature glows, a soft bloom - all derived
 * from ONE tint (hue option > theme "match" > the item's stock colour), so a
 * recolour stays coherent. Motion is slow and physical (sway, pulse, glide)
 * and only ever transform / opacity / stroke-dashoffset on a few groups.
 *
 * Composition rule: nothing sits in the bottom-right, where the status dot is
 * (geometry.ts SAFE_ZONE). Rings open around it; creatures and plants live on
 * the left, the top and the upper right.
 */

export interface DecoCtx {
    /** Per-instance id prefix (SVG ids must be unique per document). */
    u: string;
    o: ItemOptions;
    /** "Match theme" colour from the card, or null. */
    tint: string | null;
    /**
     * Drawn at thumbnail size (the Settings picker's 26-44px avatars): items
     * whose detail is finer than a pixel there (hairline orbits, corona
     * streamers, bat silhouettes) draw a bolder version of the same picture.
     * Most items ignore it.
     */
    compact?: boolean;
}
export type Draw = (c: DecoCtx) => React.ReactNode;
export interface DecorationArt { back?: Draw; front?: Draw }

const K: Readonly<Record<number, number>> = { 1: 0.6, 2: 1, 3: 1.45 };
const k = (v: number | undefined) => K[v ?? 2] ?? 1;
const pick = <T,>(list: readonly T[], i: number | undefined): T => list[Math.max(0, Math.min(list.length - 1, i ?? 0))];
const hsl = (hex: string): HSL => hexToHsl(hex)!;


// ── Rings ────────────────────────────────────────────────────────────────────

/** Lume ring: a crisp line of light, a soft bloom, and a glint that travels around it. */
const lumeRing: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#25E0C8');
    const g = k(o.i);
    const style = o.p ?? 0;
    const R = 53.6;
    const ring = gappedRing(R, 3.6, 1.2);
    return (
        <>
            {style === 2 && (
                <>
                    <defs>
                        <Rad id={`${u}-halo`} user cx={50} cy={50} r={66} stops={[[0.74, shade(t, 0, 0)], [0.82, shade(t, 6, 0.42 * g)], [0.9, shade(t, -6, 0.12 * g)], [1, shade(t, 0, 0)]]} />
                    </defs>
                    <circle data-glow="halo" className="pc-breathe" cx="50" cy="50" r="66" fill={`url(#${u}-halo)`} />
                </>
            )}
            <path d={ring.d} fill="none" stroke={shade(t, 0, 0.2 * g)} strokeWidth="7" strokeLinecap="round" />
            <path d={ring.d} fill="none" stroke={shade(t, 4)} strokeWidth={style === 1 ? 1.8 : 2.4} strokeLinecap="round" />
            {style === 1 && <path d={gappedRing(58.6, 1.2, 0.6).d} fill="none" stroke={shade(t, 12, 0.7)} strokeWidth="0.9" strokeLinecap="round" />}
            <path className="pc-glint" d={ring.d} fill="none" stroke={shade(t, 30, 0.95, -25)} strokeWidth="1.5" strokeLinecap="round" pathLength={100} strokeDasharray="5 95" />
        </>
    );
};

const MORSE: Record<string, string> = { C: '-.-.', I: '..', P: '.--.', H: '....', E: '.', R: '.-.', L: '.-..', N: '-.' };
/** Dash pattern for a word in Morse (round caps: a "dot" is a near-zero dash). */
function morse(word: string): number[] {
    const out: number[] = [];
    for (const ch of word) {
        const code = MORSE[ch];
        if (!code) continue;
        [...code].forEach((s, i) => { out.push(s === '-' ? 3.6 : 0.01, i === code.length - 1 ? 7 : 3); });
    }
    out[out.length - 1] = 12; // word gap before it repeats
    return out;
}

/** Deep dash: a ring of dashes (or dots, or "CIPHERLINE" in Morse) flowing slowly around. */
const deepDash: Draw = ({ o, tint }) => {
    const t = itemTint(o.h, tint, '#5E8EE0');
    const pattern = o.p === 1 ? [0.01, 4.8] : o.p === 2 ? morse('CIPHERLINE') : [6.4, 4.4];
    const period = pattern.reduce((a, b) => a + b, 0);
    const ring = gappedRing(54.6, 1.6, 1.5);
    return (
        <>
            <path d={ring.d} fill="none" stroke={shade(t, -8, 0.32)} strokeWidth="0.7" />
            <path
                className="pc-dashflow" d={ring.d} fill="none" stroke={shade(t, 6)} strokeWidth={o.p === 1 ? 3.1 : 2.5} strokeLinecap="round"
                strokeDasharray={pattern.map(f1).join(' ')} style={{ ['--pc-dash' as string]: `${f1(period)}` }}
            />
        </>
    );
};

/** A diver's watch bezel that opens around the status dot, its first quarter lit. */
const diveBezel: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#25E0C8');
    const R = 58.2, W = 9.4;
    const band = gappedRing(R, W / 2, W / 2);
    const ticks: React.ReactNode[] = [];
    const lumeDots = o.p === 1;
    for (let i = 1; i < 60; i++) {
        const deg = i * 6;
        if (inGap(deg, R, W / 2 + 2)) continue;
        const major = i % 5 === 0;
        if (lumeDots && major) {
            const [x, y] = polar(R, deg);
            ticks.push(<circle key={i} cx={f1(x)} cy={f1(y)} r="1.45" fill={shade(t, 14)} />);
            continue;
        }
        const [x1, y1] = polar(major ? 54.8 : 56.6, deg);
        const [x2, y2] = polar(major ? 61.4 : 59.8, deg);
        ticks.push(<line key={i} x1={f1(x1)} y1={f1(y1)} x2={f1(x2)} y2={f1(y2)} stroke={!lumeDots && deg <= 90 ? shade(t, 10) : '#DCE4F7'} strokeOpacity={major ? 0.95 : 0.5} strokeWidth={major ? 1.6 : 0.75} strokeLinecap="round" />);
    }
    return (
        <>
            <defs>
                <Lin id={`${u}-bez`} stops={[[0, '#26345E'], [0.5, '#121A35'], [1, '#0A1024']]} />
            </defs>
            <path d={band.d} fill="none" stroke={`url(#${u}-bez)`} strokeWidth={W} strokeLinecap="round" />
            {!lumeDots && <path d={arcPath(R, 0, 90)} fill="none" stroke={shade(t, 0, 0.2)} strokeWidth={W} />}
            <path d={gappedRing(R + W / 2 - 0.5, 0.6, 0.6).d} fill="none" stroke={shade(t, 18, 0.32)} strokeWidth="0.7" strokeLinecap="round" />
            <path d={arcPath(R + W / 2 - 0.9, -62, 62)} fill="none" stroke="#FFFFFF" strokeOpacity=".2" strokeWidth=".8" strokeLinecap="round" />
            <path d={gappedRing(R - W / 2 + 0.3, 0.5, 0.5).d} fill="none" stroke="#000" strokeOpacity=".35" strokeWidth=".7" />
            {ticks}
            <path d="M45.2 -11.6 L54.8 -11.6 L50 -3.8 Z" fill={shade(t, 10)} stroke={shade(t, 10)} strokeWidth="1.1" strokeLinejoin="round" />
            <circle cx="50" cy="-8.8" r="1.2" fill="#0B1226" />
        </>
    );
};

/** Aurora ring: three colours flowing around the ring under a static mask (the gap never moves). */
const auroraRing: Draw = ({ u, o }) => {
    const base = hsl(pick(AURORA_RING_COLOURS, o.c)[1]);
    const c0 = shade(base, 4), c1 = shade(base, 0, 1, 0, 55), c2 = shade(base, 6, 1, 0, -70);
    const R = 54;
    const core = gappedRing(R, 3, 1.6);
    const wide = gappedRing(R, 6.5, 3);
    return (
        <>
            <defs>
                <Lin id={`${u}-a`} x2={1} y2={1} stops={[[0, c0], [0.5, c1], [1, c2]]} />
                <Lin id={`${u}-b`} x1={1} x2={0} y2={1} stops={[[0, c2], [0.5, c0], [1, c1]]} />
                <mask id={`${u}-core`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
                    <path d={core.d} fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
                </mask>
                <mask id={`${u}-wide`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
                    <path d={wide.d} fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth="11" strokeLinecap="round" />
                </mask>
            </defs>
            {[`${u}-wide`, `${u}-core`].map((m) => (
                <g key={m} mask={`url(#${m})`}>
                    <g className="pc-spin"><circle cx="50" cy="50" r="62" fill={`url(#${u}-a)`} /></g>
                    <g className="pc-spin pc-spin--rev" opacity=".65"><circle cx="50" cy="50" r="62" fill={`url(#${u}-b)`} /></g>
                </g>
            ))}
        </>
    );
};

/** Abyss halo: a crisp ring, a gold hairline, and a soft halo that breathes. */
const abyssHalo: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#25E0C8');
    const gold = hsl('#FFC94D');
    const g = k(o.i);
    return (
        <>
            <defs>
                <Rad id={`${u}-h`} user cx={50} cy={50} r={70} stops={[[0.7, shade(t, 0, 0)], [0.77, shade(t, 8, 0.5 * g)], [0.84, shade(gold, 0, 0.2 * g)], [1, shade(gold, 0, 0)]]} />
            </defs>
            <circle data-glow="halo" className="pc-breathe" cx="50" cy="50" r="70" fill={`url(#${u}-h)`} />
            <path d={gappedRing(53, 1.3, 1.2).d} fill="none" stroke={shade(t, 10)} strokeWidth="2.2" strokeLinecap="round" />
            <path d={gappedRing(57.6, 0.5, 0.5).d} fill="none" stroke={shade(gold, 4, 0.75)} strokeWidth="0.9" strokeLinecap="round" />
        </>
    );
};

/** Pearls on a string that opens around the status dot, a gold clasp at one end. */
const pearlString: Draw = ({ u, o }) => {
    const col = hsl(pick(PEARL_COLOURS, o.c)[1]);
    const R = 55.2, pr = 3.25;
    const g = gapHalf(R, pr + 0.6);
    const a0 = 135 + g + 4, a1 = 495 - g - 2;
    const step = (2 * pr + 0.55) / R * 180 / Math.PI;
    const n = Math.floor((a1 - a0) / step) + 1;
    const pearls: React.ReactNode[] = [];
    for (let i = 0; i < n; i++) {
        const [x, y] = polar(R, a0 + i * step);
        pearls.push(
            <g key={i} transform={`translate(${f1(x)} ${f1(y)})`}>
                <circle cx=".55" cy=".85" r={pr} fill="#000" fillOpacity=".38" />
                <circle r={pr} fill={`url(#${u}-p)`} />
                <circle r={pr} fill={`url(#${u}-o)`} />
                <circle cx="-1.1" cy="-1.2" r=".75" fill="#fff" fillOpacity=".9" />
            </g>,
        );
    }
    const [cx, cy] = polar(R, a0 - 3.4);
    return (
        <>
            <defs>
                <Rad id={`${u}-p`} cx={0.36} cy={0.3} r={0.78} stops={[[0, '#FFFFFF'], [0.3, shade(col, 10)], [0.75, shade(col, -4)], [1, shade(col, -26)]]} />
                <Rad id={`${u}-o`} cx={0.7} cy={0.75} r={0.6} stops={[[0, 'hsl(320 70% 80% / .28)'], [0.6, 'hsl(160 60% 75% / .12)'], [1, 'hsl(0 0% 100% / 0)']]} />
                <Lin id={`${u}-g`} stops={[[0, '#FFE39A'], [0.5, '#E2A93A'], [1, '#9C6A12']]} />
            </defs>
            <path d={arcPath(R, a0, a1)} fill="none" stroke="#E9EEF8" strokeOpacity=".35" strokeWidth=".45" />
            {pearls}
            <g transform={`translate(${f1(cx)} ${f1(cy)}) rotate(${f1(a0 - 3.4 + 90)})`}>
                <rect x="-2.6" y="-2" width="5.2" height="4" rx="1.2" fill={`url(#${u}-g)`} stroke="#7A5208" strokeWidth=".4" />
                <circle r=".8" fill="#FFF3CC" />
            </g>
        </>
    );
};


// ── Keys (the mascot): one item shows him ───────────────────────────────────

const KEYS_STOCK = '#25E0C8';
const keysPeek: DecorationArt = {
    back: ({ u, o, tint }) => <KeysHead u={u} t={itemTint(o.h, tint, KEYS_STOCK)} mood={o.p} />,
    front: ({ o, tint }) => <KeysPaws t={itemTint(o.h, tint, KEYS_STOCK)} />,
};

// ── Plants ───────────────────────────────────────────────────────────────────

type P = [number, number];
/** One kelp frond: a stipe along a cubic, blades with a float at each base. */
function frond(key: string, c: [P, P, P, P], blades: number, len0: number, fillId: string, t: HSL, side: 'both' | 'out' = 'both', outSign = 1): React.ReactNode {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < blades; i++) {
        const tt = 0.14 + (i / Math.max(1, blades - 1)) * 0.82;
        const [x, y] = bez(...c, tt);
        const [xa, ya] = bez(...c, Math.min(1, tt + 0.02));
        const tan = Math.atan2(ya - y, xa - x) * 180 / Math.PI;
        const s = side === 'out' ? outSign : (i % 2 ? 1 : -1);
        const rot = tan + s * 34;
        const len = len0 * (1 - tt * 0.38);
        const w = len * 0.25;
        out.push(
            <g key={i} transform={`translate(${f1(x)} ${f1(y)}) rotate(${f1(rot)})`}>
                <path d={`M0 0 C ${f1(len * 0.12)} ${f1(-w * 0.9)}, ${f1(len * 0.3)} ${f1(-w * 1.1)}, ${f1(len * 0.45)} ${f1(-w * 0.86)} Q ${f1(len * 0.55)} ${f1(-w * 1.12)} ${f1(len * 0.66)} ${f1(-w * 0.72)} Q ${f1(len * 0.78)} ${f1(-w * 0.82)} ${f1(len * 0.86)} ${f1(-w * 0.36)} L ${f1(len)} ${f1(-w * 0.1)} C ${f1(len * 0.7)} ${f1(w * 0.9)}, ${f1(len * 0.25)} ${f1(w * 0.95)}, 0 0 Z`} fill={`url(#${fillId})`} />
                <path d={`M${f1(len * 0.08)} 0 Q ${f1(len * 0.5)} ${f1(-w * 0.15)} ${f1(len * 0.86)} 0`} stroke={shade(t, -22, 0.55)} strokeWidth=".35" fill="none" />
                <ellipse cx="-.6" cy="0" rx="1.5" ry="1.15" fill={shade(t, 10)} />
            </g>,
        );
    }
    const [p0, p1, p2, p3] = c;
    return (
        <g key={key} className="pc-sway" style={{ animationDelay: `${-(key.charCodeAt(0) % 7) * 0.9}s` }}>
            <path d={`M${pt(p0)} C ${pt(p1)}, ${pt(p2)}, ${pt(p3)}`} fill="none" stroke={shade(t, -18)} strokeWidth="2.4" strokeLinecap="round" />
            {out}
        </g>
    );
}

const kelp: DecorationArt = {
    back: ({ u, o, tint }) => {
        const t = itemTint(o.h, tint, '#3FD49A');
        const n = o.n ?? 2;
        const id = `${u}-kb`;
        return (
            <g>
                <defs>
                    <Lin id={id} x2={1} y2={0} stops={[[0, shade(t, -18)], [0.55, shade(t, 0)], [1, shade(t, 14)]]} />
                </defs>
                {n >= 3 && frond('c', [[-20, 114], [-34, 84], [-18, 58], [-34, 24]], 7, 20, id, t)}
                {frond('a', [[-4, 118], [-24, 80], [-2, 42], [-16, -6]], 10, 26, id, t)}
                {n >= 2 && frond('b', [[12, 120], [0, 102], [16, 86], [2, 64]], 5, 18, id, t)}
                {frond('r', [[118, 100], [128, 80], [112, 60], [122, 28]], n >= 3 ? 6 : 4, 19, id, t, 'out', 1)}
            </g>
        );
    },
    front: ({ u, o, tint }) => {
        const t = itemTint(o.h, tint, '#3FD49A');
        return (
            <g className="pc-sway" style={{ animationDelay: '-2.4s' }}>
                <defs><Lin id={`${u}-kf`} x2={1} y2={0} stops={[[0, shade(t, -14)], [1, shade(t, 12)]]} /></defs>
                <path d="M-6 76 C 0 70, 8 68.6, 18 70.4 Q 13 73.4 9 73.6 Q 4 76.4 -6 76 Z" fill={`url(#${u}-kf)`} />
                <path d="M-4 75.4 Q 6 71.6 16 70.8" fill="none" stroke={shade(t, -24, 0.5)} strokeWidth=".4" />
            </g>
        );
    },
};

/** Seagrass: long ribbons rising from the lower left and leaning over in the current. */
const seagrass: DecorationArt = {
    back: ({ u, o, tint }) => {
        const t = itemTint(o.h, tint, '#7BD65A');
        const n = o.n ?? 2;
        const all: Array<[P, P, P, P, number]> = [
            [[-10, 116], [-22, 76], [-18, 30], [12, -12], 4.6],
            [[-2, 118], [-10, 80], [-4, 36], [30, -20], 4.2],
            [[-18, 114], [-30, 82], [-34, 50], [-24, 16], 4],
            [[8, 120], [4, 98], [10, 80], [30, 72], 3.4],
            [[-14, 116], [-24, 94], [-28, 72], [-42, 54], 3.6],
            [[-6, 118], [-16, 70], [6, 18], [48, -24], 3.8],
            [[14, 120], [14, 106], [24, 94], [40, 92], 3],
        ];
        const blades = all.slice(0, n === 1 ? 3 : n === 2 ? 5 : 7);
        return (
            <g>
                <defs><Lin id={`${u}-g`} y1={1} y2={0} stops={[[0, shade(t, -26)], [0.5, shade(t, -6)], [1, shade(t, 14)]]} /></defs>
                {blades.map(([p0, p1, p2, p3, w], i) => (
                    <g key={i} className="pc-sway pc-sway--long" style={{ animationDelay: `${-i * 1.15}s` }}>
                        <path d={ribbon(p0, p1, p2, p3, w, 0.5)} fill={`url(#${u}-g)`} />
                        <path d={`M${pt(bez(p0, p1, p2, p3, 0.15))} C ${pt(bez(p0, p1, p2, p3, 0.45))}, ${pt(bez(p0, p1, p2, p3, 0.7))}, ${pt(bez(p0, p1, p2, p3, 0.92))}`} fill="none" stroke={shade(t, 26, 0.45)} strokeWidth=".45" strokeLinecap="round" />
                    </g>
                ))}
            </g>
        );
    },
};

/**
 * A gorgonian sea fan rooted on the avatar's lower-left rim and opening up
 * over its left side (owner: the old fan was "mostly off profile"). Grown by
 * branching (seeded: the same fan every time) with the cross-links of the
 * real lattice. It stays within the decoration's visible bounds: every branch
 * turns along SEA_FAN_REACH (from the avatar centre) instead of crossing it,
 * and growth keeps to upward directions, well clear of the status dot. Drawn
 * in front of the avatar's edge but faded out towards its middle (a radial
 * mask over the fan's sector), so it frames the face instead of covering it.
 */
export const SEA_FAN_REACH = 66;
const seaFan: DecorationArt = {
    front: ({ u, o }) => {
        const col = hsl(pick(SEA_FAN_COLOURS, o.c)[1]);
        const depthMax = 5 + (o.n ?? 2);
        const rand = rng(1907);
        const byDepth: string[] = Array.from({ length: depthMax + 1 }, () => '');
        const tips: P[] = [];
        const levels: P[][] = Array.from({ length: depthMax + 1 }, () => []);
        const R = SEA_FAN_REACH - 3.5; // room for a bent branch's bow and the polyp on its tip
        const root: P = polar(52, 218);
        const axis = -112, sector = 74;
        const grow = (x: number, y: number, ang: number, len: number, depth: number) => {
            let ad = Math.max(axis - sector, Math.min(axis + sector, ang));
            // At the reach circle a branch turns to run along it (towards its own side of the fan) instead of crossing it.
            const side = ad >= axis ? 1 : -1;
            const over = (d: number) => Math.hypot(x + Math.cos(d * Math.PI / 180) * len - 50, y + Math.sin(d * Math.PI / 180) * len - 50) > R;
            for (let k2 = 0; k2 < 10 && over(ad); k2++) ad += side * 8;
            const a = ad * Math.PI / 180;
            const dx = Math.cos(a), dy = Math.sin(a);
            const px = x - 50, py = y - 50;
            const bq = px * dx + py * dy, cq = px * px + py * py - R * R;
            const sMax = -bq + Math.sqrt(Math.max(0, bq * bq - cq));
            const clipped = len >= sMax;
            const L = clipped ? Math.max(0, sMax - 0.6) : len;
            if (L < 1) { tips.push([x, y]); return; }
            const ex = x + dx * L, ey = y + dy * L;
            const bend = (rand() - 0.5) * L * 0.3;
            const mx = (x + ex) / 2 - dy * bend, my = (y + ey) / 2 + dx * bend;
            byDepth[depth] += `M${f1(x)} ${f1(y)} Q ${f1(mx)} ${f1(my)} ${f1(ex)} ${f1(ey)} `;
            levels[depth].push([ex, ey]);
            if (clipped || depth >= depthMax) { tips.push([ex, ey]); return; }
            const spread = 13 + rand() * 9;
            const kids = depth < 2 ? 2 : rand() < 0.84 ? 2 : 1;
            for (let i = 0; i < kids; i++) {
                const na = ad + (kids === 1 ? (rand() - 0.5) * 14 : (i ? spread : -spread)) + (rand() - 0.5) * 8;
                grow(ex, ey, na, len * (0.85 + rand() * 0.07), depth + 1);
            }
        };
        grow(root[0], root[1], axis + 8, 11, 0);
        // The lattice: link each node to its nearest same-level neighbour (sorted round the holdfast).
        let mesh = '';
        for (let d = 2; d <= depthMax; d++) {
            const lv = [...levels[d]].sort((p, q) => Math.atan2(p[1] - root[1], p[0] - root[0]) - Math.atan2(q[1] - root[1], q[0] - root[0]));
            for (let i = 1; i < lv.length; i++) {
                const [p1, p2] = [lv[i - 1], lv[i]];
                if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 8) mesh += `M${f1(p1[0])} ${f1(p1[1])} L${f1(p2[0])} ${f1(p2[1])} `;
            }
        }
        const polyps = tips.map(([x, y]) => `M${f1(x - 0.85)} ${f1(y)} a.85 .85 0 1 0 1.7 0 a.85 .85 0 1 0 -1.7 0`).join(' ');
        // The fade: an annular sector over the fan's side only (never the dot's), bright outside the rim, gone by the face.
        const a0 = 170, a1 = 420;
        const sectorPath = `M${pt(polar(R + 4, a0))} A${R + 4} ${R + 4} 0 1 1 ${pt(polar(R + 4, a1))} L${pt(polar(30, a1))} A30 30 0 1 0 ${pt(polar(30, a0))} Z`;
        return (
            <>
                <defs>
                    <Rad id={`${u}-fade`} user cx={50} cy={50} r={R + 4} stops={[[0.46, '#000'], [0.68, '#555'], [0.78, '#fff']]} />
                    <mask id={`${u}-fan`} maskUnits="userSpaceOnUse" x="-30" y="-30" width="160" height="160">
                        <path d={sectorPath} fill={`url(#${u}-fade)`} />
                    </mask>
                </defs>
                <g mask={`url(#${u}-fan)`}>
                    <g className="pc-sway pc-sway--fan" style={{ transformOrigin: `${f1(root[0])}px ${f1(root[1])}px` }}>
                        <path d={mesh} fill="none" stroke={shade(col, -6, 0.55)} strokeWidth=".42" strokeLinecap="round" />
                        {byDepth.map((p, dd) => p && (
                            <path key={dd} d={p} fill="none" stroke={shade(col, -22 + dd * 5, 1, -30 + dd * 5)} strokeWidth={f1(Math.max(0.5, 2.8 - dd * 0.36))} strokeLinecap="round" />
                        ))}
                        <path d={polyps} fill={shade(col, 26)} />
                    </g>
                </g>
            </>
        );
    },
};

// ── Creatures ────────────────────────────────────────────────────────────────

/** A manta banking over the top of the avatar, seen from above, its leading edges lit. */
// Right half of a manta seen from above, nose up: cephalic fin, the long
// leading edge out to a swept wing tip, the concave trailing edge, the pelvis.
// Each entry is a cubic [c1, c2, end]; the left half is the same, mirrored.
const MANTA_START: P = [0, -25];
const MANTA_RIGHT: Array<[P, P, P]> = [
    [[3, -25], [5, -25.4], [6.4, -25.8]],
    [[6, -30], [7.4, -34.6], [9.6, -33.2]],
    [[11.2, -31.6], [11, -27.4], [11.6, -24.6]],
    [[28, -24.4], [52, -16.6], [71, 4]],
    [[56, 4.4], [36, 11.6], [21, 27]],
    [[15, 33], [8, 34.6], [0, 34]],
];
const mx = (p: P): string => `${f1(-p[0])} ${f1(p[1])}`;
function mantaOutline(): string {
    let d = `M${pt(MANTA_START)}`;
    for (const [c1, c2, e] of MANTA_RIGHT) d += ` C ${pt(c1)}, ${pt(c2)}, ${pt(e)}`;
    for (let i = MANTA_RIGHT.length - 1; i >= 0; i--) {
        const [c1, c2] = MANTA_RIGHT[i];
        const s = i === 0 ? MANTA_START : MANTA_RIGHT[i - 1][2];
        d += ` C ${mx(c2)}, ${mx(c1)}, ${mx(s)}`;
    }
    return `${d} Z`;
}
const MANTA = mantaOutline();
const manta: DecorationArt = {
    back: ({ u, o, tint }) => {
        const black = o.p === 1;
        const rim = itemTint(o.h, tint, '#8EC5FF');
        return (
            <g transform="translate(16 -9) rotate(-27) scale(.84)">
                <g className="pc-glide">
                    <defs>
                        <Lin id={`${u}-md`} stops={black ? [[0, '#232C52'], [0.5, '#121935'], [1, '#070A18']] : [[0, '#33477E'], [0.45, '#1B2754'], [1, '#0B1230']]} />
                        <Rad id={`${u}-sh`} user cx={0} cy={-8} r={40} stops={[[0, 'hsl(220 60% 80% / .16)'], [1, 'hsl(220 60% 80% / 0)']]} />
                    </defs>
                    <path d="M0 33 C 1 46, -1 58, -5 70" fill="none" stroke="#141D42" strokeWidth="1.8" strokeLinecap="round" />
                    <path d={MANTA} fill="#000" fillOpacity=".32" transform="translate(2 4)" />
                    <path d={MANTA} fill={`url(#${u}-md)`} />
                    <path d={MANTA} fill={`url(#${u}-sh)`} />
                    {!black && (
                        <g fill="#E8EFFF" fillOpacity=".7">
                            <path d="M6 -15 C 15 -17, 27 -13, 36 -5 C 26 -7.6, 15 -6, 8 -2.4 C 9 -7, 8 -11, 6 -15 Z" />
                            <path d="M-6 -15 C -15 -17, -27 -13, -36 -5 C -26 -7.6, -15 -6, -8 -2.4 C -9 -7, -8 -11, -6 -15 Z" />
                        </g>
                    )}
                    <path d="M0 -20 C 1 -4, 1 14, 0 28" stroke="#fff" strokeOpacity=".1" strokeWidth="3" strokeLinecap="round" fill="none" />
                    <path d="M11.6 -24.6 C 28 -24.4, 52 -16.6, 71 4 M-11.6 -24.6 C -28 -24.4, -52 -16.6, -71 4" fill="none" stroke={shade(rim, 12, 0.9)} strokeWidth="1.3" strokeLinecap="round" />
                    <path d="M9.6 -33.2 C 11.2 -31.6, 11 -27.4, 11.6 -24.6 M-9.6 -33.2 C -11.2 -31.6, -11 -27.4, -11.6 -24.6" fill="none" stroke={shade(rim, 18, 0.7)} strokeWidth=".9" strokeLinecap="round" />
                    <path d="M-6.4 -25.8 C -3 -24, 3 -24, 6.4 -25.8" fill="none" stroke={black ? '#E8EFFF' : '#070A18'} strokeOpacity={black ? 0.75 : 0.7} strokeWidth="1" strokeLinecap="round" />
                </g>
            </g>
        );
    },
};

// ── Seasonal ─────────────────────────────────────────────────────────────────

/** A carved pumpkin on the lower LEFT edge, its candle flickering through the face. */
const jackOLantern: Draw = ({ u, o }) => {
    const g = k(o.i);
    const face = o.p ?? 0;
    const cx = 12, cy = 86;
    const faces: Record<number, string> = {
        0: `M${cx - 7} ${cy - 3} l3 -4 l3 4 Z M${cx + 1} ${cy - 3} l3 -4 l3 4 Z M${cx - 1} ${cy} l1 -2 l1 2 Z M${cx - 8} ${cy + 2.4} q8 7.4 16 0 l-2.4 1.2 l-1.4 -1.6 l-1.8 1.8 l-1.6 -1.8 l-1.6 1.8 l-1.8 -1.8 l-1.4 1.6 Z`,
        1: `M${cx - 7.4} ${cy - 5.6} l5.4 2.4 l-4.4 2.6 Z M${cx + 7.4} ${cy - 5.6} l-5.4 2.4 l4.4 2.6 Z M${cx - 8} ${cy + 3.6} l2 -2.6 l2 2 l2 -2.6 l2 2.6 l2 -2.6 l2 2 l2 -2.6 l2 2.6 l-1.6 2.6 l-2 -2 l-2 2.2 l-2 -2.2 l-2 2.2 l-2 -2.2 l-2 2 Z`,
        2: `M${cx - 6.4} ${cy - 3.6} a2.3 2.6 0 1 0 4.6 0 a2.3 2.6 0 1 0 -4.6 0 Z M${cx + 1.8} ${cy - 3.6} a2.3 2.6 0 1 0 4.6 0 a2.3 2.6 0 1 0 -4.6 0 Z M${cx - 6.6} ${cy + 1.4} q6.6 6.4 13.2 0 q-6.6 3.4 -13.2 0 Z`,
    };
    return (
        <>
            <defs>
                <Rad id={`${u}-pk`} user cx={cx - 3} cy={cy - 6} r={17} stops={[[0, '#FFB25E'], [0.5, '#F57A1F'], [1, '#A93B0C']]} />
                <Rad id={`${u}-fl`} user cx={cx} cy={cy} r={9} stops={[[0, '#FFF6C8'], [0.45, '#FFC94D'], [1, '#FF7A1A']]} />
                <Rad id={`${u}-gl`} stops={[[0, `hsl(32 100% 60% / ${(0.34 * g).toFixed(3)})`], [1, 'hsl(32 100% 60% / 0)']]} />
            </defs>
            <g transform={`translate(${cx} ${cy}) scale(1.38) translate(${-cx} ${-cy})`}>
            <ellipse data-glow="candle light" className="pc-flicker" cx={cx + 9} cy={cy - 7} rx="20" ry="17" fill={`url(#${u}-gl)`} />
            <ellipse cx={cx + 1} cy={cy + 10.5} rx="12.5" ry="2.4" fill="#000" fillOpacity=".35" />
            <g stroke="#7A2A06" strokeWidth=".6">
                <ellipse cx={cx - 6.2} cy={cy} rx="7.2" ry="10" fill={`url(#${u}-pk)`} />
                <ellipse cx={cx + 6.2} cy={cy} rx="7.2" ry="10" fill={`url(#${u}-pk)`} />
                <ellipse cx={cx} cy={cy - 0.4} rx="7.8" ry="10.4" fill={`url(#${u}-pk)`} />
            </g>
            <path d={`M${cx - 2.2} ${cy - 13} C ${cx - 3} ${cy - 13}, ${cx - 0.2} ${cy - 17.4}, ${cx + 2.4} ${cy - 17} L ${cx + 2.2} ${cy - 15} C ${cx + 1} ${cy - 14.6}, ${cx + 1} ${cy - 13}, ${cx + 1.4} ${cy - 10.4} Z`} fill="#4E6B2A" stroke="#2C3F14" strokeWidth=".5" />
            <path d={`M${cx + 2} ${cy - 15} q 5 -3 7 1 q -3 -1 -5 1.4`} fill="none" stroke="#6E8F3A" strokeWidth=".8" strokeLinecap="round" />
            <path d={faces[face] ?? faces[0]} fill="#3A1204" />
            <path className="pc-flicker" d={faces[face] ?? faces[0]} fill={`url(#${u}-fl)`} />
            <path d={`M${cx - 11} ${cy - 5} C ${cx - 10} ${cy - 9}, ${cx - 7} ${cy - 10}, ${cx - 5} ${cy - 10}`} fill="none" stroke="#fff" strokeOpacity=".3" strokeWidth=".9" strokeLinecap="round" />
            </g>
        </>
    );
};

/** A six-fold snowflake: arms with side branches (one path), drawn at (x, y). */
function flake(x: number, y: number, r: number, rot: number): string {
    let d = '';
    for (let i = 0; i < 6; i++) {
        const a = (rot + i * 60) * Math.PI / 180;
        const ex = x + Math.cos(a) * r, ey = y + Math.sin(a) * r;
        d += `M${f1(x)} ${f1(y)} L${f1(ex)} ${f1(ey)} `;
        for (const s of [0.45, 0.72]) {
            const px = x + Math.cos(a) * r * s, py = y + Math.sin(a) * r * s;
            const bl = r * (s < 0.5 ? 0.36 : 0.24);
            for (const side of [-1, 1]) {
                const b = a + side * Math.PI / 3;
                d += `M${f1(px)} ${f1(py)} L${f1(px + Math.cos(b) * bl)} ${f1(py + Math.sin(b) * bl)} `;
            }
        }
    }
    return d;
}

/** Frost along the top of the avatar: a rime edge, icicles over the rim, three snowflakes that glint. */
const frostCrown: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#BFE6FF');
    const n = 7 + (o.n ?? 2) * 4;
    const rand = rng(1225);
    let icicles = '';
    for (let i = 0; i < n; i++) {
        const deg = -74 + (148 * i) / (n - 1) + (rand() - 0.5) * 5;
        const L = 2.6 + rand() * (i % 3 === 1 ? 7 : 4);
        const w = 0.9 + rand() * 0.7;
        const [bx] = polar(52.6, deg);
        const [lx, ly] = polar(52.6, deg - w * 1.1);
        const [rx, ry] = polar(52.6, deg + w * 1.1);
        const [tx, ty] = polar(52.6 - L, deg + (rand() - 0.5) * 2);
        icicles += `M${f1(lx)} ${f1(ly)} Q ${f1((lx + tx) / 2 + (bx - tx) * 0.1)} ${f1((ly + ty) / 2)} ${f1(tx)} ${f1(ty)} Q ${f1((rx + tx) / 2)} ${f1((ry + ty) / 2)} ${f1(rx)} ${f1(ry)} Z `;
    }
    const flakes: Array<[number, number, number, number]> = [[-50, 62.5, 7.4, 8], [6, 63.5, 5.4, 20], [46, 61.5, 6.2, 0]];
    return (
        <>
            <defs>
                <Rad id={`${u}-ic`} user cx={50} cy={50} r={54} stops={[[0.82, shade(t, 0, 0.15)], [0.94, shade(t, 22, 0.85)], [1, '#fff']]} />
                <Rad id={`${u}-fg`} stops={[[0, shade(t, 30, 0.85)], [0.4, shade(t, 10, 0.3)], [1, shade(t, 0, 0)]]} />
            </defs>
            <path d={arcPath(53, -80, 80)} fill="none" stroke={shade(t, 10, 0.3)} strokeWidth="4.2" strokeLinecap="round" />
            <path d={arcPath(53, -80, 80)} fill="none" stroke={shade(t, 30, 0.95)} strokeWidth="1.1" strokeLinecap="round" strokeDasharray="5 0.8 2 1.2 7 0.6" />
            <path d={icicles} fill={`url(#${u}-ic)`} />
            {flakes.map(([deg, r, size, rot], i) => {
                const [x, y] = polar(r, deg);
                return (
                    <g key={i}>
                        <circle className="pc-twinkle" style={{ animationDelay: `${-i * 1.2}s` }} cx={f1(x)} cy={f1(y)} r={f1(size * 1.5)} fill={`url(#${u}-fg)`} />
                        <path d={flake(x, y, size, rot)} fill="none" stroke={shade(t, 4, 0.5)} strokeWidth="1.5" strokeLinecap="round" />
                        <path d={flake(x, y, size, rot)} fill="none" stroke={shade(t, 32)} strokeWidth=".6" strokeLinecap="round" />
                    </g>
                );
            })}
        </>
    );
};

// ── The table ────────────────────────────────────────────────────────────────

export const DECORATION_ART: Readonly<Record<string, DecorationArt>> = {
    'lume-ring': { front: lumeRing },
    'deep-dash': { front: deepDash },
    'keys-peek': keysPeek,
    'dive-bezel': { front: diveBezel },
    'kelp': kelp,
    'seagrass': seagrass,
    'sea-fan': seaFan,
    'aurora-ring': { front: auroraRing },
    'abyss-halo': { front: abyssHalo },
    'manta': manta,
    'pearl-string': { front: pearlString },
    'jack-o-lantern': { front: jackOLantern },
    'frost-crown': { front: frostCrown },
    ...HALO_ART,
};

/**
 * Legacy colour variants (`<base>-ember` / `<base>-violet`): the base art at a
 * fixed hue. The hue option on the base item replaces them in the picker.
 */
export const LEGACY_VARIANT_HUE: Readonly<Record<string, number>> = { ember: 22, violet: 272 };
export function resolveDecoration(id: string | null | undefined): { base: string; legacyHue: number | null } | null {
    if (!id) return null;
    if (Object.prototype.hasOwnProperty.call(DECORATION_ART, id)) return { base: id, legacyHue: null };
    const m = /^(lume-ring|deep-dash|keys-peek)-(ember|violet)$/.exec(id);
    return m ? { base: m[1], legacyHue: LEGACY_VARIANT_HUE[m[2]] } : null;
}
