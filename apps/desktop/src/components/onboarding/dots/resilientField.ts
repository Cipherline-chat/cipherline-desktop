/* ============================================================
   The dot field the onboarding actually uses: WebGL when it works,
   the Canvas 2D fallback (canvasEngine.ts) when it does not.

     - WebGL context creation fails (no GPU / blocklisted / the shader
       will not compile): the 2D field is created instead, on the same
       canvas when it can still give a 2D context, otherwise on a twin
       canvas right next to it.
     - The WebGL context is LOST later (GPU process crash, driver reset):
       the dead WebGL field is released and a 2D field takes over on a
       twin canvas (a canvas that has held a WebGL context can never give
       a 2D one), carrying over the camera, the current scene (as its
       target, snapped), pause state and every frame listener.

   On a machine where WebGL works and stays up this is a transparent
   pass-through: every call goes straight to the WebGL field.

   The twin canvas is a shallow clone of the original (same class,
   same aria-hidden) inserted right after it; it follows the original's
   class attribute (React keeps toggling `on` / `over` there) and the
   original is hidden while the twin stands in. destroy() removes it.
   ============================================================ */
import { PARAM_NAMES, createDotField } from './engine';
import type {
  DotBackground, DotField, DotFieldOptions, FrameListener, MorphOptions, ParamName, Shape, Vec3,
} from './engine';
import { createCanvasDotField } from './canvasEngine';
import { decideRenderPath } from './renderVerify';
import type { DotsReason, ProbeVerdict, RenderOutcome } from './renderVerify';
import type { CanvasDotField, CanvasDotFieldOptions, CanvasFrameStats } from './canvasEngine';

export interface ResilientFieldOptions extends DotFieldOptions {
  /** Skip WebGL entirely (the dev harness's `&dots=2d`). */
  forceCanvas?: boolean;
  /** An earlier launch of this app version fell back (renderVerify.ts rememberFallback): start on 2D. */
  remembered?: DotsReason | null;
  /** Called once per path decision: 'verified' when WebGL's readback came back lit, or the reason for 2D. */
  onRender?: (o: RenderOutcome) => void;
  /** Options for the 2D fallback only. */
  canvas?: Pick<CanvasDotFieldOptions, 'startLevel' | 'fixedQuality' | 'onQuality'>;
}

/** The field, plus the 2D fallback's frame statistics (null while WebGL draws). */
export interface ResilientDotField extends DotField {
  stats(): CanvasFrameStats | null;
  resetStats(): void;
}

/** A canvas next to `canvas`, standing in for it until destroy(). */
function makeTwin(canvas: HTMLCanvasElement): { el: HTMLCanvasElement; release: () => void } | null {
  const parent = canvas.parentNode;
  if (!parent || typeof canvas.cloneNode !== 'function') return null;
  const el = canvas.cloneNode(false) as HTMLCanvasElement;
  el.removeAttribute('width'); el.removeAttribute('height');
  parent.insertBefore(el, canvas.nextSibling);
  const prevDisplay = canvas.style.display;
  canvas.style.display = 'none';
  let mo: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(() => { el.className = canvas.className; });
    mo.observe(canvas, { attributes: true, attributeFilter: ['class'] });
  }
  return {
    el,
    release() {
      mo?.disconnect(); mo = null;
      el.remove();
      canvas.style.display = prevDisplay;
    },
  };
}

function tryCanvas(canvas: HTMLCanvasElement, opts: ResilientFieldOptions): DotField | null {
  try { return createCanvasDotField(canvas, { ...opts, ...opts.canvas }); } catch { return null; }
}

/**
 * Create the field: WebGL first, the 2D fallback when WebGL is unavailable
 * or lost. Null only when neither can draw (no canvas support at all).
 */
