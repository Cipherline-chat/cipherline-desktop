/**
 * AnnotationOverlay — the drawing surface laid over one video tile.
 *
 * A single <canvas> that covers the tile, renders the strokes the store holds
 * for this track, and (when the local user may draw here) turns pointer input
 * into normalized strokes. All geometry goes through annotationGeometry so a
 * point drawn on a 320px tile lands on the same content pixel on a 4K
 * fullscreen — that invariant is what the vitest suite locks; this file is
 * the thin DOM shell around it.
 *
 * Why a sibling of <video> rather than a wrapper: VideoTile already layers
 * its chrome as absolute inset-0 siblings (z-[3] avatar, z-20 labels), and
 * the <video> itself is object-fit'd inside the tile box. Sitting at z-[2]
 * puts strokes above the frame and below every control.
 *
 * ── Rendering cost, and why it is shaped like this ──────────────────────────
 *
 * This canvas repaints every frame that anything is on it, on machines whose
 * devicePixelRatio is 2 or 3. Three rules keep that affordable, and all three
 * were measured (headless Chrome, Emulation.setDeviceMetricsOverride, a 1280×720
 * tile carrying one long stroke plus four remote ones):
 *
 *  1. ONE PATH PER STROKE, ONE ALPHA. Stroking each segment separately — which
 *     is what per-point opacity forces you to do — cost 459ms/frame at dpr 3
 *     with 900 points on screen. One path per stroke is 30ms. It is also the
 *     fix for the "dots on the trail" artifact: adjacent round line caps
 *     compositing against each other at differing alphas is what made the line
 *     look beaded rather than continuous.
 *
 *  2. NO ctx.shadowBlur. The glow used to come from shadowBlur, which is a
 *     gaussian over the drawn geometry's bounding box. That was survivable when
 *     each segment blurred its own few pixels; applied once to a whole-stroke
 *     path it blurs the entire tile and costs 412ms/frame at dpr 3. The glow is
 *     now a handful of strokes of the SAME path — a graded stack of wide
 *     translucent halos under a bright core (see GLOW_LAYERS) — which is a
 *     fraction of the cost and, being geometry rather than a filter, scales
 *     with line width instead of canvas area.
 *
 *  3. BACKING STORE CAPPED AT 2×. A 4K laptop reports dpr 2–3; past 2× the
 *     extra device pixels are invisible on a soft glowing line and cost real
 *     fill rate (~25% of frame time at dpr 3).
 *
 * The fourth rule is not in draw() at all: a stroke in progress must not
 * re-render React. `strokes` is read through a ref fed by a direct store
 * subscription, and the only thing this component selects from the store is
 * the BOOLEAN "does this track have anything on it" — so appending a point
 * repaints the canvas without re-rendering the tile, let alone the tree.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { filterStrokesByAuthor } from '../../utils/annotationOverlayCapture';
import {
    annotationStore, useAnnotationStore, strokeAlpha, clock, STROKE_IDLE_MS,
    EMPTY_STROKES, type Stroke, type AnnotationState,
} from '../../utils/annotationStore';
import {
    contentRect, toNormalized, isInsideContent, clampUnit,
    type FitMode, type ContentRect,
} from '../../utils/annotationGeometry';

export interface AnnotationOverlayProps {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** annotationStore.trackKey(identity, source) for the tile's track. */
    trackKey: string;
    /** Must mirror the object-fit class VideoTile put on this <video>. */
    fit: FitMode;
    /** The local user may draw on this tile right now. */
    canDraw: boolean;
    /** The tool is on and this tile is an annotation surface, whether or not
     *  WE may draw here. Clicks are swallowed either way, so a focused tile
     *  never unfocuses under someone who is trying to draw. */
    armed?: boolean;
    /** Local identity, stamped on every stroke as its author. */
    by: string;
    /** The tile's right-click handler. While drawing, the canvas sits above
     *  the tile's context-menu hit surface, so it forwards right-clicks. */
    onContextMenu?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
    /**
     * Draw only strokes authored by this identity (null/undefined = all).
     * Set on a screen share whose sharer's desktop overlay is captured into
     * the video (Linux) — see utils/annotationOverlayCapture.ts.
     */
    onlyBy?: string | null;
}

/** Points closer than this (in normalized units) are coalesced — keeps a
 *  slow hand from producing thousands of near-identical points. */
