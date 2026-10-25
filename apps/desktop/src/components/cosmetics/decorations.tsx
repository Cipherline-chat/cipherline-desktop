import React from 'react';
import type { ItemOptions } from '../../utils/profileCosmetics';
import {
    AURORA_RING_COLOURS, CROWN_COLOURS, PEARL_COLOURS, SEA_FAN_COLOURS, STARFISH_COLOURS,
} from '../../utils/profileCosmetics';
import { hexToHsl, itemTint, shade, type HSL } from './colour';
import { arcPath, bez, f1, gapHalf, gappedRing, inGap, polar, pt, ribbon, rng } from './geometry';
import { Jelly, KeysHead, KeysPaws, Lin, Rad } from './svgParts';

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


// ── Keys (the mascot): exactly two items show him ────────────────────────────

const KEYS_STOCK = '#25E0C8';
const keysPeek: DecorationArt = {
    back: ({ u, o, tint }) => <KeysHead u={u} t={itemTint(o.h, tint, KEYS_STOCK)} mood={o.p} />,
    front: ({ o, tint }) => <KeysPaws t={itemTint(o.h, tint, KEYS_STOCK)} />,
};

const keysCrown: DecorationArt = {
    back: ({ u, o }) => {
        const metal = hsl(pick(CROWN_COLOURS, o.c)[1]);
        return (
            <>
                <KeysHead u={u} t={hsl(KEYS_STOCK)} />
                <g transform="translate(0.5 -42) scale(0.9) rotate(-7 55 16)">
                    <defs>
                        <Lin id={`${u}-m`} stops={[[0, shade(metal, 16)], [0.45, shade(metal, 0)], [1, shade(metal, -30)]]} />
                    </defs>
                    <path d="M37 18 L39.5 0 L48 9 L55 -4 L62 9 L70.5 0 L73 18 Z" fill={`url(#${u}-m)`} stroke={shade(metal, -38)} strokeWidth="1" strokeLinejoin="round" />
                    <path d="M38 14.5 L72 14.5" stroke={shade(metal, -30)} strokeWidth="1.1" />
                    <path d="M41 4 L44 7.5 M55 0 L55 5 M69 4 L66 7.5" stroke="#fff" strokeOpacity=".45" strokeWidth="1" strokeLinecap="round" />
                    <circle cx="39.5" cy="0" r="2.3" fill="#FF6B5E" stroke="#8C1D16" strokeWidth=".5" />
                    <circle cx="55" cy="-4" r="2.6" fill="#7FD8FF" stroke="#1B5D7A" strokeWidth=".5" />
                    <circle cx="70.5" cy="0" r="2.3" fill="#FF6B5E" stroke="#8C1D16" strokeWidth=".5" />
                    <circle cx="54.2" cy="-4.8" r=".8" fill="#fff" />
                </g>
            </>
        );
    },
    front: () => <KeysPaws t={hsl(KEYS_STOCK)} />,
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

/** Starfish, lower LEFT (the dot is lower right), one arm reaching over the avatar's edge. */
const starfish: Draw = ({ u, o }) => {
    const col = hsl(pick(STARFISH_COLOURS, o.c)[1]);
    const cx = 13, cy = 87, rot = 12, rv = 6.2;
    const lens = [22, 20.5, 21.5, 20, 21];
    const bend = [5, -4, 6, -5, 3];
    let d = '';
    for (let i = 0; i < 5; i++) {
        const a = rot + i * 72 + bend[i];
        const v0 = polar(rv, rot + i * 72 - 36, cx, cy), v1 = polar(rv, rot + i * 72 + 36, cx, cy);
        const tl = polar(lens[i], a - 4.6, cx, cy), tr = polar(lens[i], a + 4.6, cx, cy);
        const c1 = polar(rv * 1.55, rot + i * 72 - 20, cx, cy), c2 = polar(lens[i] * 0.72, a - 8, cx, cy);
        const c3 = polar(lens[i] * 0.72, a + 8, cx, cy), c4 = polar(rv * 1.55, rot + i * 72 + 20, cx, cy);
        if (i === 0) d += `M${pt(v0)} `;
        d += `C ${pt(c1)}, ${pt(c2)}, ${pt(tl)} A 1.9 1.9 0 0 1 ${pt(tr)} C ${pt(c3)}, ${pt(c4)}, ${pt(v1)} `;
    }
    d += 'Z';
    const bumps: React.ReactNode[] = [];
    if ((o.p ?? 0) === 0) {
        for (let i = 0; i < 5; i++) {
            const a = rot + i * 72 + bend[i] * 0.6;
            for (let r = 5; r < lens[i] - 2.5; r += 2.6) {
                const [x, y] = polar(r, a, cx, cy);
                bumps.push(<circle key={`${i}-${r}`} cx={f1(x)} cy={f1(y)} r={f1(1.05 - r * 0.025)} fill={shade(col, 26, 0.9, -10)} />);
            }
        }
    }
    return (
        <>
            <defs>
                <Rad id={`${u}-s`} user cx={cx - 2} cy={cy - 3} r={20} stops={[[0, shade(col, 12)], [0.45, shade(col, 0)], [1, shade(col, -20)]]} />
            </defs>
            <path d={d} fill="#000" fillOpacity=".35" transform="translate(1.1 1.9)" />
            <path d={d} fill={`url(#${u}-s)`} stroke={shade(col, -26)} strokeWidth=".6" strokeLinejoin="round" />
            {(o.p ?? 0) === 1 && Array.from({ length: 5 }, (_, i) => {
                const a = rot + i * 72 + bend[i] * 0.6;
                return <path key={i} d={`M${pt(polar(4, a, cx, cy))} L${pt(polar(lens[i] - 3, a, cx, cy))}`} stroke={shade(col, 18, 0.5)} strokeWidth=".9" strokeLinecap="round" />;
            })}
            {bumps}
            <circle cx={cx} cy={cy} r="2.2" fill={shade(col, 18)} />
            <circle cx={cx + 2.6} cy={cy - 1.4} r=".9" fill={shade(col, -20)} />
        </>
    );
};

/** A gorgonian sea fan, grown by branching (seeded: the same fan every time), with cross-links like the real lattice. */
const seaFan: DecorationArt = {
    back: ({ o }) => {
        const col = hsl(pick(SEA_FAN_COLOURS, o.c)[1]);
        const depthMax = 4 + (o.n ?? 2);
        const rand = rng(1907);
        const byDepth: string[] = Array.from({ length: depthMax + 1 }, () => '');
        const tips: P[] = [];
        const levels: P[][] = Array.from({ length: depthMax + 1 }, () => []);
        const grow = (x: number, y: number, ang: number, len: number, depth: number) => {
            const a = ang * Math.PI / 180;
            const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
            const bend = (rand() - 0.5) * len * 0.35;
            const mx = (x + ex) / 2 - Math.sin(a) * bend, my = (y + ey) / 2 + Math.cos(a) * bend;
            byDepth[depth] += `M${f1(x)} ${f1(y)} Q ${f1(mx)} ${f1(my)} ${f1(ex)} ${f1(ey)} `;
            levels[depth].push([ex, ey]);
            if (depth >= depthMax) { tips.push([ex, ey]); return; }
            const spread = 17 + rand() * 13;
            const kids = depth < 2 ? 2 : rand() < 0.82 ? 2 : 1;
            for (let i = 0; i < kids; i++) {
                let na = ang + (kids === 1 ? (rand() - 0.5) * 16 : (i ? spread : -spread)) + (rand() - 0.5) * 8;
                na = Math.max(-178, Math.min(-44, na));
                grow(ex, ey, na, len * (0.8 + rand() * 0.1), depth + 1);
            }
        };
        grow(-8, 102, -116, 19, 0);
        // The lattice: link each node to its nearest same-level neighbour.
        let mesh = '';
        for (let d = 3; d <= depthMax; d++) {
            const lv = [...levels[d]].sort((p, q) => Math.atan2(p[1] - 102, p[0] + 8) - Math.atan2(q[1] - 102, q[0] + 8));
            for (let i = 1; i < lv.length; i++) {
                const [a, b] = [lv[i - 1], lv[i]];
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 9) mesh += `M${f1(a[0])} ${f1(a[1])} L${f1(b[0])} ${f1(b[1])} `;
            }
        }
        const polyps = tips.map(([x, y]) => `M${f1(x - 0.9)} ${f1(y)} a.9 .9 0 1 0 1.8 0 a.9 .9 0 1 0 -1.8 0`).join(' ');
        return (
            <g className="pc-sway pc-sway--fan">
                <path d={mesh} fill="none" stroke={shade(col, -8, 0.5)} strokeWidth=".45" strokeLinecap="round" />
                {byDepth.map((p, dd) => p && (
                    <path key={dd} d={p} fill="none" stroke={shade(col, -24 + dd * 5, 1, -30 + dd * 5)} strokeWidth={f1(Math.max(0.55, 3.1 - dd * 0.42))} strokeLinecap="round" />
                ))}
                <path d={polyps} fill={shade(col, 26)} />
            </g>
        );
    },
};

