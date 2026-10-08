/* ============================================================
   Shapes for DotField. Every generator returns exactly N points:
   { pos: Float32Array(3N), col: Float32Array(3N) }. Points a shape
   does not need become the ambient field (dim plankton) or go dark,
   so any shape can morph into any other.

   Seeded PRNG: the same call gives the same shape, so frames and
   videos are repeatable.

   Typed port of ob6/js/shapes.js. The Canvas-2D helpers (text, drawn,
   keyGlyph and everything built on them) create their offscreen canvas
   lazily, so importing this module touches no DOM.
   ============================================================ */
import type { Shape } from './engine';

export type Rgb = readonly [number, number, number];

/** A shape that knows its point count (everything the generators here return). */
export type PointShape = Shape & { N: number };

export const C = {
  teal: [0.145, 0.878, 0.784] as Rgb,
  ice: [0.5, 0.78, 1.0] as Rgb,
  lilac: [0.72, 0.6, 1.0] as Rgb,
  gold: [1.0, 0.78, 0.45] as Rgb,
  pearl: [1.0, 0.93, 0.8] as Rgb,
  match: [0.55, 1.0, 0.9] as Rgb,
  white: [0.92, 0.97, 1.0] as Rgb,
  dark: [0, 0, 0] as Rgb,
};

/** Seeded PRNG (LCG), returns floats in [0, 1). Same seed, same sequence. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const scale = (c: Rgb, k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a: Rgb, b: Rgb, t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function blank(N: number): PointShape { return { pos: new Float32Array(N * 3), col: new Float32Array(N * 3), n: 0, N }; }
export function put(s: Shape, i: number, x: number, y: number, z: number, c: ArrayLike<number>): void {
  s.pos[i * 3] = x; s.pos[i * 3 + 1] = y; s.pos[i * 3 + 2] = z;
  s.col[i * 3] = c[0]; s.col[i * 3 + 1] = c[1]; s.col[i * 3 + 2] = c[2];
}

export interface AmbientOpts {
  seed?: number;
  bright?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

/* fill the remaining slots from `from` onward */
export function fillAmbient(s: PointShape, from: number, o: AmbientOpts = {}): PointShape {
  const r = rng(o.seed || 99);
  const k = o.bright ?? 0.32;
  for (let i = from; i < s.N; i++) {
    const x = (r() * 2 - 1) * (o.sx ?? 3.2), y = (r() * 2 - 1) * (o.sy ?? 2.1), z = -r() * (o.sz ?? 2.6) + 0.6;
    const c = r() < 0.5 ? C.teal : C.ice;
    put(s, i, x, y, z, k ? scale(c, k * (0.3 + r() * 0.7)) : C.dark);
  }
  return s;
}
function fillDark(s: PointShape, from: number, cx = 0, cy = 0): PointShape {
  const r = rng(7);
  for (let i = from; i < s.N; i++) put(s, i, cx + (r() - .5) * .2, cy + (r() - .5) * .2, -1, C.dark);
  return s;
}

/* ---------- ambient: the whole cloud as plankton ---------- */
export function ambient(N: number, o: AmbientOpts = {}): PointShape { return fillAmbient(blank(N), 0, o); }

/* ---------- Keys, from apps/website/public/logo.svg geometry ----------
   viewBox 110 x 90: four legs (rounded rects), a dome (half disc + band),
   two W brows cut out of the face so the eyes read as gaps. Relief depth
   so a yaw of ~25 deg still reads as a solid character. */
