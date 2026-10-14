/**
 * DeviceApprovalHost — mounted once inside the signed-in app (Dashboard). It
 * is this device's role as an APPROVER:
 *
 *  - seeds the queue from `GET /v1/devices/pending` at boot and after every
 *    WS reconnect (a prompt sent while this device was offline is not lost),
 *    then stays live on `device:approval_pending` / `device:approval_resolved`
 *    through `deviceApprovalBus`;
 *  - shows `DeviceResetBanner` ("A device reset was requested — Cancel reset")
 *    for any request with a cooling-off reset ahead of it; unlike the modal it
 *    cannot be parked;
 *  - opens `DeviceApprovalModal` for the oldest request the user has not set
 *    aside ("Not now" parks it; Settings → Devices lists it);
 *  - publishes this device's recovery commitment once per sign-in, so a
 *    future new device can be approved by typing a recovery key.
 *
 * Nothing here is a gate; the server is. This is the prompt.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { DeviceApprovalModal, DeviceRemovedNotice } from './DeviceApprovalModal';
import { ChangePasswordModal } from './auth/ChangePasswordModal';
import { DeviceResetBanner } from './DeviceResetBanner';
import {
    deviceApprovalBus, fetchPendingRequests, pruneExpired, publishRecoveryCommitment, removePending, upsertPending,
    type ApprovalOutcome, type PendingDeviceRequest,
} from '../utils/deviceApproval';

interface Props {
    /** `useRealtime().wsConnectCount` — bumps on every (re)connect. */
    wsConnectCount: number;
}

export const DeviceApprovalHost: React.FC<Props> = ({ wsConnectCount }) => {
    const { token, userId, deviceId } = useAuth();
    const toast = useToast();
    const [queue, setQueue] = useState<PendingDeviceRequest[]>([]);
    // "Not now": parked requests stay in the queue (and in Settings) but do not
    // re-open on their own. Cleared per request when it is re-announced.
    const [parked, setParked] = useState<Set<string>>(() => new Set());
    const [notMe, setNotMe] = useState<PendingDeviceRequest | null>(null);
    const [changePw, setChangePw] = useState(false);
    const committedFor = useRef<string | null>(null);

    // Seed (boot + every reconnect).
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        fetchPendingRequests(token)
            .then(list => { if (!cancelled) setQueue(list); })
            .catch(() => { /* the live events still arrive; Settings can refetch */ });
        return () => { cancelled = true; };
    }, [token, wsConnectCount]);

    // Live events.
    useEffect(() => deviceApprovalBus.subscribe(ev => {
        if (ev.kind === 'pending') {
            // A re-announcement (new nonce after a re-registration, or a reset
            // request) is a new decision: un-park it.
            setParked(p => { if (!p.has(ev.request.device_id)) return p; const n = new Set(p); n.delete(ev.request.device_id); return n; });
            setQueue(q => upsertPending(q, ev.request));
        } else {
            setQueue(q => removePending(q, ev.resolved.device_id));
        }
    }), []);

    // Drop lapsed requests so a dead prompt never lingers.
    useEffect(() => {
        const t = setInterval(() => setQueue(q => pruneExpired(q, Date.now())), 15_000);
        return () => clearInterval(t);
    }, []);

    // Recovery commitment: once per (user, device) per app run.
    useEffect(() => {
        if (!token || !userId || !deviceId) return;
        const key = `${userId}:${deviceId}`;
        if (committedFor.current === key) return;
        committedFor.current = key;
        void publishRecoveryCommitment(token, userId, deviceId);
    }, [token, userId, deviceId]);

    const resolved = useCallback((id: string, outcome: ApprovalOutcome) => {
        setQueue(q => removePending(q, id));
        if (outcome === 'expired') toast.push({ kind: 'info', title: 'Request expired', message: 'That device will need to sign in again.' });
    }, [toast]);

    const current = queue.find(r => !parked.has(r.device_id)) ?? null;

    return (
        <>
            <DeviceResetBanner requests={queue} onResolved={(id) => setQueue(q => removePending(q, id))} />
            {current && (
                <DeviceApprovalModal
                    key={`${current.device_id}:${current.nonce_b64}`}
                    request={current}
                    onClose={() => setParked(p => new Set(p).add(current.device_id))}
                    onResolved={resolved}
                    onNotMe={(r) => { setQueue(q => removePending(q, r.device_id)); setNotMe(r); }}
                />
            )}
            {notMe && !changePw && (
                <DeviceRemovedNotice
                    deviceName={notMe.device_name}
                    onLater={() => setNotMe(null)}
                    onChangePassword={() => setChangePw(true)}
                />
            )}
            <ChangePasswordModal open={changePw} onClose={() => { setChangePw(false); setNotMe(null); }} />
        </>
    );
};

export default DeviceApprovalHost;
