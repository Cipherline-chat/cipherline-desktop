/**
 * DeviceApprovalModal — an APPROVED device decides whether a new device may
 * join the account (DEVICE_APPROVAL_REQUIRED=enforce).
 *
 * What makes the decision safe, in the order the user meets it:
 *
 *  - The user must TYPE the six digits the new device is showing. They cannot
 *    be read off this screen (it shows none), so approving needs the new
 *    device in front of you — a stranger's request cannot be approved by
 *    reflex. The digits are re-derived here from the identity key and nonce
 *    the server relayed; if the relay swapped the key, what the human typed
 *    from the new device will not match and approval is refused locally.
 *  - Approving is an Ed25519 signature by THIS device's identity key
 *    (electron/device-approval-keys.ts); the server verifies it against the
 *    key it has pinned for this device. A bearer token alone cannot approve.
 *  - "This wasn't me" denies AND prompts a password change: a request nobody
 *    here made means someone holds the password or a session token.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Smartphone, ShieldAlert, ShieldCheck, Clock } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClModal } from './cl';
import SlottedCodeInput from './SlottedCodeInput';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
    approvePendingDevice, codeForRequest, denyPendingDevice, describeApprovalError, formatCountdown,
    networkHint, platformLabel, secondsUntil, type ApprovalOutcome, type PendingDeviceRequest,
} from '../utils/deviceApproval';

interface Props {
    request: PendingDeviceRequest;
    /** User closed it without deciding ("Not now"): the request stays pending. */
    onClose: () => void;
    /** The request ended by a decision (or turned out to be over). */
    onResolved: (deviceId: string, outcome: ApprovalOutcome) => void;
    /** "This wasn't me": the request was denied; the host shows the
     *  change-your-password follow-up (it must outlive this dialog, which the
     *  host unmounts as soon as the request leaves its queue). */
    onNotMe: (request: PendingDeviceRequest) => void;
}

function PlatformIcon({ platform }: { platform: string }) {
    const p = (platform || '').toLowerCase();
    return p === 'ios' || p === 'android' ? <Smartphone size={22} /> : <Monitor size={22} />;
}

type Busy = null | 'approve' | 'deny' | 'notme';

