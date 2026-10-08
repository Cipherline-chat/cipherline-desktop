/* ============================================================
   DotField: the shared point-cloud renderer for the onboarding.
   Typed port of the round-6 prototype (ob6/js/dots.js). Same look as
   the website's "glow in the deep" section: raw WebGL 1, additive soft
   sprites, one draw call for the points.

   Every particle carries a FROM and a TO position + colour. A morph
   blends them in the vertex shader (per-particle delay + a swim arc),
   so a shape change costs one buffer upload and nothing per frame.
   The CPU only sets a handful of uniforms each frame.

   Budget:
     - DPR capped at 1.5, one draw call, no per-frame CPU work per point
     - 60 fps while something moves (a morph, the pointer, a tween);
       30 fps while it only breathes; nothing once settled, nothing
       while the tab is hidden (see frameBudget.ts)
     - reduced motion: no drift, morphs jump, a frame only on change

   API (all coordinates are "world": roughly -1..1, y up):
     const f = createDotField(canvas, { count, reducedMotion })
     f.morph(shape, { ms, stagger, arc })   shape = { pos, col, size? }
     f.param(name, value, ms?)              tweened uniforms: offX offY
                                            scale yaw pitch spin follow
                                            repel bright fog drift cam px
     f.project([x, y, z]) -> { x, y }       CSS px, for DOM labels
     f.pulse(strength)                      a brief brightness swell
     const off = f.on('frame', fn)          off() unsubscribes
     f.destroy()                            releases EVERYTHING

   No globals, no network. Nothing touches the DOM / GL at import time.
   ============================================================ */
import { BREATHING_GAP_MS, frameBudget } from './frameBudget';

/** A point cloud: `pos`/`col` are 3 floats per point; `size` (optional) is 1 float per point. */
export interface Shape {
  pos: Float32Array;
  col: Float32Array;
  size?: Float32Array;
  n?: number;
  N?: number;
}

export type Vec3 = readonly [number, number, number];

export interface DotBackground {
  top: [number, number, number];
  bot: [number, number, number];
  glowC: [number, number, number];
  glow: [number, number, number];
}

export interface DotFieldOptions {
  /** number of particles (default 8000) */
  count?: number;
  /** transparent canvas: skip the background quad and clear to alpha 0 */
  transparent?: boolean;
  /** ms to keep breathing (30 fps) after the last motion before the loop stops (default 3500) */
  settle?: number;
  /** reduced motion: no drift, morphs/params jump, a frame only on change. Read once, at creation. */
  reducedMotion?: boolean;
  /** opaque-mode background gradient overrides */
  bg?: Partial<DotBackground>;
}

export interface MorphOptions {
  ms?: number;
  stagger?: number;
  arc?: number;
}

export type ParamName =
  | 'offX' | 'offY' | 'scale' | 'yaw' | 'pitch' | 'spin' | 'follow' | 'repel'
  | 'bright' | 'fog' | 'drift' | 'cam' | 'spinRate' | 'px';

export interface Projected {
  x: number;
  y: number;
  depth: number;
}

export type DotFieldEvent = 'frame';
export type FrameListener = (t: number) => void;

export interface DotField {
  readonly N: number;
  /** Blend the cloud into `shape` from wherever it currently is. Resolves when the morph time has elapsed. */
  morph(shape: Shape, o?: MorphOptions): Promise<void>;
  /** Jump to `shape` with no animation. */
  snap(shape: Shape): void;
  /** Set (ms = 0) or tween a camera/look parameter. Resolves when the tween ends. */
  param(name: ParamName, value: number, ms?: number): Promise<void>;
  /** Current value of a parameter. */
  get(name: ParamName): number;
  /** JS twin of the vertex projection: world point -> CSS px relative to the canvas. */
  project(v: Vec3): Projected;
  /** Override opaque-mode background colours. */
  bg(o: Partial<DotBackground>): void;
  /** A brief brightness swell. */
  pulse(strength?: number): void;
  /** Subscribe to the per-frame event; returns an unsubscribe function. */
  on(ev: DotFieldEvent, fn: FrameListener): () => void;
  /** Wake the loop (it stops by itself when settled). */
  kick(): void;
  /** pause(true) stops the loop and ignores the pointer; pause(false) resumes. */
  pause(v: boolean): void;
  /** True while a frame is scheduled. */
  readonly running: boolean;
  /** Alias of kick(). */
  draw(): void;
  /** Release the loop, every listener, all GL objects, and the context. Idempotent. */
  destroy(): void;
}

