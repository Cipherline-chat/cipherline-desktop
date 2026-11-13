import { describe, expect, it } from 'vitest';
import {
  DOTS_RENDER_KEY, INK_THRESHOLD, MIN_INK_PIXELS, PROBE_CHECKPOINTS,
  cssRepairs, decideRenderPath, foldReadings, hasInk, readRememberedFallback, rememberFallback,
} from './renderVerify';

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
};

describe('hasInk', () => {
  it('is false for an all-zero buffer (drew nothing)', () => {
    expect(hasInk(new Uint8Array(4 * 1000))).toBe(false);
  });
  it('is true when enough pixels are lit, in any channel (alpha-0 additive rgb counts too)', () => {
    const b = new Uint8Array(4 * 1000);
    for (let i = 0; i < MIN_INK_PIXELS; i++) b[i * 4 + 1] = 200;
    expect(hasInk(b)).toBe(true);
    const a = new Uint8Array(4 * 1000);
    for (let i = 0; i < MIN_INK_PIXELS; i++) a[i * 4 + 3] = 200;
    expect(hasInk(a)).toBe(true);
  });
  it('negative control: a couple of hot pixels, or values at the threshold, are not a dot field', () => {
    const few = new Uint8Array(4 * 1000); few[0] = 255; few[4] = 255;
    expect(hasInk(few)).toBe(false);
    const dim = new Uint8Array(4 * 1000).fill(INK_THRESHOLD);
    expect(hasInk(dim)).toBe(false);
  });
});

describe('foldReadings', () => {
  it('lit at any checkpoint = drew, immediately', () => {
    expect(foldReadings([false, true], 1)).toBe('drew');
  });
  it('empty so far but checkpoints remain = keep waiting', () => {
    expect(foldReadings([false], 2)).toBeNull();
    expect(foldReadings([], 3)).toBeNull();
  });
  it('empty at every checkpoint = blank', () => {
    expect(foldReadings([false, false, false], 0)).toBe('blank');
  });
  it('has several checkpoints, first early', () => {
    expect(PROBE_CHECKPOINTS.length).toBeGreaterThan(1);
    expect(PROBE_CHECKPOINTS[0]).toBeLessThan(PROBE_CHECKPOINTS[PROBE_CHECKPOINTS.length - 1]);
  });
});

describe('decideRenderPath: drew / drew nothing / lost / threw', () => {
  it('drew -> stays on WebGL, verified', () => {
    expect(decideRenderPath({ verdict: 'drew' })).toEqual({ path: 'webgl', reason: 'verified' });
  });
  it('unknown readback never causes a fallback', () => {
    expect(decideRenderPath({ verdict: 'unknown' }).path).toBe('webgl');
  });
  it('drew nothing -> 2D (blank)', () => {
    expect(decideRenderPath({ verdict: 'blank' })).toEqual({ path: 'canvas2d', reason: 'blank' });
  });
  it('lost -> 2D', () => {
    expect(decideRenderPath({ lost: true })).toEqual({ path: 'canvas2d', reason: 'lost' });
  });
  it('threw -> 2D, and outranks the others', () => {
    expect(decideRenderPath({ threw: true, lost: true, verdict: 'drew' })).toEqual({ path: 'canvas2d', reason: 'threw' });
  });
  it('no WebGL at creation -> 2D', () => {
    expect(decideRenderPath({ noWebgl: true })).toEqual({ path: 'canvas2d', reason: 'no_webgl' });
  });
});

describe('persistence per app version', () => {
  it('a remembered fallback is honoured for the same version only', () => {
    const s = mem();
    expect(rememberFallback(s, '1.0.24', 'blank')).toBe(true);
    expect(readRememberedFallback(s, '1.0.24')).toBe('blank');
    expect(readRememberedFallback(s, '1.0.25')).toBeNull();   /* a new version retries WebGL */
  });
  it('negative controls: nothing stored, garbage, unknown reason, throwing store', () => {
    const s = mem();
    expect(readRememberedFallback(s, '1.0.24')).toBeNull();
    s.m.set(DOTS_RENDER_KEY, '{not json');
    expect(readRememberedFallback(s, '1.0.24')).toBeNull();
    s.m.set(DOTS_RENDER_KEY, JSON.stringify({ v: '1.0.24', r: 'verified' }));
    expect(readRememberedFallback(s, '1.0.24')).toBeNull();
    const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readRememberedFallback(boom, '1')).toBeNull();
    expect(rememberFallback(boom, '1', 'lost')).toBe(false);
    expect(readRememberedFallback(null, '1')).toBeNull();
    expect(rememberFallback(null, '1', 'lost')).toBe(false);
  });
  it('only bad reasons are ever stored (a healthy WebGL, a forced 2D leave no mark)', () => {
    const s = mem();
    for (const r of ['verified', 'forced', 'remembered', 'css_opacity'] as const) expect(rememberFallback(s, '1', r)).toBe(false);
    expect(s.m.size).toBe(0);
    for (const r of ['blank', 'lost', 'threw', 'no_webgl'] as const) expect(rememberFallback(s, '1', r)).toBe(true);
  });
});

describe('cssRepairs: never invisible because of CSS', () => {
  it('a field that should show but sits at opacity 0 is forced visible without a transition', () => {
    expect(cssRepairs(true, { opacity: 0, visibility: 'visible' })).toEqual({ opacity: '1', transition: 'none' });
  });
  it('visibility hidden is repaired too', () => {
    expect(cssRepairs(true, { opacity: 1, visibility: 'hidden' })).toEqual({ visibility: 'visible' });
  });
  it('NaN opacity counts as not shown', () => {
    expect(cssRepairs(true, { opacity: NaN, visibility: 'visible' })?.opacity).toBe('1');
  });
  it('negative controls: a healthy canvas, or one that is meant to be off, is left alone', () => {
    expect(cssRepairs(true, { opacity: 1, visibility: 'visible' })).toBeNull();
    expect(cssRepairs(false, { opacity: 0, visibility: 'hidden' })).toBeNull();
  });
});
