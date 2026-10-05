import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, RotateCcw } from 'lucide-react';
import { ClModal } from './ClModal';
import { ClButton } from '../ClButton';
import { ClSlider } from '../ClSlider';
import {
    type CropTransform, IDENTITY_CROP, MAX_ZOOM, CROP_JPEG_QUALITY,
    clampCrop, zoomAbout, loadImageElement, renderCroppedBlob,
} from '../../utils/imageCrop';

/**
 * Image cropper — drag to reposition, pinch/wheel/slider to zoom, then export
 * exactly the framed region at the caller's output size.
 *
 * Lives in the kit (and uses only kit pieces — no framer-motion) because the
 * website's account portal reaches these primitives through its `@app-cl`
 * alias and does not have framer-motion installed.
 *
 * Semantics worth knowing before wiring a new surface up:
 *   • The exported blob is always the full frame rectangle at
 *     `outputWidth × outputHeight`. `shape="circle"` only dims the corners to
 *     preview how avatars are displayed (CSS `border-radius`) — those corners
 *     are still encoded, which is what every avatar surface already expects.
 *   • The frame's aspect ratio is derived from the output dimensions, so the
 *     preview cannot disagree with the saved result.
 *   • The image can never be panned off the frame (see `clampCrop`), so there
 *     is no empty-gutter state to design around.
 */

interface ClImageCropperProps {
    open: boolean;
    /** The user-picked image. Re-opening with a new file resets the transform. */
    file: File | Blob | null;
    /** Exact output pixel size; also fixes the frame's aspect ratio. */
    outputWidth: number;
    outputHeight: number;
    /** Circle dims the corners to preview avatar display. Output stays rectangular. */
    shape?: 'circle' | 'rect';
    title?: string;
    /** Sub-heading under the title. Defaults to a generic instruction. */
    hint?: string;
    confirmLabel?: string;
    quality?: number;
    /**
     * Overrides the overlay style. Defaults to sitting one layer above the
     * kit's `.mod` (z-index 50) — see the nested-modal note below.
     */
    overlayStyle?: React.CSSProperties;
    onCancel: () => void;
    /** Receives the cropped JPEG. The cropper does not upload anything itself. */
    onConfirm: (blob: Blob) => void;
}

/**
 * Every surface that crops opens the cropper from INSIDE another modal (server
 * settings, group settings, the create-group sheet), and both overlays are
 * `.mod` — which `cl-kit-ext.css` raises to z-index 1000. Equal z-index would
 * leave "which dialog is on top" resting on portal append order, so pin the
 * cropper one layer above the modal tier. Deliberately well under the call
 * overlays (2000+), which must never be covered by a settings dialog.
 */
const CROPPER_Z = 1100;

/** Frame is wider for banner-ish ratios so the crop stays legible in the modal. */
const frameWidthFor = (aspect: number) => (aspect >= 1.6 ? 420 : 300);

/** Arrow-key nudge, in frame pixels. Shift multiplies it. */
const NUDGE = 8;
const NUDGE_FAST = 32;