const VS = `
attribute vec3 aF; attribute vec3 aT; attribute vec3 aCF; attribute vec3 aCT; attribute vec4 aS;
uniform float uM; uniform float uStag; uniform float uArc; uniform float uT; uniform float uDrift;
uniform float uYaw; uniform float uPitch; uniform float uSpin; uniform float uAsp;
uniform vec2 uOff; uniform float uSc; uniform float uPx; uniform vec3 uMouse; uniform float uRepel;
uniform float uBright; uniform float uFog; uniform float uPulse; uniform float uCam;
varying vec3 vC;
float ease(float x){ return x < 0.5 ? 4.0*x*x*x : 1.0 - pow(-2.0*x + 2.0, 3.0)/2.0; }
void main(){
  float d = aS.x;
  float l = clamp((uM - d*uStag)/(1.0 - uStag), 0.0, 1.0);
  float e = ease(l);
  vec3 sw = normalize(vec3(sin(aS.z*91.7), cos(aS.z*53.1), sin(aS.z*27.3 + 1.0)) + 0.0001);
  vec3 p = mix(aF, aT, e) + sw*sin(l*3.14159)*uArc;
  vec3 c = mix(aCF, aCT, e);
  /* breathing: small, per-particle, never enough to blur a shape */
  p += vec3(sin(uT*0.9 + aS.z*40.0), cos(uT*0.7 + aS.z*23.0), sin(uT*0.6 + aS.z*11.0))*0.006*uDrift;
  /* camera: spin (auto) + yaw/pitch (pointer) */
  float yaw = uYaw + uSpin;
  float cy = cos(yaw), sy = sin(yaw);
  p *= uSc;
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  float cp = cos(uPitch), sp = sin(uPitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  float z = uCam - p.z;
  vec2 ndc = vec2(p.x*2.2/uAsp, p.y*2.2)/z + uOff;
  /* the cloud parts around the pointer */
  vec2 dm = (ndc - uMouse.xy)*vec2(uAsp, 1.0);
  float dl = length(dm);
  ndc += dm/max(dl, 0.001)*vec2(1.0/uAsp, 1.0)*uMouse.z*uRepel*0.07*(1.0 - smoothstep(0.0, 0.3, dl));
  gl_Position = vec4(ndc, 0.0, 1.0);
  float fog = mix(1.0, clamp(1.55 - z*0.2, 0.25, 1.0), uFog);
  float tw = 0.85 + 0.15*sin(uT*2.0 + aS.z*60.0)*uDrift;
  gl_PointSize = max(1.0, uPx*aS.y*uSc/z);
  vC = c*fog*tw*(uBright + uPulse*0.6);
}`;
const FS = `
precision mediump float;
varying vec3 vC;
void main(){
  vec2 q = gl_PointCoord*2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float a = exp(-r2*3.2)*0.55 + exp(-r2*16.0)*0.9;
  gl_FragColor = vec4(vC*a, 0.0);
}`;

const VS_BG = `attribute vec2 aP; void main(){ gl_Position = vec4(aP, 0.0, 1.0); }`;
const FS_BG = `
precision mediump float;
uniform vec2 uRes; uniform float uT; uniform vec3 uTop; uniform vec3 uBot; uniform vec3 uGlowC; uniform vec3 uGlow;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
void main(){
  vec2 uv = gl_FragCoord.xy/uRes; float asp = uRes.x/uRes.y;
  vec3 col = mix(uBot, uTop, smoothstep(0.0, 1.0, uv.y));
  vec2 g = (uv - uGlow.xy)*vec2(asp, 1.0);
  col += uGlowC*exp(-dot(g, g)*2.6)*uGlow.z;
  vec2 v = (uv - 0.5)*vec2(1.0, 1.2);
  col *= 1.0 - 0.55*dot(v, v);
  col += (h(gl_FragCoord.xy + fract(uT)*37.0) - 0.5)*(2.5/255.0);
  gl_FragColor = vec4(col, 1.0);
}`;

/* the same blend the vertex shader does, on the CPU, so a morph can
   start from wherever the previous one has got to without a jump */
const easeJS = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

interface TweenRec {
  from: number;
  to: number;
  t0: number;
  ms: number;
  res: () => void;
}

interface MorphWait {
  id: number;
  res: () => void;
}

type AttrRec = { name: string; loc: number; size: number };

