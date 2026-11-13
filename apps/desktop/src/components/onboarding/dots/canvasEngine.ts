/* ============================================================
   Canvas 2D fallback for the dot field, for machines where WebGL is
   unavailable (a VM without 3D acceleration, Remote Desktop / "Microsoft
   Basic Render Driver", a GPU process that keeps crashing). Current
   Chromium no longer falls back to SwiftShader for WebGL, and turning
   that back on is a GPU-process security regression, so this draws the
   same field with plain 2D canvas instead.

   It implements the SAME DotField interface as engine.ts, with the same
   semantics, so every scene, morph, tag and the ending work unchanged on
   top of it:
     - the same 7000-point shapes go in (N is the field's count); every
       particle gets the same delay/size/seed as in WebGL (same LCG),
       and the vertex shader's maths (morph blend + swim arc, breathing,
       camera, pointer repel, fog, twinkle) runs here on the CPU
     - project() is the same JS projection, so DOM tags line up
     - the same tweened params, morph promises, pulse, frame events,
       pause(), kick(), destroy()

   What it does differently, to stay light on a CPU-only machine:
     - draws a strided subset of the points (canvasQuality.ts levels,
       2400 at most), each a little larger to keep the shapes' weight
     - the backing store is CSS-pixel sized (DPR 1), not up to 1.5x
     - at most 30 fps while something moves, 20 fps while it only
       breathes, nothing once settled (the same frameBudget() as WebGL)
     - stops while the document is hidden OR the window is unfocused
     - measures its own frame time and the actual frame rate; steps
       down a level when it cannot hold it, and as a last resort goes
       'still': a still frame of the current scene, redrawn only when
       the scene changes (morphs and tweens jump, like reduced motion)
     - reduced motion: exactly the WebGL rules (no drift, no twinkle,
       morphs/params jump, the pointer moves and wakes nothing, a frame
       only on change)

   The soft additive sprite is the fragment shader's falloff
   (exp(-r²·3.2)·0.55 + exp(-r²·16)·0.9), pre-rendered once per
   quantised hue and drawn with 'lighter' compositing.

   No globals, no network. Nothing touches the DOM at import time.
   ============================================================ */
import { BREATHING_GAP_MS, frameBudget } from './frameBudget';
import { effectiveFollow } from './pointerReaction';
import type {
  DotBackground, DotField, DotFieldOptions, FrameListener, MorphOptions, ParamName, Projected, Shape, Vec3,
} from './engine';
import { CANVAS_POINT_LEVELS, createQualityTracker, strideFor } from './canvasQuality';

/** Minimum gap between draws while something moves (30 fps). */
export const CANVAS_BUSY_GAP_MS = BREATHING_GAP_MS;
/** Minimum gap between draws while only breathing (20 fps). */
export const CANVAS_BREATHING_GAP_MS = 48;
/** Backing store pixels per CSS pixel (the WebGL engine uses DPR up to 1.5). */
export const CANVAS_RES = 1;
/** No quality judgement for this long after the field wakes. */
export const CANVAS_WARMUP_MS = 700;

export type CanvasQuality = { level: number; points: number } | 'still';

export interface CanvasDotFieldOptions extends DotFieldOptions {
  /** Start at this quality level (0 = most points); 'still' starts still. Tests / the dev harness. */
  startLevel?: number | 'still';
  /** Never step down (tests). */
  fixedQuality?: boolean;
  /** Told whenever the quality changes. */
  onQuality?: (q: CanvasQuality) => void;
}

export interface CanvasFrameStats {
  frames: number;
  /** mean / max of the field's own work per drawn frame (ms) */
  meanCostMs: number;
  maxCostMs: number;
  /** mean gap between back-to-back drawn frames (ms) */
  meanGapMs: number;
  quality: CanvasQuality;
}

export interface CanvasDotField extends DotField {
  readonly quality: CanvasQuality;
  /** Frame statistics since creation (or the last resetStats()). */
  stats(): CanvasFrameStats;
  resetStats(): void;
}

const easeJS = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface TweenRec { from: number; to: number; t0: number; ms: number; res: () => void }
interface MorphWait { id: number; res: () => void }

/* A strided subset draws each point larger, so lines and shells keep their
   weight (≈ √stride, capped), and a touch dimmer, so the overlaps that this
   creates do not over-brighten. Tuned against WebGL screenshots. */