const LEGS = [22.5, 39.8, 57.1, 74.4];
type KeysPart = 'leg' | 'dome';
function inKeys(x: number, y: number): KeysPart | null {
  for (const lx of LEGS) {
    if (x >= lx && x <= lx + 13 && y >= 44 && y <= 78) {
      const cx = lx + 6.5;
      if (y < 50.5 || y > 71.5) { const cy = y < 50.5 ? 50.5 : 71.5; if ((x - cx) ** 2 + (y - cy) ** 2 > 6.5 ** 2) continue; }
      return 'leg';
    }
  }
  if (y <= 48 && (x - 55) ** 2 + (y - 48) ** 2 <= 34 * 34) return 'dome';
  if (y > 48 && y <= 53 && x >= 21 && x <= 89) return 'dome';
  return null;
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function onBrow(x: number, y: number): boolean {
  for (const bx of [33.5, 61.5]) {
    const pts = [[bx, 40], [bx + 3.75, 35], [bx + 7.5, 40], [bx + 11.25, 35], [bx + 15, 40]];
    for (let i = 0; i < 4; i++) if (segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) < 2.25) return true;
  }
  return false;
}
function keysRelief(x: number, y: number, part: KeysPart): number {
  if (part === 'dome') { const d = Math.min(1, ((x - 55) ** 2 + (y - 48) ** 2) / (34 * 34)); return 0.30 * Math.sqrt(1 - d); }
  const lx = LEGS.find((l) => x >= l && x <= l + 13) ?? LEGS[0]; const u = (x - (lx + 6.5)) / 6.5;
  return 0.085 * Math.sqrt(Math.max(0, 1 - u * u));
}

export interface KeysOpts {
  seed?: number;
  count?: number;
  size?: number;
  x?: number;
  y?: number;
  color?: Rgb;
  dark?: boolean;
  ambient?: AmbientOpts;
}
/* a dot-matrix grid over the logo: front skin on a regular lattice
   (that is what makes it read as "dot matrix" and keeps the brows
   crisp), plus a dimmer back skin for thickness when it turns */
export function keys(N: number, o: KeysOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 42);
  const budget = Math.min(N, o.count || Math.round(N * 0.8));
  const front = Math.round(budget * 0.86);
  const S = o.size ?? 1.0, ox = o.x ?? 0, oy = o.y ?? 0;
  const body = o.color || C.teal;
  const cands = (g: number): Array<[number, number, KeysPart]> => {
    const out: Array<[number, number, KeysPart]> = [];
    for (let y = 13; y <= 79; y += g) for (let x = 20; x <= 90; x += g) { const part = inKeys(x, y); if (part && !onBrow(x, y)) out.push([x, y, part]); }
    return out;
  };
  let g = 0.5, pts = cands(g);
  while (pts.length > front && g < 6) { g *= 1.06; pts = cands(g); }
  let i = 0;
  const toW = (x: number, y: number): [number, number] => [((x - 55) / 45) * S + ox, (-(y - 50) / 45) * S + oy];
  for (const [x, y, part] of pts) {
    if (i >= budget) break;
    const z = keysRelief(x, y, part);
    const [X, Y] = toW(x + (r() - .5) * g * 0.08, y + (r() - .5) * g * 0.08);
    put(s, i++, X, Y, z * S, scale(mixc(body, C.ice, r() * 0.2), 0.95 + r() * 0.35));
  }
  /* back skin */
  while (i < budget) {
    const [x, y, part] = pts[Math.floor(r() * pts.length)];
    const z = -keysRelief(x, y, part) * 0.7;
    const [X, Y] = toW(x + (r() - .5) * g, y + (r() - .5) * g);
    put(s, i++, X, Y, z * S, scale(body, 0.14 + r() * 0.12));
  }
  return o.dark ? fillDark(s, i, ox, oy) : fillAmbient(s, i, o.ambient || {});
}

