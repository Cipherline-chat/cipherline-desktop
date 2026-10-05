/**
 * annotationGeometry — pure coordinate mapping for drawing on a video tile.
 *
 * Every annotation point is stored and transmitted NORMALIZED to the video's
 * intrinsic frame: x, y in [0, 1] over videoWidth × videoHeight. That is the
 * one coordinate space every participant shares. Each client maps it through
 * its own element box and object-fit letterboxing, so a stroke lands on the
 * same pixel of the *content* on every screen regardless of tile size, DPR,
 * or fullscreen. Nothing here touches the DOM — it is all testable math, and
 * the invariants below are what the vitest suite locks.
 */

export type FitMode = 'contain' | 'cover';

/** The element's CSS-pixel box (from getBoundingClientRect / ResizeObserver). */
export interface Box { width: number; height: number }

/** The video's intrinsic frame (HTMLVideoElement.videoWidth / videoHeight). */
export interface IntrinsicSize { width: number; height: number }

/** Where, within the element box, the frame is actually painted (CSS px). */
export interface ContentRect { x: number; y: number; width: number; height: number }

export interface Point { x: number; y: number }

/**
 * The rectangle the frame occupies inside the element, for CSS `object-fit`
 * with the default `object-position: 50% 50%`.
 *
 * Returns null until the video has metadata (intrinsic size 0×0) — callers
 * must not draw before then, because there is no frame to map onto yet.
 */
export function contentRect(box: Box, intrinsic: IntrinsicSize, fit: FitMode): ContentRect | null {
    if (!(intrinsic.width > 0) || !(intrinsic.height > 0)) return null;
    if (!(box.width > 0) || !(box.height > 0)) return null;
    const sx = box.width / intrinsic.width;
    const sy = box.height / intrinsic.height;
    const scale = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
    const width = intrinsic.width * scale;
    const height = intrinsic.height * scale;
    return {
        x: (box.width - width) / 2,
        y: (box.height - height) / 2,
        width,
        height,
    };
}

/** Element-local CSS px → normalized frame coords. May fall outside [0,1]
 *  when the point is in a letterbox bar (or a cropped-away region in cover
 *  mode); see isInsideContent / clampUnit for how callers treat that. */
export function toNormalized(pt: Point, rect: ContentRect): Point {
    return {
        x: (pt.x - rect.x) / rect.width,
        y: (pt.y - rect.y) / rect.height,
    };
}

/** Normalized frame coords → element-local CSS px. */
export function toElement(norm: Point, rect: ContentRect): Point {
    return {
        x: rect.x + norm.x * rect.width,
        y: rect.y + norm.y * rect.height,
    };
}

/** Normalized frame coords → device pixels on a canvas that covers the whole
 *  element box and is sized `box × dpr` (the usual HiDPI setup). */
export function toCanvas(norm: Point, rect: ContentRect, dpr: number): Point {
    const el = toElement(norm, rect);
    return { x: el.x * dpr, y: el.y * dpr };
}

export function isInsideContent(norm: Point): boolean {
    return norm.x >= 0 && norm.x <= 1 && norm.y >= 0 && norm.y <= 1;
}

/** Clamp into the frame. Used mid-stroke so a hand that drifts into the
 *  letterbox bar keeps the line continuous along the edge instead of
 *  breaking it; a stroke that *starts* outside is rejected by the caller. */
export function clampUnit(norm: Point): Point {
    return {
        x: Math.min(1, Math.max(0, norm.x)),
        y: Math.min(1, Math.max(0, norm.y)),
    };
}

/** Wire-safety: a point is well-formed only if both coords are finite and
 *  inside the unit square. Receivers apply this to every incoming point. */
export function isValidWirePoint(p: unknown): p is Point {
    if (!p || typeof p !== 'object') return false;
    const { x, y } = p as { x?: unknown; y?: unknown };
    return typeof x === 'number' && typeof y === 'number'
        && Number.isFinite(x) && Number.isFinite(y)
        && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}
