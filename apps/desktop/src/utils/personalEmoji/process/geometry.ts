/**
 * Where a source picture lands inside the square emoji canvas.
 *
 *   crop - fill the square, centred, losing the overflowing edges.
 *   fit  - the whole picture, letterboxed with transparent padding.
 *
 * Pure so it is testable; the worker just draws the rectangles it returns.
 */

export type FrameMode = 'crop' | 'fit';

export interface FramePlan {
    /** Source rectangle to read. */
    sx: number; sy: number; sw: number; sh: number;
    /** Destination rectangle inside the `side` x `side` canvas. */
    dx: number; dy: number; dw: number; dh: number;
}

export function planFrame(srcW: number, srcH: number, side: number, mode: FrameMode): FramePlan {
    if (!(srcW > 0) || !(srcH > 0) || !(side > 0)) throw new Error('empty image');
    if (mode === 'crop') {
        const s = Math.min(srcW, srcH);
        return { sx: (srcW - s) / 2, sy: (srcH - s) / 2, sw: s, sh: s, dx: 0, dy: 0, dw: side, dh: side };
    }
    const k = side / Math.max(srcW, srcH);
    const dw = Math.max(1, Math.round(srcW * k));
    const dh = Math.max(1, Math.round(srcH * k));
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: Math.floor((side - dw) / 2), dy: Math.floor((side - dh) / 2), dw, dh };
}
