/**
 * useVideoZoomPan — wheel-to-zoom / drag-to-pan on a focused video tile.
 *
 * Gesture-only by design: there is no on-screen control anywhere in this
 * feature, so the affordances are the cursor and the gestures themselves.
 *
 *   wheel                zoom, anchored under the pointer
 *   ctrl+wheel           the same (macOS trackpad pinch arrives this way)
 *   drag                 pan, once past 1x — left button, or middle button
 *                        / space+drag when the annotation tool owns the left
 *   double-click         while zoomed: below fill -> jump to fill (bars gone,
 *                        cursor-anchored), at/past fill -> back to fit
 *   focus change         reset (the tile remounts, and we reset defensively)
 *
 * ── Zoom operates on the STAGE, not the fitted picture ──────────────────
 * The picture is object-contain inside the tile, so a wide share has bars.
 * The fit-shaped clip window that rounds the picture's corners used to be
 * fixed to that fitted rect, so a zoomed picture was still clipped to its own
 * original box: you zoomed into "the window of the screen". The hook now owns
 * that clip (`clipRef`): it is the visible part of the transformed picture
 * (transformed fit rect intersected with the stage), so as you zoom the picture
 * grows past its fitted box and the bars go; at fit it is exactly the old
 * fit-shaped clip. See utils/videoZoomPan.ts for fit/fill and the clamps.
 *
 * ── Why the state lives in refs ─────────────────────────────────────────
 * A wheel gesture fires dozens of events and a pan fires one per mouse move.
 * Routing those through useState would re-render VideoTile — which sits in
 * the call UI next to a 7.4k-line dashboard — at pointer rate. Instead the
 * state is a ref and the transform is written straight to the layer's style
 * inside a rAF. That keeps the whole gesture on the compositor: one
 * `translate()/scale()` on one element, no layout properties, no React work.
 *
 * ── Two elements, and why ───────────────────────────────────────────────
 * `rootRef`  the tile root. Never transformed, so its getBoundingClientRect()
 *            is the true, untransformed box: it is both the viewport we clamp
 *            against and the origin we resolve pointer anchors against.
 *            Listeners live here because the tile's own z-10 context-menu hit
 *            surface would otherwise swallow everything aimed at the layer.
 * `layerRef` the transformed wrapper holding BOTH the <video> and the
 *            annotation canvas, so one transform moves them together and the
 *            annotation layer's normalised (0-1) coordinates stay valid with
 *            no annotation-side maths at all.
 */
import { useEffect, useRef } from 'react';
import { contentRect, type FitMode } from '../utils/annotationGeometry';
import {
    IDLE_DRAG,
    beginDrag,
    endDrag as endDragGesture,
    isActive as dragIsActive,
    moveDrag,
    type DragState,
} from '../utils/dragGesture';
import {
    IDENTITY,
    clampState,
    doubleClickTarget,
    fullRect,
    isZoomed,
    panBy,
    visibleRect,
    wheelZoomFactor,
    zoomAt,
    type Rect,
    type ZoomState,
} from '../utils/videoZoomPan';

