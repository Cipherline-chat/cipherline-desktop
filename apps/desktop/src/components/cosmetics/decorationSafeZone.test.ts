// @vitest-environment jsdom
/**
 * The status dot sits on the avatar's bottom-right. Owner: "the starfish has
 * the starfish right where your online indicator is" - so for EVERY decoration
 * (and every variant of its options) this test proves the art leaves the dot's
 * zone (geometry.ts SAFE_ZONE) empty:
 *
 *   1. structurally: every layer is wrapped in the safe-zone mask;
 *   2. geometrically: the rendered SVG is walked with its transforms, every
 *      shape's outline is sampled (arcs converted properly, stroke widths
 *      included) and no sample - and no filled interior - may reach the zone;
 *      bodies riding an orbit (halos.tsx, `data-orbit`) are checked at every
 *      10 degrees of the loop, not just where they start.
 *
 * It also bounds every decoration to VISIBLE_REACH from the avatar centre
 * (owner, 2026-10-26: the sea fan was "mostly off profile").
 *
 * Soft glow fills (`data-glow`) are the one exemption: they are light, not
 * objects, and the mask (1) is what keeps them off the dot.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AvatarDecoration } from '../ProfileCosmetics';
import { AVATAR_DECORATIONS, optionSpecsFor, type ItemOptions } from '../../utils/profileCosmetics';
import { SAFE_ZONE } from './geometry';
import { SEA_FAN_REACH } from './decorations';

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function parseTransform(s: string | null): M {
    let m = I;
    if (!s) return m;
    for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
        const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
        if (fn === 'translate') m = mul(m, [1, 0, 0, 1, a[0], a[1] ?? 0]);
        else if (fn === 'scale') m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
        else if (fn === 'rotate') {
            const r = (a[0] * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
            const cx = a[1] ?? 0, cy = a[2] ?? 0;
            m = mul(mul(mul(m, [1, 0, 0, 1, cx, cy]), [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        } else if (fn === 'matrix') m = mul(m, a as M);
        else throw new Error(`unsupported transform ${fn}`);
    }
    return m;
}

/** Endpoint arc -> sampled points (SVG spec F.6.5). */
function arcPoints(x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number): Array<[number, number]> {
    if (rx === 0 || ry === 0) return [[x2, y2]];
    const p = (phi * Math.PI) / 180, cp = Math.cos(p), sp = Math.sin(p);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
    const out: Array<[number, number]> = [];
    const n = Math.max(8, Math.ceil(Math.abs(dt) / 0.05));
    for (let i = 1; i <= n; i++) {
        const t = t1 + (dt * i) / n;
        out.push([cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp]);
    }
    return out;
}

/** Path data -> subpaths of sampled points (absolute, local coordinates). */
function pathPoints(d: string): Array<Array<[number, number]>> {
    const toks = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+)(?:e-?\d+)?/g) ?? [];
    const subs: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    let i = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = '', lcx = 0, lcy = 0;
    const num = () => Number(toks[i++]);
    const bez = (pts: Array<[number, number]>) => {
        const n = 16;
        for (let k = 1; k <= n; k++) {
            const t = k / n;
            if (pts.length === 3) {
                const [p0, p1, p2] = pts, u = 1 - t;
                cur.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
            } else {
                const [p0, p1, p2, p3] = pts, u = 1 - t;
                cur.push([
                    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
                    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
                ]);
            }
        }
    };
    while (i < toks.length) {
        if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
        const rel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();
        const ox = rel ? x : 0, oy = rel ? y : 0;
        switch (C) {
            case 'M': { x = ox + num(); y = oy + num(); if (cur.length) subs.push(cur); cur = [[x, y]]; sx = x; sy = y; cmd = rel ? 'l' : 'L'; break; }
            case 'L': { x = ox + num(); y = oy + num(); cur.push([x, y]); break; }
            case 'H': { x = (rel ? x : 0) + num(); cur.push([x, y]); break; }
            case 'V': { y = (rel ? y : 0) + num(); cur.push([x, y]); break; }
            case 'C': {
                const p1: [number, number] = [ox + num(), oy + num()], p2: [number, number] = [ox + num(), oy + num()], p3: [number, number] = [ox + num(), oy + num()];
                bez([[x, y], p1, p2, p3]); lcx = p2[0]; lcy = p2[1]; [x, y] = p3; break;
            }
            case 'Q': {
                const p1: [number, number] = [ox + num(), oy + num()], p2: [number, number] = [ox + num(), oy + num()];
                bez([[x, y], p1, p2]); lcx = p1[0]; lcy = p1[1]; [x, y] = p2; break;
            }
            case 'T': {
                const p1: [number, number] = [2 * x - lcx, 2 * y - lcy], p2: [number, number] = [ox + num(), oy + num()];
                bez([[x, y], p1, p2]); lcx = p1[0]; lcy = p1[1]; [x, y] = p2; break;
            }
            case 'A': {
                const rx = num(), ry = num(), phi = num(), fa = num(), fs = num(), x2 = ox + num(), y2 = oy + num();
                cur.push(...arcPoints(x, y, rx, ry, phi, fa, fs, x2, y2)); x = x2; y = y2; break;
            }
            case 'Z': { cur.push([sx, sy]); x = sx; y = sy; break; }
            default: throw new Error(`unsupported path command ${cmd}`);
        }
        if (C !== 'C' && C !== 'Q' && C !== 'T') { lcx = x; lcy = y; }
    }
    if (cur.length) subs.push(cur);
    return subs;
}

