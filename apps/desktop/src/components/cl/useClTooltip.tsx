import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeTooltipPlacement, type TooltipPlacement, type TooltipSide } from './tooltipPlacement';
import { useEscape } from '../../hooks/useEscape';

/**
 * Hover/focus tooltips for the kit.
 *
 * The original implementation rendered `<span class="tip2">` as an ordinary
 * absolutely-positioned sibling *inside* the `.clb` button wrapper. That broke
 * in three separate ways, all of which show up on real screens:
 *
 *  1. **Clipping.** Any ancestor with `overflow: hidden|auto` (scroll bodies,
 *     modal cards, the call rail) cut the tooltip off, and any ancestor with a
 *     `transform` re-based its containing block.
 *  2. **Stacking.** `z-index: 6` inside the button's own stacking context sits
 *     far below the modal layer (overlays run from 1000 up to 100000), so a
 *     tooltip on a control inside a modal rendered *behind* the modal.
 *  3. **No collision handling.** It was hard-pinned above the anchor and
 *     centred on it, so a button near the top or the right edge — a modal's
 *     close X being the canonical case — pushed its tooltip off-screen.
 *
 * This module renders tooltips through a single portal to `document.body` with
 * `position: fixed`, computes placement from `getBoundingClientRect()`, flips
 * top↔bottom and clamps horizontally on collision, and sits above every modal
 * layer. Placement math lives in `tooltipPlacement.ts` and is unit-tested.
 *
 * Only React + react-dom are used here: this file is reachable from the website
 * through the `@app-cl` alias, which has no Electron and no LiveKit.
 */

/** Matches the historical `.tip2` `transition-delay: .4s` patient reveal. */
const HOVER_OPEN_DELAY_MS = 400;

/** Above every modal overlay (max 100000) and below the screen lock (999999). */
export const TOOLTIP_Z_INDEX = 200000;

interface TooltipState {
    placement: TooltipPlacement | null;
    /** Set one frame after placement so the fade/spring transition can run. */
    shown: boolean;
}

const CLOSED: TooltipState = { placement: null, shown: false };

export interface UseClTooltipResult {
    /** Spread onto the element the tooltip should describe/anchor to. */
    anchorProps: {
        ref: (node: HTMLElement | null) => void;
        onPointerEnter: (e: React.PointerEvent) => void;
        onPointerLeave: () => void;
        onPointerDown: () => void;
        onFocus: (e: React.FocusEvent) => void;
        onBlur: () => void;
    };
    /** Render this next to the anchor — it portals itself to `document.body`. */
    tooltip: React.ReactNode;
    /** Wire to the interactive element as `aria-describedby` when open. */
    describedBy: string | undefined;
}

/**
 * Returns props to spread on an anchor plus the portal node to render.
 *
 * Passing `undefined`/`null`/empty-string content disables everything — no
 * listeners fire and no portal is created, so untooltipped buttons pay
 * nothing. `text` is typed as `ReactNode` (not just `string`) so a caller that
 * needs an icon alongside the label — see `StatusPicker`'s "Playing X" tip —
 * doesn't have to give that up to get the portal/collision handling.
 */
