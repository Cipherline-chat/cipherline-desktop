import React from 'react';
import { CIRCLET_COLOURS, NEON_COLOURS, NEON_OUTER } from '../../utils/profileCosmetics';
import { hexToHsl, itemTint, shade, type HSL } from './colour';
import { arcPath, f1, gapHalf, gappedRing, inGap, polar, pt, rng } from './geometry';
import { Bat, Lin, OrbitHalf, Rad, type OrbitFrame } from './svgParts';
import type { DecorationArt, Draw } from './decorations';

/**
 * The halo set (owner, 2026-10-26: "I like the halo ones, maybe add more that
 * aren't as much with the sea theme"): rings, orbits and coronas of light,
 * plus the two rewards that replaced retired items (the circlet for the
 * keys-finale-crown egg, the bat halo for Halloween 2026).
 *
 * Same rules as decorations.tsx: one tint per item drives the whole palette;
 * motion is transform / opacity / stroke-dashoffset only; nothing ever enters
 * the status-dot zone (geometry.ts SAFE_ZONE) - rings open around it and
 * orbits are sized so a body riding them never reaches it at ANY point of the
 * loop (decorationSafeZone.test.ts samples every orbit all the way round).
 *
 * ORBITS. A body on a tilted ellipse is drawn in a frame squashed by ry/rx,
 * where the ellipse is a circle: the body rides a CSS rotation of that circle
 * and a reverse rotation (same keyframes, same duration) keeps it upright, and
 * a counter-scale keeps it round. Its phase is a static rotate, so with
 * reduced motion the bodies still sit spread out around the orbit. The far
 * half of an orbit is drawn in the BACK layer (behind the avatar), the near
 * half in the FRONT layer, each clipped to its half, so bodies pass behind
 * you and then in front of you.
 */

const K: Readonly<Record<number, number>> = { 1: 0.6, 2: 1, 3: 1.45 };
const k = (v: number | undefined) => K[v ?? 2] ?? 1;
const pick = <T,>(list: readonly T[], i: number | undefined): T => list[Math.max(0, Math.min(list.length - 1, i ?? 0))];
const hsl = (hex: string): HSL => hexToHsl(hex)!;

// ── orbit machinery ──────────────────────────────────────────────────────────

/**
 * Bodies riding an orbit (inside an OrbitHalf). `phase` is where each body
 * starts (degrees, clockwise from the +x end); `body` is drawn upright and
 * round at the body's position.
 */
function riders(f: OrbitFrame, phases: readonly number[], body: (i: number) => React.ReactNode): React.ReactNode {
    const q = f.ry / f.rx;
    return (
        <g transform={`scale(1 ${f1(q)})`}>
            {phases.map((ph, i) => (
                <g key={i} transform={`rotate(${f1(ph)})`}>
                    <g className="pc-orbit" data-orbit="spin">
                        <g transform={`translate(${f1(f.rx)} 0)`}>
                            <g className="pc-orbit pc-orbit--counter" data-orbit="counter">
                                <g transform={`rotate(${f1(-ph)}) scale(1 ${f1(1 / q)})`}>{body(i)}</g>
                            </g>
                        </g>
                    </g>
                </g>
            ))}
        </g>
    );
}

// ── Orrery ───────────────────────────────────────────────────────────────────

/**
 * Moons on a tilted orbit, a stream of dust flowing along it, passing behind you and in front.
 *
 * Compact (picker thumbnails, 26-44px): at 36px one unit here is a third of a pixel, so the hairline orbit and the
 * dust vanish and the moons shrink to specks - the tile read as a faint line through the avatar. The compact orrery
 * is the same picture drawn bolder: one solid orbit line ~3x thicker and brighter (the dust and the faint outer
 * ring, all sub-pixel there, are dropped), and moons ~1.8x larger with a stronger glow and a crisp lit edge.
 */