const ellipsePts = (cx: number, cy: number, rx: number, ry: number) =>
    Array.from({ length: 48 }, (_, k): [number, number] => [cx + rx * Math.cos((k / 48) * 2 * Math.PI), cy + ry * Math.sin((k / 48) * 2 * Math.PI)]);

const inside = (pt: [number, number], poly: Array<[number, number]>): boolean => {
    let c = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, yi] = poly[a], [xj, yj] = poly[b];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
};

interface Hit { tag: string; at: [number, number]; dist: number }
/** One sampled point of drawn geometry (absolute coordinates) and the half stroke width around it. */
type Visit = (p: [number, number], half: number, tag: string) => void;
const rot = (deg: number): M => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
/** Orbits (cosmetics/halos.tsx) are sampled all the way round, this many degrees apart. */
const ORBIT_STEP = 10;

/**
 * Walk the drawn geometry under `el`: every outline sample (with its stroke
 * half-width) goes to `visit`, every filled closed shape to `filled`.
 * `data-orbit="spin"` groups ride a CSS rotation: their content is visited at
 * every ORBIT_STEP of it, and `data-orbit="counter"` undoes the same angle,
 * exactly as the animation does.
 */
function walk(el: Element, m: M, strokeW: number, visit: Visit, filled: (poly: Array<[number, number]>, tag: string) => void, theta?: number): void {
    const tag = el.tagName.toLowerCase();
    if (tag === 'defs' || tag === 'mask' || tag === 'clippath' || tag.endsWith('gradient') || el.hasAttribute('data-glow')) return;
    let mm = mul(m, parseTransform(el.getAttribute('transform')));
    const orbit = el.getAttribute('data-orbit');
    if (orbit === 'spin' && theta === undefined) {
        for (let a = 0; a < 360; a += ORBIT_STEP) walk(el, mm, strokeW, visit, filled, a);
        return;
    }
    if (orbit === 'spin') mm = mul(mm, rot(theta!));
    if (orbit === 'counter') mm = mul(mm, rot(-(theta ?? 0)));
    // Content under an art mask (not the safe mask) is only visible through
    // the mask's shape: check that shape instead of what it reveals.
    const mk = /^url\(#(.+)\)$/.exec(el.getAttribute('mask') ?? '');
    if (mk && !/-safe-[bf]$/.test(mk[1])) {
        const mask = el.ownerDocument.getElementById(mk[1]);
        if (!mask) throw new Error(`mask ${mk[1]} not found`);
        for (const c of Array.from(mask.children)) walk(c, mm, strokeW, visit, filled, theta);
        return;
    }
    const sw = el.hasAttribute('stroke-width') ? Number(el.getAttribute('stroke-width')) : strokeW;
    const stroke = el.getAttribute('stroke');
    const fill = el.getAttribute('fill');
    const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
    let subs: Array<Array<[number, number]>> | null = null;
    const n = (a: string) => Number(el.getAttribute(a) ?? 0);
    if (tag === 'path') subs = pathPoints(el.getAttribute('d') ?? '');
    else if (tag === 'circle') subs = [ellipsePts(n('cx'), n('cy'), n('r'), n('r'))];
    else if (tag === 'ellipse') subs = [ellipsePts(n('cx'), n('cy'), n('rx'), n('ry'))];
    else if (tag === 'line') subs = [[[n('x1'), n('y1')], [n('x2'), n('y2')]]];
    else if (tag === 'rect') { const x = n('x'), y = n('y'), w = n('width'), h = n('height'); subs = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]; }
    else if (tag === 'polygon') subs = [(el.getAttribute('points') ?? '').trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number])];
    else if (!['g', 'svg'].includes(tag)) throw new Error(`unsupported element <${tag}>`);
    if (subs) {
        const half = stroke && stroke !== 'none' ? (sw * scale) / 2 : 0;
        for (const sub of subs) {
            const pts = sub.map(([x, y]) => apply(mm, x, y));
            for (const p of pts) visit(p, half, tag);
            if (fill !== 'none' && pts.length > 2) filled(pts, tag);
        }
    }
    for (const c of Array.from(el.children)) walk(c, mm, sw, visit, filled, theta);
}

