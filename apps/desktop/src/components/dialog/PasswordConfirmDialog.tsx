import React, { useId } from 'react';
import { ClModal, ClButton, ClInput } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from './DialogFrame';
import { DialogForm, DialogField, DialogStack } from './DialogExtras';

/**
 * A destructive confirmation that also wants the account password (delete a
 * server, hand over ownership). The house dialog pattern, form variant:
 * icon tile, title, what-happens copy, one password field, Cancel + the
 * action.
 *
 * Presentation only. The caller owns the password / error / busy state and the
 * request (`onSubmit`); this dialog never sees the network. The password field
 * takes focus (a stray Enter with it empty does nothing), Enter submits, and
 * Escape / backdrop cancel unless a request is in flight.
 */
interface Props {
    open: boolean;
    /** Ignored while `busy`: a request in flight cannot be cancelled out from under itself. */
    onClose: () => void;
    onSubmit: () => void;
    title: React.ReactNode;
    /** `aria-label` for the dialog. */
    label: string;
    subtitle?: React.ReactNode;
    icon: React.ReactNode;
    tone?: 'danger' | 'warn';
    /** The what-happens copy (one or more <DialogText>). */
    children: React.ReactNode;
    password: string;
    onPasswordChange: (value: string) => void;
    error?: string | null;
    busy?: boolean;
    submitLabel: string;
    busyLabel: string;
    /** Danger button for deletes; the primary button for a hand-over. */
    submitVariant?: 'danger' | 'primary';
    hint?: React.ReactNode;
    overlayStyle?: React.CSSProperties;
    width?: number;
}

export const PasswordConfirmDialog: React.FC<Props> = ({
    open, onClose, onSubmit, title, label, subtitle, icon, tone = 'danger', children,
    password, onPasswordChange, error, busy = false, submitLabel, busyLabel,
    submitVariant = 'danger', hint, overlayStyle, width = 460,
}) => {
    const id = useId();
    const canSubmit = !busy && password.trim().length > 0;
    return (
        <ClModal
            open={open}
            onClose={busy ? () => undefined : onClose}
            width={width}
            overlayStyle={overlayStyle}
            label={label}
            cardClassName="dlg-card"
        >
            <DialogHeader tone={tone} icon={icon} title={title} subtitle={subtitle} />
            <DialogForm onSubmit={() => { if (canSubmit) onSubmit(); }}>
                <DialogBody>
                    <DialogStack tight>
                        <div>{children}</div>
                        <DialogField label="Your account password" htmlFor={id}>
                            <ClInput
                                id={id}
                                type="password"
                                value={password}
                                onChange={(e) => onPasswordChange(e.target.value)}
                                placeholder="Enter it to confirm"
                                autoComplete="current-password"
                                autoFocus
                                disabled={busy}
                                aria-invalid={error ? true : undefined}
                            />
                        </DialogField>
                    </DialogStack>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                <DialogFooter hint={busy ? busyLabel : hint}>
                    <ClButton type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</ClButton>
                    <ClButton type="submit" variant={submitVariant} size="sm" loading={busy} disabled={!canSubmit}>
                        {submitLabel}
                    </ClButton>
                </DialogFooter>
            </DialogForm>
        </ClModal>
    );
};

export default PasswordConfirmDialog;
