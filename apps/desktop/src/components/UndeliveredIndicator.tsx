import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { UNDELIVERED_LABEL } from '../utils/undeliveredSend';

interface Props {
    /** Why it failed, when the queue knew ("No connection"). Absent for a message that is merely slow. */
    reason?: string;
    onRetry: () => void;
    onDiscard: () => void;
}

const POPOVER_W = 232;
const MARGIN = 8;

/**
 * The red "!" beside a message that has not been delivered (see
 * utils/undeliveredSend.ts for when it appears). Always a glyph + an accessible
 * name, never colour or motion alone, so it reads with reduced motion and for
 * colour-blind users. Click → a small popover: "Message not delivered" with
 * Retry and Discard.
 *
 * The popover is portalled to <body> (the feed clips overflow), so its React
 * events still bubble through the portal to the message row — whose click
 * handler would otherwise save/unsave the message. Hence the stopPropagation
 * on every pointer event it receives.
 */
export const UndeliveredIndicator: React.FC<Props> = ({ reason, onRetry, onDiscard }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => setOpen(false), []);
    useEscape(close, open);
    useDismissOnOutsideClick(
        useCallback((t: Node) => !!(btnRef.current?.contains(t) || popRef.current?.contains(t)), []),
        open,
        close,
    );

    useLayoutEffect(() => {
        if (!open || !btnRef.current) return;
        const r = btnRef.current.getBoundingClientRect();
        const h = popRef.current?.offsetHeight ?? 110;
        let left = r.left;
        if (left + POPOVER_W > window.innerWidth - MARGIN) left = Math.max(MARGIN, window.innerWidth - MARGIN - POPOVER_W);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - MARGIN) top = Math.max(MARGIN, r.top - 6 - h);
        setPos({ top, left });
    }, [open]);

    const stop = (e: React.SyntheticEvent) => e.stopPropagation();

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                data-testid="undelivered-indicator"
                aria-label={UNDELIVERED_LABEL}
                aria-haspopup="dialog"
                aria-expanded={open}
                title={UNDELIVERED_LABEL}
                onMouseDown={stop}
                onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
                className="inline-flex items-center justify-center align-middle ml-2 w-[16px] h-[16px] rounded-full bg-cl-flash text-cl-on-flash text-[11px] font-black leading-none select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-cl-flash/60 hover:brightness-110"
            >
                !
            </button>
            {open && ReactDOM.createPortal(
                <div
                    ref={popRef}
                    role="dialog"
                    aria-label={UNDELIVERED_LABEL}
                    data-testid="undelivered-popover"
                    onMouseDown={stop}
                    onClick={stop}
                    onContextMenu={stop}
                    className="fixed z-[300] rounded-lg border border-cl-border bg-cl-deep p-3 shadow-xl"
                    style={{ width: POPOVER_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
                >
                    <div className="text-[13px] font-semibold text-cl-text">{UNDELIVERED_LABEL}</div>
                    {reason && <div className="mt-0.5 text-[12px] text-cl-muted">{reason}</div>}
                    <div className="mt-2.5 flex items-center gap-2">
                        <ClButton size="sm" autoFocus onClick={() => { close(); onRetry(); }}>Retry</ClButton>
                        <ClButton size="sm" variant="ghost" onClick={() => { close(); onDiscard(); }}>Discard</ClButton>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
};