/** Every way the zone is touched by the drawn geometry under `el`. */
function violations(el: Element, m: M, strokeW: number, out: Hit[]): void {
    walk(el, m, strokeW, (p, half, tag) => {
        const d = Math.hypot(p[0] - SAFE_ZONE.cx, p[1] - SAFE_ZONE.cy) - half;
        if (d < SAFE_ZONE.r) out.push({ tag, at: p, dist: d });
    }, (pts, tag) => {
        if (inside([SAFE_ZONE.cx, SAFE_ZONE.cy], pts)) out.push({ tag: `${tag} (filled over the dot)`, at: [SAFE_ZONE.cx, SAFE_ZONE.cy], dist: 0 });
    });
}

/**
 * The box the cards leave visible around the avatar (avatar = 0..100; soft
 * glows exempt, they are light). Plants may root below the avatar and rise
 * past its side, rings sit just outside it; nothing may wander off across the
 * card the way the old sea fan did (it grew out to x = -80: "mostly off
 * profile").
 */
export const VISIBLE_BOX = { x0: -45, y0: -40, x1: 135, y1: 125 } as const;
function bounds(el: Element): { x0: number; y0: number; x1: number; y1: number } {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    walk(el, I, 1, (p, h) => {
        b.x0 = Math.min(b.x0, p[0] - h); b.y0 = Math.min(b.y0, p[1] - h); b.x1 = Math.max(b.x1, p[0] + h); b.y1 = Math.max(b.y1, p[1] + h);
    }, () => {});
    return b;
}
const inBox = (b: ReturnType<typeof bounds>) => b.x0 >= VISIBLE_BOX.x0 && b.y0 >= VISIBLE_BOX.y0 && b.x1 <= VISIBLE_BOX.x1 && b.y1 <= VISIBLE_BOX.y1;
/** Furthest drawn point from the avatar centre. */
function reach(el: Element): number {
    let max = 0;
    walk(el, I, 1, (p, half) => { max = Math.max(max, Math.hypot(p[0] - 50, p[1] - 50) + half); }, () => {});
    return max;
}

/** Every combination of a decoration's choice / colour / range options (hue does not move geometry). */
function variants(id: string): ItemOptions[] {
    let out: ItemOptions[] = [{}];
    for (const s of optionSpecsFor('decoration', id)) {
        const values = s.type === 'choice' || s.type === 'color' ? s.choices.map((c) => c.value) : s.type === 'range' ? [s.min, s.max] : [];
        if (!values.length) continue;
        out = out.flatMap((o) => values.map((v) => ({ ...o, [s.key]: v })));
    }
    return out;
}

const render = (id: string, o: ItemOptions, compact = false) =>
    new DOMParser().parseFromString(renderToStaticMarkup(React.createElement(AvatarDecoration, { decoration: id, options: o, compact, children: 'x' })), 'text/html');
/** Card size and the picker's bolder thumbnail version (DecoCtx.compact): both must keep clear of the dot. */
const SIZES = [false, true] as const;

