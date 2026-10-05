import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscape } from '../../hooks/useEscape';

interface ClModalProps {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    width?: number | string;
    closeOnOverlay?: boolean;
    cardClassName?: string;
    cardStyle?: React.CSSProperties;
    /** Override the overlay (`.mod`) style — e.g. raise z-index above a host overlay. */
    overlayStyle?: React.CSSProperties;
    /** Accessible label for the dialog (announced by screen readers). If omitted the
     *  dialog is unlabelled — supply one when the content doesn't include an h1–h6. */
    label?: string;
}

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Modal — guide markup verbatim: `.mod` blurred-deep overlay + `.mcard` that
 * springs in on translateY (no scale — text stays crisp). Closes on Escape and
 * overlay click; mounts briefly past close for the exit transition.
 *
 * A11y: traps Tab/Shift+Tab inside the dialog, auto-focuses the first focusable
 * child on open, and restores focus to the opener on close.
 */
export const ClModal: React.FC<ClModalProps> = ({
    open, onClose, children, width, closeOnOverlay = true, cardClassName, cardStyle, overlayStyle, label,
}) => {
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);
    const openerRef = useRef<Element | null>(null);

    useEffect(() => {
        if (open) {
            // Save the element that had focus before the dialog opened so we can
            // restore it on close.
            openerRef.current = document.activeElement;
            setMounted(true);
            const r = requestAnimationFrame(() => {
                setShown(true);
                // Auto-focus first focusable element inside the dialog.
                const first = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)[0];
                first?.focus();
            });
            return () => cancelAnimationFrame(r);
        }
        setShown(false);
        // Restore focus before the dialog unmounts so the browser doesn't lose
        // track of where focus was.
        if (openerRef.current instanceof HTMLElement) {
            openerRef.current.focus();
            openerRef.current = null;
        }
        const t = setTimeout(() => setMounted(false), 260);
        return () => clearTimeout(t);
    }, [open]);

    // Escape through the shared stack — migrated here ONCE so every ClModal
    // consumer (there are many) gets stack-owned Escape for free instead of
    // each needing its own useEscape call.
    useEscape(() => onClose(), open);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;

            const focusable = Array.from(
                cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
            ).filter(el => el.offsetParent !== null); // skip hidden elements
            if (!focusable.length) return;

            const first = focusable[0];
            const last  = focusable[focusable.length - 1];

            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!mounted) return null;

    return createPortal(
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div
                className={`mod${shown ? ' open' : ''}`}
                style={overlayStyle}
                onClick={closeOnOverlay ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
            >
                <div
                    ref={cardRef}
                    className={['mcard', cardClassName ?? ''].filter(Boolean).join(' ')}
                    style={{ ...(width !== undefined ? { maxWidth: width } : null), ...cardStyle }}
                    role="dialog"
                    aria-modal="true"
                    {...(label ? { 'aria-label': label } : {})}
                >
                    {children}
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ClModal;
