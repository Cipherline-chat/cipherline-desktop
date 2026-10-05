import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';

interface ImageLightboxProps {
    src: string;
    alt?: string;
    filename?: string;
    externalUrl?: string;
    /** Set to 'no-referrer' for third-party hosts (e.g. KLIPY) that must not learn the app origin. */
    referrerPolicy?: React.ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
    onClose: () => void;
}

const ZOOM_SCALE     = 2.5;   // scale applied on click-to-zoom
const DRAG_THRESHOLD = 4;     // px movement to differentiate click vs drag

export const ImageLightbox: React.FC<ImageLightboxProps> = ({ src, alt, filename, referrerPolicy, onClose }) => {
    const [phase, setPhase]         = useState<'in' | 'idle' | 'out'>('in');
    const [zoomed, setZoomed]       = useState(false);
    const [dragging, setDragging]   = useState(false);
    const [translate, setTranslate] = useState({ x: 0, y: 0 });
    const [pinchScale, setPinchScale] = useState(ZOOM_SCALE); // zoom level while zoomed

    const dragData = useRef<{
        startX: number; startY: number;
        tx: number;     ty: number;
        moved: boolean;
    } | null>(null);

    // After 'in' anim, go idle so zoom transforms don't fight entrance anim
    useEffect(() => {
        if (phase !== 'in') return;
        const t = setTimeout(() => setPhase('idle'), 240);
        return () => clearTimeout(t);
    }, [phase]);

    const dismiss = useCallback(() => {
        // Snap zoom out first so the exit scale is clean
        setZoomed(false);
        setTranslate({ x: 0, y: 0 });
        setPhase('out');
    }, []);

    useEscape(dismiss);

    // Scroll-to-zoom
    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            setPinchScale(s => {
                const next = Math.min(Math.max(s * factor, 0.5), 10);
                if (next < 1.05) {
                    setZoomed(false);
                    setTranslate({ x: 0, y: 0 });
                    return ZOOM_SCALE;
                }
                setZoomed(true);
                return next;
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // Mouse down → start potential drag
    const onImgMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragData.current = {
            startX: e.clientX, startY: e.clientY,
            tx: translate.x,   ty: translate.y,
            moved: false,
        };
        setDragging(true);
    };

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const d = dragData.current;
            if (!d) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
            if (d.moved && zoomed) setTranslate({ x: d.tx + dx, y: d.ty + dy });
        };

        const onUp = () => {
            const d = dragData.current;
            if (!d) return;
            const wasMoved = d.moved;
            dragData.current = null;
            setDragging(false);

            if (!wasMoved) {
                // Toggle zoom on clean click
                if (zoomed) {
                    setZoomed(false);
                    setPinchScale(ZOOM_SCALE);
                    setTranslate({ x: 0, y: 0 });
                } else {
                    setZoomed(true);
                }
            }
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [zoomed]);

    const imgScale = zoomed ? pinchScale : 1;
    const imgTransition = dragging
        ? 'border-radius 0.2s'
        : 'transform 0.28s cubic-bezier(0.34,1.15,0.64,1), border-radius 0.2s';

    // Cursor
    const imgCursor = zoomed
        ? (dragging ? 'grabbing' : 'grab')
        : 'zoom-in';

    return createPortal(
        <>
            <style>{`
                @keyframes lb-bg-in  { from { opacity: 0 } to { opacity: 1 } }
                @keyframes lb-bg-out { from { opacity: 1 } to { opacity: 0 } }
                @keyframes lb-in     { from { opacity: 0; transform: scale(0.9) }
                                        to  { opacity: 1; transform: scale(1)   } }
                @keyframes lb-out    { from { opacity: 1; transform: scale(1)   }
                                        to  { opacity: 0; transform: scale(0.9) } }
            `}</style>

            {/* Dark backdrop */}
            <div
                style={{
                    position: 'fixed', inset: 0, zIndex: 10002,
                    background: 'rgba(0,0,0,0.92)',
                    animation: phase === 'out'
                        ? 'lb-bg-out 0.22s ease forwards'
                        : 'lb-bg-in  0.22s ease forwards',
                }}
                onAnimationEnd={() => { if (phase === 'out') onClose(); }}
                // Stop both mousedown and click — without this, the closing
                // click bubbles via the React portal up to the chat row's
                // onClick (it bubbles through the React tree even though the
                // backdrop renders into document.body) and toggles save on
                // the underlying message. That's the "clicking an image
                // saves it" bug.
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); dismiss(); }}
            />

            {/* X button — above backdrop */}
            <div
                style={{
                    position: 'fixed', top: 48, right: 16, zIndex: 10004,
                    animation: phase === 'out'
                        ? 'lb-bg-out 0.22s ease forwards'
                        : 'lb-bg-in  0.22s ease forwards',
                }}
            >
                <ClButton
                    icon
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); dismiss(); }}
                    tooltip="Close (Esc)"
                >
                    <X size={16} strokeWidth={2.5} />
                </ClButton>
            </div>

            {/* Image — above backdrop, below X button */}
            <div
                ref={containerRef}
                style={{
                    position: 'fixed', inset: 0, zIndex: 10003,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden',
                    cursor: imgCursor,
                    pointerEvents: phase === 'out' ? 'none' : 'auto',
                    animation: phase === 'in'
                        ? 'lb-in  0.24s cubic-bezier(0.34,1.56,0.64,1) forwards'
                        : phase === 'out'
                        ? 'lb-out 0.2s ease forwards'
                        : 'none',
                }}
                // Same reason as the backdrop: stop bubbling so the closing
                // click on empty space around the image doesn't reach the
                // chat row's onClick and toggle save.
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); dismiss(); }}
            >
                <img
                    src={src}
                    alt={alt || filename || ''}
                    referrerPolicy={referrerPolicy}
                    draggable={false}
                    onMouseDown={onImgMouseDown}
                    onClick={e => e.stopPropagation()}
                    style={{
                        display: 'block',
                        maxWidth:  zoomed ? undefined : '90vw',
                        maxHeight: zoomed ? undefined : '90vh',
                        borderRadius: zoomed ? 4 : 10,
                        boxShadow: '0 20px 80px rgba(0,0,0,0.85)',
                        transform: `translate(${translate.x}px, ${translate.y}px) scale(${imgScale})`,
                        transformOrigin: 'center center',
                        transition: phase === 'idle' ? imgTransition : 'none',
                        cursor: imgCursor,
                        userSelect: 'none',
                        pointerEvents: 'auto',
                    }}
                />
            </div>
        </>,
        document.body,
    );
};
