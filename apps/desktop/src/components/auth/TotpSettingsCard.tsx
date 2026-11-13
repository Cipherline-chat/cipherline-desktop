/**
 * Security Settings → Authenticator app card.
 *
 * - Shows current enrolment status + remaining backup code count.
 * - "Set up authenticator" → opens TotpSetupModal (QR scan + backup codes).
 * - "Disable" → dedicated email OTP confirm (single-step), then removes enrolment.
 * - "Regenerate codes" → email OTP confirm (same gate as disable) → shows 10 new codes once.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Smartphone, ShieldCheck, ShieldOff, RefreshCw, Copy, Download, CheckCheck } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { TotpSetupModal } from './TotpSetupModal';
import { ClButton, ClModal, ClCheckbox } from '../cl';
import SlottedCodeInput from '../SlottedCodeInput';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogStack, DialogLinkButton } from '../dialog/DialogExtras';
import { writeToClipboard } from '../../utils/clipboard';

interface Status {
    enabled: boolean;
    enabled_at: string | null;
    backup_codes_remaining: number;
}

interface TotpSettingsCardProps {
    /** Hide the card's own "Two-factor authentication" heading — for hosts
     *  (the Descent security card) that already provide section context. */
    bare?: boolean;
}

export const TotpSettingsCard: React.FC<TotpSettingsCardProps> = ({ bare = false }) => {
    const { token, user } = useAuth();
    const [status, setStatus] = useState<Status | null>(null);
    const [showSetup, setShowSetup] = useState(false);
    const [showDisable, setShowDisable] = useState(false);

    // Disable modal state (single step — email OTP only)
    const [emailCode, setEmailCode] = useState('');
    const [emailCodeError, setEmailCodeError] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const [codeSent, setCodeSent] = useState(false);
    const [resendCooldown, setResendCooldown] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Regenerate backup codes modal — email OTP gated (same model as disable)
    const [showRegen, setShowRegen] = useState(false);
    const [regenStep, setRegenStep] = useState<'auth' | 'codes'>('auth');
    const [regenEmailCode, setRegenEmailCode] = useState('');
    const [regenEmailCodeError, setRegenEmailCodeError] = useState(false);
    const [regenSendingCode, setRegenSendingCode] = useState(false);
    const [regenCodeSent, setRegenCodeSent] = useState(false);
    const [regenResendCooldown, setRegenResendCooldown] = useState(0);
    const [regenError, setRegenError] = useState('');
    const [regenLoading, setRegenLoading] = useState(false);
    const [regenCodes, setRegenCodes] = useState<string[]>([]);
    const [regenCopied, setRegenCopied] = useState(false);
    const [regenAcknowledged, setRegenAcknowledged] = useState(false);
    const regenCooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const authHeader = { Authorization: `Bearer ${token}` };

    const refresh = useCallback(async () => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/auth/2fa/totp/status`, { headers: authHeader });
            setStatus(res.data);
        } catch (err) {
            console.warn('[TotpSettings] status fetch failed', err);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    useEffect(() => { refresh(); }, [refresh]);

    // ── Disable modal helpers ─────────────────────────────────────────────────

    const resetDisable = () => {
        setEmailCode(''); setEmailCodeError(false);
        setSendingCode(false); setCodeSent(false);
        setResendCooldown(0); setError('');
        if (cooldownRef.current) clearInterval(cooldownRef.current);
    };

    const openDisable = () => { resetDisable(); setShowDisable(true); };
    const closeDisable = () => { setShowDisable(false); resetDisable(); };

    const sendDisableCode = useCallback(async () => {
        if (sendingCode || resendCooldown > 0) return;
        setSendingCode(true); setError('');
        try {
            await axios.post(`${API_BASE}/auth/2fa/totp/request-disable-code`, {}, { headers: authHeader });
            setCodeSent(true);
            setEmailCode(''); setEmailCodeError(false);
            setResendCooldown(30);
            cooldownRef.current = setInterval(() => {
                setResendCooldown(n => {
                    if (n <= 1) { clearInterval(cooldownRef.current!); return 0; }
                    return n - 1;
                });
            }, 1000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Could not send verification code.');
        } finally {
            setSendingCode(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sendingCode, resendCooldown, token]);

    // Auto-send when disable modal opens
    useEffect(() => {
        if (showDisable) sendDisableCode();
        return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showDisable]);

    const handleDisable = useCallback(async (code: string) => {
        if (code.length !== 6) return;
        setError(''); setEmailCodeError(false); setLoading(true);
        try {
            await axios.post(`${API_BASE}/auth/2fa/totp/disable`, {
                email_code: code,
            }, { headers: authHeader });
            await refresh();
            closeDisable();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            const rawMsg = err?.response?.data?.message;
            const msg: string = Array.isArray(rawMsg) ? (rawMsg[0] || '') : (typeof rawMsg === 'string' ? rawMsg : '');
            setEmailCodeError(true);
            setTimeout(() => setEmailCodeError(false), 900);
            setEmailCode('');
            setError(msg || 'Invalid or expired code. Request a new one.');
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, refresh]);

    // ── Regenerate modal helpers ──────────────────────────────────────────────

    const resetRegen = () => {
        setRegenStep('auth'); setRegenEmailCode(''); setRegenEmailCodeError(false);
        setRegenSendingCode(false); setRegenCodeSent(false); setRegenResendCooldown(0);
        setRegenError(''); setRegenLoading(false);
        setRegenCodes([]); setRegenCopied(false); setRegenAcknowledged(false);
        if (regenCooldownRef.current) clearInterval(regenCooldownRef.current);
    };

    const openRegen = () => { resetRegen(); setShowRegen(true); };
    const closeRegen = () => { setShowRegen(false); resetRegen(); };

    const sendRegenCode = useCallback(async () => {
        if (regenSendingCode || regenResendCooldown > 0) return;
        setRegenSendingCode(true); setRegenError('');
        try {
            await axios.post(`${API_BASE}/auth/2fa/totp/request-regen-code`, {}, { headers: authHeader });
            setRegenCodeSent(true);
            setRegenEmailCode(''); setRegenEmailCodeError(false);
            setRegenResendCooldown(30);
            regenCooldownRef.current = setInterval(() => {
                setRegenResendCooldown(n => {
                    if (n <= 1) { clearInterval(regenCooldownRef.current!); return 0; }
                    return n - 1;
                });
            }, 1000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setRegenError(err?.response?.data?.message || 'Could not send verification code.');
        } finally {
            setRegenSendingCode(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [regenSendingCode, regenResendCooldown, token]);

    // Auto-send when the regen modal opens
    useEffect(() => {
        if (showRegen) sendRegenCode();
        return () => { if (regenCooldownRef.current) clearInterval(regenCooldownRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showRegen]);

    const handleRegen = useCallback(async (code: string) => {
        if (code.length !== 6) return;
        setRegenError(''); setRegenEmailCodeError(false); setRegenLoading(true);
        try {
            const res = await axios.post(`${API_BASE}/auth/2fa/totp/regenerate-backup-codes`, {
                email_code: code,
            }, { headers: authHeader });
            setRegenCodes(res.data.backup_codes || []);
            setRegenStep('codes');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            const rawMsg = err?.response?.data?.message;
            const msg: string = Array.isArray(rawMsg) ? (rawMsg[0] || '') : (typeof rawMsg === 'string' ? rawMsg : '');
            setRegenEmailCodeError(true);
            setTimeout(() => setRegenEmailCodeError(false), 900);
            setRegenEmailCode('');
            setRegenError(msg || 'Invalid or expired code. Request a new one.');
        } finally {
            setRegenLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const copyRegenCodes = async () => {
        try {
            await writeToClipboard(regenCodes.join('\n'));
            setRegenCopied(true);
            setTimeout(() => setRegenCopied(false), 2000);
        } catch { /* ignore — clipboard unavailable */ }
    };

    const downloadRegenCodes = async () => {
        const text = `Cipherline backup codes — keep these safe!\nEach code can be used once to sign in if you lose your authenticator.\n\n${regenCodes.join('\n')}\n`;
        const bytes = new TextEncoder().encode(text);
        if (window.electronAPI?.saveFileAs) {
            await window.electronAPI.saveFileAs({
                title: 'Save Cipherline backup codes',
                defaultPath: 'cipherline-backup-codes.txt',
                filters: [{ name: 'Text', extensions: ['txt'] }],
            }, bytes);
        } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'cipherline-backup-codes.txt';
            a.click();
        }
    };

    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div className="space-y-3">
            {!bare && <h4 className="text-sm font-bold" style={{ color: 'var(--cl-text)' }}>Two-factor authentication</h4>}

            {/* ── Status row ── */}
            <div className="border rounded-xl p-4 flex items-center justify-between gap-3" style={{ background: 'var(--cl-surface)', borderColor: 'var(--cl-border)' }}>
                <div className="flex items-center gap-4 min-w-0">
                    <div
                        className="flex items-center justify-center shrink-0"
                        style={{
                            width: 36, height: 36, borderRadius: 10,
                            background: status?.enabled ? 'rgba(37,224,200,0.1)' : 'var(--cl-raise)',
                            border: `1px solid ${status?.enabled ? 'rgba(37,224,200,0.2)' : 'var(--cl-border)'}`,
                            color: status?.enabled ? 'var(--cl-lume)' : 'var(--cl-faint)',
                        }}
                    >
                        {status?.enabled ? <ShieldCheck size={17} /> : <Smartphone size={17} />}
                    </div>
                    <div className="min-w-0">
                        <div className="text-sm font-bold" style={{ color: 'var(--cl-text)' }}>Authenticator app</div>
                        <div className="text-xs" style={{ color: 'var(--cl-faint)' }}>
                            {status?.enabled ? (
                                <>Active. {status.backup_codes_remaining} backup code{status.backup_codes_remaining === 1 ? '' : 's'} remaining.</>
                            ) : (
                                <>Use Google Authenticator, Authy, or 1Password instead of email codes.</>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex gap-2 shrink-0">
                    {status?.enabled ? (
                        <>
                            <ClButton size="sm" variant="ghost" onClick={openRegen} tooltip="Regenerate backup codes">
                                <RefreshCw size={13} /> Regen codes
                            </ClButton>
                            {/* Ghost, not danger — the confirm modal is the real gate; a red
                                button next to routine actions read as a standing alarm. */}
                            <ClButton size="sm" variant="ghost" onClick={openDisable}>Disable</ClButton>
                        </>
                    ) : (
                        <ClButton size="sm" onClick={() => setShowSetup(true)}>Set up</ClButton>
                    )}
                </div>
            </div>

            {showSetup && (
                <TotpSetupModal onClose={() => setShowSetup(false)} onDone={() => refresh()} />
            )}

            {/* ── Disable modal ──────────────────────────────────────────── */}
            <ClModal open={showDisable} onClose={closeDisable} width={420} label="Disable authenticator" cardClassName="dlg-card dlg-tone-danger">
                <DialogHeader
                    icon={<ShieldOff size={19} strokeWidth={2.2} />}
                    title="Disable authenticator"
                    subtitle="After disabling, sign-in codes will be sent to your email instead."
                />
                <DialogBody>
                    <DialogStack center>
                        <div className="dlg-copy">
                            {codeSent
                                ? <>A 6-digit code was sent to <strong>{user?.email ?? 'your email'}</strong>. Enter it to disable.</>
                                : 'Sending a verification code to your email…'}
                        </div>
                        <SlottedCodeInput
                            value={emailCode}
                            onChange={setEmailCode}
                            onAutoSubmit={handleDisable}
                            disabled={loading || sendingCode || !codeSent}
                            error={emailCodeError}
                        />
                        <DialogLinkButton disabled={sendingCode || resendCooldown > 0} onClick={sendDisableCode}>
                            <RefreshCw size={13} />
                            {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : sendingCode ? 'Sending…' : 'Resend code'}
                        </DialogLinkButton>
                    </DialogStack>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                <DialogFooter hint="Needs a code from your email">
                    <ClButton variant="ghost" size="sm" onClick={closeDisable}>Cancel</ClButton>
                    <ClButton
                        variant="danger"
                        size="sm"
                        disabled={emailCode.length < 6 || loading || sendingCode}
                        loading={loading}
                        onClick={() => handleDisable(emailCode)}
                    >
                        Disable authenticator
                    </ClButton>
                </DialogFooter>
            </ClModal>

            {/* ── Regenerate backup codes modal ──────────────────────────── */}
            <ClModal
                open={showRegen}
                onClose={closeRegen}
                width={440}
                label={regenStep === 'codes' ? 'New backup codes' : 'Regenerate backup codes'}
                cardClassName={`dlg-card${regenStep === 'codes' ? ' dlg-tone-ok' : ' dlg-tone-warn'}`}
            >
                {regenStep === 'auth' && (
                    <>
                        <DialogHeader
                            icon={<RefreshCw size={19} strokeWidth={2.2} />}
                            title="Regenerate backup codes"
                            subtitle="Your existing backup codes will be permanently revoked and replaced with 10 new ones."
                        />
                        <DialogBody>
                            <DialogStack center>
                                <div className="dlg-copy">
                                    {regenCodeSent
                                        ? <>A 6-digit code was sent to <strong>{user?.email ?? 'your email'}</strong>. Enter it to continue.</>
                                        : 'Sending a verification code to your email…'}
                                </div>
                                <SlottedCodeInput
                                    value={regenEmailCode}
                                    onChange={setRegenEmailCode}
                                    onAutoSubmit={handleRegen}
                                    disabled={regenLoading || regenSendingCode || !regenCodeSent}
                                    error={regenEmailCodeError}
                                />
                                <DialogLinkButton disabled={regenSendingCode || regenResendCooldown > 0} onClick={sendRegenCode}>
                                    <RefreshCw size={13} />
                                    {regenResendCooldown > 0 ? `Resend in ${regenResendCooldown}s` : regenSendingCode ? 'Sending…' : 'Resend code'}
                                </DialogLinkButton>
                            </DialogStack>
                        </DialogBody>
                        {regenError && <DialogError>{regenError}</DialogError>}
                        <DialogFooter hint="Needs a code from your email">
                            <ClButton variant="ghost" size="sm" onClick={closeRegen}>Cancel</ClButton>
                            <ClButton
                                size="sm"
                                disabled={regenEmailCode.length < 6 || regenLoading || regenSendingCode}
                                loading={regenLoading}
                                onClick={() => handleRegen(regenEmailCode)}
                            >
                                Regenerate backup codes
                            </ClButton>
                        </DialogFooter>
                    </>
                )}

                {regenStep === 'codes' && (
                    <>
                        <DialogHeader
                            icon={<CheckCheck size={19} strokeWidth={2.2} />}
                            title="New backup codes"
                            subtitle="Your old codes are now invalid. Save these somewhere safe."
                        />
                        <DialogBody className="dlg-body--scroll">
                            <DialogStack>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                    {regenCodes.map((c, i) => (
                                        <code key={i} className="dlg-code" style={{ padding: '8px 10px', letterSpacing: '0.1em' }}>{c}</code>
                                    ))}
                                </div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <ClButton variant="ghost" size="sm" fullWidth onClick={copyRegenCodes}>
                                        <Copy size={13} /> {regenCopied ? 'Copied' : 'Copy all'}
                                    </ClButton>
                                    <ClButton variant="ghost" size="sm" fullWidth onClick={downloadRegenCodes}>
                                        <Download size={13} /> Download
                                    </ClButton>
                                </div>
                                <ClCheckbox
                                    checked={regenAcknowledged}
                                    onChange={setRegenAcknowledged}
                                    label="I've saved my new backup codes somewhere safe."
                                />
                            </DialogStack>
                        </DialogBody>
                        <DialogFooter hint="We won't show these again">
                            <ClButton size="sm" disabled={!regenAcknowledged} onClick={() => { refresh(); closeRegen(); }}>
                                Done
                            </ClButton>
                        </DialogFooter>
                    </>
                )}
            </ClModal>
        </div>
    );
};
