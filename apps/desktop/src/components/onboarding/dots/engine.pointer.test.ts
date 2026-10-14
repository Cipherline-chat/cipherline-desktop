/* The dot field's pointer behaviour, against a fake WebGL context (no GPU):
   - follow > 0: the pointer tilts the cloud (yaw/pitch uniforms follow it, left vs right);
   - follow = 0 (the old privacy wiring): it does not (negative control);
   - reduced motion: no tilt even with follow > 0, and the pointer wakes nothing;
   - pointer movement is camera-only: it never uploads a scene (no morph / snap),
     however many events arrive;
   - the frame budget still idles the loop once the pointer has been still. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDotField } from './engine';
import type { DotField } from './engine';
import { POINTER_REACTION, applyPointerReaction } from './pointerReaction';
import { burst } from './shapes';

const N = 64;
const W = 1000, H = 800;

type Handler = (e: unknown) => void;

interface Rig {
  field: DotField;
  gl: { uniforms: Map<string, number>; uploads: () => number; draws: () => number };
  pointer: (x: number, y: number) => void;
  runFrames: (n: number, stepMs?: number) => void;
  advance: (ms: number) => void;
  rafScheduled: () => boolean;
  rafRequests: () => number;
}

function makeRig(opts: { reducedMotion?: boolean } = {}): Rig {
  let clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);

  const winHandlers = new Map<string, Handler[]>();
  const rafQueue: Array<{ id: number; cb: (ts: number) => void }> = [];
  let rafId = 0, rafRequests = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => { rafId++; rafRequests++; rafQueue.push({ id: rafId, cb }); return rafId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { const i = rafQueue.findIndex((r) => r.id === id); if (i >= 0) rafQueue.splice(i, 1); });
  vi.stubGlobal('ResizeObserver', undefined);
  const win = {
    addEventListener: (t: string, h: Handler) => { winHandlers.set(t, [...(winHandlers.get(t) ?? []), h]); },
    removeEventListener: () => {},
    devicePixelRatio: 1,
    setTimeout: (fn: () => void) => { void fn; return 1; },
    clearTimeout: () => {},
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });

  const uniforms = new Map<string, number>();
  let uploads = 0, draws = 0;
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
      switch (prop) {
        case 'isContextLost': return () => false;
        case 'getShaderParameter': case 'getProgramParameter': return () => true;
        case 'getAttribLocation': return () => 0;
        case 'getUniformLocation': return (_p: unknown, name: string) => ({ name });
        case 'bufferSubData': return () => { uploads++; };
        case 'drawArrays': return () => { draws++; };
        case 'uniform1f': return (loc: { name: string }, v: number) => { uniforms.set(loc.name, v); };
        case 'getShaderInfoLog': case 'getProgramInfoLog': return () => '';
        default: return () => ({});
      }
    },
  });
  const canvas = {
    width: 0, height: 0,
    getContext: () => gl,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const field = createDotField(canvas as unknown as HTMLCanvasElement, { count: N, transparent: true, settle: 2600, reducedMotion: opts.reducedMotion });

  const runOne = (stepMs: number): void => {
    clock += stepMs;
    const q = rafQueue.splice(0);
    for (const r of q) r.cb(clock);
  };
  return {
    field,
    gl: { uniforms, uploads: () => uploads, draws: () => draws },
    pointer: (x, y) => { for (const h of winHandlers.get('pointermove') ?? []) h({ clientX: x, clientY: y }); },
    runFrames: (n, stepMs = 16) => { for (let i = 0; i < n; i++) runOne(stepMs); },
    advance: (ms) => { clock += ms; },
    rafScheduled: () => rafQueue.length > 0,
    rafRequests: () => rafRequests,
  };
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Settle a morph first so the only thing moving afterwards is the pointer. */
function settled(rig: Rig): void {
  rig.field.snap(burst(N));
  rig.runFrames(5);
}

