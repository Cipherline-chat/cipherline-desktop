/**
 * StaleDevicesHost — mounted once in the signed-in app (Dashboard), next to
 * DeviceApprovalHost. Owner rule (2026-10-19): prompt after 30 days unseen,
 * prompt again after 180, the server removes the device after a year.
 *
 * Once per sign-in on this device (not per reconnect, not on a timer) it
 * reads `GET /v1/devices` a little after boot and, if the server marks any
 * OTHER device of the user as `stale_prompt_due`, opens StaleDevicesDialog.
 * Whether a prompt is due is the server's call: "Keep it" is recorded there
 * per device and tier, so answering on one device silences the prompt on all
 * of them, and the next prompt for that device only comes at 180 days.
 *
 * Nothing here is a gate. Removal is the ordinary revoke route.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { ConfirmDialog } from './primitives/ConfirmDialog';
import { StaleDevicesDialog, type StaleRowState } from './StaleDevicesDialog';
import {
    dueStaleDevices, fetchOwnDevices, keepStaleDevices, removeOwnDevice, type OwnDevice,
} from '../utils/staleDevices';

/** Let the app settle (and any device-approval prompt claim the screen) first. */
const BOOT_DELAY_MS = 20_000;

export const StaleDevicesHost: React.FC<{ delayMs?: number }> = ({ delayMs = BOOT_DELAY_MS }) => {
    const { token, deviceId } = useAuth();
    const toast = useToast();
    const [due, setDue] = useState<OwnDevice[]>([]);
    const [rowState, setRowState] = useState<Record<string, StaleRowState>>({});
    const [confirming, setConfirming] = useState<OwnDevice | null>(null);
    const [closing, setClosing] = useState(false);
    const checkedFor = useRef<string | null>(null);

    useEffect(() => {
        if (!token || !deviceId) return;
        if (checkedFor.current === deviceId) return;
        let cancelled = false;
        const t = window.setTimeout(() => {
            checkedFor.current = deviceId;
            fetchOwnDevices(token)
                .then(list => { if (!cancelled) setDue(dueStaleDevices(list, deviceId)); })
                .catch(() => { /* quiet: Settings → Devices shows the same state */ });
        }, delayMs);
        return () => { cancelled = true; window.clearTimeout(t); };
    }, [token, deviceId, delayMs]);

    const drop = useCallback((id: string) => {
        setDue(list => list.filter(d => d.device_id !== id));
        setRowState(s => { const n = { ...s }; delete n[id]; return n; });
    }, []);

    const keep = useCallback(async (d: OwnDevice) => {
        if (!token || !deviceId) return;
        setRowState(s => ({ ...s, [d.device_id]: { busy: 'keeping' } }));
        try {
            await keepStaleDevices(token, deviceId, [d]);
            drop(d.device_id);
        } catch {
            setRowState(s => ({ ...s, [d.device_id]: { error: 'Couldn’t save that. Try again.' } }));
        }
    }, [token, deviceId, drop]);

    const remove = useCallback(async (d: OwnDevice) => {
        if (!token || !deviceId) return;
        setRowState(s => ({ ...s, [d.device_id]: { busy: 'removing' } }));
        try {
            await removeOwnDevice(token, deviceId, d.device_id);
            drop(d.device_id);
            toast.push({ kind: 'success', title: 'Device removed', message: `${d.device_name || 'That device'} was signed out.` });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / Error); read defensively
        } catch (e: any) {
            const message = e?.response?.data?.message;
            setRowState(s => ({ ...s, [d.device_id]: { error: typeof message === 'string' ? message : 'Couldn’t remove it. Try again.' } }));
        }
    }, [token, deviceId, drop, toast]);

    /** Done / Escape: keep everything still listed (recorded once, server-side). */
    const done = useCallback(async () => {
        if (!token || !deviceId || closing) return;
        const remaining = due.filter(d => !rowState[d.device_id]?.busy);
        setClosing(true);
        try {
            await keepStaleDevices(token, deviceId, remaining);
        } catch {
            /* the prompt may come back next launch — that is the safe failure */
        } finally {
            setDue([]);
            setRowState({});
            setClosing(false);
        }
    }, [token, deviceId, due, rowState, closing]);

    if (due.length === 0) return null;
    return (
        <>
            {/* Stays mounted under the confirm (ClModal stacks; Escape closes
                only the top one), so cancelling does not replay its entrance. */}
            <StaleDevicesDialog
                devices={due}
                state={rowState}
                busy={closing}
                onKeep={d => { void keep(d); }}
                onRemove={d => setConfirming(d)}
                onDone={() => { if (!confirming) void done(); }}
            />
            {confirming && (
                <ConfirmDialog
                    title={`Remove ${confirming.device_name || 'this device'}?`}
                    message="It will be signed out right away, and any messages still waiting for it will be deleted. You can sign in on it again later as a new device."
                    confirmLabel="Remove device"
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => { const d = confirming; setConfirming(null); void remove(d); }}
                />
            )}
        </>
    );
};

export default StaleDevicesHost;
