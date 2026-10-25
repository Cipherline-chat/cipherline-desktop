/**
 * DeviceApprovalPending — the screen a NEW device lands on when the server
 * (DEVICE_APPROVAL_REQUIRED=enforce) holds its sign-in as a pending request.
 *
 * It is content only; AuthScreen wraps it in its own card shell. Three ways
 * out, all enforced by the server — nothing here is a gate:
 *
 *   1. Approve from another device. The six digits shown here are derived
 *      LOCALLY from this device's own identity key and the server's nonce
 *      (utils/deviceApprovalCode.ts); the approver derives them from the key
 *      the server relayed. The human compares the two screens, so a relay
 *      that swapped keys is visible. The code is a comparison aid, not a
 *      secret — approval additionally needs the approver's signature.
 *   2. Sign in with a QR code instead (an approved device scans it).
 *   3. Type a recovery key — the "Storage Recovery Key" from Settings on any
 *      of the user's devices. Derived in the main process; never stored.
 *
 * The request lasts ~15 minutes. When it lapses the screen says so and offers
 * a fresh attempt. "I've lost my other devices" schedules a 24-hour
 * cooling-off reset (the account's other devices are emailed and any sign of
 * life on one of them cancels it).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, KeyRound, QrCode, Loader2, Clock, LifeBuoy } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClBanner } from './ClBanner';
import { ClConfirm, ClInput } from './cl';
import type { PendingDeviceApproval } from '../utils/deviceRegistration';
import { deriveDeviceApprovalCode, formatDeviceApprovalCode } from '../utils/deviceApprovalCode';
import {
    describeApprovalError, fetchApprovalStatus, formatCountdown, requestDeviceReset,
    secondsUntil, submitRecoveryKeyProof, type ApprovalStatus,
} from '../utils/deviceApproval';

const POLL_MS = 3000;

type Terminal = 'expired' | 'denied';

interface Props {
    userId: string;
    deviceId: string;
    /** Access token of the pending session — only usable for the approval routes. */
    token: string;
    approval: PendingDeviceApproval;
    /** The server approved this device: finish signing in. */
    onApproved: () => void;
    /** Leave the pending screen for the sign-in screen's QR option. */
    onUseQr: () => void;
    /** Back to the sign-in form (also the "try again" exit). */
    onBack: () => void;
}

const ErrorLine: React.FC<{ msg: string }> = ({ msg }) => (
    <ClBanner inline tone="danger" description={msg} />
);

