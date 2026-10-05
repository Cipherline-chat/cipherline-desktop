/**
 * GifPlayer — animated GIF display with focus-aware and hover-controlled playback.
 *
 * Behaviour:
 *   • Window unfocused → GIF frozen on current frame, no play icon.
 *   • Window focused + autoPlayGifs=true (default) → GIF plays; no play icon.
 *   • Window focused + autoPlayGifs=false → GIF frozen until hovered; a small
 *     play icon sits in the top-right corner to signal "hover to play".  The
 *     icon disappears as soon as the cursor enters, and the GIF animates.
 *
 * OS "reduce motion" (prefers-reduced-motion: reduce) is treated exactly like
 * autoPlayGifs=false: frozen until hovered, with the play badge.
 *
 * Implementation: a hidden `<canvas>` holds the frozen frame (drawn via
 * drawImage when the transition play→pause is detected, or on first load).
 * When paused the canvas is shown and the `<img>` is hidden (display:none),
 * which also stops Chromium from ticking the GIF's animation loop — saving CPU.
 * When playing the img is shown and the canvas is hidden.
 */
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { useGifSettings } from '../hooks/useGifSettings';
import { useWindowFocus } from '../hooks/useWindowFocus';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';

export interface GifPlayerProps {
    src: string;
    alt?: string;
    /** CSS applied to the `<img>` element (and mirrored on the `<canvas>`
     *  so that both alternatives occupy the same layout space). */
    imgStyle?: React.CSSProperties;
    draggable?: boolean;
    /** Called when the user clicks anywhere on the component. */
    onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
    /** Forwarded from the img onLoad event. */
    onLoad?: () => void;
    /** Same moment as `onLoad`, with the event (e.g. to read naturalWidth). */
    onLoadImg?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
    /** Forwarded from the img onError event. */
    onError?: () => void;
    /** Set to 'no-referrer' for third-party media (KLIPY). */
    referrerPolicy?: React.HTMLAttributeReferrerPolicy;
    /** Extra style for the wrapper (e.g. fill a grid cell). */
    wrapperStyle?: React.CSSProperties;
}


export const GifPlayer: React.FC<GifPlayerProps> = ({
    src, alt, imgStyle, draggable = false, onClick, onLoad, onLoadImg, onError, referrerPolicy, wrapperStyle,
}) => {
    const { settings: { autoPlayGifs: autoPlaySetting } } = useGifSettings();
    const reducedMotion = usePrefersReducedMotion();
    const autoPlayGifs = autoPlaySetting && !reducedMotion;
    const windowFocused = useWindowFocus();
    const [isHovered, setIsHovered] = useState(false);
    const [imgLoaded, setImgLoaded] = useState(false);

    const imgRef    = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    /** shouldPlay = true → show <img> (animates); false → show <canvas> (frozen). */
    const shouldPlay = windowFocused && (autoPlayGifs || isHovered);

    // Play icon: only shown when the user has opted out of autoPlay and the
    // cursor is not over the GIF.  Window-unfocus pauses the GIF silently —
    // no icon needed there since it resumes automatically on refocus.
    const showPlayIcon = imgLoaded && !autoPlayGifs && !isHovered;

    // ── Frame capture ─────────────────────────────────────────────────────────

    const captureFrame = useCallback(() => {
        const img    = imgRef.current;
        const canvas = canvasRef.current;
        if (!img || !canvas || !img.complete || img.naturalWidth === 0) return;
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
    }, []);

    // The frozen frame is only ever shown while paused. Copying every GIF into
    // a full-size canvas the moment it loads (the old behaviour) cost a
    // main-thread drawImage per GIF and a second full-resolution bitmap per
    // GIF in memory, for the common case (autoplay on, window focused) where
    // the canvas is never displayed. Capture at load only when it starts
    // paused; otherwise the play→pause effect below captures on demand.
    const shouldPlayRef = useRef(shouldPlay);
    useLayoutEffect(() => { shouldPlayRef.current = shouldPlay; });
    const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        setImgLoaded(true);
        if (!shouldPlayRef.current) captureFrame();
        onLoad?.();
        onLoadImg?.(e);
    }, [captureFrame, onLoad, onLoadImg]);

    // Capture whenever we transition to the paused state so the canvas shows
    // the most recently displayed frame (not always frame 0). Layout effect:
    // runs before the paint that swaps <img> for <canvas>, so the canvas is
    // never shown blank (or at its default 300×150 size) for a frame.
    const prevShouldPlay = useRef(shouldPlay);
    useLayoutEffect(() => {
        if (prevShouldPlay.current && !shouldPlay && imgLoaded) {
            captureFrame();
        }
        prevShouldPlay.current = shouldPlay;
    }, [shouldPlay, imgLoaded, captureFrame]);

    return (
        <div
            style={{ position: 'relative', display: 'inline-block', ...wrapperStyle }}
            onClick={onClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Animated GIF — shown when playing */}
            <img
                ref={imgRef}
                src={src}
                alt={alt ?? ''}
                draggable={draggable}
                decoding="async"
                style={{ ...imgStyle, display: shouldPlay ? 'block' : 'none' }}
                onLoad={handleImgLoad}
                onError={onError}
                referrerPolicy={referrerPolicy}
            />

            {/* Frozen frame canvas — shown when paused */}
            <canvas
                ref={canvasRef}
                style={{
                    ...imgStyle,
                    display: (!shouldPlay && imgLoaded) ? 'block' : 'none',
                    borderRadius: imgStyle?.borderRadius,
                }}
            />

            {/* Skeleton while the image hasn't loaded yet and we're paused */}
            {!imgLoaded && !shouldPlay && (
                <div style={{
                    ...imgStyle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.05)',
                    minWidth: 80,
                    minHeight: 50,
                }} />
            )}

            {/* Top-right play badge — only visible when autoPlay is off and
                the cursor is not over the GIF.  Tells the user "hover to play." */}
            {showPlayIcon && (
                <div
                    style={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        background: 'rgba(0,0,0,0.6)',
                        backdropFilter: 'blur(3px)',
                        borderRadius: '50%',
                        width: 24,
                        height: 24,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                    }}
                >
                    <Play size={11} style={{ color: '#fff', fill: '#fff', marginLeft: 1 }} />
                </div>
            )}
        </div>
    );
};
