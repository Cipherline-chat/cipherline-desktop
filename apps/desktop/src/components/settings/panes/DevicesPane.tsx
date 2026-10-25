import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { Laptop, Monitor, Smartphone, RefreshCw, AlertTriangle } from 'lucide-react';
import { ClButton, ClSkeleton } from '../../cl';
import axios from 'axios';
import { API_BASE } from '../../../constants';
import { apiUrl } from '../../../utils/apiPath';
import { useToast } from '../../../contexts/ToastContext';
import { useOwnDevicePresence } from '../../../hooks/useOwnDevicePresence';
import { PhoneLinkPanel } from '../../link/PhoneLinkPanel';
import { DeviceApprovalModal, DeviceRemovedNotice } from '../../DeviceApprovalModal';
import { ChangePasswordModal } from '../../auth/ChangePasswordModal';
import {
    deviceApprovalBus, denyPendingDevice, describeApprovalError, fetchPendingRequests, formatCountdown, pruneExpired,
    platformLabel, removePending, secondsUntil, upsertPending, type PendingDeviceRequest,
} from '../../../utils/deviceApproval';
import { formatLastActive, staleBadgeLabel, staleTierOf, type StaleTier } from '../../../utils/staleDevices';
import '../../../styles/stale-devices.css';

/**
 * Twilight · Devices — Descent redesign (phase 2).
 * Icon-tile rows with mono device ids + relative last-seen, skeletons while
 * loading (kit rule: never spinners for content), rows stagger in on load.
 */
interface DeviceInfo {
    device_id: string;
    device_name: string;
    platform: string;
    created_at: string;
    last_seen_at: string;
    // Stale-device policy (absent on older servers → treated as not stale).
    last_active_on?: string;
    stale_tier?: StaleTier;
}

function platformIcon(platform: string) {
    const p = (platform || '').toLowerCase();
    if (p.includes('android') || p.includes('ios') || p.includes('mobile')) return <Smartphone size={16} />;
    if (p.includes('mac') || p.includes('darwin')) return <Laptop size={16} />;
    return <Monitor size={16} />;
}

/** "just now" / "2 h ago" / "6 d ago" / date — tighter than a full timestamp. */
function relativeSeen(iso: string): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 90_000) return 'just now';
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** First 16 hex chars of the UUID, grouped like a fingerprint. */
function shortId(id: string): string {
    const hex = id.replace(/-/g, '').slice(0, 16).toUpperCase();
    return hex.replace(/(.{4})/g, '$1 ').trim();
}