/** Bull kelp: a float behind the upper left, its blades streaming over the top of the avatar. */
const bullKelp: DecorationArt = {
    back: ({ u, o, tint }) => {
        const t = itemTint(o.h, tint, '#D9A94E');
        const float: P = [0, -8];
        // Blades stream to the right over the top; the longest ones reach past the avatar.
        const blades: Array<[P, P, P, number]> = [
            [[12, -30], [30, -46], [52, -50], 6.2],
            [[16, -24], [40, -32], [68, -40], 7.2],
            [[20, -16], [46, -20], [84, -30], 7.6],
            [[20, -8], [52, -10], [100, -16], 7],
            [[18, -2], [44, 0], [78, -4], 6.4],
            [[14, 2], [30, 6], [50, 2], 5.2],
        ];
        return (
            <g>
                <defs>
                    <Lin id={`${u}-b`} x2={1} y2={0} stops={[[0, shade(t, -20)], [0.35, shade(t, -4)], [0.8, shade(t, 8)], [1, shade(t, 16, 0.7)]]} />
                    <Lin id={`${u}-st`} x2={1} y2={0} stops={[[0, shade(t, -30)], [1, shade(t, -12)]]} />
                    <Rad id={`${u}-f`} cx={0.36} cy={0.3} r={0.75} stops={[[0, shade(t, 30)], [0.45, shade(t, 0)], [1, shade(t, -28)]]} />
                </defs>
                <path d={ribbon([-18, 120], [-30, 72], [-6, 34], [float[0] - 2, float[1] + 3], 4.4, 2.8)} fill={`url(#${u}-st)`} />
                {blades.map(([p1, p2, p3, w], i) => (
                    <g key={i} className="pc-stream" style={{ animationDelay: `${-i * 1.1}s` }}>
                        <path d={ribbon(float, p1, p2, p3, w, 1.2, 22)} fill={`url(#${u}-b)`} />
                        <path d={`M${pt(bez(float, p1, p2, p3, 0.12))} C ${pt(bez(float, p1, p2, p3, 0.4))}, ${pt(bez(float, p1, p2, p3, 0.7))}, ${pt(bez(float, p1, p2, p3, 0.95))}`} fill="none" stroke={shade(t, 22, 0.35)} strokeWidth=".5" strokeLinecap="round" />
                    </g>
                ))}
                <ellipse cx={float[0]} cy={float[1]} rx="6.4" ry="5.6" fill={`url(#${u}-f)`} />
                <ellipse cx={float[0] - 2} cy={float[1] - 2.2} rx="2" ry="1.2" fill="#fff" fillOpacity=".55" />
            </g>
        );
    },
};