const ORRERY: OrbitFrame = { cx: 50, cy: 50, tilt: -22, rx: 66, ry: 17 };
const MOONS: ReadonlyArray<{ ph: number; r: number }> = [{ ph: 205, r: 4.4 }, { ph: 52, r: 2.9 }, { ph: 318, r: 1.9 }];
const MOON_SCALE_COMPACT = 1.8;
function orreryLayer(half: 'far' | 'near'): Draw {
    return ({ u, o, tint, compact }) => {
        const t = itemTint(o.h, tint, '#9FB8FF');
        const n = (o.p ?? 1) + 1;
        const f = ORRERY;
        const dim = half === 'far' ? (compact ? 0.7 : 0.55) : 1;
        // Dust: an uneven dot pattern that divides the normalised path length exactly, so it never shows a seam.
        const dust = [0.01, 1.99, 0.01, 3.49, 0.01, 2.49].map(f1).join(' ');
        return (
            <OrbitHalf id={`${u}-${half}`} f={f} half={half}>
                <defs>
                    <Rad id={`${u}-m`} cx={0.34} cy={0.3} r={0.8} stops={[[0, shade(t, 34, 1, -30)], [0.45, shade(t, 8)], [0.85, shade(t, -26)], [1, shade(t, -40)]]} />
                    <Rad id={`${u}-mg`} stops={[[0, shade(t, 20, (compact ? 0.8 : 0.5) * dim)], [1, shade(t, 0, 0)]]} />
                </defs>
                {compact ? (
                    <ellipse rx={f.rx} ry={f.ry} fill="none" stroke={shade(t, 16, 0.85 * dim, -10)} strokeWidth="2.2" />
                ) : (
                    <>
                        <ellipse rx={f.rx} ry={f.ry} fill="none" stroke={shade(t, 6, 0.42 * dim)} strokeWidth=".7" />
                        <ellipse rx={f.rx + 2.4} ry={f.ry + 0.62} fill="none" stroke={shade(t, 0, 0.16 * dim)} strokeWidth=".45" />
                        <ellipse
                            className="pc-dashflow" rx={f.rx} ry={f.ry} fill="none" stroke={shade(t, 24, 0.85 * dim, -20)} strokeWidth="1.05" strokeLinecap="round"
                            pathLength={100} strokeDasharray={dust} style={{ ['--pc-dash' as string]: '10' }}
                        />
                    </>
                )}
                {riders(f, MOONS.slice(0, n).map((m) => m.ph), (i) => {
                    const r = MOONS[i].r * (compact ? MOON_SCALE_COMPACT : 1);
                    return (
                        <>
                            <circle data-glow="moonlight" r={f1(r * (compact ? 2.2 : 2.6))} fill={`url(#${u}-mg)`} />
                            <circle r={r} fill={`url(#${u}-m)`} />
                            <path d={`M${f1(-r * 0.15)} ${f1(-r)} A ${f1(r)} ${f1(r)} 0 0 1 ${f1(r * 0.98)} ${f1(r * 0.2)}`} fill="none" stroke="#fff" strokeOpacity={half === 'far' ? (compact ? 0.45 : 0.25) : (compact ? 0.85 : 0.55)} strokeWidth={compact ? 1.1 : 0.45} strokeLinecap="round" />
                        </>
                    );
                })}
            </OrbitHalf>
        );
    };
}
const orrery: DecorationArt = { back: orreryLayer('far'), front: orreryLayer('near') };

// ── Eclipse ──────────────────────────────────────────────────────────────────

/**
 * You are the moon. Behind the avatar: the inner corona's soft glow, ~120
 * seeded streamers (longer in three helmet streamers, like the real corona's
 * shape near solar minimum), a hot chromosphere line at the limb. The
 * streamers shimmer in three interleaved groups; nothing rotates, so the gap
 * around the status dot never moves. "Diamond ring": the last bead of sunlight
 * flaring at the upper-left limb.
 *
 * Compact (picker thumbnails): the streamers are 0.3-0.5 units wide (a sixth of a pixel at 36px) and fade out within
 * ~3px of the limb, so the tile showed a plain white ring - nothing said "corona". The compact eclipse draws ~40
 * streamers instead of ~96, each about four times as wide, with the fade pushed further out and the three helmet
 * streamers longer, so the uneven spiky silhouette of the real corona survives; the inner glow and the limb are
 * brighter to match.
 */