export const DeviceApprovalModal: React.FC<Props> = ({ request, onClose, onResolved, onNotMe }) => {
    const { token, userId, deviceId } = useAuth();
    const toast = useToast();
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState<Busy>(null);
    const [error, setError] = useState('');
    const [codeError, setCodeError] = useState(false);
    const [mismatches, setMismatches] = useState(0);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    useEffect(() => {
        const t = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    const remaining = secondsUntil(request.expires_at, nowMs);
    const expired = remaining !== null && remaining <= 0;
    const resetScheduled = !!request.reset_due_at;
    const net = networkHint(request.ip_hint);
    const ctx = useMemo(() => (token && userId && deviceId ? { token, userId, deviceId } : null), [token, userId, deviceId]);

    const flashCodeError = () => {
        setCodeError(true);
        setTimeout(() => { if (alive.current) { setCodeError(false); setTyped(''); } }, 900);
    };

    const handleApprove = async () => {
        if (!ctx || busy || typed.length !== 6) return;
        setError(''); setBusy('approve');
        try {
            const derived = await codeForRequest(ctx.userId, request);
            if (typed !== derived) {
                // Local refusal: nothing is sent. A wrong digit and a swapped key
                // look the same from here, so say what to do about the second.
                const n = mismatches + 1;
                setMismatches(n);
                setError(n >= 3
                    ? "That still doesn't match. If you're reading the code correctly off the new device, deny this request."
                    : "That doesn't match the code on the new device. Check the digits and try again.");
                flashCodeError();
                return;
            }
            await approvePendingDevice(ctx, request, derived);
            toast.push({ kind: 'success', title: 'Device approved', message: `${request.device_name} can now use your account.` });
            onResolved(request.device_id, 'approved');
        } catch (e) {
            const d = describeApprovalError(e);
            setError(d.attemptsLeft != null ? `${d.message} ${d.attemptsLeft} ${d.attemptsLeft === 1 ? 'try' : 'tries'} left.` : d.message);
            if (d.kind === 'locked') onResolved(request.device_id, 'denied');
            else if (d.kind === 'expired') onResolved(request.device_id, 'expired');
            else if (d.kind === 'code_mismatch') flashCodeError();
        } finally {
            if (alive.current) setBusy(null);
        }
    };

    const handleDeny = async (notMe: boolean) => {
        if (!ctx || busy) return;
        setError(''); setBusy(notMe ? 'notme' : 'deny');
        try {
            await denyPendingDevice(ctx, request);
            if (notMe) {
                onNotMe(request);
            } else {
                toast.push({ kind: 'info', title: 'Request denied', message: `${request.device_name} was signed out.` });
                onResolved(request.device_id, 'denied');
            }
        } catch (e) {
            const d = describeApprovalError(e);
            if (d.kind === 'expired') onResolved(request.device_id, 'expired');
            else setError(d.message);
        } finally {
            if (alive.current) setBusy(null);
        }
    };

    return (
        <ClModal open onClose={busy ? () => undefined : onClose} width={460} label="Approve new device" closeOnOverlay={false}>
            <div className="flex items-start gap-3 mb-4">
                <span className="sd-tile" style={{ flexShrink: 0 }}><PlatformIcon platform={request.platform} /></span>
                <div className="min-w-0 flex-1">
                    <h4 className="m-0 mb-0.5">A new device wants to join your account</h4>
                    <p className="m-0 text-sm" style={{ color: 'var(--cl-faint)' }}>
                        Only approve it if you started this sign-in just now.
                    </p>
                </div>
            </div>

            <dl
                className="rounded-xl px-4 py-3 mb-4 text-sm"
                style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)', display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 6 }}
            >
                <dt style={{ color: 'var(--cl-faint)' }}>Device</dt>
                <dd className="m-0 font-semibold text-right break-all" style={{ color: 'var(--cl-text)' }}>{request.device_name}</dd>
                <dt style={{ color: 'var(--cl-faint)' }}>Platform</dt>
                <dd className="m-0 text-right" style={{ color: 'var(--cl-text)' }}>{platformLabel(request.platform)}</dd>
                {net && (<>
                    <dt style={{ color: 'var(--cl-faint)' }}>Network</dt>
                    <dd className="m-0 text-right" style={{ color: 'var(--cl-text)' }}>{net}</dd>
                </>)}
                <dt style={{ color: 'var(--cl-faint)' }}>Expires</dt>
                <dd className="m-0 text-right" style={{ color: expired ? 'var(--cl-flash)' : 'var(--cl-text)' }}>
                    <Clock size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                    {resetScheduled ? 'in about a day (reset requested)' : expired ? 'expired' : formatCountdown(remaining ?? 0)}
                </dd>
            </dl>

            {resetScheduled && (
                <p className="text-sm mb-3" style={{ color: 'var(--cl-glow)' }}>
                    This device asked to <b>reset your devices</b> — it says it can't reach any of them. If you can read this, you can
                    simply deny it, or approve it below. Doing nothing and leaving every device unused for a day would sign them all out.
                </p>
            )}

            {!expired && (
                <>
                    <p className="text-sm mb-2" style={{ color: 'var(--cl-text)' }}>
                        Enter the 6-digit code shown on the new device:
                    </p>
                    <div className="mb-3" style={{ display: 'flex', justifyContent: 'center' }}>
                        <SlottedCodeInput
                            value={typed} onChange={setTyped} disabled={!!busy} error={codeError} noAutoPaste
                        />
                    </div>
                </>
            )}

            {error && (
                <div className="mb-3 px-3 py-2 rounded-xl text-sm text-center" role="alert"
                    style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.25)', color: 'rgb(248,113,113)' }}>
                    {error}
                </div>
            )}

            <div className="mrow" style={{ flexWrap: 'wrap', gap: 8 }}>
                <ClButton variant="danger" size="sm" disabled={!!busy || !ctx} loading={busy === 'notme'} onClick={() => handleDeny(true)}>
                    <ShieldAlert size={14} /> This wasn't me
                </ClButton>
                <span style={{ flex: 1 }} />
                <ClButton variant="ghost" size="sm" disabled={!!busy} onClick={onClose}>Not now</ClButton>
                <ClButton variant="ghost" size="sm" disabled={!!busy || !ctx} loading={busy === 'deny'} onClick={() => handleDeny(false)}>Deny</ClButton>
                <ClButton
                    variant="primary" size="sm" loading={busy === 'approve'}
                    disabled={!!busy || !ctx || expired || typed.length !== 6}
                    onClick={handleApprove}
                >
                    <ShieldCheck size={14} /> Approve
                </ClButton>
            </div>
        </ClModal>
    );
};

/**
 * Shown after "This wasn't me": the device is gone and never saw a message,
 * but it only got as far as asking because someone holds the password or a
 * session token — so the next step is a password change (which also revokes
 * every other still-pending device server-side).
 */
export const DeviceRemovedNotice: React.FC<{
    deviceName: string; onChangePassword: () => void; onLater: () => void;
}> = ({ deviceName, onChangePassword, onLater }) => (
    <ClModal open onClose={onLater} width={440} label="Device removed" closeOnOverlay={false}>
        <div className="flex items-center gap-3 mb-3">
            <span className="sd-tile"><ShieldAlert size={18} /></span>
            <h4 className="m-0">We removed that device</h4>
        </div>
        <p>
            <b>{deviceName}</b> was signed out and never saw any of your messages. Because it got as far as asking,
            someone may know your password — change it now. That also removes any other device still waiting for approval.
        </p>
        <div className="mrow">
            <ClButton variant="ghost" size="sm" onClick={onLater}>Later</ClButton>
            <ClButton variant="primary" size="sm" onClick={onChangePassword}>Change password</ClButton>
        </div>
    </ClModal>
);

export default DeviceApprovalModal;