/**
 * Create a field on `canvas`. Throws if WebGL is unavailable (or the canvas's
 * context was already lost by a previous field's destroy()); use
 * `tryCreateDotField` for a null instead.
 */
export function createDotField(canvas: HTMLCanvasElement, opts: DotFieldOptions = {}): DotField {
  const RM = !!opts.reducedMotion;
  const N = opts.count || 8000;
  const TRANSPARENT = !!opts.transparent;
  const SETTLE = opts.settle ?? 3500;

  const ctx = canvas.getContext('webgl', {
    antialias: false, alpha: TRANSPARENT, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!ctx) throw new Error('WebGL unavailable');
  const gl: WebGLRenderingContext = ctx;
  if (gl.isContextLost()) throw new Error('WebGL context lost: use a fresh canvas');

  /* ---- GL objects we own, so destroy() can release every one ---- */
  const shaders: WebGLShader[] = [];
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  let released = false;
  function releaseGl(): void {
    if (released) return;
    released = true;
    try {
      for (const b of buffers) gl.deleteBuffer(b);
      for (const p of programs) gl.deleteProgram(p);
      for (const s of shaders) gl.deleteShader(s);
      // NOT WEBGL_lose_context.loseContext(): on SwiftShader (headless, and
      // Electron on machines without GPU acceleration) it blocked the main
      // thread for 29-95 s at the end of onboarding. Shrinking the drawing
      // buffer frees the framebuffer memory at once; the context itself goes
      // with the canvas element when it is unmounted.
      canvas.width = 1; canvas.height = 1;
    } catch { /* context already gone */ }
    buffers.length = 0; programs.length = 0; shaders.length = 0;
  }

  function sh(type: number, src: string): WebGLShader {
    const s = gl.createShader(type);
    if (!s) throw new Error('createShader failed');
    shaders.push(s);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  }
  function program(vs: string, fs: string): WebGLProgram {
    const p = gl.createProgram();
    if (!p) throw new Error('createProgram failed');
    programs.push(p);
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    return p;
  }
  function makeBuffer(): WebGLBuffer {
    const b = gl.createBuffer();
    if (!b) throw new Error('createBuffer failed');
    buffers.push(b);
    return b;
  }

  /* everything after this point may throw (compile/link/alloc): release what exists, then rethrow */
  let bgProg!: WebGLProgram, prog!: WebGLProgram, bgBuf!: WebGLBuffer;
  const UB: Record<string, WebGLUniformLocation | null> = {};
  const U: Record<string, WebGLUniformLocation | null> = {};
  let bgLoc = -1;
  const buf: Record<string, WebGLBuffer> = {};
  const attrs: AttrRec[] = [];
  /* CPU mirrors of the attributes */
  const F = new Float32Array(N * 3), T = new Float32Array(N * 3);
  const CF = new Float32Array(N * 3), CT = new Float32Array(N * 3);
  const S = new Float32Array(N * 4);
  const BG: DotBackground = {
    top: [0.035, 0.11, 0.16], bot: [0.012, 0.02, 0.045], glowC: [0.06, 0.22, 0.26], glow: [0.66, 0.55, 0.9],
    ...(opts.bg || {}),
  };
  try {
    /* background quad */
    bgProg = program(VS_BG, FS_BG);
    bgBuf = makeBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const n of ['uRes', 'uT', 'uTop', 'uBot', 'uGlowC', 'uGlow']) UB[n] = gl.getUniformLocation(bgProg, n);
    bgLoc = gl.getAttribLocation(bgProg, 'aP');

    prog = program(VS, FS);
    gl.useProgram(prog);
    for (const n of ['uM', 'uStag', 'uArc', 'uT', 'uDrift', 'uYaw', 'uPitch', 'uSpin', 'uAsp', 'uOff', 'uSc', 'uPx', 'uMouse', 'uRepel', 'uBright', 'uFog', 'uPulse', 'uCam']) {
      U[n] = gl.getUniformLocation(prog, n);
    }

    let rs = 1234567;
    const rnd = (): number => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < N; i++) {
      S[i * 4] = rnd();                      // delay
      S[i * 4 + 1] = 0.6 + rnd() * 1.1;      // size
      S[i * 4 + 2] = rnd();                  // seed
      S[i * 4 + 3] = rnd();
    }
    const attr = (name: string, data: Float32Array, size: number): void => {
      const loc = gl.getAttribLocation(prog, name);
      attrs.push({ name, loc, size });
      const b = makeBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      buf[name] = b;
    };
    attr('aF', F, 3); attr('aT', T, 3); attr('aCF', CF, 3); attr('aCT', CT, 3); attr('aS', S, 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
  } catch (e) {
    releaseGl();
    throw e;
  }
  function upload(name: string, data: Float32Array): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf[name]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  const now = (): number => performance.now();
  let destroyed = false, lost = false;
  let raf = 0, lastDraw = 0, t = 0, lastTs = 0, pulse = 0, lastActive = now(), paused = false;

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
    if (!ms || RM) {
      p.v = value;
      const old = tweens.get(name); tweens.delete(name); if (old) old.res();
      kick();
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      const old = tweens.get(name); if (old) old.res();   /* a replaced tween must not leave its promise hanging */
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
      const sd = S[i * 4 + 2];
      let sx = Math.sin(sd * 91.7), sy = Math.cos(sd * 53.1), sz = Math.sin(sd * 27.3 + 1);
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const a = Math.sin(l * Math.PI) * mArc;
      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        outP[j] = F[j] + (T[j] - F[j]) * e + (k === 0 ? sx : k === 1 ? sy : sz) * a;
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
    upload('aF', F); upload('aT', T); upload('aCF', CF); upload('aCT', CT);
    if (shape.size) { for (let i = 0; i < N; i++) S[i * 4 + 1] = shape.size[i]; upload('aS', S); }
    mMs = RM ? 1 : (o.ms ?? 1400); mStag = o.stagger ?? 0.45; mArc = RM ? 0 : (o.arc ?? 0.3);
    mT0 = now(); mDone = false;
    kick();
    return new Promise<void>((res) => {
      const w: MorphWait = { id: 0, res };
      w.id = window.setTimeout(() => { morphWaits.delete(w); res(); }, mMs);
      morphWaits.add(w);
    });
  }
  function snap(shape: Shape): void {
    if (destroyed) return;
    const p = shape.pos.subarray(0, N * 3), c = shape.col.subarray(0, N * 3);
    T.set(p); CT.set(c); F.set(p); CF.set(c);
    upload('aF', F); upload('aT', T); upload('aCF', CF); upload('aCT', CT);
    mDone = true; kick();
  }

  /* ---- pointer ---- */
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, z: 0, tz: 0, moved: 0 };
  const onMove = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    mouse.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.ty = -(((e.clientY - r.top) / r.height) * 2 - 1);
    if (paused) return;
    mouse.tz = 1; mouse.moved = now(); kick();
  };
  const onLeave = (): void => { mouse.tz = 0; kick(); };
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);

  /* ---- size ---- */
  let W = 1, H = 1, dpr = 1;
  function resize(): void {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    kick();
  }
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(resize); ro.observe(canvas); }
  else window.addEventListener('resize', resize);
  resize();

  /* ---- loop ---- */
  const listeners = new Set<FrameListener>();
  function busy(): boolean {
    return !mDone || tweens.size > 0 || now() - mouse.moved < 1200 || pulse > 0.01
      || Math.abs(mouse.x - mouse.tx) + Math.abs(mouse.y - mouse.ty) > 0.002;
  }
  const camState = { yaw: 0, pitch: 0 };
  function budgetNow(isBusy: boolean) {
    return frameBudget({ busy: isBusy, sinceActiveMs: now() - lastActive, settleMs: SETTLE, hidden: document.hidden, paused, reducedMotion: RM });
  }
  function frame(ts: number): void {
    raf = 0;
    if (destroyed || lost || document.hidden || paused) return;
    const dtReal = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    const isBusy = busy();
    /* 30 fps while merely breathing */
    if (budgetNow(isBusy) === 30 && ts - lastDraw < BREATHING_GAP_MS) { raf = requestAnimationFrame(frame); return; }
    lastTs = ts; lastDraw = ts;
    if (!RM) t += dtReal;
    /* tweens */
    for (const [name, tw] of tweens) {
      const u = Math.min(1, (now() - tw.t0) / tw.ms);
      P[name].v = tw.from + (tw.to - tw.from) * easeJS(u);
      if (u >= 1) { tweens.delete(name); tw.res(); }
    }
    if (!mDone && progress() >= 1) mDone = true;
    /* pointer smoothing */
    const k = RM ? 1 : 1 - Math.pow(0.0015, dtReal);
    mouse.x += (mouse.tx - mouse.x) * k; mouse.y += (mouse.ty - mouse.y) * k; mouse.z += (mouse.tz - mouse.z) * k;
    P.spin.v += P.spinRate.v * dtReal;
    pulse *= Math.pow(0.02, dtReal);
    const fol = P.follow.v;
    const yaw = P.yaw.v + mouse.x * 0.42 * fol * mouse.z;
    const pitch = P.pitch.v - mouse.y * 0.22 * fol * mouse.z;

    /* background */
    if (TRANSPARENT) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); } else {
      gl.disable(gl.BLEND);
      gl.useProgram(bgProg);
      for (const a of attrs) gl.disableVertexAttribArray(a.loc);
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.enableVertexAttribArray(bgLoc); gl.vertexAttribPointer(bgLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(UB.uRes, canvas.width, canvas.height); gl.uniform1f(UB.uT, t);
      gl.uniform3fv(UB.uTop, BG.top); gl.uniform3fv(UB.uBot, BG.bot); gl.uniform3fv(UB.uGlowC, BG.glowC); gl.uniform3fv(UB.uGlow, BG.glow);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(bgLoc);
    }
    /* points */
    gl.useProgram(prog);
    for (const a of attrs) { gl.bindBuffer(gl.ARRAY_BUFFER, buf[a.name]); gl.enableVertexAttribArray(a.loc); gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0); }
    gl.enable(gl.BLEND);
    gl.uniform1f(U.uM, progress()); gl.uniform1f(U.uStag, mStag); gl.uniform1f(U.uArc, mArc);
    gl.uniform1f(U.uT, t); gl.uniform1f(U.uDrift, RM ? 0 : P.drift.v);
    gl.uniform1f(U.uYaw, yaw); gl.uniform1f(U.uPitch, pitch); gl.uniform1f(U.uSpin, P.spin.v);
    gl.uniform1f(U.uAsp, W / H); gl.uniform2f(U.uOff, P.offX.v, P.offY.v); gl.uniform1f(U.uSc, P.scale.v);
    gl.uniform1f(U.uPx, P.px.v * dpr * Math.min(W, H) / 900);
    gl.uniform3f(U.uMouse, mouse.x, mouse.y, mouse.z); gl.uniform1f(U.uRepel, RM ? 0 : P.repel.v);
    gl.uniform1f(U.uBright, P.bright.v); gl.uniform1f(U.uFog, P.fog.v); gl.uniform1f(U.uPulse, pulse);
    gl.uniform1f(U.uCam, P.cam.v);
    gl.drawArrays(gl.POINTS, 0, N);
    camState.yaw = yaw; camState.pitch = pitch;
    for (const fn of Array.from(listeners)) fn(t);
    const stillBusy = busy();
    if (stillBusy) lastActive = now();
    if (!destroyed && budgetNow(stillBusy) !== 'stop') raf = requestAnimationFrame(frame);
  }
  function kick(): void {
    if (destroyed) return;
    lastActive = now();
    if (!raf && !lost && !document.hidden && !paused) raf = requestAnimationFrame(frame);
  }
  const onVisibility = (): void => kick();
  document.addEventListener('visibilitychange', onVisibility);
  const onContextLost = (e: Event): void => {
    e.preventDefault(); lost = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  /* JS twin of the vertex projection, for DOM labels */
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
    canvas.removeEventListener('webglcontextlost', onContextLost);
    if (ro) { ro.disconnect(); ro = null; } else window.removeEventListener('resize', resize);
    /* nobody awaiting a tween / morph is left hanging */
    for (const tw of tweens.values()) tw.res();
    tweens.clear();
    for (const w of morphWaits) { window.clearTimeout(w.id); w.res(); }
    morphWaits.clear();
    listeners.clear();
    releaseGl();
  }

  return {
    N, morph, snap, param, project, destroy, kick,
    get: (n) => P[n].v,
    bg(o) { Object.assign(BG, o); kick(); },
    pulse(s = 1) { pulse = Math.max(pulse, s); kick(); },
    on(ev, fn) {
      if (ev !== 'frame') return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    pause(v) { paused = !!v; if (!v) kick(); else if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    get running() { return !!raf; },
    draw() { kick(); },
  };
}

/** Like createDotField, but returns null instead of throwing (no WebGL, context lost, shader failure). */
export function tryCreateDotField(canvas: HTMLCanvasElement, opts: DotFieldOptions = {}): DotField | null {
  try {
    return createDotField(canvas, opts);
  } catch (e) {
    console.warn('dots off', e);
    return null;
  }
}
