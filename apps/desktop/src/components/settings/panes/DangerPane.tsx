import React, { useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { LogOut, Trash2, AlertTriangle, Lock, Eye, EyeOff } from 'lucide-react';
import { DialogHeader, DialogBody, DialogFooter, DialogError, DialogText, DialogCallout, DialogField } from '../../dialog/DialogFrame';
import { ClButton, ClInput, ClModal } from '../../cl';
import SlottedCodeInput from '../../SlottedCodeInput';
import axios from 'axios';
import { API_BASE } from '../../../constants';

/**
 * The Abyss · Danger Zone — sign out and account deletion, at the literal
 * bottom of the gauge. Destructive copy is plain and complete (doctrine:
 * real security events get zero jokes). Delete flow ported 1:1 from
 * SettingsModal (password + TOTP or email-code verification).
 */
interface DangerPaneProps {
    onLogout: () => void;
    /** Closes the settings screen (called before onLogout after deletion). */
    onCloseSettings: () => void;
}

export const DangerPane: React.FC<DangerPaneProps> = ({ onLogout, onCloseSettings }) => {
    const { token } = useAuth();

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deletePassword, setDeletePassword] = useState('');
    const [deleteShowPassword, setDeleteShowPassword] = useState(false);
    const [deleteTotp, setDeleteTotp] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const [deleteTotpEnabled, setDeleteTotpEnabled] = useState<boolean | null>(null);
    const [deleteEmailCode, setDeleteEmailCode] = useState('');
    const [deleteCodeSent, setDeleteCodeSent] = useState(false);
    const [deleteSendingCode, setDeleteSendingCode] = useState(false);

    const openDeleteFlow = () => {
        setDeleteError(''); setDeletePassword(''); setDeleteTotp('');
        setDeleteEmailCode(''); setDeleteCodeSent(false); setDeleteSendingCode(false);
        setDeleteTotpEnabled(null);
        setShowDeleteConfirm(true);
        if (token) {
            axios.get(`${API_BASE}/auth/2fa/totp/status`, { headers: { Authorization: `Bearer ${token}` } })
                .then(res => setDeleteTotpEnabled(res.data.enabled === true))
                .catch(() => setDeleteTotpEnabled(false));
        }
    };

    const sendDeletionCode = async () => {
        if (!token) return;
        setDeleteSendingCode(true); setDeleteError('');
        try {
            await axios.post(`${API_BASE}/auth/account/deletion-code`, {}, { headers: { Authorization: `Bearer ${token}` } });
            setDeleteCodeSent(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setDeleteError(err?.response?.data?.message || 'Failed to send code.');
        } finally {
            setDeleteSendingCode(false);
        }
    };

    // Step-up gate: the password always, plus the authenticator code when 2FA is
    // on, or an emailed code (which must have been requested) when it is off.
    // Also held back while the 2FA status is still loading, so the right second
    // factor is never skipped. The server enforces all of it independently.
    const canDelete = !deleting
        && !!deletePassword
        && deleteTotpEnabled !== null
        && !(deleteTotpEnabled === true && !deleteTotp)
        && !(deleteTotpEnabled === false && !deleteCodeSent);

    const deleteAccount = async () => {
        if (!token) return;
        setDeleting(true); setDeleteError('');
        try {
            await axios.delete(`${API_BASE}/auth/account`, {
                headers: { Authorization: `Bearer ${token}` },
                data: {
                    password: deletePassword,
                    ...(deleteTotp ? { totp_code: deleteTotp } : {}),
                    ...(deleteEmailCode ? { email_code: deleteEmailCode } : {}),
                },
            });
            setShowDeleteConfirm(false);
            onCloseSettings();
            onLogout();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setDeleteError(err?.response?.data?.message || 'Deletion failed. Please try again.');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <>
            {/* Sign out */}
            <div className="sd-card">
                <h3>Sign out</h3>
                <p className="sd-sub">Your keys stay in this device’s encrypted keystore. Signing back in does not need a new pairing.</p>
                <ClButton variant="ghost" onClick={() => { onCloseSettings(); setTimeout(onLogout, 150); }}>
                    <LogOut size={15} />Sign out of this device
                </ClButton>
            </div>

            {/* Delete account */}
            <div className="sd-card sd-card--danger">
                <h3>Delete account</h3>
                <p className="sd-sub" style={{ color: 'var(--cl-muted)' }}>
                    This permanently deletes your account, every device registration, your key bundles,
                    and every encrypted file you have uploaded. Messages already delivered to other
                    people remain on their devices. This cannot be undone.
                </p>
                <ClButton variant="danger" onClick={openDeleteFlow}>
                    <Trash2 size={14} />Delete my account
                </ClButton>
            </div>

            {/* ── Delete account dialog (same requests + step-up as before) ────── */}
            <ClModal
                open={showDeleteConfirm}
                onClose={() => { if (!deleting) setShowDeleteConfirm(false); }}
                width={480}
                label="Delete account"
                cardClassName="dlg-card"
            >
                <form className="dlg-form" noValidate onSubmit={(e) => { e.preventDefault(); if (canDelete) void deleteAccount(); }}>
                    <DialogHeader
                        tone="danger"
                        icon={<Trash2 size={18} strokeWidth={2.2} />}
                        title="Delete account"
                        subtitle="This permanently erases your account. It can't be undone."
                    />
                    <DialogBody>
                        <DialogText>
                            This deletes your account, all devices, and all server-side data.
                        </DialogText>
                        <DialogCallout icon={<AlertTriangle size={14} />}>
                            Your encrypted messages are stored locally. Back up from Storage settings first if you want to keep them.
                        </DialogCallout>

                        <div style={{ marginTop: 16 }}>
                            <DialogField label="Confirm it's you" htmlFor="delete-account-password">
                                {/* Password */}
                                <div className="relative">
                                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 z-10" style={{ color: 'var(--cl-faint)' }}><Lock size={14} /></span>
                                    <ClInput
                                        id="delete-account-password"
                                        type={deleteShowPassword ? 'text' : 'password'}
                                        value={deletePassword}
                                        onChange={e => setDeletePassword(e.target.value)}
                                        placeholder="Your current password"
                                        autoComplete="current-password"
                                        autoFocus
                                        disabled={deleting}
                                        style={{ paddingLeft: 40, paddingRight: 40, width: '100%' }}
                                    />
                                    {/* A plain flat button, matching AuthScreen's own reveal
                                        toggle — not a ClButton. The kit button is a 40px
                                        depth control with its own shadow sheets, which
                                        inside a 43px field fills it corner to corner and
                                        reads as a second control sitting on top of the
                                        input rather than an adornment inside it. */}
                                    <button
                                        type="button"
                                        aria-label={deleteShowPassword ? 'Hide password' : 'Show password'}
                                        onClick={() => setDeleteShowPassword(v => !v)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center text-cl-faint hover:text-cl-text transition-colors"
                                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4 }}
                                    >
                                        {deleteShowPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                                    </button>
                                </div>

                                {/* 2FA */}
                                {deleteTotpEnabled === null ? (
                                    <div className="h-12 flex items-center justify-center">
                                        <div className="w-4 h-4 rounded-full border-2 border-t-white/60 animate-spin" style={{ borderColor: 'rgba(255,255,255,.2)', borderTopColor: 'rgba(255,255,255,.6)' }} />
                                    </div>
                                ) : deleteTotpEnabled ? (
                                    <ClInput
                                        type="text"
                                        inputMode="numeric"
                                        maxLength={6}
                                        aria-label="Authenticator code"
                                        value={deleteTotp}
                                        onChange={e => setDeleteTotp(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                                        placeholder="Authenticator code"
                                        disabled={deleting}
                                        style={{ width: '100%', textAlign: 'center', letterSpacing: '0.15em', fontFamily: 'var(--cl-font-mono)' }}
                                    />
                                ) : (
                                    <div className="space-y-2">
                                        {!deleteCodeSent ? (
                                            <ClButton
                                                variant="ghost"
                                                fullWidth
                                                loading={deleteSendingCode}
                                                disabled={deleteSendingCode}
                                                onClick={sendDeletionCode}
                                            >
                                                {deleteSendingCode ? 'Sending…' : 'Email me a verification code'}
                                            </ClButton>
                                        ) : (
                                            <div className="space-y-2">
                                                <SlottedCodeInput
                                                    value={deleteEmailCode}
                                                    onChange={setDeleteEmailCode}
                                                />
                                                <ClButton
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => { setDeleteCodeSent(false); setDeleteEmailCode(''); }}
                                                >
                                                    Resend code
                                                </ClButton>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </DialogField>
                        </div>
                    </DialogBody>
                    {deleteError && <DialogError>{deleteError}</DialogError>}
                    <DialogFooter hint={deleteTotpEnabled === false && !deleteCodeSent ? <span>Request a code to continue</span> : undefined}>
                        <ClButton type="button" variant="ghost" size="sm" disabled={deleting} onClick={() => setShowDeleteConfirm(false)}>
                            Cancel
                        </ClButton>
                        <ClButton type="submit" variant="danger" size="sm" disabled={!canDelete} loading={deleting}>
                            {deleting ? 'Deleting…' : 'Delete my account'}
                        </ClButton>
                    </DialogFooter>
                </form>
            </ClModal>
        </>
    );
};
