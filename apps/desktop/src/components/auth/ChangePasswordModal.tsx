/**
 * Change Password modal — two steps:
 *   1. Verify identity: email OTP (always available) or, if 2FA is enabled,
 *      authenticator app / backup code. The server validates the credential and
 *      returns a short-lived change_token.
 *   2. Set the new password. Submits change_token + new_password together.
 *
 * The password field is never shown until identity has been confirmed server-side.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useZxcvbn } from '../../utils/passwordStrength';
import { Lock, KeyRound, Mail, Smartphone, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ClModal, ClButton, ClInput, ClCheckbox } from '../cl';
import SlottedCodeInput from '../SlottedCodeInput';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogForm, DialogStack, DialogField, DialogCopy, DialogLinkButton, DialogSteps } from '../dialog/DialogExtras';

interface Props {
    open: boolean;
    onClose: () => void;
}

type VerifyMode = 'totp' | 'backup' | 'email';

const STRENGTH_BAR   = ['bg-red-500', 'bg-orange-500', 'bg-yellow-400', 'bg-green-400', 'bg-emerald-500'];
const STRENGTH_LABEL = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];

export const ChangePasswordModal: React.FC<Props> = ({ open, onClose }) => {
    const { token, user, updateTokens } = useAuth();
    const toast = useToast();

    // ── Step 1: verify identity ───────────────────────────────────────────────
    // null = still loading TOTP status
    const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
    const [mode, setMode] = useState<VerifyMode>('email');

    const [code, setCode] = useState('');
    const [codeError, setCodeError] = useState(false);
    const [verifying, setVerifying] = useState(false);

    // Email-code sending state
    const [emailSending, setEmailSending] = useState(false);
    const [emailSent, setEmailSent] = useState(false);
    const [emailCooldown, setEmailCooldown] = useState(0);
    const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // ── Step 2: new password (visible only after identity verified) ───────────
    const [changeToken, setChangeToken] = useState<string | null>(null); // non-null = on step 2
    const [currentPw, setCurrentPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [logoutOthers, setLogoutOthers] = useState(true);
    const [confirmPw, setConfirmPw] = useState('');
    const [showNew, setShowNew] = useState(false);
    const [saving, setSaving] = useState(false);

    const [error, setError] = useState('');

    const authHeader = { Authorization: `Bearer ${token}` };

    // ── Email code sending ────────────────────────────────────────────────────

    const sendEmailCode = useCallback(async () => {
        if (emailSending || emailCooldown > 0) return;
        setEmailSending(true); setError('');
        try {
            await axios.post(`${API_BASE}/auth/request-password-change-code`, {}, { headers: authHeader });
            setEmailSent(true);
            setCode(''); setCodeError(false);
            setEmailCooldown(30);
            cooldownRef.current = setInterval(() => {
                setEmailCooldown(n => {
                    if (n <= 1) { clearInterval(cooldownRef.current!); return 0; }
                    return n - 1;
                });
            }, 1000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Could not send verification code.');
        } finally {
            setEmailSending(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [emailSending, emailCooldown, token]);

    // ── On open: reset + fetch TOTP status ────────────────────────────────────

    useEffect(() => {
        if (!open) {
            if (cooldownRef.current) clearInterval(cooldownRef.current);
            return;
        }
        // Full reset each time the modal opens
        setTotpEnabled(null); setMode('email');
        setCode(''); setCodeError(false); setVerifying(false);
        setEmailSending(false); setEmailSent(false); setEmailCooldown(0);
        setChangeToken(null);
        setCurrentPw(''); setNewPw(''); setConfirmPw(''); setShowNew(false); setLogoutOthers(true);
        setSaving(false); setError('');

        let cancelled = false;
        (async () => {
            let enabled = false;
            try {
                const res = await axios.get(`${API_BASE}/auth/2fa/totp/status`, { headers: authHeader });
                enabled = res.data?.enabled === true;
            } catch { /* default to email path on failure */ }
            if (cancelled) return;
            setTotpEnabled(enabled);
            if (enabled) {
                setMode('totp');
            } else {
                setMode('email');
                sendEmailCode();
            }
        })();
        return () => {
            cancelled = true;
            if (cooldownRef.current) clearInterval(cooldownRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // ── Method switching ──────────────────────────────────────────────────────

    const switchMode = (m: VerifyMode) => {
        setMode(m); setCode(''); setCodeError(false); setError('');
        if (m === 'email' && !emailSent) sendEmailCode();
    };

    // ── Step 1 submit: verify the code ────────────────────────────────────────

    const codeReady = mode === 'backup' ? code.trim().length >= 6 : code.length === 6;

    const verifyCode = async () => {
        if (!token || !codeReady || verifying) return;
        setError(''); setCodeError(false); setVerifying(true);
        try {
            const credential =
                mode === 'totp'   ? { totp_code: code } :
                mode === 'backup' ? { backup_code: code.trim() } :
                                    { email_code: code };
            const res = await axios.post(`${API_BASE}/auth/verify-change-code`, credential, { headers: authHeader });
            setChangeToken(res.data.change_token);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            const rawMsg = err?.response?.data?.message;
            const msg: string = Array.isArray(rawMsg) ? (rawMsg[0] || '') : (typeof rawMsg === 'string' ? rawMsg : '');
            setCodeError(true);
            setTimeout(() => { setCode(''); setCodeError(false); }, 900);
            setError(msg || 'That code is invalid or expired.');
        } finally {
            setVerifying(false);
        }
    };

    // ── Step 2 submit: set the new password ───────────────────────────────────

    // Loaded on first need; until then the score reads 0, which keeps submit
    // disabled — never the permissive direction.
    const zxcvbn = useZxcvbn(!!newPw);
    const pwScore   = newPw && zxcvbn ? zxcvbn(newPw).score : 0;
    const canSubmit = !!changeToken && !!currentPw && !!newPw && newPw === confirmPw && pwScore >= 3 && !saving;

    const submitPassword = async () => {
        if (!token || !canSubmit) return;
        setError(''); setSaving(true);
        try {
            const res = await axios.post(`${API_BASE}/auth/change-password`, {
                change_token: changeToken,
                current_password: currentPw,
                new_password: newPw,
                logout_other_devices: logoutOthers,
            }, { headers: authHeader });
            // Swap in the fresh token pair so this session stays alive while all
            // other sessions are invalidated server-side within ~60 s.
            updateTokens(res.data.access_token, res.data.refresh_token);
            toast.push({ kind: 'success', title: 'Password changed', message: 'Signed out of all other sessions.' });
            onClose();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            const rawMsg = err?.response?.data?.message;
            const msg: string = Array.isArray(rawMsg) ? (rawMsg[0] || '') : (typeof rawMsg === 'string' ? rawMsg : '');
            // Token expired mid-flow — send them back to verify again
            if (/token.*invalid|expired|verify.*identity/i.test(msg)) {
                setChangeToken(null);
                setCode(''); setCodeError(false);
            }
            setError(msg || 'Failed to change password.');
        } finally {
            setSaving(false);
        }
    };

    // ── Render: step 1 (verify identity) ─────────────────────────────────────

    const verifyLabel =
        mode === 'totp'   ? 'Enter the 6-digit code from your authenticator app.' :
        mode === 'backup' ? 'Enter one of your backup codes.' :
                            null;

    // Plain function (not a component) — prevents remounting on every keystroke.
    const renderVerify = () => {
        if (totpEnabled === null) {
            return (
                <div style={{ height: 76, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="w-4 h-4 rounded-full border-2 animate-spin" style={{ borderColor: 'rgba(255,255,255,.2)', borderTopColor: 'var(--cl-lume)' }} />
                </div>
            );
        }
        return (
            <DialogStack center>
                {verifyLabel && (
                    <DialogCopy>{verifyLabel}</DialogCopy>
                )}

                {mode === 'email' && (
                    <DialogCopy>
                        {emailSent
                            ? <>We sent a 6-digit code to <strong>{user?.email ?? 'your email'}</strong>.</>
                            : 'Sending a verification code to your email…'}
                    </DialogCopy>
                )}

                {mode === 'backup' ? (
                    <ClInput
                        placeholder="abcd-efgh-ijkl-mnop"
                        value={code}
                        onChange={e => setCode(e.target.value)}
                        autoComplete="off"
                        style={{ width: '100%', textAlign: 'center', fontFamily: 'var(--cl-font-mono)', letterSpacing: '0.08em', borderColor: codeError ? 'var(--cl-flash)' : undefined }}
                    />
                ) : (
                    <SlottedCodeInput
                        value={code}
                        onChange={setCode}
                        disabled={mode === 'email' && (emailSending || !emailSent)}
                        error={codeError}
                        noAutoPaste={mode === 'totp'}
                        onAutoSubmit={() => verifyCode()}
                    />
                )}

                {/* Method switching + email resend */}
                <div className="dlg-linkrow">
                    {mode === 'email' && (
                        <DialogLinkButton disabled={emailSending || emailCooldown > 0} onClick={sendEmailCode}>
                            <RefreshCw size={12} />
                            {emailCooldown > 0 ? `Resend in ${emailCooldown}s` : emailSending ? 'Sending…' : 'Resend code'}
                        </DialogLinkButton>
                    )}
                    {totpEnabled && mode !== 'totp' && (
                        <DialogLinkButton onClick={() => switchMode('totp')}>
                            <Smartphone size={12} /> Use authenticator app
                        </DialogLinkButton>
                    )}
                    {totpEnabled && mode !== 'backup' && (
                        <DialogLinkButton onClick={() => switchMode('backup')}>
                            <KeyRound size={12} /> Use a backup code
                        </DialogLinkButton>
                    )}
                    {mode !== 'email' && (
                        <DialogLinkButton onClick={() => switchMode('email')}>
                            <Mail size={12} /> Email me a code instead
                        </DialogLinkButton>
                    )}
                </div>
            </DialogStack>
        );
    };

    // ── Render: step 2 (new password) ────────────────────────────────────────

    const renderPassword = () => (
        <DialogStack>
            <DialogField label="Current password" htmlFor="cp-current">
                <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--cl-faint)', display: 'flex', pointerEvents: 'none' }}><Lock size={14} /></span>
                    <ClInput
                        id="cp-current"
                        type="password"
                        value={currentPw}
                        onChange={e => setCurrentPw(e.target.value)}
                        autoComplete="current-password"
                        style={{ width: '100%', paddingLeft: 40 }}
                    />
                </div>
            </DialogField>

            <DialogField label="New password" htmlFor="cp-new">
                <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--cl-faint)', display: 'flex', pointerEvents: 'none' }}><KeyRound size={14} /></span>
                    <ClInput
                        id="cp-new"
                        type={showNew ? 'text' : 'password'}
                        value={newPw}
                        onChange={e => setNewPw(e.target.value)}
                        autoComplete="new-password"
                        style={{ width: '100%', paddingLeft: 40, paddingRight: 40 }}
                    />
                    <button
                        type="button"
                        onClick={() => setShowNew(v => !v)}
                        aria-label={showNew ? 'Hide password' : 'Show password'}
                        aria-pressed={showNew}
                        style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--cl-faint)', display: 'flex', alignItems: 'center' }}
                    >
                        {showNew ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                </div>
                {newPw && (
                    <div>
                        <div className="h-[3px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.08)' }}>
                            <div className={`h-full rounded-full transition-all duration-300 ${STRENGTH_BAR[pwScore]}`} style={{ width: `${(pwScore + 1) * 20}%` }} />
                        </div>
                        <div className="dlg-help" style={{ textAlign: 'right', marginTop: 4 }}>{STRENGTH_LABEL[pwScore]}</div>
                    </div>
                )}
            </DialogField>

            <DialogField
                label="Confirm new password"
                htmlFor="cp-confirm"
                error={confirmPw && newPw !== confirmPw ? 'Passwords do not match' : undefined}
            >
                <ClInput
                    id="cp-confirm"
                    type={showNew ? 'text' : 'password'}
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    autoComplete="new-password"
                    style={{ width: '100%' }}
                />
            </DialogField>

            <ClCheckbox
                checked={logoutOthers}
                onChange={setLogoutOthers}
                label={<span className="text-[13px] text-cl-muted">Sign out all other devices</span>}
            />
        </DialogStack>
    );

    // ── Modal shell ───────────────────────────────────────────────────────────

    const step2 = changeToken !== null;
    const verifyDisabled = !codeReady || verifying || (mode === 'email' && !emailSent);

    return (
        <ClModal open={open} onClose={onClose} width={440} cardClassName="dlg-card" label="Change password">
            <DialogHeader
                icon={<Lock size={19} strokeWidth={2.2} />}
                title="Change password"
                subtitle={step2
                    ? 'Identity verified. Choose a strong new password.'
                    : 'Verify it\'s you first. You\'ll be signed out of all other sessions.'}
            />
            {step2 ? (
                <DialogForm onSubmit={() => { void submitPassword(); }}>
                    <DialogBody className="dlg-body--scroll">{renderPassword()}</DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={<DialogSteps index={1} count={2} />}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={() => { setChangeToken(null); setCode(''); setCurrentPw(''); }}>← Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!canSubmit} loading={saving}>
                            {saving ? 'Saving…' : 'Change password'}
                        </ClButton>
                    </DialogFooter>
                </DialogForm>
            ) : (
                <>
                    {/* Not a <form>: the code input already auto-submits (and on Enter),
                        a second submit path would double-fire verifyCode. */}
                    <DialogBody className="dlg-body--scroll">{renderVerify()}</DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={<DialogSteps index={0} count={2} />}>
                        <ClButton variant="ghost" size="sm" onClick={onClose}>Cancel</ClButton>
                        <ClButton size="sm" disabled={verifyDisabled} loading={verifying} onClick={verifyCode}>
                            {verifying ? 'Verifying…' : 'Verify'}
                        </ClButton>
                    </DialogFooter>
                </>
            )}
        </ClModal>
    );
};

export default ChangePasswordModal;
