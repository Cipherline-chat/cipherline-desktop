import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import QRCode from 'qrcode';
import { Smartphone, Loader2, AlertTriangle, ShieldCheck, CheckCircle2, X as XIcon } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { buildInviteQr } from '../../utils/linkQr';
import { formatCountdown } from '../../utils/formatCountdown';
import { ClButton } from '../ClButton';
import { ClInput, ClField } from '../cl/ClInput';
import {
    PhoneLinkController, type PhoneLinkDeps, type PhoneLinkSnapshot,
} from '../../utils/phoneLinkController';
import type {
    ApproveLinkSessionBody, ApproveLinkSessionResponse, CreateLinkInviteResponse,
    LinkGrantPayloadV2, LinkInvitePollResponse,
} from '../../types/link';
import { useLinkController } from './useLinkController';

/**
 * "Sign in on your phone" — THIS desktop is the signed-in device showing an
 * invite QR for a new phone to scan. Settings → Devices. The mirror of
 * `QrSignInPanel` (where this desktop is the new device); state machinery in
 * `../../utils/phoneLinkController.ts`, whose header walks the exchange.
 *
 * What the user does here, in order: press "Show a code" → the phone scans it
 * (Sign in → "Sign in with a QR code") → this card says which phone joined
 * and asks for the six digits that phone is now showing (+ an authenticator
 * code when the account has TOTP) → Approve → "Finish on your phone".
 *
 * Same visual language as `TransferQrPanel` (sd-card, sd-tile header), and
 * the same StrictMode-safe controller lifetime via `useLinkController`.
 */

const POLL_INTERVAL_MS = 2000;
const COUNTDOWN_TICK_MS = 250;

function realDeps(getAuth: () => { token: string | null; deviceId: string | null }): PhoneLinkDeps {
    const headers = () => {
        const { token, deviceId } = getAuth();
        return { Authorization: `Bearer ${token}`, 'x-device-id': deviceId ?? '' };
    };
    return {
        createInvite: async (): Promise<CreateLinkInviteResponse> =>
            (await axios.post<CreateLinkInviteResponse>(`${API_BASE}/link/invites`, {}, { headers: headers() })).data,
        pollInvite: async (inviteId: string): Promise<LinkInvitePollResponse> =>
            (await axios.get<LinkInvitePollResponse>(`${API_BASE}/link/invites/${inviteId}`, { headers: headers() })).data,
        approve: async (inviteId: string, body: ApproveLinkSessionBody): Promise<ApproveLinkSessionResponse> =>
            (await axios.post<ApproveLinkSessionResponse>(`${API_BASE}/link/sessions/${inviteId}/approve`, body, { headers: headers() })).data,
        deny: async (inviteId: string) => {
            await axios.post(`${API_BASE}/link/sessions/${inviteId}/deny`, {}, { headers: headers() });
        },
        seal: async (payload: LinkGrantPayloadV2, ekPubB64: string, linkId: string) => {
            if (!window.electronAPI?.linkSeal) throw new Error('This feature requires the desktop app.');
            return window.electronAPI.linkSeal(payload, ekPubB64, linkId);
        },
        postGrant: async (inviteId: string, envelopeB64: string) => {
            await axios.post(`${API_BASE}/link/sessions/${inviteId}/grant`, { envelope_b64: envelopeB64 }, { headers: headers() });
        },
        renderQr: (text: string) => QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 256 }),
        buildQrText: buildInviteQr,
        pollIntervalMs: POLL_INTERVAL_MS,
        countdownTickMs: COUNTDOWN_TICK_MS,
    };
}

const emptySnapshot: PhoneLinkSnapshot = {
    phase: 'idle', qrDataUrl: null, remainingS: 0, error: null, joined: null, formError: null, deniedReason: null,
};

function platformName(p: string | null): string {
    switch (p) {
        case 'ios': return 'iPhone';
        case 'android': return 'Android phone';
        case 'mac': return 'Mac';
        case 'windows': return 'Windows PC';
        case 'linux': return 'Linux PC';
        default: return 'device';
    }
}

/**
 * The code (+ second factor) form. A separate component so its field state
 * lives exactly as long as ONE joined phone is on screen: it mounts when the
 * panel enters `joined`, survives `approving` (same instance), and unmounts —
 * fields discarded — on every other phase. No effect needed to reset it.
 */
