import { afterEach, describe, expect, it, vi } from 'vitest';
import * as S from './shapes';
import type { PointShape } from './shapes';

const N = 1500;

function expectWellFormed(sh: PointShape, n: number): void {
  expect(sh.pos).toBeInstanceOf(Float32Array);
  expect(sh.col).toBeInstanceOf(Float32Array);
  expect(sh.pos.length).toBe(n * 3);
  expect(sh.col.length).toBe(n * 3);
  expect(sh.pos.every(Number.isFinite)).toBe(true);
  expect(sh.col.every(Number.isFinite)).toBe(true);
  /* colours are non-negative light intensities */
  expect(sh.col.every((v) => v >= 0)).toBe(true);
}

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = S.rng(42), b = S.rng(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it('differs between seeds', () => {
    expect(S.rng(1)()).not.toBe(S.rng(2)());
  });
  it('stays in [0, 1)', () => {
    const r = S.rng(7);
    for (let i = 0; i < 2000; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
  it('treats seed 0 like seed 1 (never degenerate)', () => {
    expect(S.rng(0)()).toBe(S.rng(1)());
  });
});

describe('canvas-free shapes return exactly N finite points', () => {
  const cases: Array<[string, (n: number) => PointShape]> = [
    ['blank', (n) => S.blank(n)],
    ['ambient', (n) => S.ambient(n)],
    ['keys', (n) => S.keys(n)],
    ['keys (dark)', (n) => S.keys(n, { dark: true, size: 0.5, x: 0.2, y: -0.1 })],
    ['pearl', (n) => S.pearl(n)],
    ['pearl (half closed)', (n) => S.pearl(n, { close: 0.5 })],
    ['halves', (n) => S.halves(n, { lift: 0.4 })],
    ['ring', (n) => S.ring(n)],
    ['ring (dark, partial)', (n) => S.ring(n, { dark: true, count: Math.floor(n / 2) })],
    ['orb (no glyph)', (n) => S.orb(n)],
    ['burst', (n) => S.burst(n)],
    ['seed', (n) => S.seed(n)],
    ['darkAt', (n) => S.darkAt(n, 0.3, -0.2)],
    ['appLayout', (n) => S.appLayout(n)],
    ['outlines', (n) => S.outlines(n, [{ x: -1, y: 0.5, w: 2, h: 1 }, { x: -1, y: 0, w: 1.5, h: 0.1, kind: 'line' }])],
    ['compose', (n) => S.compose(n, [{ n: 300, gen: (k) => S.ring(k) }, { n: 400, gen: (k) => S.burst(k) }])],
    ['tint', (n) => S.tint(S.pearl(n), S.C.gold, 1.2, 0.5)],
  ];
  for (const [name, gen] of cases) {
    it(name, () => expectWellFormed(gen(N), N));
  }

  it('compose never overruns N when parts are larger than the cloud', () => {
    expectWellFormed(S.compose(500, [{ n: 400, gen: (k) => S.ring(k) }, { n: 400, gen: (k) => S.burst(k) }]), 500);
  });
});

describe('determinism and structure', () => {
  it('the same call gives the same shape', () => {
    const a = S.keys(N), b = S.keys(N);
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.col)).toEqual(Array.from(b.col));
  });

  it('ambient points stay in the plankton box and are dim', () => {
    const a = S.ambient(N);
    for (let i = 0; i < N; i++) {
      expect(Math.abs(a.pos[i * 3])).toBeLessThanOrEqual(3.2);
      expect(Math.abs(a.pos[i * 3 + 1])).toBeLessThanOrEqual(2.1);
      expect(Math.max(a.col[i * 3], a.col[i * 3 + 1], a.col[i * 3 + 2])).toBeLessThanOrEqual(0.32 + 1e-6);
    }
  });

  it('dark fill is black', () => {
    const r = S.ring(N, { dark: true, count: 100 });
    for (let i = 100; i < N; i++) expect(r.col[i * 3] + r.col[i * 3 + 1] + r.col[i * 3 + 2]).toBe(0);
  });

  it('ring lies on a flat disc of the requested radius', () => {
    const r = S.ring(N, { r: 0.9, y: -0.7, ambient: { bright: 0 } });
    for (let i = 0; i < N; i++) {
      const rad = Math.hypot(r.pos[i * 3], r.pos[i * 3 + 2]);
      expect(rad).toBeLessThanOrEqual(0.9 * 1.0125 + 1e-5);
    }
  });

  it('tint recolours lit points and leaves dark ones, sharing positions', () => {
    const src = S.ring(200, { dark: true, count: 50 });
    const t = S.tint(src, [1, 0, 0]);
    expect(t.pos).toBe(src.pos);
    expect(t.col).not.toBe(src.col);
    expect(t.col[1]).toBe(0);
    expect(t.col[0]).toBeGreaterThan(0);
    expect(t.col[60 * 3]).toBe(0);
  });

  it('put writes both position and colour', () => {
    const s = S.blank(2);
    S.put(s, 1, 1, 2, 3, [0.1, 0.2, 0.3]);
    expect(Array.from(s.pos)).toEqual([0, 0, 0, 1, 2, 3]);
    expect(Array.from(s.col).map((v) => +v.toFixed(2))).toEqual([0, 0, 0, 0.1, 0.2, 0.3]);
  });
});

/* a stand-in Canvas-2D surface: every pixel opaque, so the sampler returns a full grid */
function stubCanvas(): void {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 10 });
      if (prop === 'getImageData') {
        return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) });
      }
      if (typeof prop === 'string' && prop in target) return target[prop];
      return () => undefined; /* fillText, clearRect, stroke, beginPath, ... */
    },
    set(target, prop, value) { target[prop as string] = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  vi.stubGlobal('document', { ...(globalThis.document as object), createElement: () => canvas });
}

describe('canvas-backed shapes (2D context stubbed)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('without any canvas the sampled shapes fall back to ambient and do not throw', () => {
    /* the node test environment has no document.createElement */
    expectWellFormed(S.text(N, 'hello'), N);
    expectWellFormed(S.keyGlyph(N), N);
    expect(S.textPoints('x').pts).toEqual([]);
  });

  it('text returns exactly N points', () => {
    stubCanvas();
    expectWellFormed(S.text(N, 'ABC', { count: 600, dark: true }), N);
  });

  it('textPoints reports width in em units and a point grid', () => {
    stubCanvas();
    const { pts, w } = S.textPoints('ab', { px: 100, step: 10 });
    expect(pts.length).toBeGreaterThan(0);
    expect(w).toBeCloseTo((2 * 10 + 8) / 100, 5);
  });

  it('drawn / keyGlyph / orb with glyph return exactly N points', () => {
    stubCanvas();
    expectWellFormed(S.drawn(N, () => undefined, { w: 60, h: 60, step: 3 }), N);
    expectWellFormed(S.keyGlyph(N, { dark: true }), N);
    expectWellFormed(S.orb(N, { glyph: 'S' }), N);
  });
});
