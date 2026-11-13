/* The Canvas 2D fallback of the dot field (canvasEngine.ts), against a fake
   2D context (no DOM), and the WebGL-loss / WebGL-unavailable switch
   (resilientField.ts):
   - it is light: a strided subset of the 7000 points, at most 30 fps
     while busy, nothing once settled, nothing while hidden / unfocused;
   - reduced motion: the WebGL rules (morph jumps, pointer wakes nothing);
   - project() is the WebGL engine's, so DOM tags line up the same;
   - too slow → fewer points → a still frame, which then only redraws on change;
   - the resilient field picks WebGL when it works, the 2D path when it does
     not, and swaps to 2D when the WebGL context is lost. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasDotField } from './canvasEngine';
import type { CanvasDotFieldOptions } from './canvasEngine';
import { createDotField } from './engine';
import { createResilientDotField } from './resilientField';
import { CANVAS_POINT_LEVELS, QUALITY_WINDOW } from './canvasQuality';
import { burst } from './shapes';
import { privacy } from './scenes';

const W = 1000, H = 800;
type Handler = (e: unknown) => void;

interface Env {
  clock: { v: number };
  winHandlers: Map<string, Handler[]>;
  docHandlers: Map<string, Handler[]>;
  doc: { hidden: boolean };
  rafQueue: Array<{ id: number; cb: (ts: number) => void }>;
  rafRequests: () => number;
  runOne: (stepMs: number) => void;
  timeouts: Array<() => void>;
}

function makeEnv(): Env {
  const clock = { v: 100_000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.v);
  const winHandlers = new Map<string, Handler[]>();
  const docHandlers = new Map<string, Handler[]>();
  const rafQueue: Env['rafQueue'] = [];
  const timeouts: Array<() => void> = [];
  let rafId = 0, rafRequests = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => { rafId++; rafRequests++; rafQueue.push({ id: rafId, cb }); return rafId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { const i = rafQueue.findIndex((r) => r.id === id); if (i >= 0) rafQueue.splice(i, 1); });
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('MutationObserver', undefined);
  const add = (m: Map<string, Handler[]>) => (t: string, h: Handler) => { m.set(t, [...(m.get(t) ?? []), h]); };
  const remove = (m: Map<string, Handler[]>) => (t: string, h: Handler) => { m.set(t, (m.get(t) ?? []).filter((x) => x !== h)); };
  vi.stubGlobal('window', {
    addEventListener: add(winHandlers), removeEventListener: remove(winHandlers), devicePixelRatio: 1,
    setTimeout: (fn: () => void) => { timeouts.push(fn); return timeouts.length; }, clearTimeout: () => {},
  });
  const doc = { hidden: false, addEventListener: add(docHandlers), removeEventListener: remove(docHandlers) };
  vi.stubGlobal('document', doc);
  /* sprites are painted into OffscreenCanvas */
  vi.stubGlobal('OffscreenCanvas', class {
    width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }; }
  });
  return {
    clock, winHandlers, docHandlers, doc, rafQueue, timeouts,
    rafRequests: () => rafRequests,
    runOne: (stepMs) => { clock.v += stepMs; const q = rafQueue.splice(0); for (const r of q) r.cb(clock.v); },
  };
}

interface Fake2d {
  draws: number;
  /** drawImage calls in the last frame (between two clearRects) */
  lastFrame: number;
  frames: number;
  /** ms of fake work per drawImage (advances the mocked clock) */
  costPerDraw: number;
}

function fake2dCanvas(env: Env, spy: Fake2d, opts: { webgl?: 'null' | 'throw' | 'ok' } = {}) {
  const listeners = new Map<string, Handler[]>();
  let current = 0;
  const ctx2d = {
    setTransform: () => {}, clearRect: () => { spy.frames++; spy.lastFrame = current; current = 0; }, fillRect: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: () => { spy.draws++; current++; env.clock.v += spy.costPerDraw; },
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '',
  };
  let mode: 'none' | '2d' | 'webgl' = 'none';
  const canvas = {
    width: 0, height: 0, dataset: {} as Record<string, string>, style: { display: '' }, className: 'ob-dots',
    getContext: (kind: string) => {
      if (kind === '2d') { if (mode === 'webgl') return null; mode = '2d'; return ctx2d; }
      if (opts.webgl === 'ok' && mode !== '2d') { mode = 'webgl'; return fakeGl(); }
      return null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== h)); },
    fire: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
  };
  return canvas;
}