/* ---------- the pearl + lattice shell (website midnight zone) ---------- */
export interface PearlOpts {
  seed?: number;
  r?: number;
  close?: number;
  x?: number;
  y?: number;
  core?: number;
  shell?: number;
  coreCol?: Rgb;
  shellCol?: Rgb;
  ambient?: AmbientOpts;
}
export function pearl(N: number, o: PearlOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 5);
  const R = o.r ?? 0.62, close = o.close ?? 0, cx = o.x ?? 0, cy = o.y ?? 0;
  const coreN = Math.round(N * (o.core ?? 0.32));
  const shellN = Math.round(N * (o.shell ?? 0.42));
  let i = 0;
  const coreCol = o.coreCol || C.pearl;
  for (; i < coreN; i++) {
    /* a dense glowing ball */
    const u = r(), v = r(), w = Math.cbrt(r()) * R * 0.48;
    const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
    put(s, i, cx + w * Math.sin(ph) * Math.cos(th), cy + w * Math.cos(ph), w * Math.sin(ph) * Math.sin(th), scale(coreCol, 0.55 + r() * 0.6));
  }
  /* shell: meridians + rings; `close` (0..1) is how much of it is drawn;
     undrawn points wait loosely around the pearl, dim */
  const MER = 16;
  for (let k = 0; k < shellN; k++, i++) {
    const lineOn = r() < 0.7;
    let x: number, y: number, z: number, lit: boolean;
    if (lineOn) {
      const m = Math.floor(r() * MER); const a = (m / MER) * Math.PI * 2;
      const ph = r() * Math.PI;
      x = Math.sin(ph) * Math.cos(a); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(a);
      lit = (m / MER) < close;
    } else {
      const ring = Math.floor(r() * 5) + 1; const ph = (ring / 6) * Math.PI; const a = r() * Math.PI * 2;
      x = Math.sin(ph) * Math.cos(a); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(a);
      lit = (a / (Math.PI * 2)) < close;
    }
    const jit = (r() - .5) * 0.015;
    if (lit) put(s, i, cx + x * (R + jit), cy + y * (R + jit), z * (R + jit), scale(o.shellCol || C.teal, 0.75 + r() * 0.5));
    else { const f = 1.25 + r() * 0.5; put(s, i, cx + x * R * f, cy + y * R * f, z * R * f, scale(C.ice, 0.12 + r() * 0.12)); }
  }
  return fillAmbient(s, i, o.ambient || {});
}

/* ---------- the pearl split into its two halves (your keys) ---------- */
export interface HalvesOpts extends PearlOpts {
  up?: number;
  sep?: number;
  lift?: number;
  flyX?: number;
}
export function halves(N: number, o: HalvesOpts = {}): PointShape {
  const base = pearl(N, { ...o, close: 1, core: 0.78, shell: 0.0, r: (o.r ?? 0.62) * 1.25 });
  const s = blank(N); s.pos.set(base.pos); s.col.set(base.col);
  const coreN = Math.round(N * 0.78); const r = rng(11);
  const up = o.up ?? 1.9, sep = o.sep ?? 0.55;
  for (let i = 0; i < coreN; i++) {
    const x = s.pos[i * 3];
    if (x >= 0) { /* public half: teal, lifts away */
      s.pos[i * 3] += sep + (o.flyX ?? 0); s.pos[i * 3 + 1] += up * (o.lift ?? 0);
      const c = scale(C.teal, 0.7 + r() * 0.5); s.col.set(c, i * 3);
    } else { /* private half: gold, stays */
      s.pos[i * 3] -= sep * 0.35 * (1 - Math.min(1, o.lift || 0)) - (o.lift ? 0.12 : 0);
      const c = scale(C.gold, 0.7 + r() * 0.5); s.col.set(c, i * 3);
    }
  }
  return s;
}

/* ---------- text rendered to dots ---------- */
/* A scratch canvas for sampling, created on demand (never at import, so the
   module loads in a DOM-less environment). Null when there is no DOM. */
function scratch(): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  return document.createElement('canvas');
}

