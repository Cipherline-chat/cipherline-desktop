import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { computeTooltipPlacement, type TooltipPlacement } from '../cl/tooltipPlacement';
import { TOOLTIP_Z_INDEX } from '../cl/useClTooltip';
import { useEscape } from '../../hooks/useEscape';

/**
 * The small "i" next to a settings label: the explanation a row used to print
 * as an inline paragraph, one hover / tap / Tab away instead.
 *
 * - A real <button> named "About <setting>". Hover or keyboard focus shows the
 *   note; a click (or tap) pins it until you click again, click elsewhere,
 *   Tab away or press Escape.
 * - While shown, the button carries aria-expanded="true" and aria-describedby
 *   pointing at the note (role="tooltip"), so a screen reader reads it with
 *   the button.
 * - The note portals to <body> with position:fixed (above every modal layer,
 *   the same z the kit's tooltips use), so the settings scroll container never
 *   clips it; placement flips above/below and clamps inside the window.
 * - Escape goes through the shared escape stack (useEscape), so it closes the
 *   note first and leaves Settings open; a second Escape closes Settings.
 * - Hover is forgiving (WCAG 1.4.13): moving the pointer onto the note keeps it.
 *
 * Settings-local on purpose: components/cl/ is also compiled into the website.
 */
export interface InfoTipProps {
    /** The setting's name, for the button's accessible name ("About <label>"). */
    label: string;
    children: React.ReactNode;
}

/** How long the pointer may be off both the button and the note before it hides. */
const HOVER_GRACE_MS = 140;

export const InfoTip: React.FC<InfoTipProps> = ({ label, children }) => {
    const tipId = useId();
    const btnRef = useRef<HTMLButtonElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [place, setPlace] = useState<TooltipPlacement | null>(null);
    const pinned = useRef(false);
    const hideTimer = useRef<number | null>(null);

    const cancelHide = () => {
        if (hideTimer.current !== null) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
    };
    const close = useCallback(() => {
        cancelHide();
        pinned.current = false;
        setOpen(false);
    }, []);
    const show = () => { cancelHide(); setOpen(true); };
    const hideSoon = () => {
        if (pinned.current) return;
        cancelHide();
        hideTimer.current = window.setTimeout(() => { hideTimer.current = null; setOpen(false); }, HOVER_GRACE_MS);
    };

    useEffect(() => () => cancelHide(), []);
    useEscape(close, open);

    const measure = useCallback(() => {
        const a = btnRef.current, t = tipRef.current;
        if (!a || !t) return;
        const r = a.getBoundingClientRect();
        // Scrolled out of the window: nothing left to point at.
        if (r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
        setPlace(computeTooltipPlacement(
            { left: r.left, top: r.top, width: r.width, height: r.height },
            { width: t.offsetWidth, height: t.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
            { preferred: 'top', gap: 8 },
        ));
    }, [close]);

    // Measured before paint on every open, so a position left over from the
    // last time is never shown.
    useLayoutEffect(() => {
        if (open) measure();
    }, [open, measure]);

    useEffect(() => {
        if (!open) return;
        // capture: the settings column scrolls, not the window
        window.addEventListener('scroll', measure, true);
        window.addEventListener('resize', measure);
        return () => {
            window.removeEventListener('scroll', measure, true);
            window.removeEventListener('resize', measure);
        };
    }, [open, measure]);

    const onClick = () => {
        if (pinned.current) { close(); return; }
        pinned.current = true;
        show();
    };

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className="vv-info"
                aria-label={`About ${label}`}
                aria-expanded={open}
                aria-describedby={open ? tipId : undefined}
                data-open={open ? 'true' : undefined}
                onClick={onClick}
                onPointerEnter={e => { if (e.pointerType === 'mouse') show(); }}
                onPointerLeave={e => { if (e.pointerType === 'mouse') hideSoon(); }}
                onFocus={show}
                onBlur={close}
            >
                <Info size={14} strokeWidth={2.2} aria-hidden="true" />
            </button>
            {open && typeof document !== 'undefined' && createPortal(
                <div
                    ref={tipRef}
                    id={tipId}
                    role="tooltip"
                    className="vv-tip"
                    data-side={place?.side ?? 'top'}
                    style={{
                        position: 'fixed',
                        left: place?.left ?? 0,
                        top: place?.top ?? 0,
                        zIndex: TOOLTIP_Z_INDEX,
                        visibility: place ? 'visible' : 'hidden',
                    }}
                    onPointerEnter={cancelHide}
                    onPointerLeave={e => { if (e.pointerType === 'mouse') hideSoon(); }}
                    // Keep focus on the button: pressing on the note must not blur-close it.
                    onMouseDown={e => e.preventDefault()}
                >
                    {children}
                </div>,
                document.body,
            )}
        </>
    );
};

export default InfoTip;
