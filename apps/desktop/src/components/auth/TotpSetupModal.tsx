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
import { motion, useReducedMotion } from 'framer-motion';
import axios from 'axios';
import { Mail, Smartphone, Copy, Download, CheckCheck, ShieldCheck, RefreshCw, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { ClModal, ClButton, ClCheckbox } from '../cl';
import SlottedCodeInput from '../SlottedCodeInput';
import { Keys } from '../mascot/Keys';
import { writeToClipboard } from '../../utils/clipboard';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogStack, DialogNote, DialogLinkButton, DialogSteps } from '../dialog/DialogExtras';

interface Props {
    onClose: () => void;
    onDone: () => void;
}

export const TotpSetupModal: React.FC<Props> = ({ onClose, onDone }) => {
    const { token, user } = useAuth();
    const reduceMotion = useReducedMotion();

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
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

    // ─────────────────────────────────────────────────────────────────────────
    // Layout: the shared dialog pattern (components/dialog) — one header per
    // step, a body for that step's content, the inline error between body and
    // footer, and a footer whose hint tracks progress. Presentation only: every
    // handler above is unchanged.

    const STEP_INDEX: Record<Step, number> = { 'email-verify': 0, setup: 1, verify: 2, warning: 3, codes: 4 };
    const emailAddress = user?.email ?? 'your email';

    const head: { icon: React.ReactNode; title: string; subtitle: React.ReactNode; tone: string } =
        step === 'email-verify' ? {
            icon: <Mail size={19} strokeWidth={2.2} />, tone: '',
            title: "Confirm it's you",
            subtitle: codeSent
                ? <>We sent a 6-digit code to <strong style={{ color: 'var(--cl-text)' }}>{emailAddress}</strong>.</>
                : 'Sending a verification code to your email…',
        } : step === 'setup' ? {
            icon: <Smartphone size={19} strokeWidth={2.2} />, tone: '',
            title: 'Scan with your authenticator',
            subtitle: 'Open Google Authenticator, Authy, or 1Password and scan this QR code.',
        } : step === 'verify' ? {
            icon: <ShieldCheck size={19} strokeWidth={2.2} />, tone: '',
            title: 'Enter the code from your app',
            subtitle: 'Type the 6-digit code your authenticator shows for Cipherline.',
        } : step === 'warning' ? {
            icon: <AlertTriangle size={19} strokeWidth={2.2} />, tone: ' dlg-tone-warn',
            title: 'Read this before continuing',
            subtitle: "Next you'll see 10 backup codes. Save them somewhere safe before closing.",
        } : {
            icon: <CheckCheck size={19} strokeWidth={2.2} />, tone: ' dlg-tone-ok',
            title: 'Save your backup codes',
            subtitle: <>Each code works <strong style={{ color: 'var(--cl-text)' }}>once</strong> if you lose your authenticator.</>,
        };

    return (
        <ClModal open onClose={onClose} width={440} label="Set up authenticator app" cardClassName={`dlg-card${head.tone}`}>
            <DialogHeader icon={head.icon} title={head.title} subtitle={head.subtitle} />

            <DialogBody className="dlg-body--scroll">
                {/* ── Step 1: email verification ───────────────────────────────── */}
                {step === 'email-verify' && (
                    <DialogStack center>
                        <SlottedCodeInput
                            value={emailCode}
                            onChange={setEmailCode}
                            onAutoSubmit={handleEmailCodeSubmit}
                            disabled={loading || sendingCode || !codeSent}
                            error={emailCodeError}
                        />
                        <DialogLinkButton disabled={sendingCode || resendCooldown > 0} onClick={() => sendCode()}>
                            <RefreshCw size={13} />
                            {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : sendingCode ? 'Sending…' : 'Resend code'}
                        </DialogLinkButton>
                    </DialogStack>
                )}

                {/* ── Step 2: QR code ──────────────────────────────────────────── */}
                {step === 'setup' && (
                    <DialogStack center>
                        <img src={qrDataUrl} alt="TOTP QR code" style={{ width: 188, height: 188, borderRadius: 12, background: 'white', padding: 8 }} />
                        <DialogStack tight>
                            <div className="dlg-help">Can&rsquo;t scan? Enter this secret manually:</div>
                            <code className="dlg-code">{secretB32}</code>
                        </DialogStack>
                    </DialogStack>
                )}

                {/* ── Step 3: confirm TOTP code ─────────────────────────────────── */}
                {step === 'verify' && (
                    <DialogStack center>
                        <SlottedCodeInput
                            value={totpCode}
                            onChange={setTotpCode}
                            onAutoSubmit={handleEnable}
                            disabled={loading}
                            error={totpError}
                            noAutoPaste
                        />
                    </DialogStack>
                )}

                {/* ── Step 4: warning ──────────────────────────────────────────── */}
                {step === 'warning' && (
                    <DialogStack center>
                        <motion.div
                            initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: 'spring', stiffness: 220, damping: 16 }}
                        >
                            <Keys size={76} signal="alert" interactive={false} waveOnMount={false} />
                        </motion.div>
                        <div style={{ width: '100%', textAlign: 'left' }}>
                            <DialogNote tone="warn" icon={<AlertTriangle size={16} aria-hidden />}>
                                If you <strong>lose your authenticator app</strong> and <strong>don't have backup codes</strong>, your account is <strong style={{ color: 'var(--cl-glow)' }}>permanently unrecoverable</strong>.
                            </DialogNote>
                        </div>
                    </DialogStack>
                )}

                {/* ── Step 5: backup codes ─────────────────────────────────────── */}
                {step === 'codes' && (
                    <DialogStack>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            {backupCodes.map((c, i) => (
                                <code key={i} className="dlg-code" style={{ padding: '8px 10px', letterSpacing: '0.1em' }}>{c}</code>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <ClButton variant="ghost" size="sm" fullWidth onClick={copyBackupCodes}>
                                <Copy size={13} /> {copied ? 'Copied' : 'Copy all'}
                            </ClButton>
                            <ClButton variant="ghost" size="sm" fullWidth onClick={downloadBackupCodes}>
                                <Download size={13} /> Download
                            </ClButton>
                        </div>
                        <ClCheckbox
                            checked={acknowledged}
                            onChange={setAcknowledged}
                            label="I've saved my backup codes somewhere safe."
                        />
                    </DialogStack>
                )}
            </DialogBody>

            {error && <DialogError>{error}</DialogError>}

            <DialogFooter hint={step === 'codes'
                ? <>We won&rsquo;t show these again</>
                : <DialogSteps index={STEP_INDEX[step]} count={5} label={`${STEP_INDEX[step] + 1} of 5`} />}
            >
                {step === 'email-verify' && (
                    <>
                        <ClButton variant="ghost" size="sm" onClick={onClose}>Cancel</ClButton>
                        <ClButton
                            size="sm"
                            disabled={emailCode.length < 6 || loading || sendingCode}
                            loading={loading}
                            onClick={() => handleEmailCodeSubmit(emailCode)}
                        >
                            Continue
                        </ClButton>
                    </>
                )}
                {step === 'setup' && (
                    <>
                        <ClButton variant="ghost" size="sm" onClick={onClose}>Cancel</ClButton>
                        <ClButton size="sm" onClick={() => { setError(''); setTotpCode(''); setStep('verify'); }}>
                            I scanned it
                        </ClButton>
                    </>
                )}
                {step === 'verify' && (
                    <>
                        <ClButton type="button" variant="ghost" size="sm" onClick={() => { setError(''); setStep('setup'); }}>← Back</ClButton>
                        <ClButton
                            size="sm"
                            disabled={totpCode.length < 6 || loading}
                            loading={loading}
                            onClick={() => handleEnable(totpCode)}
                        >
                            Enable
                        </ClButton>
                    </>
                )}
                {step === 'warning' && (
                    <ClButton size="sm" onClick={() => setStep('codes')}>
                        I understand — show my codes
                    </ClButton>
                )}
                {step === 'codes' && (
                    <ClButton size="sm" disabled={!acknowledged} onClick={() => { onDone(); onClose(); }}>
                        Done
                    </ClButton>
                )}
            </DialogFooter>
        </ClModal>
    );
};