export interface TextPointsOpts {
  px?: number;
  weight?: number | string;
  font?: string;
  step?: number;
}
export function textPoints(str: string, o: TextPointsOpts = {}): { pts: Array<[number, number]>; w: number } {
  const fs = o.px || 140;
  const cv = scratch();
  const ctx = cv && cv.getContext('2d', { willReadFrequently: true });
  if (!cv || !ctx) return { pts: [], w: 1 };
  const font = `${o.weight || 600} ${fs}px ${o.font || 'Fredoka, Nunito, sans-serif'}`;
  ctx.font = font;
  const w = Math.max(1, Math.ceil(ctx.measureText(str).width)) + 8, h = Math.ceil(fs * 1.25);
  cv.width = w; cv.height = h;
  ctx.font = font; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(str, 4, h / 2);
  const d = ctx.getImageData(0, 0, w, h).data;
  const step = o.step || 3;
  const pts: Array<[number, number]> = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (d[(y * w + x) * 4 + 3] > 128) pts.push([x / fs, -(y - h / 2) / fs]);
  return { pts, w: w / fs };
}

export interface TextOpts extends TextPointsOpts {
  seed?: number;
  /** world units per em */
  height?: number;
  maxW?: number;
  x?: number;
  y?: number;
  count?: number;
  depth?: number;
  color?: Rgb;
  dark?: boolean;
  ambient?: AmbientOpts;
}
export function text(N: number, str: string, o: TextOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 3);
  const { pts, w } = textPoints(str || ' ', o);
  const height = o.height ?? 0.34; /* world units per em */
  const maxW = o.maxW ?? 2.6;
  const k = Math.min(height, maxW / Math.max(w, 0.01));
  const cx = o.x ?? 0, cy = o.y ?? 0;
  const budget = Math.min(N, o.count || Math.round(N * 0.7));
  const use = pts.length > budget ? budget : pts.length;
  /* when there are more slots than glyph pixels, stack extra points in
     depth (a thicker, brighter word) rather than wasting them */
  let i = 0;
  const layers = pts.length ? Math.max(1, Math.min(4, Math.floor(budget / pts.length))) : 0;
  for (let L = 0; L < layers; L++) {
    for (let j = 0; j < use && i < budget; j++) {
      const p = pts[pts.length > budget ? Math.floor(j * pts.length / use) : j];
      const z = (L / Math.max(1, layers - 1) - 0.5) * (o.depth ?? 0.12) + (r() - 0.5) * 0.01;
      put(s, i++, cx + (p[0] - w / 2) * k, cy + p[1] * k, z, scale(o.color || C.white, 0.7 + r() * 0.45));
    }
  }
  return o.dark ? fillDark(s, i, cx, cy) : fillAmbient(s, i, o.ambient || {});
}

/* ---------- the app window, as a dot-matrix wireframe ----------
   Layout in world units for an aspect ratio; mirrors the real app's
   panes: rail | channel list | chat | members. */