const ApproveForm: React.FC<{
    joined: NonNullable<PhoneLinkSnapshot['joined']>;
    busy: boolean;
    formError: string | null;
    onApprove: (code: string, second: { totp_code?: string; backup_code?: string }) => void;
    onDeny: () => void;
}> = ({ joined, busy, formError, onApprove, onDeny }) => {
    const [code, setCode] = useState('');
    const [totp, setTotp] = useState('');
    const [useBackup, setUseBackup] = useState(false);
    const canApprove = /^\d{6}$/.test(code.replace(/\s+/g, ''))
        && (!joined.requires2fa || (useBackup ? totp.trim().length >= 8 : /^\d{6}$/.test(totp.replace(/\s+/g, ''))));

    return (
        <form
            className="flex flex-col gap-3 max-w-[360px]"
            onSubmit={(e) => {
                e.preventDefault();
                onApprove(code, useBackup ? { backup_code: totp } : { totp_code: totp });
            }}
        >
            <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--cl-text)' }}>
                <Smartphone size={15} style={{ color: 'var(--cl-lume)' }} />
                <span data-testid="phone-link-joined">
                    A {platformName(joined.platform)} that says it is <b>{joined.deviceLabel}</b> wants to sign in.
                </span>
            </div>
            <p className="text-[12px] m-0" style={{ color: 'var(--cl-faint)' }}>
                Type the six-digit code shown on that phone. If it is not your phone, or it shows no code, choose "Not this phone".
            </p>
            <ClField label="Code on the phone" error={formError ?? undefined}>
                <ClInput
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, '').slice(0, 7))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123 456"
                    disabled={busy}
                    data-testid="phone-link-code"
                    style={{ fontFamily: 'var(--cl-font-mono)', letterSpacing: '0.12em', fontSize: 18 }}
                />
            </ClField>
            {joined.requires2fa === 'totp' && (
                <ClField label={useBackup ? 'Backup code' : 'Authenticator code'} note="Your account has two-step verification on, so approving a new device needs a fresh code.">
                    <ClInput
                        value={totp}
                        onChange={(e) => setTotp(useBackup ? e.target.value : e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                        inputMode={useBackup ? 'text' : 'numeric'}
                        autoComplete="one-time-code"
                        placeholder={useBackup ? 'xxxx-xxxx-xxxx' : '000000'}
                        disabled={busy}
                        data-testid="phone-link-totp"
                    />
                    <button type="button" className="text-[12px] mt-1 self-start" style={{ color: 'var(--cl-faint)' }} onClick={() => { setUseBackup(v => !v); setTotp(''); }}>
                        {useBackup ? 'Use my authenticator app instead' : 'Use a backup code instead'}
                    </button>
                </ClField>
            )}
            <div className="flex gap-2">
                <ClButton type="button" variant="ghost" disabled={busy} onClick={onDeny}>
                    Not this phone
                </ClButton>
                <ClButton type="submit" disabled={!canApprove || busy}>
                    {busy ? <><Loader2 className="animate-spin" size={14} /> Approving…</> : 'Approve'}
                </ClButton>
            </div>
        </form>
    );
};

