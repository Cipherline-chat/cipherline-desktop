import React, { useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { LogOut, Trash2, AlertTriangle, Lock, Eye, EyeOff } from 'lucide-react';
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

            {/* ── Delete Account Modal (ported 1:1 from SettingsModal) ────────── */}
            <ClModal
                open={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                width={480}
            >
                <div className="p-7">
                    <div className="text-center mb-6">
                        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.2)' }}>
                            <AlertTriangle className="w-7 h-7" style={{ color: 'var(--cl-flash)' }} />
                        </div>
                        <h3 className="text-lg mb-1 font-display" style={{ color: 'var(--cl-flash)' }}>Delete Account</h3>
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--cl-muted)' }}>
                            This permanently deletes your account, all devices, and all server-side data.<br />
                            <span style={{ color: 'var(--cl-glow)' }}>Your encrypted messages are stored locally — back up from Storage settings first if you want to keep them.</span>
                        </p>
                    </div>
                    {deleteError && (
                        <div className="mb-4 px-4 py-3 rounded-xl text-sm text-center" style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.25)', color: 'var(--cl-flash)' }}>{deleteError}</div>
                    )}
                    <div className="space-y-3">
                        {/* Password */}
                        <div className="relative">
                            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 z-10" style={{ color: 'var(--cl-faint)' }}><Lock size={14} /></span>
                            <ClInput
                                type={deleteShowPassword ? 'text' : 'password'}
                                value={deletePassword}
                                onChange={e => setDeletePassword(e.target.value)}
                                placeholder="Your current password"
                                autoFocus
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
                                value={deleteTotp}
                                onChange={e => setDeleteTotp(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                                placeholder="Authenticator code"
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
                                        onClick={async () => {
                                            if (!token) return;
                                            setDeleteSendingCode(true); setDeleteError('');
                                            try {
                                                await axios.post(`${API_BASE}/auth/account/deletion-code`, {}, { headers: { Authorization: `Bearer ${token}` } });
                                                setDeleteCodeSent(true);
                                            } catch (err: any) {
                                                setDeleteError(err?.response?.data?.message || 'Failed to send code.');
                                            } finally {
                                                setDeleteSendingCode(false);
                                            }
                                        }}
                                    >
                                        {deleteSendingCode ? 'Sending…' : 'Send verification code to your email'}
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

                        <ClButton
                            variant="danger"
                            fullWidth
                            disabled={deleting || !deletePassword || (deleteTotpEnabled === true && !deleteTotp) || (deleteTotpEnabled === false && !deleteCodeSent)}
                            loading={deleting}
                            onClick={async () => {
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
                                } catch (err: any) {
                                    setDeleteError(err?.response?.data?.message || 'Deletion failed. Please try again.');
                                } finally {
                                    setDeleting(false);
                                }
                            }}
                        >
                            {deleting ? 'Deleting…' : 'Permanently Delete My Account'}
                        </ClButton>
                        <ClButton
                            variant="ghost"
                            fullWidth
                            onClick={() => setShowDeleteConfirm(false)}
                        >
                            Cancel
                        </ClButton>
                    </div>
                </div>
            </ClModal>
        </>
    );
};
