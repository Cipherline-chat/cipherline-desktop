import React, { useRef } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { ClModal } from './ClModal';
import { ClButton } from '../ClButton';
import { DialogHeader, DialogBody, DialogFooter, DialogText, useInitialFocus } from '../dialog/DialogFrame';

interface ClConfirmProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: React.ReactNode;
    message?: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /**
     * Destructive action — the icon tile turns danger-red, the confirm button
     * uses the flash/danger variant, and initial focus lands on Cancel so a
     * stray Enter can never confirm.
     */
    danger?: boolean;
    /** Busy state on the confirm button. */
    loading?: boolean;
    /** Extra body content rendered between the message and the buttons. */
    children?: React.ReactNode;
    width?: number | string;
    overlayStyle?: React.CSSProperties;
    /** Override the header icon (a lucide icon, ≈18px). Defaults by tone. */
    icon?: React.ReactNode;
    /** Footer line on the left (state / reassurance), e.g. "You can undo this for 30 days". */
    hint?: React.ReactNode;
}

/**
 * Confirm dialog — the house dialog pattern (components/dialog/DialogFrame):
 * icon tile (danger-tinted when destructive), title, body text, and a footer
 * with Cancel + the confirm button. Use this for every confirm/delete prompt
 * instead of hand-rolling a fixed-overlay dialog.
 *
 * Keyboard: Esc cancels (ClModal's escape layer). Focus starts on the SAFE
 * button — Cancel for a destructive confirm, the confirm button otherwise —
 * so Enter does what the dialog's tone implies. The confirm button stays the
 * rightmost action, farthest from a cursor resting on Cancel.
 */
export const ClConfirm: React.FC<ClConfirmProps> = ({
    open, onClose, onConfirm, title, message,
    confirmLabel = 'Confirm', cancelLabel = 'Cancel',
    danger, loading, children, width, overlayStyle, icon, hint,
}) => {
    const confirmSlot = useRef<HTMLSpanElement>(null);
    // Non-destructive: move focus onto the confirm button. (Destructive: ClModal's
    // own first-focusable rule already lands on Cancel, which is what we want.)
    useInitialFocus(confirmSlot, open && !danger);
    return (
        <ClModal
            open={open}
            onClose={onClose}
            width={width}
            overlayStyle={overlayStyle}
            cardClassName="dlg-card dlg-card--confirm"
            label={typeof title === 'string' ? title : undefined}
        >
            <DialogHeader
                tone={danger ? 'danger' : 'default'}
                icon={icon ?? (danger ? <AlertTriangle size={18} strokeWidth={2.2} /> : <HelpCircle size={18} strokeWidth={2.2} />)}
                title={title}
            />
            {(message || children) && (
                <DialogBody>
                    {message && <DialogText>{message}</DialogText>}
                    {children && <div style={message ? { marginTop: 12 } : undefined}>{children}</div>}
                </DialogBody>
            )}
            <DialogFooter hint={hint}>
                <ClButton variant="ghost" size="sm" disabled={loading} onClick={onClose}>{cancelLabel}</ClButton>
                <span ref={confirmSlot} className="dlg-focus-slot">
                    <ClButton variant={danger ? 'danger' : 'primary'} size="sm" loading={loading} onClick={onConfirm}>
                        {confirmLabel}
                    </ClButton>
                </span>
            </DialogFooter>
        </ClModal>
    );
};

export default ClConfirm;