const eclipseBack: Draw = ({ u, o, tint, compact }) => {
    const t = itemTint(o.h, tint, '#FFE3A6');
    const g = k(o.i);
    const rand = rng(1999 + 8 * 11);
    const helmets = [[28, 15], [196, 13], [292, 10]] as const;
    const groups = ['', '', ''];
    const count = compact ? 40 : 96;
    const pad = compact ? 2.4 : 1.6;
    for (let i = 0; i < count; i++) {
        const deg = (i / count) * 360 + (rand() - 0.5) * (compact ? 5 : 3.2);
        let L = 3 + rand() * rand() * 9;
        for (const [hd, hl] of helmets) {
            const d = Math.abs((((deg - hd) % 360) + 540) % 360 - 180);
            L += hl * (compact ? 1.25 : 1) * Math.exp(-(d * d) / (2 * 11 * 11)) * (0.75 + rand() * 0.25);
        }
        const r1 = 50.5 + L;
        const bend = (rand() - 0.5) * 3.5;
        // The dot's zone is angularly widest at the limb: check the root, the tip and the bent tip.
        if (inGap(deg, 50.5, pad) || inGap(deg, r1, pad) || inGap(deg + bend, r1, pad)) continue;
        const [x0, y0] = polar(50.5, deg);
        const [xm, ym] = polar(50.5 + L * 0.55, deg + bend * 0.5);
        const [x1, y1] = polar(r1, deg + bend);
        groups[i % 3] += `M${f1(x0)} ${f1(y0)} Q ${f1(xm)} ${f1(ym)} ${f1(x1)} ${f1(y1)} `;
    }
    const limb = gappedRing(51.2, compact ? 2 : 1.2, 1.2);
    const glow: Array<[number, string]> = compact
        ? [[0.66, shade(t, 14, 0.8 * g)], [0.74, shade(t, 6, 0.38 * g)], [0.86, shade(t, 0, 0.1 * g)], [1, shade(t, 0, 0)]]
        : [[0.66, shade(t, 10, 0.55 * g)], [0.72, shade(t, 4, 0.24 * g)], [0.82, shade(t, 0, 0.07 * g)], [1, shade(t, 0, 0)]];
    // Streamers fade with distance from the limb, like the real corona's brightness falling off.
    const fade: Array<[number, string]> = compact
        ? [[0.68, shade(t, 30, 1, -20)], [0.82, shade(t, 18, 0.8)], [0.94, shade(t, 8, 0.32)], [1, shade(t, 0, 0.05)]]
        : [[0.68, shade(t, 30, 0.95, -20)], [0.78, shade(t, 16, 0.5)], [0.9, shade(t, 6, 0.12)], [1, shade(t, 0, 0)]];
    return (
        <>
            <defs>
                <Rad id={`${u}-c`} user cx={50} cy={50} r={74} stops={glow} />
                <Rad id={`${u}-st`} user cx={50} cy={50} r={74} stops={fade} />
            </defs>
            <circle data-glow="inner corona" className="pc-breathe" cx="50" cy="50" r="74" fill={`url(#${u}-c)`} />
            {groups.map((d, i) => (
                <path key={i} className="pc-corona" style={{ animationDelay: `${-i * 1.9}s`, animationDuration: `${5.4 + i * 0.9}s` }}
                    d={d} fill="none" stroke={`url(#${u}-st)`}
                    strokeOpacity={f1(Math.min(1, (compact ? 0.8 + i * 0.1 : 0.45 + i * 0.12) * g))}
                    strokeWidth={f1(compact ? 1.5 + i * 0.35 : 0.32 + i * 0.1)} strokeLinecap="round" />
            ))}
            <path d={limb.d} fill="none" stroke={shade(t, 10, (compact ? 0.6 : 0.4) * g)} strokeWidth={compact ? 4 : 3.2} strokeLinecap="round" />
            <path d={limb.d} fill="none" stroke={shade(t, 34, 0.95, -30)} strokeWidth={compact ? 1.8 : 0.9} strokeLinecap="round" />
        </>
    );
};
const eclipseFront: Draw = ({ u, o, tint }) => {
    if ((o.p ?? 0) !== 1) return null;
    const t = itemTint(o.h, tint, '#FFE3A6');
    const [x, y] = polar(51.4, 312);
    return (
        <>
            <defs>
                <Rad id={`${u}-b`} stops={[[0, 'hsl(48 100% 98% / 1)'], [0.18, shade(t, 30, 0.9, -20)], [0.5, shade(t, 10, 0.25)], [1, shade(t, 0, 0)]]} />
            </defs>
            <circle data-glow="diamond" className="pc-breathe" cx={f1(x)} cy={f1(y)} r="11" fill={`url(#${u}-b)`} />
            <g className="pc-twinkle" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
                <path d={`M${f1(x - 12)} ${f1(y)} L${f1(x + 12)} ${f1(y)} M${f1(x)} ${f1(y - 9)} L${f1(x)} ${f1(y + 9)}`} stroke="#FFFBEF" strokeOpacity=".85" strokeWidth=".55" strokeLinecap="round" />
            </g>
            <circle cx={f1(x)} cy={f1(y)} r="1.5" fill="#FFFDF6" />
            {[[300, 0.7], [323, 0.55], [292, 0.45]].map(([deg, r]) => {
                const [bx, by] = polar(51.2, deg);
                return <circle key={deg} cx={f1(bx)} cy={f1(by)} r={r} fill="#FFF6DC" fillOpacity=".9" />;
            })}
        </>
    );
};
const eclipse: DecorationArt = { back: eclipseBack, front: eclipseFront };