export interface AppLayoutOpts {
  seed?: number;
  asp?: number;
  h?: number;
  dark?: boolean;
  ambient?: AmbientOpts;
}
export function appLayout(N: number, o: AppLayoutOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 21);
  const asp = o.asp || 1.6; const Hh = o.h ?? 1.55; const Ww = Hh * asp;
  const L = -Ww / 2, T = Hh / 2;
  const panes: Array<[number, number, number, number]> = [
    [L, T, Ww * 0.055, Hh],                         /* rail */
    [L + Ww * 0.065, T, Ww * 0.17, Hh],             /* list */
    [L + Ww * 0.245, T, Ww * 0.57, Hh],             /* chat */
    [L + Ww * 0.825, T, Ww * 0.175, Hh],            /* members */
  ];
  const pts: Array<[number, number, number]> = [];
  const edge = (x0: number, y0: number, x1: number, y1: number, n: number, c: number): void => { for (let k = 0; k < n; k++) { const t = r(); pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c]); } };
  panes.forEach(([x, y, w, h]) => {
    const per = Math.round((w + h) * 900);
    edge(x, y, x + w, y, per * w / (w + h), 1); edge(x, y - h, x + w, y - h, per * w / (w + h), 1);
    edge(x, y, x, y - h, per * h / (w + h), 1); edge(x + w, y, x + w, y - h, per * h / (w + h), 1);
  });
  /* rail icons */
  for (let k = 0; k < 7; k++) { const cx = L + Ww * 0.0275, cy = T - 0.12 - k * 0.15; for (let j = 0; j < 40; j++) { const a = r() * 6.283, rr = 0.045 * Math.sqrt(r()); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 2]); } }
  /* list rows */
  for (let k = 0; k < 9; k++) { const y = T - 0.16 - k * 0.12; edge(L + Ww * 0.08, y, L + Ww * 0.08 + Ww * 0.12 * (0.5 + r() * 0.5), y, 40, 3); }
  /* chat lines */
  for (let k = 0; k < 10; k++) { const y = T - 0.2 - k * 0.11; const x0 = L + Ww * 0.27; edge(x0, y, x0 + Ww * 0.5 * (0.3 + r() * 0.7), y, 60, 3); }
  /* composer */
  edge(L + Ww * 0.26, -T + 0.09, L + Ww * 0.8, -T + 0.09, 260, 1);
  /* members */
  for (let k = 0; k < 10; k++) { const y = T - 0.16 - k * 0.11; edge(L + Ww * 0.84, y, L + Ww * 0.84 + Ww * 0.12 * (0.4 + r() * 0.6), y, 30, 3); }
  let i = 0; const n = Math.min(N, pts.length);
  for (let j = 0; j < n; j++) {
    const p = pts[Math.floor(j * pts.length / n)];
    const c = p[2] === 1 ? scale(C.teal, 0.9) : p[2] === 2 ? scale(C.ice, 0.8) : scale(C.white, 0.42);
    put(s, i++, p[0], p[1], (r() - 0.5) * 0.01, c);
  }
  return o.dark ? fillDark(s, i) : fillAmbient(s, i, o.ambient || { bright: 0.18 });
}

/* ---------- sphere burst (explosion / gather) ---------- */
export interface BurstOpts {
  seed?: number;
  r?: number;
  bright?: number;
}
export function burst(N: number, o: BurstOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 77);
  for (let i = 0; i < N; i++) {
    const u = r(), v = r(), w = (o.r ?? 3) * (0.4 + r() * 0.6);
    const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
    put(s, i, w * Math.sin(ph) * Math.cos(th), w * Math.cos(ph), w * Math.sin(ph) * Math.sin(th) - 1, scale(r() < .5 ? C.teal : C.ice, (o.bright ?? 0.6) * (0.4 + r() * 0.6)));
  }
  return s;
}
/* ---------- a single point of light ---------- */
export function seed(N: number, o: { x?: number; y?: number } = {}): PointShape {
  const s = blank(N), r = rng(9);
  for (let i = 0; i < N; i++) put(s, i, (r() - .5) * 0.02 + (o.x || 0), (r() - .5) * 0.02 + (o.y || 0), (r() - .5) * 0.02, i < N * 0.3 ? scale(C.white, 0.25) : C.dark);
  return s;
}

/* recolour a shape (returns a copy; `pos` is shared) */
export function tint(shape: PointShape, color: Rgb, k = 1, frac = 1): PointShape {
  const s: PointShape = { pos: shape.pos, col: new Float32Array(shape.col), N: shape.N };
  const n = Math.round(shape.N * frac);
  for (let i = 0; i < n; i++) {
    const lum = Math.max(shape.col[i * 3], shape.col[i * 3 + 1], shape.col[i * 3 + 2]);
    if (lum < 0.01) continue;
    s.col[i * 3] = color[0] * lum * k; s.col[i * 3 + 1] = color[1] * lum * k; s.col[i * 3 + 2] = color[2] * lum * k;
  }
  return s;
}