// ── Creatures ────────────────────────────────────────────────────────────────

/** An anglerfish behind the upper left; its lure hangs over the avatar and lights it. */
const anglerfish: DecorationArt = {
    back: ({ u, o, tint }) => {
        const L = itemTint(o.h, tint, '#FFC94D');
        return (
            <>
                <defs>
                    <Lin id={`${u}-ab`} stops={[[0, '#2B3A6E'], [0.5, '#18234A'], [1, '#0C1330']]} />
                </defs>
                <path d="M-2 -26 C 12 -50, 50 -46, 60 -16" fill="none" stroke="#3A4A7E" strokeWidth="1.4" strokeLinecap="round" />
                <g transform="translate(-12 -4) scale(1.3) rotate(-22 4 0)">
                    <path d="M-27 -2 L-36 -10 L-34 4 L-36 12 Z" fill="#141E40" stroke="#33437A" strokeWidth=".8" strokeLinejoin="round" />
                    <path d="M-26 0 C -26 -16, -10 -22, 6 -20 C 18 -18.5, 27 -12, 28 -4 L 16 -2 L 27 3 C 22 10, 6 15, -8 12 C -18 10, -26 7, -26 0 Z" fill={`url(#${u}-ab)`} stroke="#3A4C86" strokeWidth="1" strokeLinejoin="round" />
                    <path d="M-20 -10 C -12 -17, 0 -19, 12 -17" fill="none" stroke={shade(L, 10, 0.35)} strokeWidth=".9" strokeLinecap="round" />
                    <path d="M-6 6 C -2 10, 4 10, 8 8" fill="none" stroke="#0A1024" strokeWidth="1" strokeLinecap="round" />
                    <path d="M16 -2 L 18 -6 L 20 -2.6 L 22.2 -6.4 L 24 -3 L 26.4 -5.8" fill="none" stroke="#E8EEFC" strokeWidth=".9" strokeLinejoin="round" strokeLinecap="round" />
                    <path d="M17 1 L 19 4.2 L 21 1.6 L 23 4.6 L 25 2.2" fill="none" stroke="#E8EEFC" strokeWidth=".9" strokeLinejoin="round" strokeLinecap="round" />
                    <circle cx="9" cy="-10" r="3.4" fill="#070B1A" stroke="#4A5C95" strokeWidth=".8" />
                    <circle cx="10" cy="-11" r="1.1" fill={shade(L, 10)} />
                    <path d="M-14 -16 l 3 -6 l 2 5 l 3 -6 l 2 6" fill="none" stroke="#33437A" strokeWidth="1" strokeLinejoin="round" />
                </g>
            </>
        );
    },
    front: ({ u, o, tint }) => {
        const L = itemTint(o.h, tint, '#FFC94D');
        return (
            <>
                <defs>
                    <Rad id={`${u}-lg`} stops={[[0, shade(L, 20, 0.85)], [0.25, shade(L, 0, 0.45)], [1, shade(L, 0, 0)]]} />
                    <Rad id={`${u}-ls`} stops={[[0, shade(L, 0, 0.32)], [1, shade(L, 0, 0)]]} />
                </defs>
                <ellipse data-glow="lure light" className={o.p === 1 ? 'pc-flicker' : 'pc-breathe'} cx="58" cy="4" rx="22" ry="11" fill={`url(#${u}-ls)`} />
                <circle data-glow="lure" className={o.p === 1 ? 'pc-flicker' : 'pc-breathe'} cx="60" cy="-12.5" r="11" fill={`url(#${u}-lg)`} />
                <circle cx="60" cy="-12.5" r="3.4" fill={shade(L, 12)} />
                <circle cx="59" cy="-13.6" r="1.1" fill="#FFF8E6" />
            </>
        );
    },
};

