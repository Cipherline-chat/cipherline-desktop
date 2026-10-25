/**
 * DeviceResetBanner — "A device reset was requested — Cancel reset".
 *
 * A device that cannot reach any of the account's other devices can ask for a
 * cooling-off RESET: after ~24 h every other device is signed out and the
 * requester is approved, unless an approved device is seen in the meantime.
 * That is the one approval path a thief with only the password can start, so
 * an APPROVED device that is open and running shows this the moment the
 * request exists, until it is cancelled, resolved or its time passes.
 *
 * Deliberately NOT parkable (the approval modal has "Not now"; this has
 * nothing to dismiss): the only way to make it go away is to decide. Cancel
 * is an Ed25519 signature by this device's identity key (`cancelDeviceReset`),
 * so it is the owner's approved device speaking, not a bearer token. Shown
 * only on approved devices — the server never sends `device:reset_requested`
 * to a pending socket, and the host only mounts for a signed-in app.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ClBanner, ClBannerOverlay } from './ClBanner';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
    activeResetRequests, cancelDeviceReset, describeApprovalError, platformLabel, type PendingDeviceRequest,
} from '../utils/deviceApproval';

interface Props {
    /** The approver queue (the host's state); this picks out the live resets. */
    requests: PendingDeviceRequest[];
    /** The reset was cancelled, or turned out to be over. */
    onResolved: (deviceId: string) => void;
}

function whenLabel(iso: string | null): string {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'soon';
}

export const DeviceResetBanner: React.FC<Props> = ({ requests, onResolved }) => {
    const { token, userId, deviceId } = useAuth();
    const toast = useToast();
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string>('');

    // A reset whose time has passed stops being cancellable from here.
    useEffect(() => {
        const t = setInterval(() => setNowMs(Date.now()), 30_000);
        return () => clearInterval(t);
    }, []);

    const resets = useMemo(() => activeResetRequests(requests, nowMs), [requests, nowMs]);
    const ctx = useMemo(() => (token && userId && deviceId ? { token, userId, deviceId } : null), [token, userId, deviceId]);
    if (resets.length === 0) return null;

    const cancel = async (req: PendingDeviceRequest) => {
        if (!ctx || busy) return;
        setError(''); setBusy(req.device_id);
        try {
            await cancelDeviceReset(ctx, req);
            toast.push({ kind: 'success', title: 'Device reset cancelled', message: `${req.device_name} was signed out. If this wasn't you, change your password.` });
            onResolved(req.device_id);
        } catch (e) {
            const d = describeApprovalError(e);
            // Already over (expired / cancelled elsewhere): nothing left to cancel.
            if (d.kind === 'expired') onResolved(req.device_id);
            else setError(d.message);
        } finally {
            setBusy(null);
        }
    };

    return (
        <ClBannerOverlay testId="device-reset-banner" live="assertive">
            {resets.map(req => (
                <ClBanner
                    key={req.device_id}
                    inline
                    live="off"
                    tone="danger"
                    icon={<ShieldAlert size={15} />}
                    title="A device reset was requested"
                    description={<>
                        by {req.device_name} ({platformLabel(req.platform)}). If you do nothing, all your
                        other devices are signed out on {whenLabel(req.reset_due_at)}.
                    </>}
                    actions={[{
                        key: 'cancel-reset',
                        label: 'Cancel reset',
                        variant: 'primary',
                        loading: busy === req.device_id,
                        disabled: !ctx || !!busy,
                        onClick: () => cancel(req),
                    }]}
                />
            ))}
            {error && <ClBanner inline live="off" tone="danger" testId="device-reset-error" title={error} />}
        </ClBannerOverlay>
    );
};

export default DeviceResetBanner;