const SUBSET_GROW = 0.9;
const SUBSET_GROW_MAX = 1.9;
const SUBSET_ALPHA = 0.9;

/* ---- sprites: one soft dot per quantised hue ---- */
const SPRITE_PX = 32;
const HUE_Q = 8;   /* levels per channel of the max-normalised colour */

type SpriteCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeSpriteCanvas(): SpriteCanvas | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(SPRITE_PX, SPRITE_PX);
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = SPRITE_PX; c.height = SPRITE_PX;
      return c;
    }
  } catch { /* no canvas */ }
  return null;
}

/** The fragment shader's falloff for r² in [0, 1]. */
export function dotFalloff(r2: number): number {
  return r2 > 1 ? 0 : Math.exp(-r2 * 3.2) * 0.55 + Math.exp(-r2 * 16) * 0.9;
}

function paintSprite(c: SpriteCanvas, nr: number, ng: number, nb: number): boolean {
  const g = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g || typeof g.createImageData !== 'function') return false;
  const img = g.createImageData(SPRITE_PX, SPRITE_PX);
  const d = img.data, h = SPRITE_PX / 2;
  for (let y = 0; y < SPRITE_PX; y++) {
    for (let x = 0; x < SPRITE_PX; x++) {
      const qx = (x + 0.5 - h) / h, qy = (y + 0.5 - h) / h;
      const a = dotFalloff(qx * qx + qy * qy);
      const r = Math.min(1, nr * a), gg = Math.min(1, ng * a), b = Math.min(1, nb * a);
      const al = Math.max(r, gg, b);
      const o = (y * SPRITE_PX + x) * 4;
      /* ImageData is un-premultiplied: store colour / alpha so the premultiplied result is (r, g, b) */
      d[o] = al > 0 ? Math.round(255 * r / al) : 0;
      d[o + 1] = al > 0 ? Math.round(255 * gg / al) : 0;
      d[o + 2] = al > 0 ? Math.round(255 * b / al) : 0;
      d[o + 3] = Math.round(255 * al);
    }
  }
  g.putImageData(img, 0, 0);
  return true;
}

/**
 * Create the 2D field on `canvas`. Throws if the canvas cannot give a 2D
 * context (for example because it already holds a WebGL one).
 */
