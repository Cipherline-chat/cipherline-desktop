/* ============================================================
   Frame-scheduling policy for the dot field, factored out as a pure
   function so it can be unit-tested without WebGL.

     'stop' : do not schedule another frame (hidden tab, paused, or the
              field has settled and nothing is moving)
     60     : something moves (a morph, the pointer, a tween, a pulse):
              draw on every animation frame
     30     : only breathing (the settle window after the last motion):
              draw at most every ~32 ms
   ============================================================ */

export type FrameBudget = 'stop' | 30 | 60;

export interface FrameBudgetInput {
  /** a morph / tween / pointer smoothing / pulse is in flight */
  busy: boolean;
  /** ms since the field was last busy or kicked */
  sinceActiveMs: number;
  /** how long to keep breathing after the last motion */
  settleMs: number;
  /** document.hidden */
  hidden: boolean;
  /** pause(true) */
  paused: boolean;
  /** reduced motion: no breathing, a frame only on change */
  reducedMotion?: boolean;
}

export function frameBudget(i: FrameBudgetInput): FrameBudget {
  if (i.hidden || i.paused) return 'stop';
  if (i.busy) return 60;
  if (!i.reducedMotion && i.sinceActiveMs < i.settleMs) return 30;
  return 'stop';
}

/** Minimum gap between two draws while only breathing (the prototype's 32 ms gate). */
export const BREATHING_GAP_MS = 32;