const MIN_STEP = 0.0015;
/**
 * The glow, as a GRADED ramp of halo strokes under the core: `[width multiple
 * of the core, opacity]`, widest and faintest first. Each entry re-strokes the
 * same path, so the composited profile steps 0.07 → 0.19 → 0.40 → 1.0 outward
 * from the core instead of the single flat 0.28 band this replaced — which is
 * exactly what "just a hard semi transparent color then it goes to a hard
 * color" described. Three layers is where the banding stops being visible at
 * the sizes this actually draws at (a 4 CSS-px stroke is 8 device px on the
 * focused tile); a fourth was measured to be indistinguishable there.
 *
 * COST, measured the same way as the notes in the header (headless Chromium,
 * software raster, a 1280×720 tile at dpr 2 carrying 900 points across five
 * simultaneous strokes): the glow passes come to ~2.2× the two-pass halo they
 * replace, because stroke cost tracks Σ(width) and this is 7.57 core-widths
 * against 3.6. That worst case is five people scribbling at once; an ordinary
 * single ~200-point stroke stays in the low single-digit ms. If it ever has to
 * come back down, DROP A LAYER — do not reach for shadowBlur (rule 2 in the
 * header) or a blurred offscreen composite, both of which cost canvas AREA
 * rather than line width and are what this shape exists to avoid.
 *
 * Every number here is a module constant and the only per-stroke inputs are
 * `color` and `width`, both of which travel on the wire — so a receiver
 * reproduces a stroke's appearance exactly from the packet, with nothing
 * local-only in the picture.
 */
const GLOW_LAYERS: readonly (readonly [number, number])[] = [
    [2.8, 0.07],
    [1.95, 0.14],
    [1.4, 0.26],
];
/** A white-hot centre thread inside the coloured core. What makes the line
 *  read as a LIT laser rather than a translucent marker: the falloff then
 *  shifts in hue as well as in opacity, the way a real emitter does. */
const HOT_CORE_WIDTH = 0.42;
const HOT_CORE_ALPHA = 0.55;
const HOT_CORE_COLOR = '#FFFFFF';

/** Does this track have anything to draw? A boolean, so appending a point to a
 *  stroke does not re-render the tile — only the first and last stroke do. */
const selectHasStrokes = (key: string) => (s: AnnotationState): boolean => (s.strokes[key]?.length ?? 0) > 0;

/**
 * ── Backing-store sizing: ONE rule, two independent ceilings ────────────────
 *
 * `measure()` sizes the backing store from getBoundingClientRect() * DPR, and
 * that product runs away in two DIFFERENT ways. Both ceilings are needed; they
 * are not alternatives, and the effective DPR is the minimum of both.
 *
 *  (a) FILL RATE — the flat 2x cap. A 4K/Retina panel reports dpr 2-3, and
 *      everything past 2x is fill rate spent on detail a glowing 4px line
 *      cannot show (~25% of frame time at dpr 3). This is rule 3 in the
 *      header comment above and is about how fast we repaint.
 *
 *  (b) ALLOCATION — the size-aware budget. getBoundingClientRect() reports the
 *      *transformed* box, so the focused view's zoom (up to 5x, see
 *      utils/videoZoomPan) multiplies the requested store on top of whatever
 *      (a) allowed. A 4K fullscreen tile is already 11520x6480 (~300 MB) at
 *      dpr 3; past ~16384px per axis Chromium refuses the allocation outright
 *      and the canvas goes blank — strokes vanish with no error. So the store
 *      is additionally held under a per-axis cap and a total-area cap
 *      (~16 MPx, ~64 MB). This is about whether the canvas exists at all.
 *
 * (a) alone cannot save a zoomed 4K tile (2 * a 5x-inflated box still blows the
 * per-axis limit); (b) alone would happily hand back dpr 3 on a small tile and
 * pay (a)'s fill-rate cost. Composing them loses only crispness, never
 * geometry — the picture stays identical because everything downstream uses
 * the resulting value, and at high zoom the lost detail is invisible anyway
 * since the video underneath is upscaled by the same factor.
 *
 * The effective value is stashed in `dprRef` and read back by draw(). That
 * indirection is REQUIRED now that the cap depends on the box size: draw()
 * cannot recompute it, because it does not measure the box.
 */
const MAX_BACKING_SCALE = 2;
const MAX_CANVAS_DIM = 8192;
const MAX_CANVAS_AREA = 16e6;

/** DPR scaled down to fit both ceilings for a box of this size. */
function effectiveDpr(width: number, height: number, rawDpr: number): number {
    const dpr = Math.min(MAX_BACKING_SCALE, rawDpr || 1);
    if (!(width > 0) || !(height > 0)) return dpr;
    const byDim = Math.min(MAX_CANVAS_DIM / width, MAX_CANVAS_DIM / height);
    const byArea = Math.sqrt(MAX_CANVAS_AREA / (width * height));
    return Math.max(0.05, Math.min(dpr, byDim, byArea));
}