export interface UseVideoZoomPanOptions {
    /** The tile root — untransformed, and where the listeners bind. */
    rootRef: React.RefObject<HTMLElement | null>;
    /** The wrapper that gets the transform (video + annotation canvas). */
    layerRef: React.RefObject<HTMLElement | null>;
    /**
     * The untransformed clip window around `layerRef`. The hook writes its
     * `clip-path` (the visible picture, rounded) so the clip follows the zoom.
     * Callers must NOT also set clip-path in a React style on this element.
     */
    clipRef: React.RefObject<HTMLElement | null>;
    /** Corner radius of the clip, px. */
    clipRadiusPx?: number;
    /**
     * The visible picture rect (tile-box CSS px) once a zoom has SETTLED, or
     * null at fit. Debounced, never per pointer move: it is for placing
     * corner chrome on visible picture, not for painting.
     */
    onViewChange?: (rect: Rect | null) => void;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** Must mirror the object-fit the <video> actually has. */
    fit: FitMode;
    /** Zoom is focused-view only. */
    enabled: boolean;
    /**
     * The left button is free for panning.
     *
     * False only where a left-drag would actually DRAW on this tile —
     * annotation is the gesture that must stay effortless, so where it is
     * live it keeps the plain left-drag and panning falls back to middle-drag
     * or space+drag.
     *
     * "Would actually draw" is the whole point: pass the per-tile permission,
     * not the global armed flag. Surrendering the button on a tile the user
     * has no permission to draw on leaves the left-drag doing nothing at all,
     * and it falls through to the tile's click handler. See the call site in
     * VideoTile.tsx.
     */
    allowLeftDrag: boolean;
    /** Identity of the focused track. A change resets zoom and pan. */
    resetKey: string;
    /**
     * When true, a PLAIN wheel (no ctrlKey) is ignored — only a ctrl+wheel /
     * trackpad-pinch zooms, same convention as every other webpage. When
     * false (the default), any wheel zooms.
     *
     * Exists because "any wheel = zoom" (see wheelZoomFactor's docstring) was
     * designed and is only safe for a surface with nothing else to scroll —
     * true for FullscreenOverlay, but NOT for FocusedStreamBanner's docked
     * preview, which sits at the top of the chat pane's own scrollable
     * column (Dashboard.tsx's `overflow-y-auto` call+content zone) with
     * ordinary messages below it. There, an unmodified scroll while the
     * cursor happened to be over the small video thumbnail — an easy thing
     * to do scrolling down to read chat — got captured as a zoom/pan
     * (`preventDefault`+`stopPropagation`, so the page didn't even scroll),
     * nudging `scale` a hair above 1 and `tx`/`ty` off-anchor. Nothing
     * resets that short of the focused track itself changing (`resetKey`),
     * so the drift persisted: a full-height video with a gap on only one
     * side, no cropping obvious enough to read as "zoomed" — reported live,
     * repeatedly, as "the video isn't centered." True fullscreen keeps the
     * original one-tap convenience zoom; the docked view now behaves like
     * any other embedded page element.
     */
    requireModifierForWheelZoom?: boolean;
}