export const PhoneLinkPanel: React.FC = () => {
    const { token, deviceId } = useAuth();
    const authRef = useRef({ token, deviceId });
    useEffect(() => { authRef.current = { token, deviceId }; });
    const { snapshot: snap, controllerRef } = useLinkController<PhoneLinkSnapshot, PhoneLinkController>(
        () => new PhoneLinkController(realDeps(() => authRef.current)),
        emptySnapshot,
    );

    const { phase } = snap;

    return (
        <div className="sd-card overflow-hidden" style={{ padding: 0 }}>
            <div className="flex items-start gap-3.5 p-5 pb-4">
                <span className="sd-tile"><Smartphone size={17} /></span>
                <div className="min-w-0">
                    <h3 className="text-[16px] leading-tight" style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 }}>
                        Sign in on your phone
                    </h3>
                    <p className="text-[12.5px] leading-relaxed mt-1" style={{ color: 'var(--cl-faint)' }}>
                        Show a code here and scan it from the phone's sign-in screen — no password on the phone.
                        Nothing is approved until you type the six digits the phone shows back into this screen.
                    </p>
                </div>
            </div>

            <div className="px-5 pb-5">
                {phase === 'idle' && (
                    <ClButton onClick={() => void controllerRef.current?.begin()}>Show a code</ClButton>
                )}

                {phase === 'starting' && (
                    <div className="flex items-center gap-2.5 py-2">
                        <Loader2 className="animate-spin" size={18} style={{ color: 'var(--cl-lume)' }} />
                        <span className="text-[13px]" style={{ color: 'var(--cl-faint)' }}>Preparing your code…</span>
                    </div>
                )}

                {phase === 'active' && snap.qrDataUrl && (
                    <div className="flex flex-col items-start gap-3">
                        <div className="flex items-center justify-center rounded-2xl overflow-hidden" style={{ width: 180, height: 180, background: '#FFFFFF' }}>
                            <img src={snap.qrDataUrl} alt="Scan with the Cipherline app on your phone to sign it in" width={180} height={180} />
                        </div>
                        <p className="text-[12.5px] m-0" style={{ color: 'var(--cl-faint)' }}>
                            On the phone: open Cipherline → <b>Sign in with a QR code</b> → point it here.
                        </p>
                        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--cl-faint)' }} role="status" aria-live="polite">
                            <ShieldCheck size={13} />
                            <span>Code expires in {formatCountdown(snap.remainingS)}</span>
                        </div>
                        <button type="button" onClick={() => controllerRef.current?.cancel()} className="text-[13px] transition-colors" style={{ color: 'var(--cl-faint)' }}>
                            Cancel
                        </button>
                    </div>
                )}

                {(phase === 'joined' || phase === 'approving') && snap.joined && (
                    <ApproveForm
                        joined={snap.joined}
                        busy={phase === 'approving'}
                        formError={snap.formError}
                        onApprove={(code, second) => void controllerRef.current?.approve(code, second)}
                        onDeny={() => void controllerRef.current?.denyJoined()}
                    />
                )}

                {phase === 'granted' && (
                    <div className="flex items-center gap-2.5 py-2" role="status" aria-live="polite">
                        <Loader2 className="animate-spin" size={18} style={{ color: 'var(--cl-lume)' }} />
                        <span className="text-[13px]" style={{ color: 'var(--cl-text)' }}>Approved — finish on your phone. It will confirm which account it is joining.</span>
                    </div>
                )}

                {phase === 'done' && (
                    <div className="flex flex-col items-start gap-2.5 py-1">
                        <div className="flex items-center gap-2">
                            <CheckCircle2 size={16} style={{ color: 'var(--cl-lume)' }} />
                            <span className="text-[13px] font-medium" style={{ color: 'var(--cl-text)' }} data-testid="phone-link-done">
                                Your phone is signed in. It appears in the device list above.
                            </span>
                        </div>
                        <ClButton variant="ghost" size="sm" onClick={() => controllerRef.current?.cancel()}>Done</ClButton>
                    </div>
                )}

                {(phase === 'expired' || phase === 'error' || phase === 'denied') && (
                    <div className="flex flex-col items-start gap-2.5 py-1">
                        <div className="flex items-center gap-2">
                            {phase === 'denied'
                                ? <XIcon size={16} style={{ color: 'var(--cl-flash)' }} />
                                : <AlertTriangle size={16} style={{ color: phase === 'error' ? 'var(--cl-flash)' : 'var(--cl-faint)' }} />}
                            <span className="text-[13px] font-medium" style={{ color: 'var(--cl-text)' }} role="status">
                                {phase === 'expired' ? 'This code expired'
                                    : phase === 'denied' && snap.deniedReason === 'locked' ? 'Too many wrong codes — that phone was not signed in'
                                    : phase === 'denied' ? 'That phone was not signed in'
                                    : 'Could not sign the phone in'}
                            </span>
                        </div>
                        {phase === 'error' && snap.error && (
                            <p className="text-[12px] m-0" style={{ color: 'var(--cl-faint)' }}>{snap.error}</p>
                        )}
                        <ClButton onClick={() => void controllerRef.current?.begin()}>Show a new code</ClButton>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PhoneLinkPanel;