export const AnnotationOverlay: React.FC<AnnotationOverlayProps> = ({ videoRef, trackKey, fit, canDraw, armed = canDraw, by, onContextMenu, onlyBy = null }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rectRef = useRef<ContentRect | null>(null);
    /** DPR actually used for the backing store — see effectiveDpr. draw()
     *  must use this, not window.devicePixelRatio, or coordinates would be
     *  scaled against a store that was capped to a different ratio. */
    const dprRef = useRef(1);
    const activeRef = useRef<{ id: string; last: { x: number; y: number }; lastAppendAt: number } | null>(null);
    const reduced = useReducedMotion();
    const hasStrokes = useAnnotationStore(selectHasStrokes(trackKey));

    // The stroke list itself is read through a ref, NOT through React state:
    // a live stroke appends a point every pointermove, and routing that through
    // useSyncExternalStore would re-render this component (and VideoTile's
    // subtree with it) at pointer rate on every client in the call.
    const strokesRef = useRef<readonly Stroke[]>(EMPTY_STROKES);
    useEffect(() => {
        const read = () => {
            strokesRef.current = filterStrokesByAuthor(annotationStore.getState().strokes[trackKey] ?? EMPTY_STROKES, onlyBy);
        };
        read();
        return annotationStore.subscribe(read);
    }, [trackKey, onlyBy]);

    /** Re-measure the tile box + the frame's intrinsic size and resize the
     *  backing store to (capped) device pixels. Cheap; called on every layout
     *  change — never per frame. */
    const measure = useCallback((): ContentRect | null => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas || !video) return null;
        const box = canvas.getBoundingClientRect();
        const dpr = effectiveDpr(box.width, box.height, window.devicePixelRatio || 1);
        dprRef.current = dpr;
        const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const rect = contentRect(
            { width: box.width, height: box.height },
            { width: video.videoWidth, height: video.videoHeight },
            fit,
        );
        rectRef.current = rect;
        return rect;
    }, [videoRef, fit]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const rect = rectRef.current ?? measure();
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!rect) return; // no frame yet — nothing to map onto
        // dprRef, not a recomputation: the cap is size-dependent (see
        // effectiveDpr) and draw() does not measure the box, so recomputing
        // here would scale coordinates against a different ratio than the one
        // the backing store was actually sized with.
        const dpr = dprRef.current;
        const now = clock.now();
        // Width is authored in CSS px and scaled mildly with the tile so a
        // line reads the same on a thumbnail and on fullscreen.
        const scale = Math.min(2, Math.max(0.75, rect.width / 960)) * dpr;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // The normalized -> device-pixel transform, hoisted out of the point
        // loop: toElement() would allocate an object per point per frame, which
        // at 60fps and a few thousand points is pure GC pressure.
        const ox = rect.x * dpr, oy = rect.y * dpr;
        const sx = rect.width * dpr, sy = rect.height * dpr;

        for (const s of strokesRef.current) {
            const n = s.points.length;
            if (n === 0) continue;
            // ONE opacity for the whole stroke: 1 while the pen is down, then a
            // ramp once it closes. Reduced motion gets no ramp at all — the
            // stroke simply stands until expireLasers removes it.
            const alpha = reduced ? 1 : strokeAlpha(s, now);
            if (alpha <= 0) continue;

            // ONE path, built once and stroked repeatedly (graded halo, core,
            // hot centre). Successive stroke() calls with no beginPath()
            // between them re-stroke the same path, so the geometry is walked
            // once however many passes the glow takes.
            ctx.beginPath();
            ctx.moveTo(ox + s.points[0].x * sx, oy + s.points[0].y * sy);
            if (n === 1) ctx.lineTo(ox + s.points[0].x * sx + 0.01, oy + s.points[0].y * sy); // a dot
            else for (let i = 1; i < n; i++) ctx.lineTo(ox + s.points[i].x * sx, oy + s.points[i].y * sy);

            const w = s.width * scale;
            ctx.strokeStyle = s.color;
            // Widest and faintest outward-in, then the solid core, then the
            // white thread. One globalAlpha per PASS — never one per point.
            for (const [wm, am] of GLOW_LAYERS) {
                ctx.globalAlpha = alpha * am;
                ctx.lineWidth = w * wm;
                ctx.stroke();
            }
            ctx.globalAlpha = alpha;
            ctx.lineWidth = w;
            ctx.stroke();
            ctx.globalAlpha = alpha * HOT_CORE_ALPHA;
            ctx.lineWidth = Math.max(1, w * HOT_CORE_WIDTH);
            ctx.strokeStyle = HOT_CORE_COLOR;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }, [measure, reduced]);

    // One persistent rAF loop, started and stopped only when the track goes
    // from empty to non-empty and back — NOT on every point. It ages the
    // strokes (watchdog + fade) and repaints; when the last stroke goes it
    // paints once more to clear the canvas, then stops.
    useEffect(() => {
        if (!hasStrokes) { draw(); return; }
        let raf = requestAnimationFrame(function tick() {
            annotationStore.expireLasers();
            draw();
            raf = requestAnimationFrame(tick);
        });
        return () => cancelAnimationFrame(raf);
    }, [hasStrokes, draw]);

    // Layout changes: tile resize (ResizeObserver) and frame changes
    // (loadedmetadata / resize on the <video>, e.g. a share that changes
    // resolution mid-stream). Both invalidate the content rect.
    useEffect(() => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas) return;
        const relayout = () => { measure(); draw(); };
        const ro = new ResizeObserver(relayout);
        ro.observe(canvas);
        video?.addEventListener('loadedmetadata', relayout);
        video?.addEventListener('resize', relayout);
        relayout();
        return () => {
            ro.disconnect();
            video?.removeEventListener('loadedmetadata', relayout);
            video?.removeEventListener('resize', relayout);
        };
    }, [videoRef, measure, draw]);

    // ── Pointer input → normalized strokes ──────────────────────────────
    const localPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const b = e.currentTarget.getBoundingClientRect();
        return { x: e.clientX - b.left, y: e.clientY - b.top };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!canDraw || e.button !== 0) return;
        const rect = measure();
        if (!rect) return;
        const n = toNormalized(localPoint(e), rect);
        // Starting in a letterbox bar is not a stroke.
        if (!isInsideContent(n)) return;
        const id = annotationStore.beginStroke(trackKey, by, n);
        if (!id) return;
        activeRef.current = { id, last: n, lastAppendAt: clock.now() };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const active = activeRef.current;
        const rect = rectRef.current;
        if (!active || !rect) return;
        // A hand that drifts into the bar keeps the line on the frame edge.
        const n = clampUnit(toNormalized(localPoint(e), rect));
        const dx = n.x - active.last.x, dy = n.y - active.last.y;
        const t = clock.now();
        // A nearly-still hand still has to keep its own stroke alive, and it
        // has to do it the same way on EVERY client. So once the stroke is half
        // way to the watchdog we append even a sub-MIN_STEP move: that is a
        // real point, it goes on the wire like any other, and every receiver's
        // watchdog is refreshed by it. Nudging a local timer instead would let
        // the drawer keep a mark that every viewer had already faded.
        const stale = t - active.lastAppendAt >= STROKE_IDLE_MS / 2;
        if (!stale && dx * dx + dy * dy < MIN_STEP * MIN_STEP) return;
        active.last = n;
        active.lastAppendAt = t;
        if (annotationStore.appendPoints(trackKey, active.id, [n])) return;
        // The stroke closed under us: the hand was absolutely still (no pointer
        // events at all) for longer than STROKE_IDLE_MS and the watchdog gave
        // up on it, or it hit MAX_POINTS_PER_STROKE. Start a fresh one at the
        // current position rather than leaving the pen dead for the rest of
        // the gesture.
        const id = annotationStore.beginStroke(trackKey, by, n);
        if (id) active.id = id; else activeRef.current = null;
    };

    const swallow = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); };

    const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const active = activeRef.current;
        if (!active) return;
        activeRef.current = null;
        // The stroke has been whole and solid for the entire gesture; THIS is
        // where it starts to fade.
        annotationStore.endStroke(trackKey, active.id);
        // Reduced motion: no fade — the stroke goes the moment it ends. Peers
        // still received the stroke.end above and ramp it out normally on their
        // own screens; this is a local presentation preference.
        if (reduced) annotationStore.removeStroke(trackKey, active.id);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };

    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            // Passive: below every control at z-[2]. Drawing: VideoTile's
            // full-tile context-menu hit surface is an absolute z-10 sibling
            // with pointer events ON, so at z-[2] the canvas never received a
            // single pointerdown — the toolbar opened, the pen did nothing.
            // While draw mode is on, the canvas rides above that surface
            // (z-[11], still under the z-20 chrome) and hands right-clicks
            // back to the tile so its menu keeps working.
            className={`absolute inset-0 w-full h-full ${canDraw ? 'z-[11]' : 'z-[2]'}`}
            style={{
                pointerEvents: armed || canDraw ? 'auto' : 'none',
                cursor: canDraw ? 'crosshair' : armed ? 'default' : undefined,
                touchAction: 'none',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
            onPointerCancel={finish}
            onLostPointerCapture={finish}
            // The tile underneath toggles focus on click and fullscreen on
            // double-click. While drawing, a stroke's trailing click must not
            // reach it — right-click is left alone so the tile's context menu
            // still works.
            onClick={armed || canDraw ? swallow : undefined}
            onDoubleClick={armed || canDraw ? swallow : undefined}
            onContextMenu={canDraw ? onContextMenu : undefined}
        />
    );
};