const glUniforms = new Map<string, number>();
function fakeGl() {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
      switch (prop) {
        case 'isContextLost': return () => false;
        case 'getShaderParameter': case 'getProgramParameter': return () => true;
        case 'getAttribLocation': return () => 0;
        case 'getUniformLocation': return (_p: unknown, name: string) => ({ name });
        case 'uniform1f': return (loc: { name: string }, v: number) => { glUniforms.set(loc.name, v); };
        case 'getShaderInfoLog': case 'getProgramInfoLog': return () => '';
        default: return () => ({});
      }
    },
  });
}

function rig2d(o: CanvasDotFieldOptions = {}) {
  const env = makeEnv();
  const spy: Fake2d = { draws: 0, lastFrame: 0, frames: 0, costPerDraw: 0 };
  const canvas = fake2dCanvas(env, spy);
  const field = createCanvasDotField(canvas as unknown as HTMLCanvasElement, { count: 7000, transparent: true, settle: 2600, ...o });
  const pointer = (x: number, y: number) => { for (const h of env.winHandlers.get('pointermove') ?? []) h({ clientX: x, clientY: y }); };
  const run = (n: number, stepMs = 16) => { for (let i = 0; i < n; i++) env.runOne(stepMs); };
  return { env, spy, canvas, field, pointer, run };
}

