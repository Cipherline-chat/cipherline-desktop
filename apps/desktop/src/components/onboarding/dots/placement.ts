/* ============================================================
   DOM helpers for the dot field (ported from ob6/js/main.js place()
   and positionTags()). The tag layer itself is DotTagLayer.tsx
   (a .ts file cannot hold JSX); it is re-exported from index.ts.
   ============================================================ */
import type { DotField } from './engine';

/**
 * Fit a world radius `R` into an element's box: centre the cloud on the
 * element (plus `dy` px) and scale it so radius R fills 94% of the box's
 * shorter half. Assumes the canvas covers the whole viewport.
 * Tweens over `ms` (0 = jump). Resolves when the tweens have finished.
 */
export function place(field: DotField | null, el: Element | null, R: number, ms = 900, dy = 0): Promise<void> {
  if (!field || !el) return Promise.resolve();
  const r = el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2 + dy;
  const want = Math.min(r.width, r.height) / 2 * 0.94;
  const s = want / (R * (2.2 / 3.2) * H / 2);
  return Promise.all([
    field.param('offX', (cx / W) * 2 - 1, ms),
    field.param('offY', 1 - (cy / H) * 2, ms),
    field.param('scale', s, ms),
  ]).then(() => undefined);
}

/**
 * Horizontal clamp for a label of half-width `hw` centred on projected x:
 * keeps it 8px from the left edge and 10px from the right (the prototype's
 * numbers, asymmetric on purpose).
 */
export function clampTagX(x: number, hw: number, viewportW: number): number {
  return Math.max(hw + 8, Math.min(viewportW - hw - 10, x));
}