export const ClImageCropper: React.FC<ClImageCropperProps> = ({
    open, file, outputWidth, outputHeight, shape = 'rect',
    title = 'Adjust your image', hint, confirmLabel = 'Apply',
    quality = CROP_JPEG_QUALITY, overlayStyle, onCancel, onConfirm,
}) => {
    const aspect = outputWidth / outputHeight;
    const frameW = frameWidthFor(aspect);
    const frameH = Math.round(frameW / aspect);

    const [img, setImg] = useState<HTMLImageElement | null>(null);
    // The on-screen <img> needs a LIVE URL. loadImageElement revokes its own
    // object URL as soon as the decode finishes (the decoded bitmap is all the
    // final render needs), so `img.src` is dead by the time we would paint it -
    // the broken-image glyph. Keep a separate URL for display, revoked on cleanup.
    const [displayUrl, setDisplayUrl] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [t, setT] = useState<CropTransform>(IDENTITY_CROP);

    const stageRef = useRef<HTMLDivElement>(null);
    // Live pointers, so a second finger can promote a pan into a pinch.
    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    // Gesture origin: the transform and pointer geometry when the gesture began.
    const gestureRef = useRef<{
        startT: CropTransform; startX: number; startY: number; startDist: number;
    } | null>(null);
    const reduced = typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Decode whenever a new file arrives. `cancelled` guards the classic
    // race where the user picks a second image before the first decodes.
    useEffect(() => {
        if (!open || !file) return;
        let cancelled = false;
        setImg(null);
        setError('');
        setT(IDENTITY_CROP);
        const url = URL.createObjectURL(file);
        setDisplayUrl(url);
        loadImageElement(file)
            .then((loaded) => { if (!cancelled) setImg(loaded); })
            .catch(() => { if (!cancelled) setError('That image could not be opened.'); });
        return () => {
            cancelled = true;
            URL.revokeObjectURL(url);
            setDisplayUrl('');
        };
    }, [open, file]);

    const applyCrop = useCallback((next: CropTransform) => {
        if (!img) return;
        setT(clampCrop(next, img.naturalWidth, img.naturalHeight, frameW, frameH));
    }, [img, frameW, frameH]);

    /** Pointer position relative to the frame centre, in frame pixels. */
    const toFrameCentre = useCallback((clientX: number, clientY: number) => {
        const box = stageRef.current?.getBoundingClientRect();
        if (!box) return { x: 0, y: 0 };
        return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
    }, []);

    const zoomTo = useCallback((nextScale: number, atX = 0, atY = 0) => {
        if (!img) return;
        setT(prev => zoomAbout(
            prev, nextScale, atX, atY,
            img.naturalWidth, img.naturalHeight, frameW, frameH,
        ));
    }, [img, frameW, frameH]);

    // ── Pointer gestures (mouse, touch and pen through one path) ──────────────
    const onPointerDown = (e: React.PointerEvent) => {
        if (!img) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointersRef.current.values()];
        gestureRef.current = {
            startT: t,
            startX: pts.reduce((s, p) => s + p.x, 0) / pts.length,
            startY: pts.reduce((s, p) => s + p.y, 0) / pts.length,
            startDist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
        };
        setDragging(true);
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!img || !pointersRef.current.has(e.pointerId)) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gestureRef.current;
        if (!g) return;
        const pts = [...pointersRef.current.values()];
        const midX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const midY = pts.reduce((s, p) => s + p.y, 0) / pts.length;

        if (pts.length >= 2 && g.startDist > 0) {
            // Pinch: scale by finger separation, anchored at the midpoint so the
            // detail between the fingers stays put.
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const centre = toFrameCentre(midX, midY);
            const scaled = zoomAbout(
                g.startT, g.startT.scale * (dist / g.startDist), centre.x, centre.y,
                img.naturalWidth, img.naturalHeight, frameW, frameH,
            );
            applyCrop({ ...scaled, x: scaled.x + (midX - g.startX), y: scaled.y + (midY - g.startY) });
            return;
        }
        applyCrop({ ...g.startT, x: g.startT.x + (midX - g.startX), y: g.startT.y + (midY - g.startY) });
    };

    const endPointer = (e: React.PointerEvent) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size === 0) {
            gestureRef.current = null;
            setDragging(false);
            return;
        }
        // A finger lifted mid-pinch — re-seat the gesture origin on what is left
        // so the image does not jump.
        const pts = [...pointersRef.current.values()];
        gestureRef.current = {
            startT: t,
            startX: pts.reduce((s, p) => s + p.x, 0) / pts.length,
            startY: pts.reduce((s, p) => s + p.y, 0) / pts.length,
            startDist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
        };
    };

    // Non-passive wheel listener: React's onWheel is passive, so preventDefault
    // there is ignored and the surrounding settings pane scrolls while zooming.
    useEffect(() => {
        const el = stageRef.current;
        if (!el || !img) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const centre = toFrameCentre(e.clientX, e.clientY);
            setT(prev => zoomAbout(
                prev, prev.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), centre.x, centre.y,
                img.naturalWidth, img.naturalHeight, frameW, frameH,
            ));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [img, frameW, frameH, toFrameCentre]);

    // Escape is handled by the `ClModal` below through the shared stack — its
    // own `useEscape` layer registers only while THIS cropper is open, so on a
    // host settings modal + cropper stack the cropper (registered later, on
    // top) is what a press closes, and `onClose={busy ? noop : onCancel}`
    // already carries the busy guard. No separate listener needed here.

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!img) return;
        const step = e.shiftKey ? NUDGE_FAST : NUDGE;
        const pan = (dx: number, dy: number) => {
            e.preventDefault();
            applyCrop({ ...t, x: t.x + dx, y: t.y + dy });
        };
        switch (e.key) {
            case 'ArrowLeft':  pan(step, 0); break;
            case 'ArrowRight': pan(-step, 0); break;
            case 'ArrowUp':    pan(0, step); break;
            case 'ArrowDown':  pan(0, -step); break;
            case '+': case '=': e.preventDefault(); zoomTo(t.scale * 1.15); break;
            case '-': case '_': e.preventDefault(); zoomTo(t.scale / 1.15); break;
            default: break;
        }
    };

    const handleConfirm = async () => {
        if (!img || busy) return;
        setBusy(true);
        try {
            const blob = await renderCroppedBlob(
                img, t, frameW, frameH, outputWidth, outputHeight, quality,
            );
            onConfirm(blob);
        } catch {
            setError('Could not process that image.');
        } finally {
            setBusy(false);
        }
    };

    // Displayed image box, derived from the same cover-fit baseline the export
    // uses — so the preview is the export, scaled.
    const display = useMemo(() => {
        if (!img) return null;
        const base = Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);
        const s = base * t.scale;
        return { w: img.naturalWidth * s, h: img.naturalHeight * s };
    }, [img, t.scale, frameW, frameH]);

    return (
        <ClModal
            open={open}
            onClose={busy ? () => {} : onCancel}
            width={frameW + 56}
            label={title}
            overlayStyle={{ zIndex: CROPPER_Z, ...overlayStyle }}
        >
            <h4 style={{ margin: '0 0 4px', fontFamily: 'var(--cl-font-display)' }}>{title}</h4>
            <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--cl-muted)' }}>
                {hint ?? 'Drag to reposition, scroll or pinch to zoom.'}
            </p>

            {error && (
                <div
                    className="clcrop-err"
                    style={{
                        marginBottom: 14, padding: '9px 12px', borderRadius: 'var(--cl-r-md, 10px)',
                        fontSize: 12.5, textAlign: 'center',
                        background: 'rgba(255,107,94,.12)', border: '1px solid rgba(255,107,94,.3)',
                        color: 'var(--cl-flash)',
                    }}
                >
                    {error}
                </div>
            )}

            <div className="clcrop-stage-wrap" style={{ display: 'flex', justifyContent: 'center' }}>
                <div
                    ref={stageRef}
                    className={`clcrop-stage${dragging ? ' is-dragging' : ''}`}
                    style={{ width: frameW, height: frameH }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endPointer}
                    onPointerCancel={endPointer}
                    onKeyDown={onKeyDown}
                    tabIndex={img ? 0 : -1}
                    role="application"
                    aria-label="Crop area. Arrow keys reposition, plus and minus zoom."
                >
                    {img && display ? (
                        <img
                            className="clcrop-img"
                            src={displayUrl}
                            alt=""
                            draggable={false}
                            style={{
                                width: display.w,
                                height: display.h,
                                transform: `translate(calc(-50% + ${t.x}px), calc(-50% + ${t.y}px))`,
                                transition: dragging || reduced ? 'none' : 'width .12s linear, height .12s linear',
                            }}
                        />
                    ) : (
                        <div className="clcrop-loading">{error ? '—' : 'Loading…'}</div>
                    )}
                    <div
                        className="clcrop-mask"
                        style={{ borderRadius: shape === 'circle' ? '50%' : 'var(--cl-r-lg, 14px)' }}
                    />
                </div>
            </div>

            <div className="clcrop-controls">
                <ZoomIn size={15} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} aria-hidden />
                <ClSlider
                    value={t.scale}
                    min={1}
                    max={MAX_ZOOM}
                    step={0.01}
                    onChange={(v) => zoomTo(v)}
                    formatLabel={(v) => `${v.toFixed(1)}×`}
                    resetValue={1}
                    disabled={!img}
                    style={{ flex: 1 }}
                />
                <ClButton
                    icon
                    size="sm"
                    variant="ghost"
                    disabled={!img}
                    onClick={() => setT(IDENTITY_CROP)}
                    tooltip="Reset"
                >
                    <RotateCcw size={14} />
                </ClButton>
            </div>

            <div className="clcrop-actions">
                <ClButton variant="ghost" fullWidth disabled={busy} onClick={onCancel}>
                    Cancel
                </ClButton>
                <ClButton fullWidth disabled={!img || busy} loading={busy} onClick={handleConfirm}>
                    {confirmLabel}
                </ClButton>
            </div>
        </ClModal>
    );
};

export default ClImageCropper;