/* several shapes in one cloud: parts = [{ n, gen: (n) => shape }] */
export function compose(N: number, parts: Array<{ n: number; gen: (n: number) => Shape }>): PointShape {
  const s = blank(N); let off = 0;
  for (const p of parts) {
    const n = Math.min(p.n, N - off); if (n <= 0) break;
    const sh = p.gen(n);
    s.pos.set(sh.pos.subarray(0, n * 3), off * 3); s.col.set(sh.col.subarray(0, n * 3), off * 3);
    off += n;
  }
  if (off < N) fillAmbient(s, off);
  return s;
}
export function darkAt(n: number, x = 0, y = 0, spread = 0.6): PointShape {
  const s = blank(n), r = rng(31);
  for (let i = 0; i < n; i++) put(s, i, x + (r() - .5) * spread, y + (r() - .5) * spread, (r() - .5) * spread, C.dark);
  return s;
}
/* points along a list of screen-space rects (already converted to world) */
export interface OutlineRect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind?: 'line' | 'rect';
  weight?: number;
  color?: Rgb;
  bright?: number;
}
export function outlines(N: number, rects: OutlineRect[], o: { seed?: number; count?: number; dark?: boolean; ambient?: AmbientOpts } = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 17);
  const per = rects.map((q) => (q.kind === 'line' ? q.w : 2 * (q.w + q.h)) * (q.weight || 1));
  const tot = per.reduce((a, b) => a + b, 0) || 1;
  const count = Math.min(N, o.count || N);
  let i = 0;
  rects.forEach((q, k) => {
    const m = Math.round(count * per[k] / tot);
    for (let j = 0; j < m && i < count; j++) {
      let x: number, y: number; const t = r();
      if (q.kind === 'line') { x = q.x + t * q.w; y = q.y - q.h / 2 + (r() - .5) * q.h * 0.6; }
      else {
        const P = 2 * (q.w + q.h); let d = t * P;
        if (d < q.w) { x = q.x + d; y = q.y; } else if ((d -= q.w) < q.h) { x = q.x + q.w; y = q.y - d; }
        else if ((d -= q.h) < q.w) { x = q.x + q.w - d; y = q.y - q.h; } else { d -= q.w; x = q.x; y = q.y - q.h + d; }
      }
      put(s, i++, x, y, (r() - .5) * 0.004, scale(q.color || C.teal, (q.bright ?? 0.9) * (0.75 + r() * 0.35)));
    }
  });
  return o.dark ? fillDark(s, i) : fillAmbient(s, i, o.ambient || { bright: 0.12 });
}