beforeEach(() => { vi.restoreAllMocks(); glUniforms.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('canvas 2D fallback: light', () => {
  it('draws a strided subset of the 7000 points (at most the level-0 budget per frame)', () => {
    const { field, spy, run } = rig2d();
    expect(field.renderer).toBe('canvas2d');
    expect(field.N).toBe(7000);
    field.snap(privacy(7000, { receipts: true, playing: true, mobile: true }, null));
    run(1);
    expect(spy.frames).toBe(1);
    run(3);
    expect(spy.lastFrame).toBeGreaterThan(500);                       /* it really draws the scene */
    expect(spy.lastFrame).toBeLessThanOrEqual(CANVAS_POINT_LEVELS[0]);
  });

  it('caps at 30 fps while a morph runs (16 ms rAF ticks → a draw every other tick)', () => {
    const { field, spy, run } = rig2d();
    void field.morph(burst(7000), { ms: 3000 });
    run(60, 16);   /* ~1 s of 60 Hz ticks */
    expect(spy.frames).toBeGreaterThanOrEqual(25);
    expect(spy.frames).toBeLessThanOrEqual(32);
  });

  it('stops once settled: no frames scheduled, no draws', () => {
    const { field, spy, env, run } = rig2d();
    field.snap(burst(7000));
    run(5);
    env.clock.v += 5000; run(5);
    env.clock.v += 5000; run(5);
    expect(env.rafQueue.length).toBe(0);
    const f = spy.frames;
    run(30);
    expect(spy.frames).toBe(f);
  });

  it('draws nothing while the document is hidden, and resumes when shown', () => {
    const { field, spy, env, run } = rig2d();
    void field.morph(burst(7000), { ms: 3000 });
    run(4);
    env.doc.hidden = true;
    const f = spy.frames;
    run(30);
    expect(spy.frames).toBe(f);
    expect(env.rafQueue.length).toBe(0);
    env.doc.hidden = false;
    for (const h of env.docHandlers.get('visibilitychange') ?? []) h({});
    run(4);
    expect(spy.frames).toBeGreaterThan(f);
  });

  it('stops while the window is unfocused, and resumes on focus', () => {
    const { field, spy, env, run } = rig2d();
    void field.morph(burst(7000), { ms: 3000 });
    run(4);
    for (const h of env.winHandlers.get('blur') ?? []) h({});
    const f = spy.frames;
    run(30);
    expect(spy.frames).toBe(f);
    expect(env.rafQueue.length).toBe(0);
    for (const h of env.winHandlers.get('focus') ?? []) h({});
    run(4);
    expect(spy.frames).toBeGreaterThan(f);
  });

  it('pause(true) stops drawing and ignores the pointer', () => {
    const { field, spy, env, pointer, run } = rig2d();
    field.snap(burst(7000)); run(3);
    field.pause(true);
    const before = env.rafRequests();
    pointer(900, 100);
    run(10);
    expect(env.rafRequests()).toBe(before);
    expect(spy.frames).toBeGreaterThan(0);
  });
});

describe('canvas 2D fallback: reduced motion, exactly as WebGL', () => {
  it('a morph jumps: one or two frames, then the loop stops', () => {
    const { field, spy, env, run } = rig2d({ reducedMotion: true });
    void field.morph(burst(7000), { ms: 1500 });
    run(10);
    expect(spy.frames).toBeLessThanOrEqual(2);
    expect(env.rafQueue.length).toBe(0);
  });

  it('a pointer move does not wake the loop', () => {
    const { field, env, pointer, run } = rig2d({ reducedMotion: true });
    field.snap(burst(7000)); run(10);
    const before = env.rafRequests();
    for (let i = 0; i < 50; i++) pointer(10 + i * 15, 100 + i * 5);
    expect(env.rafRequests()).toBe(before);
  });

  it('a param tween jumps (resolves at once)', async () => {
    const { field } = rig2d({ reducedMotion: true });
    await field.param('scale', 1.7, 900);
    expect(field.get('scale')).toBe(1.7);
  });

  it('NEGATIVE CONTROL: the same pointer moves DO wake a normal-motion field', () => {
    const { field, env, pointer, run } = rig2d();
    field.snap(burst(7000)); run(5);
    env.clock.v += 10_000; run(3);
    expect(env.rafQueue.length).toBe(0);
    pointer(500, 400);
    expect(env.rafQueue.length).toBe(1);
  });
});

describe('canvas 2D fallback: tags line up exactly as with WebGL', () => {
  it('project() returns the WebGL engine\'s screen position for the same camera', () => {
    const env = makeEnv();
    const spy: Fake2d = { draws: 0, lastFrame: 0, frames: 0, costPerDraw: 0 };
    const c2 = fake2dCanvas(env, spy);
    const cg = fake2dCanvas(env, spy, { webgl: 'ok' });
    const f2 = createCanvasDotField(c2 as unknown as HTMLCanvasElement, { count: 64 });
    const fg = createDotField(cg as unknown as HTMLCanvasElement, { count: 64 });
    for (const f of [f2, fg]) {
      void f.param('offX', 0.31); void f.param('offY', -0.12); void f.param('scale', 0.83);
      void f.param('yaw', 0.2); void f.param('pitch', -0.1); void f.param('spin', 0.4); void f.param('cam', 3.4);
    }
    for (let i = 0; i < 4; i++) env.runOne(40);
    for (const v of [[0, 0, 0], [0.7, -0.3, 0.2], [-1.1, 0.9, -0.4]] as const) {
      const a = f2.project(v), b = fg.project(v);
      expect(a.x).toBeCloseTo(b.x, 6);
      expect(a.y).toBeCloseTo(b.y, 6);
    }
  });
});

describe('canvas 2D fallback: degrades when the machine cannot keep up', () => {
  it('slow frames → fewer points → a still frame', () => {
    const levels: unknown[] = [];
    const { field, spy, run } = rig2d({ onQuality: (q) => levels.push(q) });
    spy.costPerDraw = 0.05;   /* ~40+ ms of work per frame even at the smallest level: far over budget */
    field.snap(burst(7000));
    void field.morph(privacy(7000, { receipts: true, playing: true, mobile: true }, null), { ms: 600_000 });
    for (let i = 0; i < 12 && field.quality !== 'still'; i++) run(QUALITY_WINDOW * 2 + 4, 16);
    expect(levels.length).toBe(CANVAS_POINT_LEVELS.length);
    expect(levels[0]).toEqual({ level: 1, points: Math.ceil(7000 / Math.ceil(7000 / CANVAS_POINT_LEVELS[1])) });
    expect(field.quality).toBe('still');
  });

  it('still: the loop stops, the pointer wakes nothing, and a new scene is drawn once', () => {
    const { field, spy, env, pointer, run } = rig2d({ startLevel: 'still' });
    void field.morph(burst(7000), { ms: 1500 });
    run(10);
    expect(env.rafQueue.length).toBe(0);
    const f = spy.frames;
    expect(f).toBeLessThanOrEqual(2);
    const before = env.rafRequests();
    pointer(100, 100); pointer(900, 700);
    expect(env.rafRequests()).toBe(before);
    field.snap(privacy(7000, { receipts: true, playing: false, mobile: true }, null));
    run(10);
    expect(spy.frames).toBe(f + 1);
  });

  it('NEGATIVE CONTROL: cheap, on-time frames keep the full level', () => {
    const levels: unknown[] = [];
    const { field, run } = rig2d({ onQuality: (q) => levels.push(q) });
    field.snap(burst(7000));
    void field.morph(privacy(7000, { receipts: true, playing: true, mobile: true }, null), { ms: 600_000 });
    run(QUALITY_WINDOW * 8, 16);
    expect(levels).toEqual([]);
    expect(field.quality).toEqual({ level: 0, points: Math.ceil(7000 / Math.ceil(7000 / CANVAS_POINT_LEVELS[0])) });
  });
});

describe('resilient field: WebGL first, the 2D path when it is unavailable or lost', () => {
  /** give the fake canvas a parent, so the resilient field can put a twin next to it */
  function withParent<T extends { className: string }>(c: T, siblings: unknown[], twinFactory: () => unknown) {
    return Object.assign(c, {
      parentNode: { insertBefore: (el: unknown) => { siblings.push(el); } },
      cloneNode: () => twinFactory(),
    });
  }

  it('WebGL available → the WebGL engine (pass-through)', () => {
    const env = makeEnv();
    const spy: Fake2d = { draws: 0, lastFrame: 0, frames: 0, costPerDraw: 0 };
    const c = fake2dCanvas(env, spy, { webgl: 'ok' });
    const f = createResilientDotField(c as unknown as HTMLCanvasElement, { count: 64 });
    expect(f?.renderer).toBe('webgl');
    expect(f?.stats()).toBeNull();
  });

  it('getContext("webgl") returns null → the 2D fallback on the same canvas', () => {
    const env = makeEnv();
    const spy: Fake2d = { draws: 0, lastFrame: 0, frames: 0, costPerDraw: 0 };
    const c = fake2dCanvas(env, spy, { webgl: 'null' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = createResilientDotField(c as unknown as HTMLCanvasElement, { count: 7000, transparent: true });
    expect(f?.renderer).toBe('canvas2d');
    f!.snap(burst(7000));
    env.runOne(16);
    expect(spy.frames).toBe(1);
  });

  it('the WebGL context is lost → a 2D twin takes over with the camera, the scene and the listeners', () => {
    const env = makeEnv();
    const spy: Fake2d = { draws: 0, lastFrame: 0, frames: 0, costPerDraw: 0 };
    const twinSpy: Fake2d = { draws: 0, lastFrame: 0, frames: 0, costPerDraw: 0 };
    const siblings: unknown[] = [];
    const c = withParent(fake2dCanvas(env, spy, { webgl: 'ok' }), siblings,
      () => Object.assign(fake2dCanvas(env, twinSpy), { removeAttribute: () => {}, remove: () => {} }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = createResilientDotField(c as unknown as HTMLCanvasElement, { count: 7000, transparent: true })!;
    expect(f.renderer).toBe('webgl');
    let frames = 0;
    f.on('frame', () => { frames++; });
    void f.param('scale', 0.66); void f.param('offX', 0.4);
    f.snap(privacy(7000, { receipts: true, playing: true, mobile: false }, null));
    env.runOne(16);
    expect(frames).toBe(1);

    c.fire('webglcontextlost', { preventDefault: () => {} });
    expect(f.renderer).toBe('canvas2d');
    expect(siblings.length).toBe(1);
    expect(c.style.display).toBe('none');
    expect(f.get('scale')).toBeCloseTo(0.66);
    expect(f.get('offX')).toBeCloseTo(0.4);
    for (let i = 0; i < 3; i++) env.runOne(40);
    expect(twinSpy.frames).toBeGreaterThan(0);
    expect(twinSpy.lastFrame).toBeGreaterThan(500);   /* the scene came across */
    expect(frames).toBeGreaterThan(1);                /* so did the tag layer's listener */

    f.destroy();
    expect(c.style.display).toBe('');
  });
});
