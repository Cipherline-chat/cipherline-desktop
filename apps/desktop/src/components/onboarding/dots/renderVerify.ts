/* ============================================================
   "Did the dots actually get drawn?" - the decision layer behind the
   WebGL -> Canvas 2D switch (resilientField.ts), as pure functions.

   The fallback used to engage only when WebGL FAILED outright (no
   context, shader would not compile, context lost). Some Linux stacks
   report success and then show nothing, so the field now proves itself:

     - a few frames in, the engine reads the framebuffer back and asks
       `hasInk()` whether any pixel is lit (a "drew nothing" verdict is only
       given after every checkpoint came back empty);
     - a frame that throws, or a context that is lost, is a verdict too;
     - any bad verdict moves the field to Canvas 2D AND is remembered for
       this app version (`rememberFallback`), so the next launch starts on 2D
       without first showing an empty screen. A new version retries WebGL.

   readPixels proves the GPU rendered into the drawing buffer. It cannot see
   what the compositor then does with it, which is why engine.ts also writes
   VALID premultiplied colour (rgb <= alpha): see its fragment shader.
   ============================================================ */

export type DotsPath = 'webgl' | 'canvas2d';

/** Why a path was chosen. The `dots_render` call event carries this verbatim. */
export type DotsReason =
  | 'verified'      /* WebGL drew: pixels read back lit */
  | 'blank'         /* WebGL reported success but drew nothing */
  | 'lost'          /* the WebGL context was lost */
  | 'threw'         /* a frame (or the readback) threw */
  | 'no_webgl'      /* no WebGL context / shader failure at creation */
  | 'remembered'    /* an earlier launch of this version fell back */
  | 'forced'        /* the dev harness's &dots=2d */
  | 'css_opacity';  /* the canvas was shown but its opacity stayed down: repaired inline */

/** What the readback concluded. `unknown` = the readback itself was unavailable (never a reason to fall back). */
export type ProbeVerdict = 'drew' | 'blank' | 'unknown';

export interface RenderOutcome {
  path: DotsPath;
  reason: DotsReason;
}

/** Frame numbers (1-based, counted from the first drawn frame) at which the framebuffer is read back. */
export const PROBE_CHECKPOINTS: readonly number[] = [3, 24, 72];

/** A channel value above this counts as lit. Dots are additive glows; even their faintest core is well over it. */
export const INK_THRESHOLD = 6;

/** At least this many lit pixels (of ~2.3 M): a stray hot pixel from a broken driver is not a field of dots. */
export const MIN_INK_PIXELS = 24;

/** Any lit pixel in an RGBA8 buffer? Counts a pixel when any of r, g, b, a exceeds the threshold. */
export function hasInk(rgba: Uint8Array | Uint8ClampedArray, minPixels: number = MIN_INK_PIXELS, threshold: number = INK_THRESHOLD): boolean {
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i] > threshold || rgba[i + 1] > threshold || rgba[i + 2] > threshold || rgba[i + 3] > threshold) {
      if (++n >= minPixels) return true;
    }
  }
  return false;
}

/**
 * Fold the readbacks taken so far into a verdict. `readings` are the per-checkpoint
 * results in order (true = lit); `pending` = how many checkpoints are still to come.
 * Lit at any checkpoint = drew. Empty at all of them = blank. Otherwise keep waiting (null).
 */
export function foldReadings(readings: readonly boolean[], pending: number): ProbeVerdict | null {
  if (readings.some(Boolean)) return 'drew';
  if (pending <= 0 && readings.length > 0) return 'blank';
  return null;
}

/** The single decision: what to do given what happened. */
export function decideRenderPath(e: { verdict?: ProbeVerdict | null; lost?: boolean; threw?: boolean; noWebgl?: boolean }): RenderOutcome {
  if (e.noWebgl) return { path: 'canvas2d', reason: 'no_webgl' };
  if (e.threw) return { path: 'canvas2d', reason: 'threw' };
  if (e.lost) return { path: 'canvas2d', reason: 'lost' };
  if (e.verdict === 'blank') return { path: 'canvas2d', reason: 'blank' };
  return { path: 'webgl', reason: 'verified' };
}

/* ---- persistence: per app version ---- */

/** Install-local flag (not in backups: see backupRegistry.ts). */
export const DOTS_RENDER_KEY = 'cl_dots_render_v1';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** The remembered fallback reason for `version`, or null (nothing stored, another version, or garbage). */
export function readRememberedFallback(store: KeyValueStore | null | undefined, version: string): DotsReason | null {
  if (!store) return null;
  let raw: string | null = null;
  try { raw = store.getItem(DOTS_RENDER_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: unknown; r?: unknown };
    if (!o || typeof o !== 'object' || o.v !== version) return null;
    return o.r === 'blank' || o.r === 'lost' || o.r === 'threw' || o.r === 'no_webgl' ? o.r : null;
  } catch { return null; }
}

/** Remember that WebGL did not work for this version. Only the bad reasons are ever stored. */
export function rememberFallback(store: KeyValueStore | null | undefined, version: string, reason: DotsReason): boolean {
  if (!store) return false;
  if (reason !== 'blank' && reason !== 'lost' && reason !== 'threw' && reason !== 'no_webgl') return false;
  try { store.setItem(DOTS_RENDER_KEY, JSON.stringify({ v: version, r: reason })); return true; } catch { return false; }
}

/* ---- CSS: never invisible because of a stuck transition ---- */

export interface DotsCssFacts {
  opacity: number;
  visibility: string;
}

/**
 * Is the canvas, which should be showing, hidden by its own styles? The opacity (a transition stuck at 0,
 * an animation that never ran) and visibility are repaired; `display` is not touched, because the twin-canvas
 * swap in resilientField.ts hides the replaced canvas with it on purpose.
 * Returns the repairs to apply to the element's inline style, or null.
 */
export function cssRepairs(shouldShow: boolean, f: DotsCssFacts): Partial<Record<'opacity' | 'transition' | 'visibility', string>> | null {
  if (!shouldShow) return null;
  const r: Partial<Record<'opacity' | 'transition' | 'visibility', string>> = {};
  if (!(f.opacity >= 0.95)) { r.opacity = '1'; r.transition = 'none'; }
  if (f.visibility === 'hidden' || f.visibility === 'collapse') r.visibility = 'visible';
  return Object.keys(r).length ? r : null;
}
