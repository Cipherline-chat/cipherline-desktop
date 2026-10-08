/* ============================================================
   Round-6 scenes for the dot field. Every scene returns exactly N
   points (pos + col), so any scene morphs into any other.
   World units: the cloud fits in a radius of ~1.25 around 0,0;
   the caller places and scales it into the visual column
   (see placement.ts: place()).

   Typed port of ob6/js/scenes.js.
   ============================================================ */
import type { Shape } from './engine';
import * as S from './shapes';
import type { PointShape, Rgb } from './shapes';

export const COL = {
  lume: [0.145, 0.878, 0.784] as Rgb, lumeHi: [0.55, 1.0, 0.92] as Rgb, gold: [1.0, 0.79, 0.30] as Rgb, pearl: [1.0, 0.93, 0.8] as Rgb,
  ice: [0.5, 0.78, 1.0] as Rgb, white: [0.92, 0.97, 1.0] as Rgb, amber: [1.0, 0.79, 0.30] as Rgb,
};
const sc = (c: Rgb, k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];

export function shift<T extends Shape>(sh: T, dx: number, dy: number, dz = 0): T {
  const n = sh.pos.length / 3;
  for (let i = 0; i < n; i++) { sh.pos[i * 3] += dx; sh.pos[i * 3 + 1] += dy; sh.pos[i * 3 + 2] += dz; }
  return sh;
}
/* a lucide icon (24-unit paths) as dots, via Path2D */
export function icon(n: number, paths: readonly string[], o: { lw?: number; size?: number; x?: number; y?: number; color?: Rgb } = {}): PointShape {
  return S.drawn(n, (c, w, h) => {
    c.save(); c.translate(w * 0.1, h * 0.1); c.scale(w * 0.8 / 24, h * 0.8 / 24);
    c.lineWidth = o.lw || 2.3; c.lineCap = 'round'; c.lineJoin = 'round';
    paths.forEach((d) => c.stroke(new Path2D(d)));
    c.restore();
  }, { w: 220, h: 220, step: 2, size: o.size || 0.4, count: n, x: o.x || 0, y: o.y || 0, color: o.color || COL.lume, depth: 0.06, dark: true });
}
export function ball(n: number, r: number, color: Rgb, k: number, seed = 7): PointShape {
  const s = S.blank(n), rr = S.rng(seed);
  for (let i = 0; i < n; i++) {
    const u = rr(), v = rr(), w = Math.cbrt(rr()) * r;
    const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
    S.put(s, i, w * Math.sin(ph) * Math.cos(th), w * Math.cos(ph), w * Math.sin(ph) * Math.sin(th), sc(color, k * (0.5 + rr() * 0.6)));
  }
  return s;
}
/* the lattice: meridians + rings, a sealed shell */
export function lattice(n: number, R: number, color: Rgb, seed = 5): PointShape {
  const s = S.blank(n), r = S.rng(seed);
  const MER = 12;
  for (let i = 0; i < n; i++) {
    let x: number, y: number, z: number;
    if (r() < 0.66) {
      const a = (Math.floor(r() * MER) / MER) * Math.PI * 2, ph = r() * Math.PI;
      x = Math.sin(ph) * Math.cos(a); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(a);
    } else {
      const ph = ((Math.floor(r() * 5) + 1) / 6) * Math.PI, a = r() * Math.PI * 2;
      x = Math.sin(ph) * Math.cos(a); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(a);
    }
    const j = 1 + (r() - 0.5) * 0.02;
    S.put(s, i, x * R * j, y * R * j, z * R * j, sc(color, 0.55 + r() * 0.5));
  }
  return s;
}
export function segment(n: number, a: readonly number[], b: readonly number[], color: Rgb, k: number, o: { dash?: number; sag?: number; seed?: number } = {}): PointShape {
  const s = S.blank(n), r = S.rng(o.seed || 13);
  for (let i = 0; i < n; i++) {
    let t = r();
    if (o.dash) t = Math.floor(t * o.dash) / o.dash + (r() * 0.45) / o.dash;
    const sag = o.sag ? Math.sin(t * Math.PI) * o.sag : 0;
    S.put(s, i, a[0] + (b[0] - a[0]) * t + (r() - .5) * 0.01, a[1] + (b[1] - a[1]) * t - sag + (r() - .5) * 0.01, (a[2] || 0) + (r() - .5) * 0.02, sc(color, k * (0.6 + r() * 0.5)));
  }
  return s;
}
export function stitch(N: number, parts: readonly Shape[]): PointShape {
  const s = S.blank(N); let off = 0;
  for (const sh of parts) {
    const n = Math.min(sh.pos.length / 3, N - off); if (n <= 0) break;
    s.pos.set(sh.pos.subarray(0, n * 3), off * 3); s.col.set(sh.col.subarray(0, n * 3), off * 3); off += n;
  }
  if (off < N) S.fillAmbient(s, off, { bright: 0.16, sx: 2.6, sy: 1.7, sz: 2.2, seed: 77 });
  return s;
}