// ── Crystal ring ─────────────────────────────────────────────────────────────

/**
 * A band of cut crystal: a zigzag of triangular star facets (alternately
 * pointing in and out, like a brilliant's girdle), each lit from the upper
 * left with a little seeded jitter so neighbours never match, bright edges
 * where the cuts meet, and a run of light travelling through the facets (one
 * after the next, a seamless loop). "Prism" splits the light into a spectral
 * fringe along the outer edge.
 */
const crystalRing: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#C9D8FF');
    const g = k(o.i);
    const prism = o.p === 1;
    const r0 = 53.6, r1 = 60, n = 40;
    const step = 360 / n;
    const gh = gapHalf((r0 + r1) / 2, (r1 - r0) / 2 + 0.8);
    const end = 495 - gh - 0.5;
    const rand = rng(4111);
    const facets: React.ReactNode[] = [];
    const sweeps: React.ReactNode[] = [];
    const fringe: React.ReactNode[] = [];
    const edges: string[] = [];
    const P = (r: number, d: number) => pt(polar(r, d));
    const first = 135 + gh + 0.5;
    const count = Math.floor((end - first) / step);
    const last = first + count * step;
    for (let i = 0; i < count; i++) {
        const a0 = first + i * step, a1 = a0 + step, am = a0 + step / 2;
        // Mostly the light direction, partly chance: a cut stone throws light unevenly.
        const lit = Math.min(1, (0.5 + 0.5 * Math.cos(((am - 315) * Math.PI) / 180)) * 0.6 + Math.pow(rand(), 1.6) * 0.6);
        const lit2 = Math.min(1, lit * 0.45 + rand() * 0.4);
        // Out-pointing facet: base on the outer edge, apex on the inner one.
        const out = `M${P(r1, a0)} L${P(r1, a1)} L${P(r0, am)} Z`;
        // In-pointing facet between this one and the next.
        const inn = i < count - 1 ? `M${P(r0, am)} L${P(r1, a1)} L${P(r0, am + step)} Z` : null;
        facets.push(
            <g key={i}>
                <path d={out} fill={shade(t, -16 + 46 * lit, 0.32 + 0.6 * lit, -22 - 14 * lit)} />
                {inn && <path d={inn} fill={shade(t, -18 + 38 * lit2, 0.24 + 0.4 * lit2, -30)} />}
            </g>,
        );
        edges.push(`M${P(r0, am)} L${P(r1, a0)} M${P(r0, am)} L${P(r1, a1)}`);
        sweeps.push(<path key={i} className="pc-facet" style={{ animationDelay: `${f1(-(i / count) * 7.2)}s` }} d={out} fill={shade(t, 40, 0.95, -50)} />);
        if (prism) {
            const hue = ((i * 360) / count * 1.4 + 200) % 360;
            fringe.push(<path key={i} d={arcPath(r1 + 0.9, a0 + 0.4, a1 - 0.4)} fill="none" stroke={`hsl(${f1(hue)} 95% 70% / ${f1(0.6 * Math.min(1.2, g))})`} strokeWidth=".8" />);
        }
    }
    const glints = [[312, r1 - 0.3, 6.5], [30, r1 - 0.4, 4.4], [238, r1 - 0.4, 3.6]] as const;
    return (
        <>
            <defs>
                <Rad id={`${u}-g`} stops={[[0, 'hsl(0 0% 100% / .95)'], [0.25, shade(t, 30, 0.45)], [1, shade(t, 0, 0)]]} />
            </defs>
            {facets}
            <path d={edges.join(' ')} fill="none" stroke={shade(t, 40, 0.42, -50)} strokeWidth=".22" />
            <g opacity={f1(Math.min(1, 0.6 * g))}>{sweeps}</g>
            <path d={arcPath(r1, first, last)} fill="none" stroke={shade(t, 40, 0.85, -50)} strokeWidth=".4" />
            <path d={arcPath(r0, first + step / 2, last - step / 2)} fill="none" stroke={shade(t, 30, 0.4, -40)} strokeWidth=".3" />
            {fringe}
            {glints.map(([deg, r, sz], i) => {
                const [x, y] = polar(r, deg);
                return (
                    <g key={i} className="pc-twinkle" style={{ animationDelay: `${-i * 1.3}s`, transformBox: 'fill-box', transformOrigin: 'center' }}>
                        <circle data-glow="glint" cx={f1(x)} cy={f1(y)} r={f1(sz * 0.55)} fill={`url(#${u}-g)`} />
                        <path d={`M${f1(x - sz)} ${f1(y)} L${f1(x + sz)} ${f1(y)} M${f1(x)} ${f1(y - sz * 0.8)} L${f1(x)} ${f1(y + sz * 0.8)}`} stroke="#fff" strokeOpacity=".9" strokeWidth=".45" strokeLinecap="round" />
                    </g>
                );
            })}
        </>
    );
};