const jellyfish: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#B7A4FF');
    return (
        <>
            <defs>
                <Rad id={`${u}-jb`} cx={0.5} cy={0.35} r={0.65} stops={[[0, shade(t, 24, 0.55)], [0.7, shade(t, 4, 0.28)], [1, shade(t, 0, 0.12)]]} />
            </defs>
            {o.p === 1 && <Jelly u={u} t={t} x={8} y={-18} s={1.0} delay={-2.1} />}
            <Jelly u={u} t={t} x={95} y={-1} s={1.45} delay={0} />
        </>
    );
};

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

/**
 * Vampire squid (Vampyroteuthis infernalis, "vampire squid from hell"): behind
 * the upper right, mantle up, its webbed cloak open towards the avatar, eyes
 * and arm-tip photophores glowing. Rim light keeps the dark red readable.
 */
const vampireSquid: DecorationArt = {
    back: ({ u, o, tint }) => {
        const glow = itemTint(o.h, tint, '#6FB7FF');
        const angles = [28, 44, 60, 76, 92, 108, 124, 140, 154];
        const tips: P[] = angles.map((a, i) => {
            const r = 25 + (i % 2 ? 1.6 : 0) - Math.abs(i - 4) * 0.5;
            return [Math.cos(a * Math.PI / 180) * r, Math.sin(a * Math.PI / 180) * r];
        });
        let web = `M${pt(tips[0])} `;
        for (let i = 1; i < tips.length; i++) {
            const [ax, ay] = tips[i - 1], [bx, by] = tips[i];
            web += `Q ${f1((ax + bx) * 0.38)} ${f1((ay + by) * 0.38)} ${pt(tips[i])} `;
        }
        web += 'L 0 0 Z';
        return (
            <g transform="translate(99 -14) rotate(40) scale(1.3)">
                <defs>
                    <Lin id={`${u}-vm`} stops={[[0, '#A3304A'], [0.55, '#5C1022'], [1, '#2A0610']]} />
                    <Rad id={`${u}-vw`} user cx={0} cy={0} r={27} stops={[[0, '#7A1A30'], [0.65, '#4A0B1A'], [1, '#26040D']]} />
                    <Rad id={`${u}-ph`} stops={[[0, shade(glow, 34)], [0.3, shade(glow, 8, 0.75)], [1, shade(glow, 0, 0)]]} />
                </defs>
                <path d="M-8 3 C -10.5 -10, -6 -25, 0 -28 C 6 -25, 10.5 -10, 8 3 Z" fill={`url(#${u}-vm)`} stroke="#160309" strokeWidth=".6" />
                <path d="M-6.4 -17 C -15 -22, -16.4 -11, -7.6 -10 Z M6.4 -17 C 15 -22, 16.4 -11, 7.6 -10 Z" fill="#6E1428" stroke="#160309" strokeWidth=".5" />
                <path d="M-3.4 -21 C -2 -24.6, 2 -25, 3.6 -22" fill="none" stroke="#fff" strokeOpacity=".3" strokeWidth="1" strokeLinecap="round" />
                <g className="pc-cloak">
                    <path d={web} fill={`url(#${u}-vw)`} stroke="#160309" strokeWidth=".5" strokeLinejoin="round" />
                    <path d={web.replace(/L 0 0 Z$/, '')} fill="none" stroke={shade(glow, 10, 0.45)} strokeWidth=".8" />
                    {tips.map((p, i) => (
                        <path key={i} d={`M0 2 Q ${f1(p[0] * 0.5 + (i % 2 ? 1 : -1))} ${f1(p[1] * 0.5)} ${pt(p)}`} fill="none" stroke="#8E2440" strokeWidth="1" strokeLinecap="round" />
                    ))}
                    {tips.map((p, i) => (
                        <circle key={`p${i}`} className="pc-photophore" style={{ animationDelay: `${-i * 0.41}s` }} cx={f1(p[0])} cy={f1(p[1])} r="3.4" fill={`url(#${u}-ph)`} />
                    ))}
                </g>
                <ellipse cx="0" cy="1" rx="9" ry="6.4" fill="#5C1022" stroke="#160309" strokeWidth=".5" />
                {[-4.2, 4.2].map((x) => (
                    <g key={x}>
                        <circle cx={x} cy="0.6" r="3.2" fill="#08020A" />
                        <circle cx={x} cy="0.6" r="1.9" fill={shade(glow, 8)} />
                        <circle cx={x - 0.6} cy="-0.1" r=".6" fill="#fff" />
                    </g>
                ))}
            </g>
        );
    },
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
    'starfish': { front: starfish },
    'sea-fan': seaFan,
    'bull-kelp': bullKelp,
    'anglerfish': anglerfish,
    'aurora-ring': { front: auroraRing },
    'jellyfish': { front: jellyfish },
    'abyss-halo': { front: abyssHalo },
    'manta': manta,
    'keys-crown': keysCrown,
    'pearl-string': { front: pearlString },
    'jack-o-lantern': { front: jackOLantern },
    'vampire-squid': vampireSquid,
    'frost-crown': { front: frostCrown },
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