describe('status-dot safe zone', () => {
    const ids = AVATAR_DECORATIONS.map((d) => d.id);
    it('covers every decoration in the catalog (legacy variants included)', () => {
        expect(ids.length).toBeGreaterThanOrEqual(19);
    });
    for (const id of ids) {
        it(`${id}: every layer is masked, and no shape reaches the dot in any variant, card or thumbnail (orbits sampled all the way round)`, () => {
            for (const o of variants(id)) for (const compact of SIZES) {
                const doc = render(id, o, compact);
                const layers = Array.from(doc.querySelectorAll('svg.pc-deco-art'));
                expect(layers.length).toBeGreaterThan(0);
                for (const svg of layers) {
                    const g = svg.querySelector(':scope > g[data-safe-zone="masked"]');
                    expect(g?.getAttribute('mask')).toMatch(/^url\(#.+-safe-[bf]\)$/);
                    const maskId = /url\(#(.+)\)/.exec(g!.getAttribute('mask')!)![1];
                    const hole = svg.querySelector(`mask[id="${maskId}"] circle`);
                    expect([hole?.getAttribute('cx'), hole?.getAttribute('cy'), hole?.getAttribute('r')]).toEqual([String(SAFE_ZONE.cx), String(SAFE_ZONE.cy), String(SAFE_ZONE.r)]);
                    const hits: Hit[] = [];
                    violations(g!, I, 1, hits);
                    expect({ id, o, compact, hits: hits.slice(0, 3) }).toEqual({ id, o, compact, hits: [] });
                }
            }
        });
    }
});

describe('visible bounds (owner: the sea fan was "mostly off profile")', () => {
    for (const d of AVATAR_DECORATIONS) {
        it(`${d.id}: stays inside the visible box around the avatar in every variant, card or thumbnail`, () => {
            for (const o of variants(d.id)) for (const compact of SIZES) {
                for (const svg of Array.from(render(d.id, o, compact).querySelectorAll('svg.pc-deco-art > g[data-safe-zone]'))) {
                    const b = bounds(svg);
                    expect({ id: d.id, o, compact, b, inside: inBox(b) }).toEqual({ id: d.id, o, compact, b, inside: true });
                }
            }
        });
    }
    it('the sea fan itself (not just its fade mask) keeps within SEA_FAN_REACH of the avatar centre, rooted on the rim', () => {
        for (const o of variants('sea-fan')) {
            const fan = render('sea-fan', o).querySelector('svg.pc-deco-front g[mask] > g');
            expect(fan).not.toBeNull();
            expect(reach(fan!)).toBeLessThanOrEqual(SEA_FAN_REACH + 1.5);
            expect(bounds(fan!).x0).toBeGreaterThan(-18);
        }
    });
    it('positive control: the OLD sea fan (rooted at -8,102, growing up-left past x = -45) fails the box', () => {
        const doc = new DOMParser().parseFromString('<svg><g><path d="M-8 102 Q -40 70 -62 20" fill="none" stroke="#fff" stroke-width="2" /></g></svg>', 'image/svg+xml');
        expect(inBox(bounds(doc.querySelector('g')!))).toBe(false);
    });
});

describe('the checker itself (positive controls)', () => {
    const hitsFor = (svgInner: string) => {
        const doc = new DOMParser().parseFromString(`<svg><g>${svgInner}</g></svg>`, 'image/svg+xml');
        const hits: Hit[] = [];
        violations(doc.querySelector('g')!, I, 1, hits);
        return hits.length;
    };
    it('catches the OLD starfish position (a shape at the bottom right)', () => {
        expect(hitsFor('<circle cx="88" cy="88" r="10" fill="red" />')).toBeGreaterThan(0);
    });
    it('catches a full ring through the dot, a transformed shape, and a big filled disk over it', () => {
        expect(hitsFor('<circle cx="50" cy="50" r="53" fill="none" stroke="#fff" stroke-width="2" />')).toBeGreaterThan(0);
        expect(hitsFor('<g transform="translate(70 70)"><circle cx="15" cy="15" r="2" fill="red" /></g>')).toBeGreaterThan(0);
        expect(hitsFor('<circle cx="50" cy="50" r="90" fill="red" />')).toBeGreaterThan(0);
        expect(hitsFor('<path d="M50 50 A 40 40 0 0 0 90 90" fill="none" stroke="#fff" />')).toBeGreaterThan(0);
    });
    it('passes a shape on the upper left, and ignores a declared soft glow', () => {
        expect(hitsFor('<circle cx="10" cy="10" r="8" fill="red" />')).toBe(0);
        expect(hitsFor('<circle data-glow="1" cx="50" cy="50" r="70" fill="red" />')).toBe(0);
    });
    it('samples an orbit all the way round: a moon that starts clear but passes the dot is caught', () => {
        // Starts at the top (clear of the dot), orbits at r 36 about the centre: at 135 deg it sits on the dot.
        const moon = '<g transform="translate(50 50)"><g data-orbit="spin"><g transform="translate(0 -36)"><g data-orbit="counter"><circle r="3" fill="#fff" /></g></g></g></g>';
        expect(hitsFor(moon)).toBeGreaterThan(0);
        // The same moon without the orbit marker is (wrongly) only checked where it starts: it passes.
        expect(hitsFor(moon.replace(/ data-orbit="[a-z]+"/g, ''))).toBe(0);
    });
});