describe('pointer-driven tilt (follow)', () => {
  it('follow = POINTER_REACTION.follow: yaw has opposite signs for a pointer at the right vs the left', async () => {
    const rig = makeRig();
    applyPointerReaction(rig.field, 0);
    settled(rig);
    rig.pointer(W * 0.95, H / 2); rig.runFrames(120);
    const yawRight = rig.gl.uniforms.get('uYaw')!;
    rig.pointer(W * 0.05, H / 2); rig.runFrames(120);
    const yawLeft = rig.gl.uniforms.get('uYaw')!;
    expect(yawRight).toBeGreaterThan(0.1);
    expect(yawLeft).toBeLessThan(-0.1);
    // 0.42 rad max at follow 1; the invite/privacy feel is 0.6 of that
    expect(Math.abs(yawRight)).toBeLessThan(0.42 * POINTER_REACTION.follow + 1e-6);
  });

  it('pitch follows the pointer\'s height too', () => {
    const rig = makeRig();
    applyPointerReaction(rig.field, 0);
    settled(rig);
    rig.pointer(W / 2, H * 0.05); rig.runFrames(120);
    const top = rig.gl.uniforms.get('uPitch')!;
    rig.pointer(W / 2, H * 0.95); rig.runFrames(120);
    const bottom = rig.gl.uniforms.get('uPitch')!;
    expect(top).toBeLessThan(-0.05);
    expect(bottom).toBeGreaterThan(0.05);
  });

  it('NEGATIVE CONTROL: with follow = 0 (the old privacy wiring) the cloud does not tilt', () => {
    const rig = makeRig();
    void rig.field.param('follow', 0, 0); void rig.field.param('repel', 0, 0);
    settled(rig);
    rig.pointer(W * 0.95, H / 2); rig.runFrames(120);
    expect(rig.gl.uniforms.get('uYaw')).toBe(0);
    expect(rig.gl.uniforms.get('uPitch')).toBeCloseTo(0, 10);
  });
});

describe('reduced motion', () => {
  it('no tilt even though follow > 0', () => {
    const rig = makeRig({ reducedMotion: true });
    applyPointerReaction(rig.field, 600);
    settled(rig);
    rig.pointer(W * 0.95, H / 2); rig.runFrames(60);
    expect(rig.gl.uniforms.get('uYaw')).toBe(0);
    expect(rig.gl.uniforms.get('uRepel')).toBe(0);
  });

  it('a pointer move does not even wake the loop', () => {
    const rig = makeRig({ reducedMotion: true });
    settled(rig);
    rig.runFrames(40);                       // let it go idle
    const before = rig.rafRequests();
    for (let i = 0; i < 50; i++) rig.pointer(10 + i * 15, 100 + i * 5);
    expect(rig.rafRequests()).toBe(before);
    expect(rig.rafScheduled()).toBe(false);
  });

  it('NEGATIVE CONTROL: the same moves DO wake a normal-motion field', () => {
    const rig = makeRig();
    settled(rig);
    rig.runFrames(400, 16);
    rig.advance(10_000);
    rig.runFrames(3);
    expect(rig.rafScheduled()).toBe(false);
    rig.pointer(500, 400);
    expect(rig.rafScheduled()).toBe(true);
  });
});

describe('pointer movement never restarts the scene', () => {
  it('uploads no buffers across hundreds of pointer events (no morph / snap / scene rebuild)', () => {
    const rig = makeRig();
    applyPointerReaction(rig.field, 600);
    void rig.field.morph(burst(N), { ms: 1500 });
    const afterMorph = rig.gl.uploads();
    expect(afterMorph).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) { rig.pointer((i * 37) % W, (i * 91) % H); if (i % 5 === 0) rig.runFrames(1); }
    rig.runFrames(30);
    expect(rig.gl.uploads()).toBe(afterMorph);
  });

  it('NEGATIVE CONTROL: a real morph does upload (the counter is live)', () => {
    const rig = makeRig();
    const before = rig.gl.uploads();
    void rig.field.morph(burst(N), { ms: 1500 });
    expect(rig.gl.uploads()).toBeGreaterThan(before);
  });

  it('does not reset a morph in flight: its progress uniform keeps advancing while the pointer moves', () => {
    const rig = makeRig();
    void rig.field.morph(burst(N), { ms: 1500 });
    rig.runFrames(10, 20);
    const p1 = rig.gl.uniforms.get('uM')!;
    for (let i = 0; i < 100; i++) rig.pointer((i * 53) % W, (i * 29) % H);
    rig.runFrames(10, 20);
    const p2 = rig.gl.uniforms.get('uM')!;
    expect(p1).toBeGreaterThan(0);
    expect(p2).toBeGreaterThan(p1);
  });
});

describe('frame budget is intact', () => {
  it('after the pointer goes still the loop idles (stops scheduling frames)', () => {
    const rig = makeRig();
    applyPointerReaction(rig.field, 0);
    settled(rig);
    rig.pointer(800, 300); rig.runFrames(60);
    expect(rig.rafScheduled()).toBe(true);
    // still pointer: settle window (2600 ms) passes, frames run, then it stops
    rig.advance(5000);
    rig.runFrames(5, 16);
    rig.advance(5000);
    rig.runFrames(5, 16);
    expect(rig.rafScheduled()).toBe(false);
    const draws = rig.gl.draws();
    rig.runFrames(20, 16);
    expect(rig.gl.draws()).toBe(draws);
  });

  it('pause(true) ignores the pointer entirely', () => {
    const rig = makeRig();
    applyPointerReaction(rig.field, 0);
    settled(rig);
    rig.field.pause(true);
    const before = rig.rafRequests();
    rig.pointer(900, 100);
    expect(rig.rafRequests()).toBe(before);
    expect(rig.rafScheduled()).toBe(false);
  });
});
