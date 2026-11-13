/* ============================================================
   Runtime quality ladder for the Canvas 2D fallback of the dot field
   (canvasEngine.ts), factored out as pure functions so the policy is
   unit-testable without a canvas.

   The fallback runs only where WebGL is unavailable, which in practice
   means no GPU at all (a VM without 3D acceleration, Remote Desktop's
   "Microsoft Basic Render Driver"): every pixel is rasterised by the
   CPU. So it measures itself while it moves and steps down:

     level 0..n-1   fewer points each step (CANVAS_POINT_LEVELS)
     'still'        no animation at all: a still frame of the current
                    scene, redrawn only when the scene changes

   A level is judged over a window of frames drawn back to back. It steps
   down when EITHER the field's own per-frame work is too expensive OR the
   frames it asked for arrive far too late (the browser could not keep
   up, whatever the reason: raster, compositing, the rest of the page),
   in QUALITY_STRIKES windows in a row. The engine also feeds it nothing
   for a short warm-up after it wakes (shown, focused, resized).
   ============================================================ */

/** How many of the field's points the 2D path draws at each level. */
export const CANVAS_POINT_LEVELS = [2400, 1500, 900] as const;

/** Frames per judgement window. */
export const QUALITY_WINDOW = 24;
/** Median own work per frame above this (ms) = too expensive. */
export const QUALITY_MAX_COST_MS = 14;
/** Median (actual gap / intended gap) above this = the frame rate is not being held. 30 fps → below ~18 fps. */
export const QUALITY_MAX_LATENESS = 1.65;
/** Consecutive bad windows before a step down (~1.6 s of sustained slowness at 30 fps), so a
 *  one-off burst (a step's entrance, React rendering the next screen, a GC) never costs a level. */
export const QUALITY_STRIKES = 2;

export type QualityVerdict = 'keep' | 'down';

/** Draw every `stride`-th point so at most `maxPoints` are drawn (stride ≥ 1). */
export function strideFor(n: number, maxPoints: number): number {
  if (n <= 0 || maxPoints <= 0) return 1;
  return Math.max(1, Math.ceil(n / maxPoints));
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Judge one full window of samples. `cost` = the field's own work per frame
 * (ms); `lateness` = actual gap between two consecutive drawn frames divided
 * by the gap the field asked for (1 = on time). Fewer than QUALITY_WINDOW
 * samples are never judged.
 */
export function judgeWindow(cost: readonly number[], lateness: readonly number[]): QualityVerdict {
  if (cost.length < QUALITY_WINDOW) return 'keep';
  if (median([...cost]) > QUALITY_MAX_COST_MS) return 'down';
  if (lateness.length >= QUALITY_WINDOW / 2 && median([...lateness]) > QUALITY_MAX_LATENESS) return 'down';
  return 'keep';
}

export interface QualityTracker {
  /** Record one drawn frame. `lateness` is null when the previous frame was not drawn back to back. */
  push(costMs: number, lateness: number | null): QualityVerdict;
  /** Forget the current window (after a level change, a pause, a resize). */
  reset(): void;
}

export function createQualityTracker(): QualityTracker {
  let cost: number[] = [], late: number[] = [], strikes = 0;
  return {
    push(c, l) {
      cost.push(c);
      if (l !== null && Number.isFinite(l)) late.push(l);
      if (cost.length < QUALITY_WINDOW) return 'keep';
      const v = judgeWindow(cost, late);
      cost = []; late = [];
      strikes = v === 'down' ? strikes + 1 : 0;
      if (strikes < QUALITY_STRIKES) return 'keep';
      strikes = 0;
      return 'down';
    },
    reset() { cost = []; late = []; strikes = 0; },
  };
}
