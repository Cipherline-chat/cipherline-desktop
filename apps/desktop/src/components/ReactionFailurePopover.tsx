import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';
import { reactionFailureTitle, type ReactionIntent } from '../utils/pendingReactions';

interface Props {
    anchorRef: React.RefObject<HTMLElement | null>;
    /** The card's own element, for the caller's outside-click test. */
    popRef?: React.MutableRefObject<HTMLDivElement | null>;
    kind: ReactionIntent;
    /** Why, when known ("No connection", "Timed out"). */
    reason?: string;
    /** Opened by click / Enter: take focus (Retry), like the message "!" popover. */
    focusRetry: boolean;
    onRetry: () => void;
    onDiscard: () => void;
    onClose: () => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
}

const POPOVER_W = 232;
const MARGIN = 8;

/**
 * The hover / focus card of a red reaction chip: what went wrong, plus Retry
 * and Remove (or Keep, for a failed removal). Same look and words as the
 * message "Message not delivered" popover (UndeliveredIndicator).
 *
 * Portalled to <body> because the feed clips overflow; React events still
 * bubble through the portal to the message row, whose click handler would
 * otherwise save/unsave the message - hence the stopPropagation on every
 * pointer event it receives.
 */
export const ReactionFailurePopover: React.FC<Props> = ({
    anchorRef, popRef: outerRef, kind, reason, focusRetry, onRetry, onDiscard, onClose, onPointerEnter, onPointerLeave,
}) => {
    const popRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    useEscape(useCallback(() => onClose(), [onClose]), true);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const r = anchor.getBoundingClientRect();
        const h = popRef.current?.offsetHeight ?? 110;
        let left = r.left;
        if (left + POPOVER_W > window.innerWidth - MARGIN) left = Math.max(MARGIN, window.innerWidth - MARGIN - POPOVER_W);
        // Above the chip when there is room (the chip sits under its message), else below.
        let top = r.top - 6 - h;
        if (top < MARGIN) top = r.bottom + 6;
        setPos({ top, left });
    }, [anchorRef]);

    // Opened by click / Enter (or upgraded from a hover/focus card to that):
    // Retry takes focus. An effect rather than autoFocus, because the card is
    // usually already mounted by the time the chip is clicked.
    useEffect(() => {
        if (focusRetry) popRef.current?.querySelector('button')?.focus();
    }, [focusRetry]);

    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    const title = reactionFailureTitle(kind);

    return ReactDOM.createPortal(
        <div
            ref={(el) => { popRef.current = el; if (outerRef) outerRef.current = el; }}
            role="dialog"
            aria-label={title}
            data-testid="reaction-failure-popover"
            onMouseDown={stop}
            onClick={stop}
            onContextMenu={stop}
            onMouseEnter={onPointerEnter}
            onMouseLeave={onPointerLeave}
            className="fixed z-[300] rounded-lg border border-cl-border bg-cl-deep p-3 shadow-xl"
            style={{ width: POPOVER_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
        >
            <div className="text-[13px] font-semibold text-cl-text">{title}</div>
            {reason && <div className="mt-0.5 text-[12px] text-cl-muted">{reason}</div>}
            <div className="mt-2.5 flex items-center gap-2">
                <ClButton size="sm" onClick={() => { onClose(); onRetry(); }}>Retry</ClButton>
                <ClButton size="sm" variant="ghost" onClick={() => { onClose(); onDiscard(); }}>
                    {kind === 'add' ? 'Remove' : 'Keep'}
                </ClButton>
            </div>
        </div>,
        document.body,
    );
};