export function createCanvasDotField(canvas: HTMLCanvasElement, opts: CanvasDotFieldOptions = {}): CanvasDotField {
  const RM = !!opts.reducedMotion;
  const N = opts.count || 8000;
  const TRANSPARENT = !!opts.transparent;
  const SETTLE = opts.settle ?? 3500;

  const ctx0 = canvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D | null;
  if (!ctx0) throw new Error('Canvas 2D unavailable');
  const ctx: CanvasRenderingContext2D = ctx0;

  /* ---- particles: the same attributes as the WebGL engine ---- */
  const F = new Float32Array(N * 3), T = new Float32Array(N * 3);
  const CF = new Float32Array(N * 3), CT = new Float32Array(N * 3);
  const S = new Float32Array(N * 4);
  const SW = new Float32Array(N * 3);   /* the swim direction, per particle (constant) */
  const BG: DotBackground = {
    top: [0.035, 0.11, 0.16], bot: [0.012, 0.02, 0.045], glowC: [0.06, 0.22, 0.26], glow: [0.66, 0.55, 0.9],
    ...(opts.bg || {}),
  };
  {
    let rs = 1234567;
    const rnd = (): number => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < N; i++) {
      S[i * 4] = rnd(); S[i * 4 + 1] = 0.6 + rnd() * 1.1; S[i * 4 + 2] = rnd(); S[i * 4 + 3] = rnd();
      const sd = S[i * 4 + 2];
      let sx = Math.sin(sd * 91.7), sy = Math.cos(sd * 53.1), sz = Math.sin(sd * 27.3 + 1);
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      SW[i * 3] = sx; SW[i * 3 + 1] = sy; SW[i * 3 + 2] = sz;
    }
  }

  /* ---- sprites (lazy, per quantised hue) ---- */
  const sprites: Array<SpriteCanvas | null | undefined> = new Array(HUE_Q * HUE_Q * HUE_Q);
  function spriteFor(r: number, g: number, b: number, m: number): SpriteCanvas | null {
    const qr = Math.min(HUE_Q - 1, Math.round(r / m * (HUE_Q - 1)));
    const qg = Math.min(HUE_Q - 1, Math.round(g / m * (HUE_Q - 1)));
    const qb = Math.min(HUE_Q - 1, Math.round(b / m * (HUE_Q - 1)));
    const k = (qr * HUE_Q + qg) * HUE_Q + qb;
    let s = sprites[k];
    if (s === undefined) {
      s = makeSpriteCanvas();
      if (s && !paintSprite(s, qr / (HUE_Q - 1), qg / (HUE_Q - 1), qb / (HUE_Q - 1))) s = null;
      sprites[k] = s;
    }
    return s;
  }

  const now = (): number => performance.now();
  let destroyed = false;
  let raf = 0, lastDraw = 0, t = 0, lastTs = 0, pulse = 0, lastActive = now(), paused = false, focused = true;
  /** hidden document or unfocused window: draw nothing */
  const off = (): boolean => document.hidden || !focused;

  /* ---- quality ---- */
  let still = opts.startLevel === 'still';
  let level = typeof opts.startLevel === 'number' ? Math.max(0, Math.min(CANVAS_POINT_LEVELS.length - 1, opts.startLevel)) : 0;
  let stride = strideFor(N, CANVAS_POINT_LEVELS[level]);
  const tracker = createQualityTracker();
  /* no judging for a moment after waking (shown, focused, resized): the first frames
     after a pause carry the page's own work (a step sliding in, React rendering) */
  let warmUntil = now() + CANVAS_WARMUP_MS;
  const warmUp = (): void => { tracker.reset(); warmUntil = now() + CANVAS_WARMUP_MS; };
  const quality = (): CanvasQuality => (still ? 'still' : { level, points: Math.ceil(N / stride) });
  /** reduced motion, or degraded to a still frame: no animation of any kind */
  const noMotion = (): boolean => RM || still;
  function stepDown(): void {
    if (opts.fixedQuality || still) return;
    if (level < CANVAS_POINT_LEVELS.length - 1) {
      level++;
      stride = strideFor(N, CANVAS_POINT_LEVELS[level]);
    } else {
      still = true;
      /* finish everything in flight: a still frame of where the scene is going */
      for (const [name, tw] of tweens) { P[name].v = tw.to; tw.res(); }
      tweens.clear();
      mDone = true;
      mArc = 0;
      mouse.x = mouse.tx; mouse.y = mouse.ty; mouse.z = 0; mouse.tz = 0;
      pulse = 0;
    }
    tracker.reset();
    markQuality();
    opts.onQuality?.(quality());
  }
  /* for the dev harness / devtools: which level is drawing */
  function markQuality(): void { if (canvas.dataset) canvas.dataset.dotsQuality = still ? 'still' : String(level); }
  markQuality();

  /* ---- stats ---- */
  let stFrames = 0, stCost = 0, stMax = 0, stGapN = 0, stGap = 0;
  const resetStats = (): void => { stFrames = 0; stCost = 0; stMax = 0; stGapN = 0; stGap = 0; };

  /* ---- tweened params ---- */
  const P: Record<ParamName, { v: number }> = {
    offX: { v: 0 }, offY: { v: 0 }, scale: { v: 1 }, yaw: { v: 0 }, pitch: { v: 0 },
    spin: { v: 0 }, follow: { v: 1 }, repel: { v: 1 }, bright: { v: 1 }, fog: { v: 1 },
    drift: { v: 1 }, cam: { v: 3.2 }, spinRate: { v: 0 }, px: { v: 11 },
  };
  const tweens = new Map<ParamName, TweenRec>();
  function param(name: ParamName, value: number, ms = 0): Promise<void> {
    const p = P[name];
    if (!p || destroyed) return Promise.resolve();
    if (!ms || noMotion()) {
      p.v = value;
      const old = tweens.get(name); tweens.delete(name); if (old) old.res();
      kick();
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      const old = tweens.get(name); if (old) old.res();
      tweens.set(name, { from: p.v, to: value, t0: now(), ms, res });
      kick();
    });
  }

  /* ---- morph state ---- */
  let mT0 = 0, mMs = 1, mStag = 0.45, mArc = 0.3, mDone = true;
  const morphWaits = new Set<MorphWait>();
  function progress(): number { return mDone ? 1 : Math.min(1, (now() - mT0) / mMs); }
  function currentInto(outP: Float32Array, outC: Float32Array): void {
    const m = progress();
    for (let i = 0; i < N; i++) {
      const l = Math.min(1, Math.max(0, (m - S[i * 4] * mStag) / (1 - mStag)));
      const e = easeJS(l);
      const a = Math.sin(l * Math.PI) * mArc;
      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        outP[j] = F[j] + (T[j] - F[j]) * e + SW[j] * a;
        outC[j] = CF[j] + (CT[j] - CF[j]) * e;
      }
    }
  }
  function morph(shape: Shape, o: MorphOptions = {}): Promise<void> {
    if (destroyed) return Promise.resolve();
    const nP = new Float32Array(N * 3), nC = new Float32Array(N * 3);
    currentInto(nP, nC);
    F.set(nP); CF.set(nC);
    T.set(shape.pos.subarray(0, N * 3));
    CT.set(shape.col.subarray(0, N * 3));
    if (shape.size) for (let i = 0; i < N; i++) S[i * 4 + 1] = shape.size[i];
    const nm = noMotion();
    /* the promise keeps the caller's timing either way (scenes are sequenced on it) */
    const waitMs = RM ? 1 : (o.ms ?? 1400);
    mMs = nm ? 1 : (o.ms ?? 1400); mStag = o.stagger ?? 0.45; mArc = nm ? 0 : (o.arc ?? 0.3);
    mT0 = now(); mDone = false;
    kick();
    return new Promise<void>((res) => {
      const w: MorphWait = { id: 0, res };
      w.id = window.setTimeout(() => { morphWaits.delete(w); res(); }, waitMs);
      morphWaits.add(w);
    });
  }
  function snap(shape: Shape): void {
    if (destroyed) return;
    const p = shape.pos.subarray(0, N * 3), c = shape.col.subarray(0, N * 3);
    T.set(p); CT.set(c); F.set(p); CF.set(c);
    mDone = true; kick();
  }

  /* ---- pointer ---- */
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, z: 0, tz: 0, moved: 0 };
  const onMove = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    mouse.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.ty = -(((e.clientY - r.top) / r.height) * 2 - 1);
    if (paused || noMotion()) return;
    mouse.tz = 1; mouse.moved = now(); kick();
  };
  const onLeave = (): void => { if (noMotion()) return; mouse.tz = 0; kick(); };
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);

  /* ---- size (CSS-pixel backing store) ---- */
  let W = 1, H = 1;
  function resize(): void {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    const cw = Math.max(1, Math.round(W * CANVAS_RES)), ch = Math.max(1, Math.round(H * CANVAS_RES));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    warmUp();
    kick();
  }
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(resize); ro.observe(canvas); }
  else window.addEventListener('resize', resize);
  resize();

  /* ---- loop ---- */
  const listeners = new Set<FrameListener>();
  function busy(): boolean {
    if (still) return !mDone || tweens.size > 0;
    return !mDone || tweens.size > 0 || now() - mouse.moved < 1200 || pulse > 0.01
      || Math.abs(mouse.x - mouse.tx) + Math.abs(mouse.y - mouse.ty) > 0.002;
  }
  const camState = { yaw: 0, pitch: 0 };
  function budgetNow(isBusy: boolean) {
    return frameBudget({ busy: isBusy, sinceActiveMs: now() - lastActive, settleMs: SETTLE, hidden: off(), paused, reducedMotion: noMotion() });
  }
  /** the previous frame was drawn and the next requested right away (so the gap between them is meaningful) */
  let backToBack = false, lastGapWanted = CANVAS_BUSY_GAP_MS;

  function draw(yaw: number, pitch: number): void {
    const cw = canvas.width, ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (TRANSPARENT) ctx.clearRect(0, 0, cw, ch);
    else {
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      const css = (c: readonly number[]) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
      g.addColorStop(0, css(BG.top)); g.addColorStop(1, css(BG.bot));
      ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
    }
    ctx.globalCompositeOperation = 'lighter';

    const m = progress(), stag = mStag, arc = mArc;
    const drift = noMotion() ? 0 : P.drift.v;
    const sc = P.scale.v, cam = P.cam.v, asp = W / H;
    const offX = P.offX.v, offY = P.offY.v;
    const cy = Math.cos(yaw + P.spin.v), sy = Math.sin(yaw + P.spin.v);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    /* the shader's uPx (device px of the point), at DPR 1; a strided subset draws each point a bit larger */
    const pxBase = P.px.v * (cw / W) * Math.min(W, H) / 900 * Math.min(SUBSET_GROW_MAX, Math.sqrt(stride) * SUBSET_GROW);
    const mx = mouse.x, my = mouse.y, mz = mouse.z, repel = noMotion() ? 0 : P.repel.v;
    const fogK = P.fog.v, lum = P.bright.v + pulse * 0.6;
    const st = stride;

    for (let i = 0; i < N; i += st) {
      const i3 = i * 3, i4 = i * 4;
      const l = Math.min(1, Math.max(0, (m - S[i4] * stag) / (1 - stag)));
      const e = l >= 1 ? 1 : easeJS(l);
      let r = CF[i3] + (CT[i3] - CF[i3]) * e;
      let g = CF[i3 + 1] + (CT[i3 + 1] - CF[i3 + 1]) * e;
      let b = CF[i3 + 2] + (CT[i3 + 2] - CF[i3 + 2]) * e;
      const cm0 = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (cm0 < 0.004) continue;
      const a = arc ? Math.sin(l * Math.PI) * arc : 0;
      let px = F[i3] + (T[i3] - F[i3]) * e + SW[i3] * a;
      let py = F[i3 + 1] + (T[i3 + 1] - F[i3 + 1]) * e + SW[i3 + 1] * a;
      let pz = F[i3 + 2] + (T[i3 + 2] - F[i3 + 2]) * e + SW[i3 + 2] * a;
      const seed = S[i4 + 2];
      if (drift) {
        px += Math.sin(t * 0.9 + seed * 40) * 0.006 * drift;
        py += Math.cos(t * 0.7 + seed * 23) * 0.006 * drift;
        pz += Math.sin(t * 0.6 + seed * 11) * 0.006 * drift;
      }
      px *= sc; py *= sc; pz *= sc;
      const x1 = cy * px + sy * pz, z1 = -sy * px + cy * pz;
      const y2 = cp * py - sp * z1, z2 = sp * py + cp * z1;
      const z = cam - z2;
      if (z <= 0.05) continue;
      let nx = (x1 * 2.2 / asp) / z + offX, ny = (y2 * 2.2) / z + offY;
      if (mz > 0.001 && repel) {
        const dx = (nx - mx) * asp, dy = ny - my;
        const dl = Math.hypot(dx, dy);
        const k = mz * repel * 0.07 * (1 - smoothstep(0, 0.3, dl)) / Math.max(dl, 0.001);
        if (k) { nx += dx * k / asp; ny += dy * k; }
      }
      let size = Math.max(1, pxBase * S[i4 + 1] * sc / z);
      const sx = (nx + 1) / 2 * cw, syy = (1 - ny) / 2 * ch;
      if (sx < -size || sx > cw + size || syy < -size || syy > ch + size) continue;
      const fog = 1 + (Math.min(1, Math.max(0.25, 1.55 - z * 0.2)) - 1) * fogK;
      const tw = 0.85 + 0.15 * Math.sin(t * 2 + seed * 60) * drift;
      const k = fog * tw * lum;
      r *= k; g *= k; b *= k;
      const cm = cm0 * k;
      if (cm < 0.004) continue;
      const spr = spriteFor(r, g, b, cm);
      if (!spr) continue;
      /* brighter than full: the GPU's additive overlap saturates; here a slightly larger glow */
      if (cm > 1) size *= Math.min(1.35, Math.sqrt(cm));
      const al = cm * SUBSET_ALPHA;
      ctx.globalAlpha = al > 1 ? 1 : al;
      ctx.drawImage(spr as CanvasImageSource, sx - size / 2, syy - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(ts: number): void {
    raf = 0;
    if (destroyed || off() || paused) { backToBack = false; return; }
    const isBusy = busy();
    const budget = budgetNow(isBusy);
    const gapWanted = budget === 60 ? CANVAS_BUSY_GAP_MS : CANVAS_BREATHING_GAP_MS;
    if (budget !== 'stop' && lastDraw && ts - lastDraw < gapWanted) { raf = requestAnimationFrame(frame); return; }
    const gap = lastDraw ? ts - lastDraw : 0;
    const dtReal = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts; lastDraw = ts;
    if (!noMotion()) t += dtReal;
    for (const [name, tw] of tweens) {
      const u = Math.min(1, (now() - tw.t0) / tw.ms);
      P[name].v = tw.from + (tw.to - tw.from) * easeJS(u);
      if (u >= 1) { tweens.delete(name); tw.res(); }
    }
    if (!mDone && progress() >= 1) mDone = true;
    const kk = noMotion() ? 1 : 1 - Math.pow(0.0015, dtReal);
    mouse.x += (mouse.tx - mouse.x) * kk; mouse.y += (mouse.ty - mouse.y) * kk; mouse.z += (mouse.tz - mouse.z) * kk;
    if (!noMotion()) P.spin.v += P.spinRate.v * dtReal;
    pulse *= Math.pow(0.02, dtReal);
    const fol = effectiveFollow(P.follow.v, noMotion());
    const yaw = P.yaw.v + mouse.x * 0.42 * fol * mouse.z;
    const pitch = P.pitch.v - mouse.y * 0.22 * fol * mouse.z;

    const c0 = now();
    draw(yaw, pitch);
    camState.yaw = yaw; camState.pitch = pitch;
    const cost = now() - c0;
    for (const fn of Array.from(listeners)) fn(t);

    stFrames++; stCost += cost; if (cost > stMax) stMax = cost;
    const lateness = backToBack && gap > 0 ? gap / lastGapWanted : null;
    if (lateness !== null) { stGapN++; stGap += gap; }
    if (!noMotion() && now() >= warmUntil && tracker.push(cost, lateness) === 'down') stepDown();

    const stillBusy = busy();
    if (stillBusy) lastActive = now();
    const next = budgetNow(stillBusy);
    if (!destroyed && next !== 'stop') {
      raf = requestAnimationFrame(frame);
      backToBack = true;
      lastGapWanted = next === 60 ? CANVAS_BUSY_GAP_MS : CANVAS_BREATHING_GAP_MS;
    } else backToBack = false;
  }
  function kick(): void {
    if (destroyed) return;
    lastActive = now();
    if (!raf && !off() && !paused) raf = requestAnimationFrame(frame);
  }
  const onVisibility = (): void => { backToBack = false; warmUp(); kick(); };
  const onBlur = (): void => { focused = false; backToBack = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  const onFocus = (): void => { focused = true; warmUp(); kick(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  /* a 2D canvas can lose its backing store under memory pressure; it comes back by itself, redraw then */
  const onRestored = (): void => kick();
  canvas.addEventListener('contextrestored', onRestored);

  function project(v: Vec3): Projected {
    const sc = P.scale.v;
    let x = v[0] * sc, y = v[1] * sc, z = v[2] * sc;
    const yaw = camState.yaw + P.spin.v, cy = Math.cos(yaw), sy = Math.sin(yaw);
    [x, z] = [cy * x + sy * z, -sy * x + cy * z];
    const cp = Math.cos(camState.pitch), sp = Math.sin(camState.pitch);
    [y, z] = [cp * y - sp * z, sp * y + cp * z];
    const zz = P.cam.v - z;
    const nx = (x * 2.2 / (W / H)) / zz + P.offX.v, ny = (y * 2.2) / zz + P.offY.v;
    return { x: (nx + 1) / 2 * W, y: (1 - ny) / 2 * H, depth: zz };
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    canvas.removeEventListener('contextrestored', onRestored);
    if (ro) { ro.disconnect(); ro = null; } else window.removeEventListener('resize', resize);
    for (const tw of tweens.values()) tw.res();
    tweens.clear();
    for (const w of morphWaits) { window.clearTimeout(w.id); w.res(); }
    morphWaits.clear();
    listeners.clear();
    sprites.fill(undefined);
    try { canvas.width = 1; canvas.height = 1; } catch { /* gone */ }
    if (canvas.dataset) delete canvas.dataset.dotsQuality;
  }

  return {
    N, renderer: 'canvas2d', morph, snap, param, project, destroy, kick,
    get: (n) => P[n].v,
    bg(o) { Object.assign(BG, o); kick(); },
    /* as in WebGL, a pulse plays under reduced motion too (a brightness swell, not motion); never when still */
    pulse(s = 1) { if (!still) pulse = Math.max(pulse, s); kick(); },
    on(ev, fn) {
      if (ev !== 'frame') return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    pause(v) { paused = !!v; backToBack = false; if (!v) { warmUp(); kick(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    get running() { return !!raf; },
    draw() { kick(); },
    get quality() { return quality(); },
    stats() {
      return { frames: stFrames, meanCostMs: stFrames ? stCost / stFrames : 0, maxCostMs: stMax, meanGapMs: stGapN ? stGap / stGapN : 0, quality: quality() };
    },
    resetStats,
  };
}