export const DevicesPane: React.FC = () => {
    const { token, userId, deviceId: myDeviceId } = useAuth();
    const toast = useToast();
    // Device approval: new devices waiting to join (DEVICE_APPROVAL_REQUIRED).
    // Listed apart from the approved devices above — the server never mixes
    // them into GET /devices, so an older client can't mistake one for "mine".
    const [pending, setPending] = useState<PendingDeviceRequest[]>([]);
    const [reviewing, setReviewing] = useState<PendingDeviceRequest | null>(null);
    const [notMe, setNotMe] = useState<PendingDeviceRequest | null>(null);
    const [changePw, setChangePw] = useState(false);
    const [denyingId, setDenyingId] = useState<string | null>(null);
    const [pendingNow, setPendingNow] = useState(() => Date.now());
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [devicesLoading, setDevicesLoading] = useState(true);
    const [devicesError, setDevicesError] = useState('');
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const [revokingOthers, setRevokingOthers] = useState(false);
    // Continuity — GET /v1/devices/presence, seeded at boot and on every WS
    // reconnect (never polled — see the hook's own doc comment). A SEPARATE
    // fetch from the device LIST above (GET /v1/devices, used for the
    // revoke flow) rather than replacing it: this one degrades gracefully
    // (a failed/slow presence fetch leaves every row on the pre-existing
    // "seen X ago" text, never blocks rendering the list itself).
    const { devices: presenceDevices } = useOwnDevicePresence(token);
    const presenceByDevice = useMemo(() => {
        const map: Record<string, typeof presenceDevices[number]> = {};
        for (const p of presenceDevices) map[p.device_id] = p;
        return map;
    }, [presenceDevices]);

    const fetchDevices = useCallback(async () => {
        if (!token) return;
        setDevicesLoading(true);
        setDevicesError('');
        try {
            const res = await axios.get<DeviceInfo[]>(`${API_BASE}/devices`, { headers: { Authorization: `Bearer ${token}` } });
            // This device first, then most recently seen.
            const sorted = [...res.data].sort((a, b) => {
                if (a.device_id === myDeviceId) return -1;
                if (b.device_id === myDeviceId) return 1;
                return new Date(b.last_seen_at || 0).getTime() - new Date(a.last_seen_at || 0).getTime();
            });
            setDevices(sorted);
        } catch {
            setDevicesError('Failed to load devices.');
        } finally {
            setDevicesLoading(false);
        }
    }, [token, myDeviceId]);

    useEffect(() => { fetchDevices(); }, [fetchDevices]);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        // An older server has no /pending: nothing to show.
        fetchPendingRequests(token).then(list => { if (!cancelled) setPending(list); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [token]);
    useEffect(() => deviceApprovalBus.subscribe(ev => {
        if (ev.kind === 'pending') setPending(p => upsertPending(p, ev.request));
        else {
            setPending(p => removePending(p, ev.resolved.device_id));
            // An approved request becomes a device row.
            if (ev.resolved.status === 'approved') void fetchDevices();
        }
    }), [fetchDevices]);
    useEffect(() => {
        if (pending.length === 0) return;
        const t = setInterval(() => { setPendingNow(Date.now()); setPending(p => pruneExpired(p, Date.now())); }, 1000);
        return () => clearInterval(t);
    }, [pending.length]);

    const handleDenyPending = async (req: PendingDeviceRequest) => {
        if (!token || !userId || !myDeviceId) return;
        setDenyingId(req.device_id);
        try {
            await denyPendingDevice({ token, userId, deviceId: myDeviceId }, req);
            setPending(p => removePending(p, req.device_id));
            toast.push({ kind: 'info', title: 'Request denied', message: `${req.device_name} was signed out.` });
        } catch (e) {
            toast.push({ kind: 'error', title: 'Could not deny', message: describeApprovalError(e).message });
        } finally {
            setDenyingId(null);
        }
    };

    const handleRevokeDevice = async (targetId: string) => {
        if (!token || !myDeviceId) return;
        if (!window.confirm('Remove this device? It will be signed out immediately and any pending messages for it will be deleted.')) return;
        setRevokingId(targetId);
        try {
            await axios.post(apiUrl`/devices/${targetId}/revoke`, {}, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': myDeviceId },
            });
            setDevices(prev => prev.filter(d => d.device_id !== targetId));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (e: any) {
            toast.push({ kind: 'error', title: 'Revoke failed', message: e?.response?.data?.message || 'Failed to revoke device.' });
        } finally {
            setRevokingId(null);
        }
    };

    // Mobile parity: `revokeOtherDevices` (DevicesScreen.tsx) — bulk "sign out
    // everywhere else" using the same `POST /v1/devices/revoke-others` the
    // website account portal already calls. Desktop had per-device revoke
    // only; this was the one bulk action missing here.
    const handleRevokeOthers = async () => {
        if (!token || !myDeviceId) return;
        if (!window.confirm('Sign out every other device on your account? This device stays signed in.')) return;
        setRevokingOthers(true);
        try {
            const res = await axios.post<{ ok: boolean; revoked: number; failed: number }>(
                `${API_BASE}/devices/revoke-others`, {},
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': myDeviceId } },
            );
            toast.push({
                kind: 'success',
                title: 'Signed out other devices',
                message: `Signed out ${res.data.revoked} other device${res.data.revoked === 1 ? '' : 's'}.`,
            });
            await fetchDevices();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (e: any) {
            toast.push({ kind: 'error', title: 'Sign out failed', message: e?.response?.data?.message || 'Failed to sign out other devices.' });
        } finally {
            setRevokingOthers(false);
        }
    };

    return (
        <>
            <div className="sd-card">
                <h3>Your devices</h3>
                <p className="sd-sub">Each device holds its own keys. Removing one signs it out instantly and deletes any messages still queued for it — nothing to “sync back.”</p>

                {devicesError && (
                    <div className="flex items-center gap-2 p-3 mb-3 rounded-lg text-sm" style={{ background: 'rgba(248,113,113,.08)', color: 'rgb(248,113,113)' }}>
                        <AlertTriangle size={15} />
                        {devicesError}
                        <span style={{ flex: 1 }} />
                        <ClButton variant="ghost" size="sm" onClick={fetchDevices}>Retry</ClButton>
                    </div>
                )}

                {pending.length > 0 && (
                    <div className="sd-listin" style={{ marginBottom: 14 }} data-testid="pending-devices">
                        {pending.map(r => {
                            const left = secondsUntil(r.expires_at, pendingNow);
                            return (
                                <div key={r.device_id} className="sd-row">
                                    <span className="sd-tile">{platformIcon(r.platform)}</span>
                                    <div className="sd-rl">
                                        <b>
                                            {r.device_name}
                                            <span className="sd-chip sd-chip--lume">Waiting for approval</span>
                                            <span className="sd-chip">{platformLabel(r.platform)}</span>
                                        </b>
                                        <span className="sd-mono">
                                            {r.reset_due_at ? 'asked to reset your devices' : left != null ? `expires in ${formatCountdown(left)}` : 'pending'}
                                        </span>
                                    </div>
                                    <div className="sd-rc" style={{ display: 'flex', gap: 6 }}>
                                        <ClButton size="sm" onClick={() => setReviewing(r)}>Review</ClButton>
                                        <ClButton variant="ghost" size="sm" disabled={denyingId === r.device_id} onClick={() => handleDenyPending(r)}>
                                            {denyingId === r.device_id ? 'Denying…' : 'Deny'}
                                        </ClButton>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {devicesLoading ? (
                    <div className="flex flex-col gap-3 py-1">
                        {[0, 1, 2].map(i => (
                            <div key={i} className="flex items-center gap-4">
                                <ClSkeleton style={{ width: 36, height: 36, borderRadius: 10 }} />
                                <div className="flex-1 flex flex-col gap-2">
                                    <ClSkeleton style={{ width: 180, height: 12 }} />
                                    <ClSkeleton style={{ width: 260, height: 9 }} />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : devices.length === 0 && !devicesError ? (
                    <p className="sd-empty">No devices found.</p>
                ) : (
                    <div className="sd-listin">
                        {devices.map(d => {
                            const isCurrent = d.device_id === myDeviceId;
                            // Continuity: `connected` and `attentive` are
                            // deliberately distinct — a connected laptop with
                            // the lid shut is not a present user, so don't
                            // collapse them into one label. Falls back to the
                            // existing "seen X ago" when presence hasn't
                            // loaded (or failed) for this device.
                            const presence = presenceByDevice[d.device_id];
                            // Stale-device policy: a quiet badge, never on this device.
                            const staleBadge = staleBadgeLabel(staleTierOf(d));
                            const lastActive = formatLastActive(d.last_active_on);
                            let statusNode: React.ReactNode;
                            if (isCurrent) {
                                statusNode = <span style={{ color: 'var(--cl-ok)' }}>online now</span>;
                            } else if (presence?.attentive) {
                                statusNode = <span style={{ color: 'var(--cl-ok)' }}>active now</span>;
                            } else if (presence?.connected) {
                                statusNode = <span style={{ color: 'var(--cl-glow)' }}>connected</span>;
                            } else {
                                statusNode = `seen ${relativeSeen(presence?.last_seen_at ?? d.last_seen_at)}`;
                            }
                            return (
                                <div key={d.device_id} className="sd-row">
                                    <span className={`sd-tile${isCurrent ? '' : ' sd-tile--dim'}`}>
                                        {platformIcon(d.platform)}
                                    </span>
                                    <div className="sd-rl">
                                        <b>
                                            {d.device_name || 'Unknown device'}
                                            {isCurrent && <span className="sd-chip sd-chip--lume">This device</span>}
                                            <span className="sd-chip">{d.platform || 'unknown'}</span>
                                            {!isCurrent && staleBadge && (
                                                <span
                                                    className={`stale-badge${staleTierOf(d) === '180d' ? ' stale-badge--old' : ''}`}
                                                    title={lastActive ? `Last active ${lastActive}` : undefined}
                                                    data-testid={`stale-badge-${d.device_id}`}
                                                >
                                                    {staleBadge}
                                                </span>
                                            )}
                                        </b>
                                        <span className="sd-mono">
                                            {shortId(d.device_id)} · {statusNode}
                                        </span>
                                    </div>
                                    <div className="sd-rc">
                                        {!isCurrent && (
                                            <ClButton
                                                variant="ghost"
                                                size="sm"
                                                disabled={revokingId === d.device_id}
                                                onClick={() => handleRevokeDevice(d.device_id)}
                                            >
                                                {revokingId === d.device_id ? 'Removing…' : 'Remove'}
                                            </ClButton>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {!devicesLoading && devices.length > 1 && (
                    <div className="sd-row">
                        <div className="sd-rl">
                            <b>Sign out everywhere else</b>
                            <span>Every other device on your account is signed out immediately. This device stays signed in.</span>
                        </div>
                        <div className="sd-rc">
                            <ClButton
                                variant="danger"
                                size="sm"
                                disabled={revokingOthers}
                                onClick={handleRevokeOthers}
                            >
                                {revokingOthers ? 'Signing out…' : 'Sign out others'}
                            </ClButton>
                        </div>
                    </div>
                )}
            </div>

            {reviewing && (
                <DeviceApprovalModal
                    key={`${reviewing.device_id}:${reviewing.nonce_b64}`}
                    request={reviewing}
                    onClose={() => setReviewing(null)}
                    onResolved={(id) => { setPending(p => removePending(p, id)); setReviewing(null); void fetchDevices(); }}
                    onNotMe={(r) => { setPending(p => removePending(p, r.device_id)); setReviewing(null); setNotMe(r); }}
                />
            )}
            {notMe && !changePw && (
                <DeviceRemovedNotice deviceName={notMe.device_name} onLater={() => setNotMe(null)} onChangePassword={() => setChangePw(true)} />
            )}
            <ChangePasswordModal open={changePw} onClose={() => { setChangePw(false); setNotMe(null); }} />

            {/* docs/QR-LINKING.md, reverse flow: THIS desktop shows the QR, a
                new phone scans it from its sign-in screen. Mirrors the
                sign-in screen's "Sign in with your phone" panel. */}
            <PhoneLinkPanel />

            <div className="sd-card">
                <div className="sd-row" style={{ padding: 0, border: 'none' }}>
                    <div className="sd-rl">
                        <b>Something look wrong?</b>
                        <span>Re-check the list — a revoked device disappears the moment the server confirms it.</span>
                    </div>
                    <div className="sd-rc">
                        <ClButton variant="ghost" size="sm" onClick={fetchDevices} disabled={devicesLoading}>
                            <RefreshCw size={13} /> Refresh
                        </ClButton>
                    </div>
                </div>
            </div>
        </>
    );
};
