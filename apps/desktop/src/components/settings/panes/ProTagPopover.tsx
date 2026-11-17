import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crown } from 'lucide-react';
import { computeTooltipPlacement, type TooltipPlacement } from '../../cl/tooltipPlacement';
import { useEscape } from '../../../hooks/useEscape';

/**
 * The little "Custom #numbers are a Pro feature" box with the yellow crown
 * (owner, 2026-11-16), for the locked #number segment of the username field.
 * Shared by Settings -> Profile (desktop) and the website account portal, which
 * imports this file from desktop source (like utils/discriminatorField).
 * React + react-dom + lucide only, so it builds on the website too.
 *
 * Opens on hover (mouse), on click / tap, and on keyboard focus of the anchor;
 * closes on leave (unless it was opened by a click), blur, Escape, a click
 * elsewhere, scroll or resize. It never opens a sheet or a modal - the segment
 * just stays read-only.
 *
 * Rendered through a portal with position: fixed (the field box clips its
 * children: overflow hidden for the rounded corners), placed with the kit's
 * tooltip math, below the anchor by preference. ARIA: role="tooltip" with an
 * id; spread `describedBy` onto the focusable input's aria-describedby.
 */

/** Same patient reveal as the kit tooltips, so a pass-over does not flash it. */
const HOVER_OPEN_DELAY_MS = 150;
/** Above modal overlays (max 100000), below the screen lock; = TOOLTIP_Z_INDEX. */
const Z = 200000;

export interface ProTagPopover {
    open: boolean;
    /** Spread onto the element the box points at (the #number segment). */
    anchorProps: {
        setAnchor: (node: HTMLElement | null) => void;
        onPointerEnter: (e: React.PointerEvent) => void;
        onPointerLeave: () => void;
        onClick: () => void;
        onFocus: () => void;
        onBlur: () => void;
    };
    /** The id to add to the input's aria-describedby while open (else undefined). */
    describedBy: string | undefined;
    /** Render anywhere; it portals itself to document.body. */
    popover: React.ReactNode;
}

export function useProTagPopover(enabled: boolean, message: string, testId = 'pro-tag-popover'): ProTagPopover {
    const id = `${useId()}-protip`;
    const anchor = useRef<HTMLElement | null>(null);
    const box = useRef<HTMLDivElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [open, setOpen] = useState(false);
    /** Opened by a click / tap: stays until dismissed (leave does not close it). */
    const pinned = useRef(false);
    const [place, setPlace] = useState<TooltipPlacement | null>(null);

    const cancel = useCallback(() => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } }, []);
    const close = useCallback(() => { cancel(); pinned.current = false; setOpen(false); setPlace(null); }, [cancel]);
    useEffect(() => cancel, [cancel]);

    const setAnchor = useCallback((node: HTMLElement | null) => { anchor.current = node; }, []);

    useLayoutEffect(() => {
        if (!open || !anchor.current || !box.current) return;
        const a = anchor.current.getBoundingClientRect();
        const t = box.current.getBoundingClientRect();
        const next = computeTooltipPlacement(
            { left: a.left, top: a.top, width: a.width, height: a.height },
            { width: t.width, height: t.height },
            { width: window.innerWidth, height: window.innerHeight },
            { preferred: 'bottom' },
        );
        setPlace((p) => (p && p.left === next.left && p.top === next.top && p.side === next.side ? p : next));
    }, [open, message]);

    // Escape through the shared stack (like the kit tooltips): a press closes
    // this box only, not the Settings window or dialog underneath it.
    useEscape(close, open);

    // Dismissal: a click outside the anchor and the box, scroll, resize.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node | null;
            if (t && (anchor.current?.contains(t) || box.current?.contains(t))) return;
            close();
        };
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [open, close]);

    // Stable handlers (they only touch refs / setState inside events, never in render).
    const anchorProps = useMemo<ProTagPopover['anchorProps']>(() => ({
        setAnchor,
        onPointerEnter: (e) => {
            if (!enabled || e.pointerType === 'touch') return;
            cancel();
            timer.current = setTimeout(() => { timer.current = null; setOpen(true); }, HOVER_OPEN_DELAY_MS);
        },
        onPointerLeave: () => { cancel(); if (!pinned.current) close(); },
        onClick: () => { if (!enabled) return; cancel(); pinned.current = true; setOpen(true); },
        onFocus: () => { if (enabled) setOpen(true); },
        // Focus left the segment (Tab away, or a click elsewhere): always close.
        onBlur: () => close(),
    }), [enabled, cancel, close, setAnchor]);

    const popover = open && enabled && typeof document !== 'undefined'
        ? createPortal(
            <div
                ref={box}
                id={id}
                role="tooltip"
                data-testid={testId}
                data-side={place?.side ?? 'bottom'}
                style={{
                    position: 'fixed',
                    left: place ? place.left : 0,
                    top: place ? place.top : 0,
                    visibility: place ? 'visible' : 'hidden',
                    zIndex: Z,
                    maxWidth: 280,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 10,
                    background: 'var(--cl-abyss, #0B1020)',
                    color: 'var(--cl-text, #F4F7FF)',
                    border: '1px solid rgba(255, 201, 77, .45)',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, .4)',
                    font: "700 12.5px/1.35 var(--cl-font-body, 'Nunito', sans-serif)",
                    pointerEvents: 'auto',
                }}
            >
                <Crown size={15} strokeWidth={2.4} aria-hidden="true" color="var(--cl-glow, #FFC94D)" style={{ flex: 'none' }} />
                <span>{message}</span>
            </div>,
            document.body,
        )
        : null;

    return { open: open && enabled, anchorProps, describedBy: open && enabled ? id : undefined, popover };
}
