/**
 * GifPlayer — animated GIF display with focus-aware and hover-controlled playback.
 *
 * Behaviour:
 *   • Window unfocused → GIF frozen on current frame, no play icon.
 *   • Window focused + autoPlayGifs=true (default) → GIF plays; no play icon.
 *   • Window focused + mode "On hover" (the old "Automatically play GIFs" off) →
 *     GIF frozen until hovered or its badge focused; a small play icon sits in
 *     the top-right corner to signal "hover to play".
 *   • Mode "Never" → first frame only; the badge is a button that plays or
 *     pauses that one GIF.
 *
 * Reduced motion (OS or Settings → Accessibility) turns "Always" into
 * "On hover", exactly as the OS setting always did.
 *
 * Implementation: a hidden `<canvas>` holds the frozen frame (drawn via
 * drawImage when the transition play→pause is detected, or on first load).
 * When paused the canvas is shown and the `<img>` is hidden (display:none),
 * which also stops Chromium from ticking the GIF's animation loop — saving CPU.
 * When playing the img is shown and the canvas is hidden.
 *
 * `videoSrc` (a clmedia:// stream from the main process): the same GIF rule
 * for a GIF published as a muted mp4 loop (Tenor, Giphy, Imgur .gifv links,
 * embeds/GifLoopEmbed). A paused <video> already holds its frame, so no canvas.
 *
 * While the window is unfocused in the "Always" mode the GIF freezes and a
 * small "GIF" tag (aria-hidden) sits bottom-left, so a still frame does not
 * read as a photo (round 3, owner 2026-11-23). Every GifPlayer shows it.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { useGifPlayback } from '../hooks/useGifPlayback';
import { safeClmediaUrl } from '../utils/safeMediaUrl';
import { safeBlobUrl, safeImageSrc } from '../utils/safeMediaUrl';

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
    /** A GIF published as a muted video loop: a clmedia:// URL from main. Replaces `src`. */
    videoSrc?: string;
    /** The loop's natural size once known (videoSrc only). */
    onVideoSize?: (width: number, height: number) => void;
}


const BADGE_ICON: React.CSSProperties = { color: '#fff', fill: '#fff' };

export const GifPlayer: React.FC<GifPlayerProps> = ({
    src, alt, imgStyle, draggable = false, onClick, onLoad, onLoadImg, onError, referrerPolicy, wrapperStyle, videoSrc, onVideoSize,
}) => {
    const [imgLoaded, setImgLoaded] = useState(false);
    // Settings → Accessibility → Animated images (Always / On hover / Never),
    // window focus, hover and the per-GIF play badge: hooks/useGifPlayback.ts,
    // shared with the GIF-like video loops (embeds/GifLoopEmbed).
    const { shouldPlay, showPlayIcon, showFrozenTag, manualPlay, toggleManualPlay, hoverProps, badgeFocusProps } = useGifPlayback(imgLoaded);

    // Only a validated image URL (blob:, data:image/*, KLIPY / Cipherline media
    // https) is ever given to <img>. A rejected, non-empty src is reported the
    // same way a failed load is, so callers show their existing fallback.
    const safeSrc = videoSrc === undefined ? safeImageSrc(src) : undefined;
    // A loop is a clmedia:// stream from main, or (2026-11-24) the sender's decrypted copy of it: a blob: minted here.
    const safeVideo = videoSrc === undefined ? undefined : (safeClmediaUrl(videoSrc) ?? safeBlobUrl(videoSrc));
    useEffect(() => {
        if (videoSrc !== undefined ? !safeVideo : (src && !safeSrc)) onError?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fire per rejected src, not per render of an inline onError
    }, [src, safeSrc, videoSrc, safeVideo]);

    // Video loop: the GIF rule plays / pauses it (a paused video keeps its frame).
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const v = videoRef.current;
        if (!v || !safeVideo) return;
        if (shouldPlay) void v.play().catch(() => { /* not ready yet; autoPlay / the next change retries */ });
        else v.pause();
    }, [shouldPlay, safeVideo, imgLoaded]);

    const imgRef    = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

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
            {...hoverProps}
        >
            {videoSrc !== undefined ? (safeVideo ? (
                <video
                    ref={videoRef}
                    src={safeVideo}
                    muted
                    loop
                    playsInline
                    autoPlay={shouldPlay}
                    preload="auto"
                    disablePictureInPicture
                    aria-label={alt || 'GIF'}
                    style={{ ...imgStyle, display: 'block' }}
                    onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) onVideoSize?.(v.videoWidth, v.videoHeight); }}
                    onLoadedData={() => { setImgLoaded(true); onLoad?.(); }}
                    onError={onError}
                />
            ) : null) : (<>
                {/* Animated GIF — shown when playing */}
                <img
                    ref={imgRef}
                    src={safeSrc}
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
            </>)}

            {/* Skeleton while the image hasn't loaded yet and we're paused */}
            {!imgLoaded && !shouldPlay && videoSrc === undefined && (
                <div style={{
                    ...imgStyle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgb(var(--cl-bright-rgb) / 0.05)',
                    minWidth: 80,
                    minHeight: 50,
                }} />
            )}

            {/* Top-right play badge. A real button so it can be reached and
                operated from the keyboard: in "On hover" mode focusing it plays
                the GIF, in "Never" mode Enter / click plays or pauses this one. */}
            {showPlayIcon && <GifPlayBadge playing={manualPlay} onToggle={toggleManualPlay} {...badgeFocusProps} />}

            {/* Frozen only because the window lost focus ("Always" mode): say it is a GIF. */}
            {showFrozenTag && (
                <span
                    className="gif-frozen-tag"
                    aria-hidden="true"
                    style={{
                        position: 'absolute', left: 7, bottom: 7, pointerEvents: 'none',
                        font: '700 10.5px/1 var(--cl-font-mono)', letterSpacing: '.06em', color: BADGE_ICON.color,
                        background: 'rgb(var(--cl-shade-rgb) / 0.62)', backdropFilter: 'blur(4px)',
                        padding: '4px 6px', borderRadius: 6,
                    }}
                >GIF</span>
            )}
        </div>
    );
};

/** Top-right play badge. A real button so it can be reached and operated from
 *  the keyboard: in "On hover" mode focusing it plays the GIF, in "Never" mode
 *  Enter / click plays or pauses this one. Shared with embeds/GifLoopEmbed. */
export const GifPlayBadge: React.FC<{ playing: boolean; onToggle: () => void; onFocus: () => void; onBlur: () => void }> = ({ playing, onToggle, onFocus, onBlur }) => (
    <button
        type="button"
        className="gif-play-badge"
        aria-label={playing ? 'Pause animation' : 'Play animation'}
        aria-pressed={playing}
        onClick={e => { e.stopPropagation(); onToggle(); }}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'rgb(var(--cl-shade-rgb) / 0.6)',
            backdropFilter: 'blur(3px)',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            borderRadius: '50%',
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        }}
    >
        {playing
            ? <Pause size={11} style={BADGE_ICON} />
            : <Play size={11} style={{ ...BADGE_ICON, marginLeft: 1 }} />}
    </button>
);