export function useClTooltip(
    text: React.ReactNode,
    options: { preferred?: TooltipSide; wide?: boolean } = {},
): UseClTooltipResult {
    // `wide` swaps the pill for a wrapping panel. The default `.cl-tip2` is
    // `white-space:nowrap` + `text-overflow:ellipsis`, which silently truncates
    // anything longer than a label — fine for "Mute", wrong for a tooltip whose
    // whole job is to EXPLAIN something (the verification badge's "why is this
    // yellow"). Truncating an explanation to one ellipsised line is worse than
    // having none, so those opt in here rather than being quietly cut off.
    const { preferred, wide } = options;
    const id = useId();
    const enabled = !!text;

    const anchorRef = useRef<HTMLElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<TooltipState>(CLOSED);

    const cancelPending = useCallback(() => {
        if (openTimer.current !== null) {
            clearTimeout(openTimer.current);
            openTimer.current = null;
        }
    }, []);

    const close = useCallback(() => {
        cancelPending();
        setOpen(false);
        setState(CLOSED);
    }, [cancelPending]);

    const setRef = useCallback((node: HTMLElement | null) => {
        anchorRef.current = node;
        if (!node) close();
    }, [close]);

    const openAfter = useCallback((delay: number) => {
        cancelPending();
        if (delay <= 0) { setOpen(true); return; }
        openTimer.current = setTimeout(() => {
            openTimer.current = null;
            setOpen(true);
        }, delay);
    }, [cancelPending]);

    const onPointerEnter = useCallback((e: React.PointerEvent) => {
        // Touch "hover" is a long-press artefact; leave those alone.
        if (e.pointerType === 'touch') return;
        openAfter(HOVER_OPEN_DELAY_MS);
    }, [openAfter]);

    const onFocus = useCallback((e: React.FocusEvent) => {
        // Keyboard focus only — a click already focuses the button, and showing
        // a tooltip on the thing you just clicked is noise.
        const target = e.target as HTMLElement;
        if (typeof target.matches === 'function' && !target.matches(':focus-visible')) return;
        openAfter(0);
    }, [openAfter]);

    // Measure and place before paint, so the tooltip never renders mispositioned.
    useLayoutEffect(() => {
        if (!open) return;
        const anchor = anchorRef.current;
        const tip = tipRef.current;
        if (!anchor || !tip) return;
        const a = anchor.getBoundingClientRect();
        const t = tip.getBoundingClientRect();
        const next = computeTooltipPlacement(
            { left: a.left, top: a.top, width: a.width, height: a.height },
            { width: t.width, height: t.height },
            { width: window.innerWidth, height: window.innerHeight },
            { preferred },
        );
        // Bail when the measurement is unchanged. `text` is in the deps because
        // its content genuinely changes the tooltip's size — but a caller that
        // passes a ReactNode built inline hands us a NEW node identity on every
        // render, so an unconditional setState here re-renders, re-runs this
        // effect, and blows the update depth ("Maximum update depth exceeded")
        // the moment such a tooltip opens. Callers should memoize, and the
        // badge does; the shared primitive must not depend on them remembering.
        setState((prev) => {
            const p = prev.placement;
            if (p && p.side === next.side && p.left === next.left && p.top === next.top) return prev;
            return { placement: next, shown: false };
        });
    }, [open, text, preferred, wide]);

    // Flip to `shown` a frame later so the opacity/transform transition plays.
    useEffect(() => {
        if (!state.placement || state.shown) return;
        const raf = requestAnimationFrame(() => setState((s) => (s.placement ? { ...s, shown: true } : s)));
        return () => cancelAnimationFrame(raf);
    }, [state.placement, state.shown]);

    // Anything that moves the anchor or changes intent dismisses the tooltip.
    useEffect(() => {
        if (!open) return;
        // Capture-phase scroll catches scrolling in any ancestor, not just window.
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
        };
    }, [open, close]);

    // Escape through the shared stack — a tooltip open over a dialog should
    // dismiss on its own press without also closing the dialog underneath it.
    useEscape(close, open);

    useEffect(() => cancelPending, [cancelPending]);

    const noop = useCallback(() => { /* disabled */ }, []);

    if (!enabled) {
        return {
            anchorProps: {
                ref: setRef,
                onPointerEnter: noop,
                onPointerLeave: noop,
                onPointerDown: noop,
                onFocus: noop,
                onBlur: noop,
            },
            tooltip: null,
            describedBy: undefined,
        };
    }

    const { placement, shown } = state;
    const node = open && typeof document !== 'undefined'
        ? createPortal(
            <div
                ref={tipRef}
                id={id}
                role="tooltip"
                className={`cl-tip2${wide ? ' cl-tip2--wide' : ''}${shown ? ' in' : ''}`}
                data-side={placement?.side ?? 'top'}
                style={{
                    position: 'fixed',
                    // Park it off the flow until measured, so the pre-placement
                    // frame can't produce a flash at the top-left corner.
                    left: placement ? placement.left : 0,
                    top: placement ? placement.top : 0,
                    visibility: placement ? 'visible' : 'hidden',
                    zIndex: TOOLTIP_Z_INDEX,
                }}
            >
                {text}
            </div>,
            document.body,
        )
        : null;

    return {
        anchorProps: {
            ref: setRef,
            onPointerEnter,
            onPointerLeave: close,
            onPointerDown: close,
            onFocus,
            onBlur: close,
        },
        tooltip: node,
        describedBy: open && shown ? id : undefined,
    };
}

export default useClTooltip;