export function createResilientDotField(canvas: HTMLCanvasElement, opts: ResilientFieldOptions = {}): ResilientDotField | null {
  let cur: DotField | null = null;
  let twin: { el: HTMLCanvasElement; release: () => void } | null = null;
  let destroyed = false;

  /* what a replacement field needs to pick up where the old one was */
  let lastShape: Shape | null = null;
  let bgOverride: Partial<DotBackground> | null = null;
  let paused = false;
  const listeners = new Set<FrameListener>();
  let unsubCur: (() => void) | null = null;
  const forward: FrameListener = (t) => { for (const fn of Array.from(listeners)) fn(t); };

  function adopt(f: DotField): void {
    cur = f;
    unsubCur = f.on('frame', forward);
  }

  function fallbackField(): DotField | null {
    /* the same canvas, when it never got a WebGL context; otherwise a twin */
    const same = tryCanvas(canvas, opts);
    if (same) return same;
    twin = makeTwin(canvas);
    if (!twin) return null;
    const f = tryCanvas(twin.el, opts);
    if (!f) { twin.release(); twin = null; }
    return f;
  }

  function report(o: RenderOutcome): void { try { opts.onRender?.(o); } catch { /* isolate */ } }

  /* WebGL is dead or useless (context lost, nothing drawn, a frame threw): hand over to a 2D field on a twin canvas */
  function fallBack(reason: DotsReason): void {
    if (destroyed || !cur || cur.renderer !== 'webgl') return;
    const old = cur;
    const camera = PARAM_NAMES.map((n) => [n, old.get(n)] as const);
    unsubCur?.(); unsubCur = null;
    cur = null;
    old.destroy();   /* resolves anything awaiting its tweens / morphs */
    console.warn(`dots: WebGL ${reason}, continuing with the 2D fallback`);
    twin = makeTwin(canvas);
    const f = twin ? tryCanvas(twin.el, opts) : null;
    if (!f) { twin?.release(); twin = null; return; }
    for (const [n, v] of camera) void f.param(n, v, 0);
    if (bgOverride) f.bg(bgOverride);
    if (lastShape) f.snap(lastShape);
    f.pause(paused);
    adopt(f);
    if (!paused) f.kick();
    report(decideRenderPath({ lost: reason === 'lost', threw: reason === 'threw', verdict: reason === 'blank' ? 'blank' : null }));
  }
  const onLost = (): void => fallBack('lost');
  const onVerdict = (v: ProbeVerdict): void => {
    if (v === 'blank') fallBack('blank');
    else if (v === 'drew') report(decideRenderPath({ verdict: 'drew' }));
  };

  let startReason: DotsReason | null = opts.forceCanvas ? 'forced' : opts.remembered ? 'remembered' : null;
  if (!startReason) {
    try {
      adopt(createDotField(canvas, {
        ...opts,
        onContextLost: () => onLost(),
        onFrameError: () => fallBack('threw'),
        verify: { onResult: onVerdict },
      }));
    } catch (e) {
      console.warn('dots: WebGL unavailable, using the 2D fallback', e);
      startReason = 'no_webgl';
    }
  }
  if (!cur) {
    const f = fallbackField();
    if (!f) { console.warn('dots off: neither WebGL nor Canvas 2D'); return null; }
    adopt(f);
    report({ path: 'canvas2d', reason: startReason ?? 'no_webgl' });
  }
  const first = cur as DotField | null;
  if (!first) return null;

  /* a dead field (between a loss and its replacement, or none at all) answers harmlessly */
  const resolved = Promise.resolve();
  const as2d = (): CanvasDotField | null => (cur && cur.renderer === 'canvas2d' ? cur as CanvasDotField : null);
  const field: ResilientDotField = {
    get N() { return cur?.N ?? first.N; },
    get renderer() { return cur?.renderer ?? first.renderer; },
    morph(shape: Shape, o?: MorphOptions) { lastShape = shape; return cur ? cur.morph(shape, o) : resolved; },
    snap(shape: Shape) { lastShape = shape; cur?.snap(shape); },
    param(name: ParamName, value: number, ms?: number) { return cur ? cur.param(name, value, ms) : resolved; },
    get(name: ParamName) { return cur ? cur.get(name) : first.get(name); },
    project(v: Vec3) { return cur ? cur.project(v) : { x: 0, y: 0, depth: 1 }; },
    bg(o: Partial<DotBackground>) { bgOverride = { ...(bgOverride || {}), ...o }; cur?.bg(o); },
    pulse(s?: number) { cur?.pulse(s); },
    on(ev, fn) {
      if (ev !== 'frame') return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    kick() { cur?.kick(); },
    pause(v: boolean) { paused = !!v; cur?.pause(v); },
    get running() { return !!cur?.running; },
    draw() { cur?.draw(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubCur?.(); unsubCur = null;
      cur?.destroy(); cur = null;
      listeners.clear();
      twin?.release(); twin = null;
    },
    stats() { return as2d()?.stats() ?? null; },
    resetStats() { as2d()?.resetStats(); },
  };
  return field;
}