/* ---------- privacy: your keys, sealed; three things you may share ---------- */
export type SatKey = 'receipts' | 'playing' | 'mobile';
export interface PrivacyState {
  receipts: boolean;
  playing: boolean;
  mobile: boolean;
  /** present in the flow's state, not drawn by the scene */
  capture?: boolean;
  pin?: boolean;
}
const SAT_KEYS: readonly SatKey[] = ['receipts', 'playing', 'mobile'];
const ICONS: Record<SatKey, string[]> = {
  receipts: ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
  playing: ['M6 11h4', 'M8 9v4', 'M15 12h.01', 'M18 10h.01', 'M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z'],
  mobile: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'],
};
const SAT: Record<SatKey, number> = { receipts: 150, playing: 30, mobile: -90 };
const ORBIT = 1.12, SHELL = 0.64;
function satPos(k: SatKey, on: boolean): [number, number, number] {
  const a = SAT[k] * Math.PI / 180;
  return on ? [Math.cos(a) * ORBIT, Math.sin(a) * ORBIT * 0.92, 0.12] : [Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0.2];
}
/** `hi` is the satellite to light up (or null). */
export function privacy(N: number, st: PrivacyState, hi: SatKey | string | null): PointShape {
  const parts: Shape[] = [];
  parts.push(S.keyGlyph(900, { size: 0.56, x: 0.02, y: 0, color: COL.gold, count: 900, dark: true }));
  parts.push(ball(600, 0.42, COL.pearl, 0.16, 3));
  parts.push(lattice(2100, SHELL, sc(COL.lume, 1.15)));
  for (const k of SAT_KEYS) {
    const on = st[k], [x, y, z] = satPos(k, on), lit = hi === k ? 1.35 : 1;
    if (on) parts.push(shift(icon(640, ICONS[k], { size: 0.46, lw: 2.7, color: sc(COL.lumeHi, 0.85 * lit) }), x, y, z));
    else parts.push(shift(ball(640, 0.05, COL.lume, 0.42 * lit, 21), x, y, z));
    const a = SAT[k] * Math.PI / 180, cx = Math.cos(a), cy = Math.sin(a) * 0.92;
    if (on) parts.push(segment(150, [cx * (SHELL + 0.05), cy * (SHELL + 0.05), 0.06], [cx * (ORBIT - 0.25), cy * (ORBIT - 0.25), 0.1], COL.lume, 0.55, { dash: 7, seed: 40 + k.length }));
    else {   /* the empty slot where it would sit, as a faint dashed ring */
      const [ox, oy, oz] = satPos(k, true), ring = S.blank(150), r = S.rng(50 + k.length);
      for (let i = 0; i < 150; i++) { let a2 = r() * Math.PI * 2; a2 = Math.floor(a2 / (Math.PI * 2) * 16) / 16 * Math.PI * 2 + r() * 0.2; S.put(ring, i, ox + Math.cos(a2) * 0.2, oy + Math.sin(a2) * 0.2, oz, sc(COL.ice, 0.3)); }
      parts.push(ring);
    }
  }
  return stitch(N, parts);
}
/* screen anchors for the DOM tags (world coords, before placement) */
export function privacyAnchors(st?: PrivacyState): Record<SatKey | 'key', [number, number, number]> {
  void st;   /* the anchors do not depend on the toggles; the argument is kept for call-shape compatibility */
  const out = {} as Record<SatKey | 'key', [number, number, number]>;
  for (const k of SAT_KEYS) {
    const [x, y, z] = satPos(k, true);
    out[k] = [x, y - (k === 'mobile' ? 0.3 : 0.29), z];
  }
  out.key = [0, -0.3, 0.3];
  return out;
}

/* ---------- referral ---------- */
export function codeText(N: number, code: string): PointShape {
  const t = S.text(Math.round(N * 0.62), code, { height: 0.5, maxW: 2.2, font: 'JetBrains Mono, monospace', weight: 700, color: COL.lumeHi, count: Math.round(N * 0.62), dark: true, depth: 0.1 });
  return stitch(N, [t]);
}
function orbAt(n: number, x: number, glyph: string, color: Rgb, glyphColor?: Rgb): PointShape {
  const o = S.orb(n, { r: 0.4, y: 0, glyph, color, glyphColor: glyphColor || COL.white, shell: 0.52 });
  return shift(o, x, 0);
}
function seat(n: number, x: number): PointShape {
  const s = S.blank(n), r = S.rng(19);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2; const dash = Math.floor(a / (Math.PI * 2) * 22) % 2 === 0;
    const rr = 0.4 * (1 + (r() - .5) * 0.03);
    if (dash) S.put(s, i, x + Math.cos(a) * rr, Math.sin(a) * rr, (r() - .5) * 0.02, sc(COL.ice, 0.22 + r() * 0.16));
    else S.put(s, i, x + (r() - .5) * 0.05, (r() - .5) * 0.05, -0.4, [0, 0, 0]);
  }
  return s;
}
export interface OrbSpec {
  glyph: string;
  color: Rgb;
}
/* a = left orb, b = right orb ({ glyph, color } or null for the empty seat) */
export function pair(N: number, a: OrbSpec, b: OrbSpec | null, joined: boolean): PointShape {
  const X = 0.66;
  const parts = [orbAt(2300, -X, a.glyph, a.color), b ? orbAt(2300, X, b.glyph, b.color) : seat(2300, X)];
  parts.push(joined
    ? segment(600, [-X + 0.42, 0, 0], [X - 0.42, 0, 0], COL.gold, 1.0, { sag: 0.09, seed: 29 })
    : segment(600, [-X + 0.42, 0, 0], [X - 0.42, 0, 0], COL.ice, 0.32, { sag: 0.09, dash: 9, seed: 29 }));
  return stitch(N, parts);
}
export const PAIR_X = 0.66;

export const Scenes = { privacy, privacyAnchors, codeText, pair, PAIR_X, COL, stitch, shift, icon };