/* a flat ring of light (a pedestal), seen in perspective */
export interface RingOpts {
  seed?: number;
  r?: number;
  y?: number;
  count?: number;
  color?: Rgb;
  dark?: boolean;
  ambient?: AmbientOpts;
}
export function ring(N: number, o: RingOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 61);
  const R = o.r ?? 0.9, y = o.y ?? -0.7, count = Math.min(N, o.count || N);
  let i = 0;
  for (; i < count; i++) {
    const a = r() * Math.PI * 2; const band = r() < 0.7 ? 1 : 0.62 + r() * 0.3;
    const rr = R * band * (1 + (r() - 0.5) * 0.025);
    const lift = band === 1 ? 0 : (r() * 0.02);
    put(s, i, Math.cos(a) * rr, y + lift, Math.sin(a) * rr, scale(band === 1 ? (o.color || C.teal) : C.ice, band === 1 ? 0.9 + r() * 0.4 : 0.25 + r() * 0.2));
  }
  return o.dark ? fillDark(s, i) : fillAmbient(s, i, o.ambient || {});
}
/* an orb (sphere shell) with a glyph floating in its heart */
export interface OrbOpts {
  seed?: number;
  r?: number;
  y?: number;
  shell?: number;
  color?: Rgb;
  glyph?: string;
  glyphColor?: Rgb;
  ambient?: AmbientOpts;
}
export function orb(N: number, o: OrbOpts = {}): PointShape {
  const r = rng(o.seed || 63);
  const R = o.r ?? 0.6, cy = o.y ?? 0.1;
  const shellN = Math.round(N * (o.shell ?? 0.55));
  const s = blank(N);
  let i = 0;
  for (; i < shellN; i++) {
    const u = r(), v = r(); const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
    const rr = R * (1 + (r() - .5) * 0.02);
    put(s, i, rr * Math.sin(ph) * Math.cos(th), cy + rr * Math.cos(ph), rr * Math.sin(ph) * Math.sin(th), scale(o.color || C.teal, 0.35 + r() * 0.45));
  }
  if (o.glyph) {
    const g = text(N - shellN, o.glyph, { x: 0, y: cy - 0.03, height: R * 1.15, maxW: R * 1.4, count: N - shellN, depth: 0.16, color: o.glyphColor || C.white, dark: true });
    s.pos.set(g.pos.subarray(0, (N - shellN) * 3), shellN * 3); s.col.set(g.col.subarray(0, (N - shellN) * 3), shellN * 3);
    return s;
  }
  return fillAmbient(s, i, o.ambient || {});
}
/* sample anything you can draw on a 2D canvas: draw(ctx, w, h) */
export interface DrawnOpts {
  seed?: number;
  w?: number;
  h?: number;
  step?: number;
  count?: number;
  size?: number;
  x?: number;
  y?: number;
  depth?: number;
  color?: Rgb;
  dark?: boolean;
  ambient?: AmbientOpts;
}
export function drawn(N: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, o: DrawnOpts = {}): PointShape {
  const s = blank(N), r = rng(o.seed || 65);
  const w = o.w || 400, h = o.h || 400;
  const cv = scratch();
  const ctx = cv && cv.getContext('2d', { willReadFrequently: true });
  const pts: Array<[number, number]> = [];
  if (cv && ctx) {
    cv.width = w; cv.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; draw(ctx, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const step = o.step || 3;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (d[(y * w + x) * 4 + 3] > 128) pts.push([x, y]);
  }
  const count = Math.min(N, o.count || Math.round(N * 0.8));
  const k = (o.size ?? 1.6) / Math.max(w, h);
  let i = 0;
  const layers = pts.length ? Math.max(1, Math.min(4, Math.floor(count / pts.length))) : 0;
  for (let L = 0; L < layers; L++) for (let j = 0; j < pts.length && i < count; j++) {
    const p = pts[pts.length > count ? Math.floor(j * pts.length / count) : j];
    const z = (L / Math.max(1, layers - 1) - 0.5) * (o.depth ?? 0.1);
    put(s, i++, (o.x || 0) + (p[0] - w / 2) * k, (o.y || 0) - (p[1] - h / 2) * k, z, scale(o.color || C.gold, 0.75 + r() * 0.4));
  }
  return o.dark ? fillDark(s, i) : fillAmbient(s, i, o.ambient || {});
}
/* a classic key, for "forging your keys" */
export function keyGlyph(N: number, o: { size?: number; count?: number; x?: number; y?: number; color?: Rgb; dark?: boolean; ambient?: AmbientOpts } = {}): PointShape {
  return drawn(N, (c, w, h) => {
    c.lineWidth = 34; c.lineCap = 'round';
    c.beginPath(); c.arc(w * 0.27, h * 0.5, 70, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(w * 0.27 + 86, h * 0.5); c.lineTo(w * 0.9, h * 0.5); c.stroke();
    c.lineWidth = 26;
    c.beginPath(); c.moveTo(w * 0.76, h * 0.5); c.lineTo(w * 0.76, h * 0.62); c.stroke();
    c.beginPath(); c.moveTo(w * 0.86, h * 0.5); c.lineTo(w * 0.86, h * 0.66); c.stroke();
  }, { w: 520, h: 300, size: o.size ?? 1.5, count: o.count, x: o.x, y: o.y, color: o.color || C.gold, depth: 0.14, ambient: o.ambient, dark: o.dark });
}

export const Shapes = { ring, orb, drawn, keyGlyph, compose, darkAt, outlines, C, rng, ambient, keys, pearl, halves, text, textPoints, appLayout, burst, seed, tint, blank, put, fillAmbient };
