import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sc from './scenes';
import * as S from './shapes';
import type { PointShape } from './shapes';

const N = 7000;

function expectWellFormed(sh: PointShape, n: number): void {
  expect(sh.pos.length).toBe(n * 3);
  expect(sh.col.length).toBe(n * 3);
  expect(sh.pos.every(Number.isFinite)).toBe(true);
  expect(sh.col.every(Number.isFinite)).toBe(true);
  expect(sh.col.every((v) => v >= 0)).toBe(true);
}

/* every pixel opaque, so sampled glyphs/icons produce a full grid of points */
function stubCanvas(): void {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 10 });
      if (prop === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) });
      if (typeof prop === 'string' && prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop, value) { target[prop as string] = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  vi.stubGlobal('document', { ...(globalThis.document as object), createElement: () => canvas });
  vi.stubGlobal('Path2D', class FakePath2D {});
}

describe('scene helpers', () => {
  it('stitch concatenates parts and fills the rest with ambient up to exactly N', () => {
    const a = S.ring(300, { dark: true }), b = S.burst(200);
    const out = Sc.stitch(N, [a, b]);
    expectWellFormed(out, N);
    expect(Array.from(out.pos.subarray(0, 900))).toEqual(Array.from(a.pos));
    expect(Array.from(out.pos.subarray(900, 1500))).toEqual(Array.from(b.pos));
  });

  it('stitch truncates when the parts exceed N', () => {
    expectWellFormed(Sc.stitch(250, [S.ring(200), S.burst(200)]), 250);
  });

  it('shift translates every point in place and returns the same shape', () => {
    const s = S.blank(3);
    S.put(s, 0, 1, 1, 1, [0, 0, 0]);
    const out = Sc.shift(s, 1, -2, 0.5);
    expect(out).toBe(s);
    expect(Array.from(s.pos.subarray(0, 3))).toEqual([2, -1, 1.5]);
    /* untouched slots move too (blank points sit at the origin) */
    expect(Array.from(s.pos.subarray(3, 6))).toEqual([1, -2, 0.5]);
  });

  it('ball, lattice and segment return exactly their point counts', () => {
    expectWellFormed(Sc.ball(500, 0.42, Sc.COL.pearl, 0.16), 500);
    expectWellFormed(Sc.lattice(700, 0.64, Sc.COL.lume), 700);
    expectWellFormed(Sc.segment(300, [0, 0, 0], [1, 1], Sc.COL.gold, 1, { sag: 0.1, dash: 7 }), 300);
  });

  it('lattice points sit on the shell radius (within the 1% jitter)', () => {
    const l = Sc.lattice(800, 0.64, Sc.COL.lume);
    for (let i = 0; i < 800; i++) {
      const r = Math.hypot(l.pos[i * 3], l.pos[i * 3 + 1], l.pos[i * 3 + 2]);
      expect(r).toBeGreaterThan(0.64 * 0.99 - 1e-5);
      expect(r).toBeLessThan(0.64 * 1.01 + 1e-5);
    }
  });

  it('lattice is deterministic', () => {
    expect(Array.from(Sc.lattice(300, 1, Sc.COL.lume).pos)).toEqual(Array.from(Sc.lattice(300, 1, Sc.COL.lume).pos));
  });

  it('PAIR_X matches the orb separation used by pair()', () => {
    expect(Sc.PAIR_X).toBe(0.66);
  });
});

describe('privacyAnchors', () => {
  it('gives an anchor per satellite plus the key, all finite', () => {
    const a = Sc.privacyAnchors({ receipts: true, playing: true, mobile: true });
    expect(Object.keys(a).sort()).toEqual(['key', 'mobile', 'playing', 'receipts']);
    for (const v of Object.values(a)) { expect(v).toHaveLength(3); expect(v.every(Number.isFinite)).toBe(true); }
    expect(a.key).toEqual([0, -0.3, 0.3]);
  });
});

describe('scenes that sample a canvas (2D context stubbed)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('privacy returns exactly N points in every toggle combination', () => {
    stubCanvas();
    for (const receipts of [true, false]) for (const mobile of [true, false]) {
      expectWellFormed(Sc.privacy(N, { receipts, playing: !receipts, mobile, capture: false, pin: false }, null), N);
    }
    expectWellFormed(Sc.privacy(N, { receipts: true, playing: true, mobile: true }, 'receipts'), N);
  });

  it('privacy also works with no canvas at all (ambient fallback)', () => {
    expectWellFormed(Sc.privacy(N, { receipts: true, playing: true, mobile: true }, null), N);
  });

  it('pair returns exactly N points for the joined, waiting and referral layouts', () => {
    stubCanvas();
    const me = { glyph: 'D', color: Sc.COL.lume }, friend = { glyph: 'K', color: Sc.COL.ice };
    expectWellFormed(Sc.pair(N, me, null, false), N);
    expectWellFormed(Sc.pair(N, me, friend, true), N);
    expectWellFormed(Sc.pair(N, friend, me, true), N);
  });

  it('codeText and icon return exactly their counts', () => {
    stubCanvas();
    expectWellFormed(Sc.codeText(N, 'SAM123'), N);
    expectWellFormed(Sc.icon(640, ['M0 0h24'], { size: 0.46 }), 640);
  });
});
