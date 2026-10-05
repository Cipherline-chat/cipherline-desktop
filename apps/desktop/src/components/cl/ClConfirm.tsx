import React from 'react';
import { ClModal } from './ClModal';
import { ClButton } from '../ClButton';

interface ClConfirmProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: React.ReactNode;
    message?: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Destructive action — confirm button uses the flash/danger variant. */
    danger?: boolean;
    /** Busy state on the confirm button. */
    loading?: boolean;
    /** Extra body content rendered between the message and the buttons. */
    children?: React.ReactNode;
    width?: number | string;
    overlayStyle?: React.CSSProperties;
}

/**
 * Confirm dialog — guide modal markup verbatim (`.mcard` h4/p + right-aligned
 * `.mrow`). The destructive choice is the rightmost (farthest from a cursor
 * resting on Cancel), per the guide. Use this for every confirm/delete prompt
 * instead of hand-rolling a fixed-overlay dialog.
 */
export const ClConfirm: React.FC<ClConfirmProps> = ({
    open, onClose, onConfirm, title, message,
    confirmLabel = 'Confirm', cancelLabel = 'Cancel',
    danger, loading, children, width, overlayStyle,
}) => (
    <ClModal open={open} onClose={onClose} width={width} overlayStyle={overlayStyle} cardClassName="ccpop">
        <h4>{title}</h4>
        {message && <p>{message}</p>}
        {children}
        <div className="mrow">
            <ClButton variant="ghost" size="sm" disabled={loading} onClick={onClose}>{cancelLabel}</ClButton>
            <ClButton variant={danger ? 'danger' : 'primary'} size="sm" loading={loading} onClick={onConfirm}>
                {confirmLabel}
            </ClButton>
        </div>
    </ClModal>
);

export default ClConfirm;
