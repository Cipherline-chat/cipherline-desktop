/**
 * TOTP enrolment modal — 5-step flow:
 *   1. Email verification — a 6-digit OTP is sent to the account email.
 *      Submitting it here consumes it server-side and returns the QR + a
 *      short-lived HMAC setup token (30 min).  The OTP never floats in
 *      React state waiting for the enable call.
 *   2. Show QR code + secret to scan into Google Authenticator / Authy / etc.
 *   3. User enters a fresh 6-digit code from their authenticator app.
 *   4. Warning: if you lose your authenticator AND backup codes you are locked out.
 *   5. Show the 10 backup codes ONCE with a copy/download option.
 *
 * On completion calls onDone() so the parent can refresh its TOTP-status state.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import axios from 'axios';
import { Mail, Smartphone, Copy, Download, CheckCheck, ShieldCheck, RefreshCw, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { ClModal, ClButton, ClCheckbox } from '../cl';
import SlottedCodeInput from '../SlottedCodeInput';
import { Keys } from '../mascot/Keys';
import { writeToClipboard } from '../../utils/clipboard';

interface Props {
    onClose: () => void;
    onDone: () => void;
}

export const TotpSetupModal: React.FC<Props> = ({ onClose, onDone }) => {
    const { token, user } = useAuth();

    type Step = 'email-verify' | 'setup' | 'verify' | 'warning' | 'codes';
    const [step, setStep] = useState<Step>('email-verify');

    // Email-verify step
    const [emailCode, setEmailCode] = useState('');
    const [emailCodeError, setEmailCodeError] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const [codeSent, setCodeSent] = useState(false);
    const [resendCooldown, setResendCooldown] = useState(0);

    // Setup + verify state
    const [secretB32, setSecretB32]   = useState('');
    const [qrDataUrl, setQrDataUrl]   = useState('');
    const [setupToken, setSetupToken] = useState('');  // HMAC proof that email OTP was consumed
    const [totpCode, setTotpCode]     = useState('');
    const [totpError, setTotpError]   = useState(false);

    // Codes step
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [acknowledged, setAcknowledged] = useState(false);
    const [copied, setCopied] = useState(false);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const cooldownRef  = useRef<ReturnType<typeof setInterval> | null>(null);
    const enablingRef  = useRef(false);  // double-submit guard for handleEnable

    const authHeader = { Authorization: `Bearer ${token}` };

    // ── Send email code ───────────────────────────────────────────────────────

    const sendCode = useCallback(async (signal?: AbortSignal) => {
        if (sendingCode || resendCooldown > 0) return;
        setSendingCode(true);
        setError('');
        try {
            await axios.post(`${API_BASE}/auth/2fa/totp/request-setup-code`, {}, {
                headers: authHeader,
                signal,
            });
            if (signal?.aborted) return;
            setCodeSent(true);
            setEmailCode('');
            setEmailCodeError(false);
            setResendCooldown(30);
            cooldownRef.current = setInterval(() => {
                setResendCooldown(n => {
                    if (n <= 1) { clearInterval(cooldownRef.current!); return 0; }
                    return n - 1;
                });
            }, 1000);
        } catch (err: any) {
            if (err?.code === 'ERR_CANCELED' || axios.isCancel(err)) return;
            setError(err?.response?.data?.message || 'Could not send verification code.');
        } finally {
            if (!signal?.aborted) setSendingCode(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sendingCode, resendCooldown, token]);

    // Send on mount — AbortController prevents the StrictMode double-mount from
    // firing two concurrent sends.  Cleanup aborts the first request; the second
    // (real) mount fires a fresh request that completes normally.
    useEffect(() => {
        const ctrl = new AbortController();
        sendCode(ctrl.signal);
        return () => {
            ctrl.abort();
            if (cooldownRef.current) clearInterval(cooldownRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Step 1 → Step 2: validate email code + fetch QR in one call ──────────

    const handleEmailCodeSubmit = useCallback(async (code: string) => {
        if (code.length !== 6 || loading) return;
        setLoading(true);
        setError('');
        setEmailCodeError(false);
        try {
            // POST /setup consumes the email OTP server-side and returns the QR
            // data plus a short-lived HMAC setup_token.  No OTP stored in state.
            const res = await axios.post(`${API_BASE}/auth/2fa/totp/setup`,
                { email_code: code },
                { headers: authHeader },
            );
            setSecretB32(res.data.secret_b32);
            setQrDataUrl(res.data.qr_data_url);
            setSetupToken(res.data.setup_token);
            setStep('setup');
        } catch (err: any) {
            const rawMsg = err?.response?.data?.message;
            const msg: string = Array.isArray(rawMsg) ? (rawMsg[0] || '') : (typeof rawMsg === 'string' ? rawMsg : '');
            setEmailCodeError(true);
            setEmailCode('');
            setError(msg || 'Verification code was incorrect or expired. Request a new one and try again.');
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, token]);

    // ── Verify TOTP + enable ──────────────────────────────────────────────────

    const handleEnable = useCallback(async (code: string) => {
        // enablingRef prevents the double-fire from SlottedCodeInput's onChange
        // (6th digit typed) and onKeyDown (Enter pressed) both calling this.
        if (code.length !== 6 || enablingRef.current) return;
        enablingRef.current = true;
        setError('');
        setTotpError(false);
        setLoading(true);
        try {
            const res = await axios.post(`${API_BASE}/auth/2fa/totp/enable`, {
                secret_b32: secretB32,
                code,
                setup_token: setupToken,
            }, { headers: authHeader });
            setBackupCodes(res.data.backup_codes || []);
            setStep('warning');
        } catch (err: any) {
            const rawMsg = err?.response?.data?.message;
            const msg: string = Array.isArray(rawMsg) ? (rawMsg[0] || '') : (typeof rawMsg === 'string' ? rawMsg : '');
            if (msg.toLowerCase().includes('session expired') || msg.toLowerCase().includes('start over')) {
                // setup_token expired (>30 min) — restart the whole flow
                setError('Setup session expired. Close and reopen this dialog to start over.');
            } else {
                setTotpError(true);
                setTimeout(() => setTotpError(false), 900);
                setTotpCode('');
                setError(msg || 'Authenticator code didn\'t match. Try the latest code from your app.');
            }
        } finally {
            setLoading(false);
            enablingRef.current = false;
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [secretB32, setupToken, token]);

    // ── Backup-code helpers ───────────────────────────────────────────────────

    const copyBackupCodes = async () => {
        try {
            await writeToClipboard(backupCodes.join('\n'));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* ignore — clipboard unavailable */ }
    };

    const downloadBackupCodes = async () => {
        const text = `Cipherline backup codes — keep these safe!\nEach code can be used once to sign in if you lose your authenticator.\n\n${backupCodes.join('\n')}\n`;
        const bytes = new TextEncoder().encode(text);
        if (window.electronAPI?.saveFileAs) {
            // saveFileAs shows the OS dialog AND writes the file in the main process —
            // the path never needs to pass assertInsideUserData.
            await window.electronAPI.saveFileAs({
                title: 'Save Cipherline backup codes',
                defaultPath: 'cipherline-backup-codes.txt',
                filters: [{ name: 'Text', extensions: ['txt'] }],
            }, bytes);
        } else {
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'cipherline-backup-codes.txt';
            a.click(); URL.revokeObjectURL(url);
        }
    };

    // ── Shared error banner ───────────────────────────────────────────────────

    const ErrorBanner = error ? (
        <div style={{ marginBottom: 14, padding: '10px 14px', background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.25)', borderRadius: 12, color: 'var(--cl-flash)', fontSize: 13, textAlign: 'center' }}>
            {error}
        </div>
    ) : null;

    // ─────────────────────────────────────────────────────────────────────────

    return (
        <ClModal open onClose={onClose} width={420}>

            {/* ── Step 1: email verification ───────────────────────────────── */}
            {step === 'email-verify' && (
                <>
                    <div style={{ textAlign: 'center', marginBottom: 20 }}>
                        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(37,224,200,.1)', border: '1px solid rgba(37,224,200,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                            <Mail size={28} style={{ color: 'var(--cl-lume)' }} />
                        </div>
                        <h4>Confirm it's you</h4>
                        <p>
                            {codeSent
                                ? <>We sent a 6-digit code to <strong style={{ color: 'var(--cl-text)' }}>{user?.email ?? 'your email'}</strong>. Enter it below to reveal your QR code.</>
                                : 'Sending a verification code to your email…'}
                        </p>
                    </div>

                    {ErrorBanner}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <SlottedCodeInput
                            value={emailCode}
                            onChange={setEmailCode}
                            onAutoSubmit={handleEmailCodeSubmit}
                            disabled={loading || sendingCode || !codeSent}
                            error={emailCodeError}
                        />

                        <ClButton
                            fullWidth
                            disabled={emailCode.length < 6 || loading || sendingCode}
                            loading={loading}
                            onClick={() => handleEmailCodeSubmit(emailCode)}
                        >
                            Continue
                        </ClButton>

                        <button
                            type="button"
                            disabled={sendingCode || resendCooldown > 0}
                            onClick={() => sendCode()}
                            style={{
                                background: 'none', border: 'none', cursor: sendingCode || resendCooldown > 0 ? 'default' : 'pointer',
                                color: sendingCode || resendCooldown > 0 ? 'var(--cl-faint)' : 'var(--cl-lume)',
                                fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '4px 0',
                            }}
                        >
                            <RefreshCw size={13} />
                            {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : sendingCode ? 'Sending…' : 'Resend code'}
                        </button>
                    </div>
                </>
            )}

            {/* ── Step 2: QR code ──────────────────────────────────────────── */}
            {step === 'setup' && (
                <>
                    <div style={{ textAlign: 'center', marginBottom: 20 }}>
                        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(37,224,200,.1)', border: '1px solid rgba(37,224,200,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                            <Smartphone size={28} style={{ color: 'var(--cl-lume)' }} />
                        </div>
                        <h4>Scan with your authenticator</h4>
                        <p>Open Google Authenticator, Authy, or 1Password and scan this QR code.</p>
                    </div>

                    {ErrorBanner}

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                        <img src={qrDataUrl} alt="TOTP QR code" style={{ width: 200, height: 200, borderRadius: 12, background: 'white', padding: 8 }} />
                        <div style={{ width: '100%', textAlign: 'center' }}>
                            <p style={{ fontSize: 11, color: 'var(--cl-faint)', marginBottom: 6 }}>Can't scan? Enter this secret manually:</p>
                            <code style={{ display: 'block', padding: '8px 12px', background: 'rgba(0,0,0,.3)', borderRadius: 8, fontSize: 12, color: 'var(--cl-muted)', fontFamily: 'var(--cl-font-mono)', wordBreak: 'break-all' }}>{secretB32}</code>
                        </div>
                        <ClButton fullWidth onClick={() => { setError(''); setTotpCode(''); setStep('verify'); }}>
                            I scanned it — continue
                        </ClButton>
                    </div>
                </>
            )}

            {/* ── Step 3: confirm TOTP code ─────────────────────────────────── */}
            {step === 'verify' && (
                <>
                    <div style={{ textAlign: 'center', marginBottom: 20 }}>
                        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(37,224,200,.1)', border: '1px solid rgba(37,224,200,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                            <ShieldCheck size={28} style={{ color: 'var(--cl-lume)' }} />
                        </div>
                        <h4>Enter the code from your app</h4>
                        <p>Open your authenticator and enter the 6-digit code shown for Cipherline.</p>
                    </div>

                    {ErrorBanner}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <SlottedCodeInput
                            value={totpCode}
                            onChange={setTotpCode}
                            onAutoSubmit={handleEnable}
                            disabled={loading}
                            error={totpError}
                            noAutoPaste
                        />

                        <ClButton
                            fullWidth
                            disabled={totpCode.length < 6 || loading}
                            loading={loading}
                            onClick={() => handleEnable(totpCode)}
                        >
                            Enable authenticator
                        </ClButton>

                        <ClButton type="button" variant="ghost" fullWidth onClick={() => { setError(''); setStep('setup'); }}>
                            ← Back to QR
                        </ClButton>
                    </div>
                </>
            )}

            {/* ── Step 4: warning ──────────────────────────────────────────── */}
            {step === 'warning' && (
                <motion.div
                    key="warning"
                    initial={{ opacity: 0, scale: 0.96, y: 12 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}
                >
                    <motion.div
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 220, damping: 14, delay: 0.1 }}
                        style={{ marginBottom: 16 }}
                    >
                        <Keys size={90} signal="alert" interactive={false} waveOnMount={false} />
                    </motion.div>

                    <motion.h4
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2, duration: 0.25 }}
                        style={{ margin: '0 0 10px', textAlign: 'center' }}
                    >
                        Important — read before continuing
                    </motion.h4>

                    <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.28, duration: 0.25 }}
                        style={{
                            background: 'rgba(251,191,36,.08)',
                            border: '1px solid rgba(251,191,36,.28)',
                            borderRadius: 14,
                            padding: '16px 18px',
                            marginBottom: 20,
                            width: '100%',
                        }}
                    >
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                            <AlertTriangle size={18} style={{ color: '#FBB024', flexShrink: 0, marginTop: 1 }} />
                            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--cl-text)' }}>
                                If you <strong>lose your authenticator app</strong> and <strong>don't have backup codes</strong>, your account is <strong style={{ color: '#FBB024' }}>permanently unrecoverable</strong>.
                            </p>
                        </div>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.36, duration: 0.25 }}
                        style={{ width: '100%' }}
                    >
                        <p style={{ fontSize: 13, color: 'var(--cl-muted)', textAlign: 'center', marginBottom: 16 }}>
                            On the next screen you'll see 10 backup codes. Save them somewhere safe before closing.
                        </p>
                        <ClButton fullWidth onClick={() => setStep('codes')}>
                            I understand — show me my backup codes
                        </ClButton>
                    </motion.div>
                </motion.div>
            )}

            {/* ── Step 5: backup codes ─────────────────────────────────────── */}
            {step === 'codes' && (
                <>
                    <div style={{ textAlign: 'center', marginBottom: 20 }}>
                        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(34,197,94,.1)', border: '1px solid rgba(34,197,94,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                            <CheckCheck size={28} className="text-emerald-400" />
                        </div>
                        <h4>Save your backup codes</h4>
                        <p>Each code works <strong style={{ color: 'var(--cl-text)' }}>once</strong> if you lose your authenticator. Save them somewhere safe — we won't show them again.</p>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
                        {backupCodes.map((c, i) => (
                            <code key={i} style={{ padding: '8px 12px', background: 'rgba(0,0,0,.3)', borderRadius: 8, fontSize: 12, color: 'var(--cl-muted)', fontFamily: 'var(--cl-font-mono)', textAlign: 'center', letterSpacing: '0.1em' }}>
                                {c}
                            </code>
                        ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                        <ClButton variant="ghost" size="sm" fullWidth onClick={copyBackupCodes}>
                            <Copy size={13} /> {copied ? 'Copied' : 'Copy all'}
                        </ClButton>
                        <ClButton variant="ghost" size="sm" fullWidth onClick={downloadBackupCodes}>
                            <Download size={13} /> Download
                        </ClButton>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                        <ClCheckbox
                            checked={acknowledged}
                            onChange={setAcknowledged}
                            label="I've saved my backup codes somewhere safe."
                        />
                    </div>
                    <ClButton fullWidth disabled={!acknowledged} onClick={() => { onDone(); onClose(); }}>
                        Done
                    </ClButton>
                </>
            )}
        </ClModal>
    );
};