// ── Star chart ───────────────────────────────────────────────────────────────

/**
 * Stars scattered in a band around you (seeded: the same sky every time),
 * magnitudes from a power law so a few are bright, a faint ecliptic, and three
 * constellations whose lines draw themselves in, hold, and fade back out.
 */
const starChart: Draw = ({ u, o, tint }) => {
    const t = itemTint(o.h, tint, '#CFE0FF');
    const count = [0, 16, 24, 34][o.n ?? 2] ?? 24;
    const rand = rng(1987);
    const stars: Array<{ x: number; y: number; deg: number; m: number }> = [];
    for (let tries = 0; stars.length < count && tries < 600; tries++) {
        const deg = rand() * 360, r = 53.5 + rand() * 12.5;
        if (inGap(deg, r, 3.2)) continue;
        if (r > 62 && (deg < 0 || deg > 360)) continue;
        const [x, y] = polar(r, deg);
        if (stars.some((s) => Math.hypot(s.x - x, s.y - y) < 4.2)) continue;
        stars.push({ x, y, deg, m: Math.pow(rand(), 2.6) });
    }
    // Constellations: chains of near neighbours, walked in angle order.
    const byAngle = [...stars].sort((a, b) => a.deg - b.deg);
    const chains: string[] = [];
    let cur: typeof stars = [];
    for (const s of byAngle) {
        const prev = cur[cur.length - 1];
        if (prev && (s.deg - prev.deg > 24 || Math.hypot(s.x - prev.x, s.y - prev.y) > 14 || cur.length >= 5)) {
            if (cur.length >= 3) chains.push(cur.map((p, i) => `${i ? 'L' : 'M'}${f1(p.x)} ${f1(p.y)}`).join(' '));
            cur = [];
        }
        cur.push(s);
    }
    if (cur.length >= 3) chains.push(cur.map((p, i) => `${i ? 'L' : 'M'}${f1(p.x)} ${f1(p.y)}`).join(' '));
    const linked = (o.p ?? 0) === 0;
    const ecl = gappedRing(59.5, 0.6, 0.3);
    return (
        <>
            <defs>
                <Rad id={`${u}-s`} stops={[[0, 'hsl(0 0% 100% / 1)'], [0.3, shade(t, 22, 0.55, -20)], [1, shade(t, 0, 0)]]} />
            </defs>
            <path d={ecl.d} fill="none" stroke={shade(t, 6, 0.3)} strokeWidth=".35" strokeDasharray="0.5 1.8" />
            {linked && chains.slice(0, 4).map((d, i) => (
                <path key={i} className="pc-trace" style={{ animationDelay: `${-i * 3.1}s` }} d={d} pathLength={100}
                    fill="none" stroke={shade(t, 18, 0.55, -10)} strokeWidth=".42" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {stars.map((s, i) => {
                const size = 0.45 + s.m * 1.5;
                const bright = s.m > 0.42;
                return (
                    <g key={i} className={i % 2 ? 'pc-twinkle' : undefined} style={i % 2 ? { animationDelay: `${f1(-(i % 7) * 0.7)}s`, animationDuration: `${f1(2.6 + (i % 5) * 0.5)}s`, transformBox: 'fill-box', transformOrigin: 'center' } : undefined}>
                        {bright && <circle data-glow="star" cx={f1(s.x)} cy={f1(s.y)} r={f1(size * 3)} fill={`url(#${u}-s)`} />}
                        {bright && <path d={`M${f1(s.x - size * 3.2)} ${f1(s.y)} L${f1(s.x + size * 3.2)} ${f1(s.y)} M${f1(s.x)} ${f1(s.y - size * 3.2)} L${f1(s.x)} ${f1(s.y + size * 3.2)}`} stroke={shade(t, 30, 0.7, -30)} strokeWidth=".3" strokeLinecap="round" />}
                        <circle cx={f1(s.x)} cy={f1(s.y)} r={f1(size * 0.55)} fill={shade(t, 32, 1, -45)} />
                    </g>
                );
            })}
        </>
    );
};

// ── Neon ─────────────────────────────────────────────────────────────────────

/**
 * Two tubes of neon bent around you: an inner ring and an outer tube in two
 * hand-bent runs, each with a bloom, a saturated tube and a white-hot core,
 * dark electrode caps at the ends and clips holding them. "Flicker": one run
 * stutters like a tired transformer.
 */
const neonRing: Draw = ({ u, o }) => {
    const ci = Math.max(0, Math.min(NEON_COLOURS.length - 1, o.c ?? 0));
    const A = hsl(NEON_COLOURS[ci][1]), B = hsl(NEON_OUTER[ci]);
    const inner = gappedRing(54.2, 2.4, 2);
    const g2 = gapHalf(60, 2.4, 2);
    const runs: Array<[number, number]> = [[135 + g2, 252], [262, 495 - g2]];
    const tube = (d: string, c: HSL, key: string, cls?: string) => (
        <g key={key} className={cls}>
            <path data-glow="bloom" className="pc-breathe" d={d} fill="none" stroke={shade(c, 0, 0.26)} strokeWidth="6.5" strokeLinecap="round" />
            <path d={d} fill="none" stroke={shade(c, 2)} strokeWidth="2.1" strokeLinecap="round" />
            <path d={d} fill="none" stroke={shade(c, 36, 0.95, -40)} strokeWidth=".7" strokeLinecap="round" />
        </g>
    );
    const cap = (r: number, deg: number, key: string) => {
        const [x, y] = polar(r, deg);
        return <rect key={key} x={f1(x - 1.6)} y={f1(y - 1.6)} width="3.2" height="3.2" rx=".9" fill="#14182A" stroke="#3A4266" strokeWidth=".4" transform={`rotate(${f1(deg)} ${f1(x)} ${f1(y)})`} />;
    };
    const clips = [200, 300, 20, 80].map((deg) => {
        const [x1, y1] = polar(52.4, deg), [x2, y2] = polar(61.8, deg);
        return <path key={deg} d={`M${f1(x1)} ${f1(y1)} L${f1(x2)} ${f1(y2)}`} stroke="#0F1322" strokeOpacity=".85" strokeWidth="1.1" strokeLinecap="round" />;
    });
    return (
        <>
            <defs>
                <Lin id={`${u}-n`} stops={[[0, shade(A, 10)], [1, shade(A, -6)]]} />
            </defs>
            {tube(inner.d, A, 'in')}
            {tube(arcPath(60, runs[0][0], runs[0][1]), B, 'o0')}
            {tube(arcPath(60, runs[1][0], runs[1][1]), B, 'o1', o.p === 1 ? 'pc-neon-flicker' : undefined)}
            {clips}
            {cap(54.2, inner.a0 - 1.2, 'c0')}{cap(54.2, inner.a1 + 1.2, 'c1')}
            {cap(60, runs[0][0] - 1, 'c2')}{cap(60, runs[0][1] + 1, 'c3')}{cap(60, runs[1][0] - 1, 'c4')}{cap(60, runs[1][1] + 1, 'c5')}
        </>
    );
};

// ── Circlet (the keys-finale-crown egg) ──────────────────────────────────────

/**
 * A circlet of light floating over your head, seen in perspective: a metal
 * band whose far side passes behind you, gems riding it round, a faint halo of
 * light above. Bobs gently.
 */
const CIRCLET: OrbitFrame = { cx: 50, cy: 5, tilt: -5, rx: 33, ry: 8.4 };
function circletLayer(half: 'far' | 'near'): Draw {
    return ({ u, o, tint }) => {
        const metal = hsl(pick(CIRCLET_COLOURS, o.c)[1]);
        const gem = itemTint(o.h, tint, '#6FB7FF');
        const f = CIRCLET;
        const far = half === 'far';
        const phases = Array.from({ length: 9 }, (_, i) => (i / 9) * 360 + 12);
        return (
            <g className="pc-bob">
                {far && (
                    <>
                        <defs><Rad id={`${u}-hl`} stops={[[0, shade(metal, 20, 0.36)], [0.6, shade(metal, 10, 0.12)], [1, shade(metal, 0, 0)]]} /></defs>
                        <ellipse data-glow="halo" className="pc-breathe" cx={f.cx} cy={f.cy - 4} rx={f.rx + 10} ry={f.ry + 9} fill={`url(#${u}-hl)`} />
                    </>
                )}
                <OrbitHalf id={`${u}-${half}`} f={f} half={half}>
                    <defs>
                        <Lin id={`${u}-mb`} stops={[[0, shade(metal, 26)], [0.5, shade(metal, 0)], [1, shade(metal, -34)]]} />
                        <Rad id={`${u}-gm`} cx={0.35} cy={0.3} r={0.8} stops={[[0, 'hsl(0 0% 100% / .95)'], [0.3, shade(gem, 14)], [1, shade(gem, -30)]]} />
                    </defs>
                    <ellipse rx={f.rx} ry={f.ry} fill="none" stroke={shade(metal, far ? -34 : -26)} strokeWidth="3.4" />
                    <ellipse rx={f.rx} ry={f.ry} fill="none" stroke={far ? shade(metal, -10) : `url(#${u}-mb)`} strokeWidth="2.4" />
                    <ellipse cy={-0.75} rx={f.rx} ry={f.ry} fill="none" stroke={shade(metal, 34, far ? 0.35 : 0.85, -30)} strokeWidth=".45" />
                    {riders(f, phases, (i) => (i % 3 === 0 ? (
                        <>
                            <path d="M0 -6.2 L2 -1.4 L0 -0.4 L-2 -1.4 Z" fill={shade(metal, far ? -12 : 14)} stroke={shade(metal, -36)} strokeWidth=".3" strokeLinejoin="round" />
                            <circle r="2.1" fill={`url(#${u}-gm)`} stroke={shade(metal, -30)} strokeWidth=".35" opacity={far ? 0.75 : 1} />
                        </>
                    ) : (
                        <circle r=".85" fill={shade(metal, far ? 6 : 30, 1, -20)} opacity={far ? 0.7 : 1} />
                    )))}
                </OrbitHalf>
            </g>
        );
    };
}
const circlet: DecorationArt = { back: circletLayer('far'), front: circletLayer('near') };

// ── Bat halo (Halloween 2026) ────────────────────────────────────────────────

/**
 * A pale moon rising behind your upper left; bats circling you on a tilted orbit, wings beating.
 *
 * Compact (picker thumbnails): the bats are near-black on a near-black tile, outlined by a 0.35-unit rim (about a
 * tenth of a pixel at 36px), so they vanished and the tile showed a small moon and some smudges. The compact bat
 * halo keeps the same silhouettes but draws them ~1.45x larger with a bright moonlit rim about three times wider,
 * under a bigger, brighter moon - the two things that say "bats at night" at a glance.
 */
const BATS: OrbitFrame = { cx: 50, cy: 47, tilt: -10, rx: 61, ry: 15 };
const BAT_SCALE_COMPACT = 1.5;
function batLayer(half: 'far' | 'near'): Draw {
    return ({ u, o, tint, compact }) => {
        const moon = itemTint(o.h, tint, '#F4E9C8');
        const five = o.p === 1;
        const phases = five ? [8, 80, 150, 226, 300] : [20, 140, 262];
        const sizes = [2.1, 1.6, 1.85, 1.45, 1.75];
        const far = half === 'far';
        const rim = compact ? shade(moon, 8, far ? 0.6 : 0.85) : shade(moon, 10, far ? 0.35 : 0.6);
        // The moon: centre and radius; its craters scale with it.
        const [mx, my, mr] = compact ? [12, 5, 13.5] : [13, 6, 11];
        const m = (v: number) => f1(v * (mr / 11));
        return (
            <>
                {far && (
                    <>
                        <defs>
                            <Rad id={`${u}-mg`} user cx={mx} cy={my} r={mr * (24 / 11)} stops={[[0.45, shade(moon, 0, compact ? 0.5 : 0.32)], [1, shade(moon, 0, 0)]]} />
                            <Rad id={`${u}-mb`} cx={0.38} cy={0.34} r={0.75} stops={[[0, shade(moon, 16, 1, -10)], [0.7, shade(moon, compact ? 4 : 0)], [1, shade(moon, -18)]]} />
                        </defs>
                        <circle data-glow="moonlight" className="pc-breathe" cx={mx} cy={my} r={f1(mr * (24 / 11))} fill={`url(#${u}-mg)`} />
                        <circle cx={mx} cy={my} r={mr} fill={`url(#${u}-mb)`} />
                        <g fill={shade(moon, -16, 0.55)} transform={`translate(${mx} ${my})`}>
                            <circle cx={m(-3.5)} cy={m(-2.4)} r={m(2.1)} /><circle cx={m(2.6)} cy={m(3.6)} r={m(1.4)} /><circle cx={m(3.4)} cy={m(-3.8)} r={m(0.9)} /><circle cx={m(-4.4)} cy={m(3.2)} r={m(0.8)} />
                        </g>
                    </>
                )}
                <OrbitHalf id={`${u}-${half}`} f={BATS} half={half}>
                    <ellipse rx={BATS.rx} ry={BATS.ry} fill="none" stroke={shade(moon, 0, far ? 0.07 : 0.12)} strokeWidth=".5" strokeDasharray="0.6 2.4" />
                    {riders(BATS, phases, (i) => (
                        <Bat s={sizes[i] * (far ? 0.9 : 1) * (compact ? BAT_SCALE_COMPACT : 1)} delay={-i * 0.13} rim={rim} rimW={compact ? 0.62 : undefined} />
                    ))}
                </OrbitHalf>
            </>
        );
    };
}
const batHalo: DecorationArt = { back: batLayer('far'), front: batLayer('near') };

export const HALO_ART: Readonly<Record<string, DecorationArt>> = {
    'orrery': orrery,
    'eclipse': eclipse,
    'crystal-ring': { front: crystalRing },
    'star-chart': { front: starChart },
    'neon-ring': { front: neonRing },
    'circlet': circlet,
    'bat-halo': batHalo,
};

