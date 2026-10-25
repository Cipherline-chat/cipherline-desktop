import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Lock } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClField, ClInput, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter } from './dialog/DialogFrame';
import { DialogForm, DialogStack } from './dialog/DialogExtras';

/**
 * "Enter this backup's password" — the single restore confirmation.
 *
 * Restore asks for the password of the backup it is about to read, here, at
 * the moment of restoring. It does NOT reuse the Settings passphrase field:
 * that field sets up backups, and the file being restored may have been
 * written under a different (older, other-device) password.
 *
 * This is also the "Restore backup?" overwrite warning — one dialog, not two.
 *
 * Secrets: the typed password lives only in this component's state. It is
 * handed to `onSubmit` and nowhere else, never written to any store, and is
 * cleared the moment the restore session ends (`open` -> false). The user's
 * current backup password is passed in as `currentPassword` purely so they can
 * opt in to using it; it is never rendered, and while it is selected the
 * show/hide toggle is not offered (revealing it is gated elsewhere).
 *
 * Layout: the shared dialog pattern (components/dialog) — warning-tinted
 * header, a form body, and a footer whose hint carries the restore progress
 * while an attempt is running. Presentation only; the behaviour is unchanged.
 */
export interface RestorePasswordModalProps {
    /** A restore session is active. Dropping to false clears the password. */
    open: boolean;
    /** Temporarily hide the dialog without ending the session (e.g. while the
     *  stale-backup question is on screen). Keeps the typed password. */
    hidden?: boolean;
    source: 'drive' | 'local';
    /** Basename of the picked file (local restores). */
    fileName?: string;
    /** A restore attempt is in flight. */
    busy: boolean;
    /** Progress text for the in-flight attempt. */
    progressLabel?: string;
    /** Inline error from the last attempt (wrong password). */
    error: string | null;
    /** The user's current backup password, if one is saved on this device. */
    currentPassword?: string | null;
    onSubmit: (password: string) => void;
    onCancel: () => void;
    /** The user edited the password — clear any inline error. */
    onEdit?: () => void;
}

export const RestorePasswordModal: React.FC<RestorePasswordModalProps> = ({
    open, hidden, source, fileName, busy, progressLabel, error, currentPassword, onSubmit, onCancel, onEdit,
}) => {
    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState('');
    const [show, setShow] = useState(false);
    const [useCurrent, setUseCurrent] = useState(false);

    // Clear every trace of the typed password when the session ends.
    // (Derived during render rather than in an effect: no frame where the old
    // password is still in state after the session ended.)
    const [prevOpen, setPrevOpen] = useState(open);
    if (prevOpen !== open) {
        setPrevOpen(open);
        if (!open) { setValue(''); setShow(false); setUseCurrent(false); }
    }

    // After a failed attempt, hand focus back to the field (it was disabled
    // while busy) so the user can correct the password straight away.
    const wasBusy = useRef(false);
    useEffect(() => {
        if (wasBusy.current && !busy && open && !useCurrent) {
            requestAnimationFrame(() => inputRef.current?.focus());
        }
        wasBusy.current = busy;
    }, [busy, open, useCurrent]);

    const effective = useCurrent && currentPassword ? currentPassword : value;
    const canSubmit = !busy && effective.length > 0;

    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!canSubmit) return;
        onSubmit(effective);
    };

    const cancel = () => { if (!busy) onCancel(); };

    return (
        <ClModal open={open && !hidden} onClose={cancel} width={440} closeOnOverlay={false} label="Restore backup" cardClassName="dlg-card dlg-tone-warn">
            <DialogHeader
                icon={<AlertTriangle size={19} strokeWidth={2.2} />}
                title="Restore backup?"
                subtitle={<>This overwrites this device&rsquo;s messages and settings with the {source === 'drive' ? 'Google Drive' : 'selected file'} backup, then reloads.</>}
            />
            <DialogForm onSubmit={() => submit()}>
                <DialogBody>
                    <DialogStack tight>
                        {source === 'local' && fileName ? (
                            <div className="dlg-help" style={{ wordBreak: 'break-all' }}>
                                File: <span style={{ color: 'var(--cl-text)' }}>{fileName}</span>
                            </div>
                        ) : null}
                        {useCurrent && currentPassword ? (
                            <div className="dlg-field">
                                <div className="dlg-label"><span>Backup password</span></div>
                                <div id={`${id}-using`} className="dlg-copy" style={{ color: 'var(--cl-text)' }}>
                                    Using your current backup password
                                </div>
                                <div>
                                    <button
                                        type="button"
                                        className="dlg-linkbtn"
                                        autoFocus
                                        disabled={busy}
                                        onClick={() => { setUseCurrent(false); onEdit?.(); requestAnimationFrame(() => inputRef.current?.focus()); }}
                                    >
                                        Use a different password
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <ClField label="Backup password" htmlFor={id}>
                                <div style={{ position: 'relative' }}>
                                    <ClInput
                                        ref={inputRef}
                                        id={id}
                                        type={show ? 'text' : 'password'}
                                        value={value}
                                        onChange={(e) => { setValue(e.target.value); onEdit?.(); }}
                                        autoFocus
                                        autoComplete="off"
                                        spellCheck={false}
                                        disabled={busy}
                                        aria-invalid={error ? true : undefined}
                                        aria-describedby={`${id}-hint ${id}-err`}
                                        style={{ width: '100%', paddingRight: 40 }}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShow((s) => !s)}
                                        aria-label={show ? 'Hide password' : 'Show password'}
                                        aria-pressed={show}
                                        style={{
                                            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            border: 'none', background: 'none', padding: 4, cursor: 'pointer',
                                            color: 'var(--cl-faint)',
                                        }}
                                    >
                                        {show ? <EyeOff size={15} /> : <Eye size={15} />}
                                    </button>
                                </div>
                            </ClField>
                        )}
                        <div id={`${id}-hint`} className="dlg-help">
                            This is the password that was set when the backup was created — it may differ from your current backup password.
                        </div>
                        {currentPassword && !useCurrent && (
                            <div>
                                <button
                                    type="button"
                                    className="dlg-linkbtn"
                                    disabled={busy}
                                    onClick={() => { setUseCurrent(true); setValue(''); setShow(false); onEdit?.(); }}
                                >
                                    Use my current backup password
                                </button>
                            </div>
                        )}
                        {/* Always in the DOM so assistive tech announces the text when it
                            appears. Plain div, not ClField's <p> (see StagingPasswordForm). */}
                        <div id={`${id}-err`} className="dlg-field-error" role="alert" aria-live="assertive">
                            {error}
                        </div>
                    </DialogStack>
                </DialogBody>
                <DialogFooter hint={busy
                    ? <span>{progressLabel || 'Restoring…'}</span>
                    : <><Lock size={13} aria-hidden /> Decrypted on this device</>}
                >
                    <ClButton type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>Cancel</ClButton>
                    <ClButton type="submit" size="sm" loading={busy} disabled={!canSubmit}>Restore</ClButton>
                </DialogFooter>
            </DialogForm>
        </ClModal>
    );
};

export default RestorePasswordModal;