export const DeviceApprovalPending: React.FC<Props> = ({ userId, deviceId, token, approval, onApproved, onUseQr, onBack }) => {
    const [code, setCode] = useState<string | null>(null);
    const [terminal, setTerminal] = useState<Terminal | null>(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [expiresAt, setExpiresAt] = useState<string | null>(approval.expiresAt);
    const [resetDueAt, setResetDueAt] = useState<string | null>(approval.resetDueAt);

    const [mode, setMode] = useState<'wait' | 'recovery'>('wait');
    const [recoveryKey, setRecoveryKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [confirmReset, setConfirmReset] = useState(false);

    // StrictMode mounts twice; every async continuation checks this.
    const alive = useRef(true);
    const approvedOnce = useRef(false);
    const onApprovedRef = useRef(onApproved);
    useEffect(() => { onApprovedRef.current = onApproved; });
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    // The code: derived from OUR OWN key + the server's nonce.
    useEffect(() => {
        let cancelled = false;
        deriveDeviceApprovalCode(userId, approval.identityPub, approval.nonceB64)
            .then(c => { if (!cancelled) setCode(c); })
            .catch(() => { if (!cancelled) setError('Could not compute the verification code on this device.'); });
        return () => { cancelled = true; };
    }, [userId, approval.identityPub, approval.nonceB64]);

    // Countdown tick.
    useEffect(() => {
        const t = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    const finish = useCallback((status: ApprovalStatus) => {
        if (!alive.current) return;
        if (status === 'approved') {
            if (approvedOnce.current) return;
            approvedOnce.current = true;
            onApprovedRef.current();
        } else if (status === 'expired') {
            setTerminal('expired');
        } else if (status === 'revoked' || status === 'denied') {
            setTerminal('denied');
        }
    }, []);

    // Poll the request. Also where a lapsed request expires and a due reset runs
    // (server side, lazily) — so this poll is what makes a reset complete.
    useEffect(() => {
        if (terminal) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            try {
                const st = await fetchApprovalStatus(token, deviceId);
                if (stopped) return;
                if (st.status === 'pending') {
                    if (st.expires_at) setExpiresAt(st.expires_at);
                    setResetDueAt(st.reset_due_at ?? null);
                } else {
                    finish(st.status);
                    return;
                }
            } catch (e) {
                if (stopped) return;
                const d = describeApprovalError(e);
                // A 404/expired answer ends the request; anything else (offline,
                // 429) is a blip — keep polling.
                if (d.kind === 'expired') { finish('expired'); return; }
            }
            timer = setTimeout(tick, POLL_MS);
        };
        timer = setTimeout(tick, 600);
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [terminal, token, deviceId, finish]);

    const remaining = secondsUntil(expiresAt, nowMs);
    const resetRemaining = secondsUntil(resetDueAt, nowMs);

    const submitRecovery = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy || !recoveryKey.trim()) return;
        setBusy(true); setError('');
        try {
            await submitRecoveryKeyProof(token, userId, deviceId, approval.identityPub, recoveryKey);
            setRecoveryKey('');
            finish('approved');
        } catch (err) {
            const d = describeApprovalError(err);
            if (d.kind === 'locked') setTerminal('denied');
            else setError(d.message);
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const doReset = async () => {
        setBusy(true); setError('');
        try {
            const { resetDueAt: due } = await requestDeviceReset(token, deviceId);
            setResetDueAt(due);
            // The request now outlives the cooling-off window.
            setExpiresAt(null);
            setConfirmReset(false);
        } catch (err) {
            setError(describeApprovalError(err).message);
            setConfirmReset(false);
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    if (terminal) {
        return (
            <>
                <div className="text-center mb-7">
                    <div className="w-14 h-14 rounded-2xl bg-cl-flash/10 border border-cl-flash/20 flex items-center justify-center mx-auto mb-4">
                        <Clock className="w-7 h-7 text-cl-flash" />
                    </div>
                    <h2 className="text-xl font-bold text-cl-text mb-1">
                        {terminal === 'expired' ? 'Request expired' : 'Request declined'}
                    </h2>
                    <p className="text-cl-faint text-sm leading-relaxed">
                        {terminal === 'expired'
                            ? 'Nobody approved this device in time. Sign in again to send a new request.'
                            : 'This device was not approved, so it has been signed out. If that was a mistake, sign in again to send a new request.'}
                    </p>
                </div>
                <ClButton fullWidth onClick={onBack}>Back to sign in</ClButton>
            </>
        );
    }

    return (
        <>
            <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center mx-auto mb-4">
                    <ShieldCheck className="w-7 h-7 text-cl-lume" />
                </div>
                <h2 className="text-xl font-bold text-cl-text mb-1">Approve this device</h2>
                <p className="text-cl-faint text-sm leading-relaxed">
                    Open Cipherline on one of your other devices and approve this sign-in.
                    It will ask for the code below — make sure the codes match.
                </p>
            </div>

            <div
                className="rounded-2xl py-5 mb-4 text-center"
                style={{ background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)' }}
                aria-live="polite"
            >
                <p className="text-[11px] uppercase tracking-widest mb-2" style={{ color: 'var(--cl-faint)' }}>Verification code</p>
                {code ? (
                    <p
                        data-testid="device-approval-code"
                        className="text-4xl font-bold select-all"
                        style={{ color: 'var(--cl-text)', letterSpacing: '0.18em', fontFamily: "'JetBrains Mono','SFMono-Regular',Consolas,monospace" }}
                    >
                        {formatDeviceApprovalCode(code)}
                    </p>
                ) : (
                    <Loader2 className="w-6 h-6 mx-auto animate-spin" style={{ color: 'var(--cl-faint)' }} />
                )}
                {resetDueAt == null && remaining != null && (
                    <p className="text-xs mt-3" style={{ color: 'var(--cl-faint)' }}>
                        <Clock size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: '-2px' }} />
                        Expires in {formatCountdown(remaining)}
                    </p>
                )}
            </div>

            {resetDueAt != null && (
                <div className="mb-4 px-4 py-3 rounded-xl text-sm text-center" style={{ background: 'rgba(37,224,200,.06)', border: '1px solid var(--cl-border)', color: 'var(--cl-text)' }}>
                    Device reset scheduled. If none of your other devices are used before then, this device is approved
                    {resetRemaining != null ? ` in ${Math.max(1, Math.ceil(resetRemaining / 3600))} h` : ''} and your other devices are signed out.
                    Using any of them cancels the reset.
                </div>
            )}

            {error && <div className="mb-4"><ErrorLine msg={error} /></div>}

            {mode === 'recovery' ? (
                <form onSubmit={submitRecovery} className="flex flex-col gap-3">
                    <p className="text-cl-faint text-sm leading-relaxed">
                        Paste the <b>Storage Recovery Key</b> from Settings on any device you have already signed in with.
                    </p>
                    <ClInput
                        type="password" autoFocus autoComplete="off" spellCheck={false}
                        placeholder="Recovery key" value={recoveryKey} disabled={busy}
                        onChange={e => setRecoveryKey(e.target.value)}
                    />
                    <ClButton type="submit" fullWidth disabled={busy || !recoveryKey.trim()} loading={busy}>Use recovery key</ClButton>
                    <ClButton type="button" variant="ghost" fullWidth disabled={busy} onClick={() => { setMode('wait'); setError(''); setRecoveryKey(''); }}>
                        ← Back
                    </ClButton>
                </form>
            ) : (
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--cl-faint)' }}>
                        <Loader2 size={14} className="animate-spin" /> Waiting for approval…
                    </div>
                    <ClButton variant="ghost" fullWidth onClick={onUseQr}>
                        <QrCode size={15} /> Sign in with a QR code instead
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => { setMode('recovery'); setError(''); }}>
                        <KeyRound size={15} /> Use a recovery key
                    </ClButton>
                    {resetDueAt == null && (
                        <ClButton variant="ghost" fullWidth onClick={() => setConfirmReset(true)}>
                            <LifeBuoy size={15} /> I've lost my other devices
                        </ClButton>
                    )}
                    <ClButton variant="ghost" fullWidth onClick={onBack}>← Back to sign in</ClButton>
                </div>
            )}

            <ClConfirm
                open={confirmReset}
                onClose={() => setConfirmReset(false)}
                onConfirm={doReset}
                loading={busy}
                title="Reset your devices?"
                message="If none of your other devices are used in the next 24 hours, they will all be signed out and this device will be approved. We'll email you now, and using any other device cancels the reset. Only do this if you can't reach your other devices or a recovery key."
                confirmLabel="Schedule reset"
                danger
            />
        </>
    );
};

export default DeviceApprovalPending;
