import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useEscape } from '../../../hooks/useEscape';
import { useDismissOnOutsideClick } from '../../../hooks/useDismissOnOutsideClick';
import '../../../styles/settings-ui.css';

/**
 * One settings row that shows the CURRENT choice and opens a popover to change
 * it: label + value on the row, the full catalogue only on demand. It replaces
 * the always-open tile grids that made the Profile pane long.
 *
 *  - The panel is portaled to <body> (no overflow clipping inside Settings) and
 *    placed under the row, or above it when there is no room below.
 *  - Escape closes it through the shared escape stack, so it never also closes
 *    Settings; a click outside closes it and is swallowed (useDismissOnOutsideClick).
 *  - Focus moves into the panel on open (the checked option, else the first
 *    focusable), returns to the row on close, and leaving the panel with Tab
 *    closes it. The panel is `role="dialog"`, labelled by the row.
 *  - Reduced motion: no entrance animation (CSS).
 */
export interface PickerPopoverProps {
    label: string;
    /** What the row shows for the current choice (thumbnail + name). */
    value: React.ReactNode;
    /** Optional second line under the label. */
    hint?: React.ReactNode;
    disabled?: boolean;
    /** Panel width in px (clamped to the window). */
    width?: number;
    /** Panel content; call `close()` when a pick should dismiss the panel. */
    children: (close: () => void) => React.ReactNode;
    /**
     * `row` (default): label + hint on the left, the current value as a button
     * on the right. `tile`: one compact button - a preview, the label and the
     * current value - for a grid of pickers (the Profile pane's Style section).
     */
    variant?: 'row' | 'tile';
    /** Tile only: the visual for the current choice (a swatch, your avatar wearing it...). */
    preview?: React.ReactNode;
    /** Told whenever the panel opens or closes (e.g. to drop a try-on preview, or commit a draft). */
    onOpenChange?: (open: boolean) => void;
}

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
const GAP = 6;
const EDGE = 12;

type Placement = { top?: number; bottom?: number; left: number; width: number; maxHeight: number };

/** Calls the render-prop with `close` as a prop (so the callback is not read as a ref access during render). */
const PanelBody: React.FC<{ render: (close: () => void) => React.ReactNode; close: () => void }> = ({ render, close }) => <>{render(close)}</>;

export const PickerPopover: React.FC<PickerPopoverProps> = ({ label, value, hint, disabled, width = 380, children, variant = 'row', preview, onOpenChange }) => {
    const [open, setOpen] = useState(false);
    const openChange = useRef(onOpenChange);
    useEffect(() => { openChange.current = onOpenChange; });
    const wasOpen = useRef(false);
    useEffect(() => {
        if (wasOpen.current === open) return;
        wasOpen.current = open;
        openChange.current?.(open);
    }, [open]);
    const [pos, setPos] = useState<Placement | null>(null);
    const [z, setZ] = useState(9999);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const labelId = useId();
    const panelId = useId();

    const close = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
    }, []);

    useEscape(close, open);
    const isInside = useCallback((t: Node) => !!(triggerRef.current?.contains(t) || panelRef.current?.contains(t)), []);
    useDismissOnOutsideClick(isInside, open, () => setOpen(false));

    const place = useCallback(() => {
        const t = triggerRef.current;
        if (!t) return;
        const r = t.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.min(width, vw - EDGE * 2);
        const left = Math.max(EDGE, Math.min(r.right - w, vw - w - EDGE));
        const below = vh - r.bottom - GAP - EDGE;
        const above = r.top - GAP - EDGE;
        // Prefer below; flip when there is clearly more room above.
        if (below >= 280 || below >= above) setPos({ top: r.bottom + GAP, left, width: w, maxHeight: Math.max(160, below) });
        else setPos({ bottom: vh - r.top + GAP, left, width: w, maxHeight: Math.max(160, above) });
        let maxZ = 9999;
        document.querySelectorAll<HTMLElement>('.mod.open').forEach((el) => {
            const zi = parseInt(getComputedStyle(el).zIndex, 10);
            if (!Number.isNaN(zi) && zi > maxZ) maxZ = zi;
        });
        setZ(maxZ + 1);
    }, [width]);

    useLayoutEffect(() => { if (open) place(); }, [open, place]);
    useEffect(() => {
        if (!open) return;
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
    }, [open, place]);

    // Move focus into the panel once it is placed.
    const placed = !!pos;
    useEffect(() => {
        if (!open || !placed) return;
        const raf = requestAnimationFrame(() => {
            const el = panelRef.current;
            if (!el || el.contains(document.activeElement)) return;
            const target = el.querySelector<HTMLElement>('[aria-checked="true"],[aria-pressed="true"]')
                ?? el.querySelector<HTMLElement>(FOCUSABLE);
            (target ?? el).focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(raf);
    }, [open, placed]);

    const toggle = () => { if (open) setOpen(false); else { setPos(null); setOpen(true); } };
    const trigger = variant === 'tile' ? (
        <button
            ref={triggerRef}
            type="button"
            className="ps-tile"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-labelledby={`${labelId} ${labelId}-v`}
            disabled={disabled}
            onClick={toggle}
        >
            <span className="ps-tile-prev" aria-hidden="true">{preview}</span>
            <span className="ps-tile-txt">
                <span id={labelId} className="ps-tile-label">{label}</span>
                <span id={`${labelId}-v`} className="ps-tile-value">{value}</span>
            </span>
            <ChevronDown size={14} className="su-pick-chev" aria-hidden="true" />
        </button>
    ) : (
        <>
            <div className="su-pick-text">
                <span id={labelId} className="su-pick-label">{label}</span>
                {hint && <span className="su-pick-hint">{hint}</span>}
            </div>
            <button
                ref={triggerRef}
                type="button"
                className="su-pick-trigger"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-labelledby={labelId}
                disabled={disabled}
                onClick={toggle}
            >
                <span className="su-pick-value">{value}</span>
                <ChevronDown size={14} className="su-pick-chev" aria-hidden="true" />
            </button>
        </>
    );

    return (
        <div className={variant === 'tile' ? 'ps-tile-host' : 'su-pick'}>
            {trigger}
            {open && createPortal(
                <div
                    ref={panelRef}
                    id={panelId}
                    role="dialog"
                    aria-labelledby={labelId}
                    tabIndex={-1}
                    className="su-pop custom-scrollbar"
                    style={{ position: 'fixed', zIndex: z, left: pos?.left ?? 0, width: pos?.width ?? width, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden' }}
                    onBlur={(e) => {
                        // Tabbing out of the panel closes it.
                        const next = e.relatedTarget as Node | null;
                        if (next && !panelRef.current?.contains(next) && !triggerRef.current?.contains(next)) setOpen(false);
                    }}
                >
                    <PanelBody render={children} close={close} />
                </div>,
                document.body,
            )}
        </div>
    );
};
