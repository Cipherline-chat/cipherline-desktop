import React, { useCallback, useEffect, useRef } from 'react';
import { wireClButton } from '../utils/clPhysics';
import { useClTooltip } from './cl/useClTooltip';

interface ClButtonProps {
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: 'primary' | 'ghost' | 'danger' | 'ok';
    size?: 'sm' | 'lg';
    /** Circular icon button (guide `clb--icon`). */
    icon?: boolean;
    fullWidth?: boolean;
    type?: 'button' | 'submit' | 'reset';
    className?: string;
    style?: React.CSSProperties;
    /**
     * Meaning-matched icon animation played on release (guide `data-anim`).
     * The animated icon in `children` must carry className `ico`.
     */
    pressAnim?: 'send' | 'leave' | 'trash' | 'star' | 'mute' | 'unmute';
    /**
     * Hover tooltip — patient 400ms spring-down on icon buttons, and shown
     * immediately on keyboard focus. Rendered through a portal to `document.body`
     * with viewport collision handling (see `cl/useClTooltip.tsx`), so it is never
     * clipped by an `overflow` ancestor, never trapped under a modal, and never
     * pushed off-screen by an edge-hugging anchor.
     */
    tooltip?: string;
    /**
     * Side the tooltip tries first. Defaults to `'top'`; it flips automatically
     * when the preferred side would clip, so this is only a hint.
     */
    tooltipSide?: 'top' | 'bottom';
    /**
     * Toggled-on / muted state (guide `muted` class) — draws the `.slash` path
     * in the icon for mute/camera call controls. The icon must include a
     * `<path className="slash" …>`.
     */
    active?: boolean;
    /**
     * Pill chip button (app extension `clb--chip`). Uppercase 11px pill shape.
     * Combine with `variant="ghost"` and `active={enabled}` for permission chips.
     * State classes on `className` proxy to `.cap`: `perm-danger` (red glow when
     * active), `perm-inherited` (locked grey, non-interactive).
     */
    chip?: boolean;
    /**
     * Compact list-item row button (app extension `clb--row`). Gives the `.cap`
     * tight padding (7px 10px) and left-aligned content — for sidebar tabs, menu
     * rows, channel list items. Combine with `fullWidth` and `variant="ghost"`.
     */
    row?: boolean;
    /** Forwarded to the underlying native `<button>` — focuses it on mount. */
    autoFocus?: boolean;
}

/**
 * The button — guide markup verbatim: `.clb` wrapper, two depth sheets
 * (`.l.l2` / `.l.l1`), the `.cap` surface, and the crush `.bloom`. Physics
 * (glowspot, seat-and-bulge, bloom, icon anim) are wired by wireClButton
 * against the guide's exact classes. Styles live in cl-kit.css (verbatim).
 */
export const ClButton: React.FC<ClButtonProps> = ({
    children, onClick, disabled, loading,
    variant = 'primary', size, icon, fullWidth, row, chip, type = 'button', className, style, pressAnim,
    tooltip, tooltipSide, active, autoFocus,
}) => {
    const nodeRef = useRef<HTMLSpanElement | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const { anchorProps, tooltip: tooltipNode, describedBy } = useClTooltip(tooltip, { preferred: tooltipSide });
    const { ref: tooltipAnchorRef, ...tooltipHandlers } = anchorProps;
    const wrapRef = useCallback((node: HTMLSpanElement | null) => {
        cleanupRef.current?.();
        nodeRef.current = node;
        cleanupRef.current = node ? wireClButton(node) : null;
        // The tooltip anchors to the same `.clb` wrapper the physics wire to.
        tooltipAnchorRef(node);
    }, [tooltipAnchorRef]);

    const isDisabled = disabled || loading;
    const isGhost = variant === 'ghost';

    const clbCls = [
        'clb',
        isGhost ? 'clb--ghost' : '',
        variant === 'danger' ? 'clb--danger' : '',
        variant === 'ok' ? 'clb--ok' : '',
        size === 'sm' ? 'clb--sm' : '',
        size === 'lg' ? 'clb--lg' : '',
        icon ? 'clb--icon' : '',
        active ? 'muted' : '',
        disabled ? 'dis' : '',
        loading ? 'load' : '',
        fullWidth ? 'w-full' : '',
        row ? 'clb--row' : '',
        chip ? 'clb--chip' : '',
        className ?? '',
    ].filter(Boolean).join(' ');

    // Wake pop when a disabled button becomes enabled (guide verbatim).
    const wasDisabled = useRef(isDisabled);
    useEffect(() => {
        const node = nodeRef.current;
        if (node && wasDisabled.current && !isDisabled
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            node.classList.remove('wake');
            void node.offsetWidth;
            node.classList.add('wake');
            const t = setTimeout(() => node.classList.remove('wake'), 650);
            wasDisabled.current = isDisabled;
            return () => clearTimeout(t);
        }
        wasDisabled.current = isDisabled;
    }, [isDisabled]);

    return (
        <span ref={wrapRef} className={`cl-kit ${clbCls}`} style={style} {...tooltipHandlers}>
            {!isGhost && <><i className="l l2" /><i className="l l1" /></>}
            <button
                type={type}
                disabled={!!isDisabled}
                aria-disabled={disabled || undefined}
                aria-busy={loading || undefined}
                aria-describedby={describedBy}
                onClick={!isDisabled ? onClick : undefined}
                className="cap"
                data-anim={pressAnim}
                autoFocus={autoFocus}
            >
                {loading
                    ? <span className="ldots"><i /><i /><i /></span>
                    : <span>{children}</span>}
                <i className="bloom" />
            </button>
            {tooltipNode}
        </span>
    );
};

export default ClButton;
