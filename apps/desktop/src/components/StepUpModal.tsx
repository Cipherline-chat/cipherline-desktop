import React, { useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClField, ClInput, ClModal } from './cl';
import type { StepUpMethod } from '../services/stepUp';

/**
 * "Confirm it's you" — the re-verification shown before a stored secret is
 * revealed. 2FA accounts give a 6-digit authenticator code or a backup code;
 * accounts without 2FA give their password. What is typed lives only in this
 * component's state: it is handed to `onSubmit`, cleared whenever the dialog
 * closes, and never written anywhere.
 */
export interface StepUpModalProps {
    open: boolean;
    method: StepUpMethod;
    busy: boolean;
    /** Inline error from the last attempt. */
    error: string | null;
    /** What is being unlocked, for the explanatory line ("your backup passphrase"). */
    subject?: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
    /** The user edited the field — clear any inline error. */
    onEdit?: () => void;
}

export const StepUpModal: React.FC<StepUpModalProps> = ({
    open, method, busy, error, subject = 'this secret', onSubmit, onCancel, onEdit,
}) => {
    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState('');

    // Clear the typed proof the moment the dialog closes (derived during
    // render, so there is no frame where it lingers in state).
    const [prevOpen, setPrevOpen] = useState(open);
    if (prevOpen !== open) {
        setPrevOpen(open);
        if (!open) setValue('');
    }

    // Hand focus back to the field after a failed attempt (disabled while busy).
    const wasBusy = useRef(false);
    useEffect(() => {
        if (wasBusy.current && !busy && open) requestAnimationFrame(() => inputRef.current?.focus());
        wasBusy.current = busy;
    }, [busy, open]);

    const isTotp = method === 'totp';
    const canSubmit = !busy && value.trim().length > 0;
    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (canSubmit) onSubmit(value);
    };
    const cancel = () => { if (!busy) onCancel(); };

    return (
        <ClModal open={open} onClose={cancel} width={380} closeOnOverlay={false} label="Confirm it's you">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 12, background: 'rgba(37,224,200,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <ShieldCheck size={17} style={{ color: 'var(--cl-lume)' }} />
                </div>
                <h4 style={{ margin: 0 }}>Confirm it's you</h4>
            </div>
            <p style={{ fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.6, marginBottom: 14 }}>
                {isTotp
                    ? <>Enter a code from your authenticator app, or one of your backup codes, to show {subject}.</>
                    : <>Enter your account password to show {subject}.</>}
            </p>
            <form onSubmit={submit} noValidate>
                <ClField label={isTotp ? 'Authenticator or backup code' : 'Account password'} htmlFor={id}>
                    <ClInput
                        ref={inputRef}
                        id={id}
                        type={isTotp ? 'text' : 'password'}
                        inputMode={isTotp ? 'text' : undefined}
                        value={value}
                        onChange={(e) => { setValue(e.target.value); onEdit?.(); }}
                        autoFocus
                        autoComplete={isTotp ? 'one-time-code' : 'current-password'}
                        spellCheck={false}
                        maxLength={isTotp ? 32 : 256}
                        disabled={busy}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={`${id}-err`}
                        style={{ width: '100%' }}
                    />
                </ClField>
                {/* Always in the DOM so assistive tech announces text when it appears. */}
                <div
                    id={`${id}-err`}
                    role="alert"
                    aria-live="assertive"
                    style={{ minHeight: 18, marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--cl-flash)' }}
                >
                    {error}
                </div>
                <div className="mrow" style={{ marginTop: 10 }}>
                    <ClButton type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>Cancel</ClButton>
                    <ClButton type="submit" size="sm" loading={busy} disabled={!canSubmit}>Confirm</ClButton>
                </div>
            </form>
        </ClModal>
    );
};

export default StepUpModal;