export function useVideoZoomPan({
    rootRef, layerRef, clipRef, clipRadiusPx = 0, onViewChange, videoRef, fit, enabled, allowLeftDrag, resetKey,
    requireModifierForWheelZoom = false,
}: UseVideoZoomPanOptions): void {
    const stateRef = useRef<ZoomState>(IDENTITY);
    const rafRef = useRef<number | null>(null);
    /** The click-or-pan decision. Pure state machine in utils/dragGesture.ts,
     *  which owns the threshold and its boundary tests. */
    const dragRef = useRef<DragState>(IDLE_DRAG);
    /** Set when a pan actually moved, consumed by the click that pointerup
     *  synthesises immediately afterwards. It cannot live on dragRef: pointerup
     *  fires BEFORE click, so by the time the click arrives the drag is over
     *  and dragRef is already idle. */
    const suppressClickRef = useRef(false);
    const spaceRef = useRef(false);
    // Read inside listeners that are bound once; refs keep them current
    // without rebinding (and without a stale `allowLeftDrag` closure).
    //
    // Mirrored in an effect rather than assigned during render: writing a ref
    // while rendering is what react-hooks/refs forbids, and under a double
    // render it would run twice. Both refs are only ever READ from listeners
    // bound in the effect below, which cannot fire before that effect has run,
    // so updating them after commit is equivalent here.
    const allowLeftRef = useRef(allowLeftDrag);
    const fitRef = useRef(fit);
    const onViewChangeRef = useRef(onViewChange);
    useEffect(() => {
        allowLeftRef.current = allowLeftDrag;
        fitRef.current = fit;
        onViewChangeRef.current = onViewChange;
    });

    useEffect(() => {
        if (!enabled) return;
        const root = rootRef.current;
        const layer = layerRef.current;
        const clip = clipRef.current;
        if (!root || !layer) return;
        const reducedMotion = () =>
            typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let viewTimer: ReturnType<typeof setTimeout> | null = null;
        let viewReported = false;

        // ── geometry ────────────────────────────────────────────────────
        /** The untransformed tile box. `getBoundingClientRect` is safe here
         *  precisely because the transform is on the inner layer, not root. */
        const viewport = () => {
            const r = root.getBoundingClientRect();
            return { width: r.width, height: r.height, left: r.left, top: r.top };
        };
        /** Where the frame is actually painted — the same rect the annotation
         *  layer derives its normalised coordinates from, so the two agree. */
        const content = (v: { width: number; height: number }): Rect => {
            const video = videoRef.current;
            const box = { width: v.width, height: v.height };
            if (!video) return fullRect(box);
            return contentRect(box, { width: video.videoWidth, height: video.videoHeight }, fitRef.current)
                ?? fullRect(box);
        };

        /** Null until the frame has an intrinsic size (nothing to clip to). */
        const contentOrNull = (v: { width: number; height: number }): Rect | null => {
            const video = videoRef.current;
            if (!video) return null;
            return contentRect({ width: v.width, height: v.height }, { width: video.videoWidth, height: video.videoHeight }, fitRef.current);
        };

        // ── painting ────────────────────────────────────────────────────
        const reportView = () => {
            viewTimer = null;
            const cb = onViewChangeRef.current;
            if (!cb) return;
            const v = viewport();
            const c = contentOrNull(v);
            if (!isZoomed(stateRef.current) || !c) {
                if (viewReported) { viewReported = false; cb(null); }
                return;
            }
            viewReported = true;
            cb(visibleRect(stateRef.current, v, c));
        };
        const paint = () => {
            rafRef.current = null;
            const s = stateRef.current;
            if (clip) {
                const v = viewport();
                const c = contentOrNull(v);
                if (c) {
                    const r = visibleRect(s, v, c);
                    const right = Math.max(0, v.width - r.x - r.width);
                    const bottom = Math.max(0, v.height - r.y - r.height);
                    clip.style.clipPath = `inset(${r.y}px ${right}px ${bottom}px ${r.x}px round ${clipRadiusPx}px)`;
                } else {
                    clip.style.clipPath = '';
                }
            }
            if (viewTimer != null) clearTimeout(viewTimer);
            viewTimer = setTimeout(reportView, isZoomed(s) ? 140 : 0);
            // Identity gets an empty transform so an un-zoomed tile is not
            // needlessly promoted to its own compositor layer.
            layer.style.transform = isZoomed(s)
                ? `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`
                : '';
            layer.style.transformOrigin = '0 0';
            // Deliberately NO `will-change: transform` here. It was tried and
            // measured: forcing the layer to be promoted made a gesture ~10x
            // SLOWER at deviceScaleFactor 3 (316ms vs 33ms median frame),
            // because promoting a 4800x2700 surface costs more to rasterise
            // each frame than letting the compositor decide. It would also
            // pin a texture per focused tile for the whole call. Leave the
            // hint off and let the browser promote when it actually pays.
            root.style.cursor = isZoomed(s) && (allowLeftRef.current || spaceRef.current)
                ? (dragIsActive(dragRef.current) ? 'grabbing' : 'grab')
                : '';
        };
        const schedule = () => {
            if (rafRef.current == null) rafRef.current = requestAnimationFrame(paint);
        };
        const commit = (next: ZoomState) => {
            const prev = stateRef.current;
            if (next.scale === prev.scale && next.tx === prev.tx && next.ty === prev.ty) return;
            stateRef.current = next;
            schedule();
        };
        /** Gesture-driven changes are immediate; discrete jumps ease. */
        const setTransition = (on: boolean) => {
            const ease = on && !reducedMotion();
            layer.style.transition = ease ? 'transform 160ms ease-out' : '';
            if (clip) clip.style.transition = ease ? 'clip-path 160ms ease-out' : '';
        };

        // ── wheel: zoom, anchored on the cursor ─────────────────────────
        // Non-passive so we can preventDefault the page/browser zoom, and
        // scoped to this element so scrolling everywhere else is untouched.
        //
        // requireModifierForWheelZoom: a plain wheel with no ctrlKey is left
        // completely alone — no preventDefault, no stopPropagation, no state
        // change — so it bubbles to whatever scrollable ancestor actually
        // owns it (see the option's own docstring for why the docked
        // FocusedStreamBanner preview needs this and FullscreenOverlay
        // doesn't).
        const onWheel = (e: WheelEvent) => {
            if (requireModifierForWheelZoom && !e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();
            const v = viewport();
            if (!(v.width > 0) || !(v.height > 0)) return;
            setTransition(false);
            commit(zoomAt(
                stateRef.current,
                { x: e.clientX - v.left, y: e.clientY - v.top },
                wheelZoomFactor(e),
                v,
                content(v),
            ));
        };

        // ── drag: pan ───────────────────────────────────────────────────
        const wantsPan = (e: PointerEvent) => {
            if (!isZoomed(stateRef.current)) return false;  // nothing to pan at fit
            if (e.button === 1) return true;                // middle always pans
            if (e.button !== 0) return false;
            return allowLeftRef.current || spaceRef.current;
        };

        const onPointerDown = (e: PointerEvent) => {
            suppressClickRef.current = false;
            if (!wantsPan(e)) return;
            dragRef.current = beginDrag(e.pointerId, e.clientX, e.clientY);
            // Capture the pointer so the rest of the gesture is delivered here
            // no matter what it travels over — another tile, the call
            // controls, or off the window entirely. Without it a fast drag
            // that leaves the tile loses its moves, and the browser is free to
            // hand the pointer to a scroll/drag gesture mid-pan.
            try { root.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
            // Middle-drag would otherwise start the browser's autoscroll.
            e.preventDefault();
            schedule();
        };

        const onPointerMove = (e: PointerEvent) => {
            const r = moveDrag(dragRef.current, e.pointerId, e.clientX, e.clientY);
            dragRef.current = r.state;
            if (!r.pan) return;
            const v = viewport();
            setTransition(false);
            commit(panBy(stateRef.current, r.pan.dx, r.pan.dy, v, content(v)));
        };

        const endDrag = (e: PointerEvent) => {
            const r = endDragGesture(dragRef.current, e.pointerId);
            dragRef.current = r.state;
            if (r.suppressClick) suppressClickRef.current = true;
            try { root.releasePointerCapture(e.pointerId); } catch { /* already released */ }
            schedule();
        };

        // A pan ends in a click. Left unchecked that click reaches the tile
        // and toggles focus off — the view the user was just panning around.
        //
        // This listener is on WINDOW, in the capture phase, deliberately.
        // Bound on the tile it only fired when the click was dispatched
        // through the tile — and the click's target is the nearest common
        // ancestor of the press and the release, so a pan that ended even one
        // pixel outside the tile was dispatched ABOVE it. The tile's listener
        // never ran and the click activated whatever container sits behind the
        // grid. Verified in a real browser, not assumed: see
        // scripts/verify-drag-gesture-browser.mjs, whose control wiring
        // reproduces the leak (a drag released off the tile lands a click on
        // the background) and whose fixed wiring does not.
        //
        // The stale flag does NOT survive into the next gesture — the
        // pointerdown above disarms it before any later click. That matters
        // MORE now, not less: a window-level suppressor that stayed armed
        // would eat a click anywhere in the app, so the disarm on pointerdown
        // and the clear on unmount below are what make this placement safe.
        // Window-capture runs before every other handler in the document
        // regardless of target, which is the only placement that makes "a pan
        // never activates anything" true.
        const onClickCapture = (e: MouseEvent) => {
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            e.stopPropagation();
            e.preventDefault();
        };

        // ── double-click: the one escape hatch ──────────────────────────
        // The tile's own click already toggles focus, so a double-click is
        // only claimed while zoomed — where it is unambiguously "change the
        // zoom", and where the user has no other way out because there is no
        // chrome. At 1x it passes straight through, exactly as before.
        // Zoomed below fill (bars still showing): fill, anchored on the
        // cursor. At/past fill: back to fit. Eased unless reduced-motion.
        const onDoubleClickCapture = (e: MouseEvent) => {
            if (!isZoomed(stateRef.current)) return;
            e.stopPropagation();
            e.preventDefault();
            const v = viewport();
            if (!(v.width > 0) || !(v.height > 0)) return;
            setTransition(true);
            commit(doubleClickTarget(
                stateRef.current,
                { x: e.clientX - v.left, y: e.clientY - v.top },
                v,
                content(v),
            ));
        };

        // ── space: the pan modifier while annotation owns the left button ──
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.code !== 'Space' || spaceRef.current) return;
            const t = e.target as HTMLElement | null;
            // Never steal the spacebar from a text field.
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            spaceRef.current = true;
            schedule();
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.code !== 'Space') return;
            spaceRef.current = false;
            schedule();
        };
        const onBlur = () => { spaceRef.current = false; schedule(); };

        // ── re-clamp on layout / frame changes ──────────────────────────
        // A tile resize or a share that changes resolution mid-stream moves
        // the content rect; the current pan may now expose a gutter.
        const reclamp = () => {
            const v = viewport();
            if (!(v.width > 0) || !(v.height > 0)) return;
            commit(clampState(stateRef.current, v, content(v)));
            // The clip tracks the stage and the frame size even when the
            // transform itself did not change (resize at fit, new metadata).
            schedule();
        };
        const ro = new ResizeObserver(reclamp);
        ro.observe(root);
        const video = videoRef.current;
        video?.addEventListener('loadedmetadata', reclamp);
        video?.addEventListener('resize', reclamp);

        paint();
        root.addEventListener('wheel', onWheel, { passive: false });
        root.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);
        // Capture can be taken away mid-gesture (the element is removed, the
        // OS grabs the pointer). Treat that as the end of the pan rather than
        // leaving the drag latched open — endDrag is a no-op once idle, so
        // the ordinary pointerup path is unaffected.
        root.addEventListener('lostpointercapture', endDrag);
        window.addEventListener('click', onClickCapture, true);
        root.addEventListener('dblclick', onDoubleClickCapture, true);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);

        return () => {
            ro.disconnect();
            video?.removeEventListener('loadedmetadata', reclamp);
            video?.removeEventListener('resize', reclamp);
            root.removeEventListener('wheel', onWheel);
            root.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', endDrag);
            window.removeEventListener('pointercancel', endDrag);
            root.removeEventListener('lostpointercapture', endDrag);
            window.removeEventListener('click', onClickCapture, true);
            root.removeEventListener('dblclick', onDoubleClickCapture, true);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            if (viewTimer != null) clearTimeout(viewTimer);
            if (viewReported) onViewChangeRef.current?.(null);
            layer.style.transition = '';
            if (clip) { clip.style.clipPath = ''; clip.style.transition = ''; }
            dragRef.current = IDLE_DRAG;
            // Never leave the window-level suppressor armed past unmount — it
            // would eat the first click anywhere in the app.
            suppressClickRef.current = false;
            stateRef.current = IDENTITY;
            layer.style.transform = '';
            root.style.cursor = '';
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requireModifierForWheelZoom is read when the wheel handler runs; toggling it must not tear down and re-attach the gesture listeners and reset zoom state
    }, [enabled, rootRef, layerRef, clipRef, videoRef]);

    // Focus moved to a different person's stream (the sibling auto-advance on
    // staging does this when a stream ends). The keyed VideoTile remounts, but
    // reset explicitly too so zoom can never be inherited by another
    // participant's video.
    useEffect(() => {
        stateRef.current = IDENTITY;
        const layer = layerRef.current;
        const root = rootRef.current;
        if (layer) layer.style.transform = '';
        if (root) root.style.cursor = '';
    }, [resetKey, layerRef, rootRef]);
}
