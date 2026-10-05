/**
 * HistorySyncBanner — popup dialog shown on a freshly-signed-in device that
 * has no local message history. Name kept for import compat with Dashboard.tsx.
 *
 * State machine:
 *   idle → picking_device → requesting → (timed_out | declined | importing → done)
 *
 * Hidden when the device already has history or the user previously dismissed it.
 */
import secureLocalStore from '../utils/secureLocalStore';
import * as messageStore from '../utils/messageStore';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { importLocalHistory } from '../utils/crypto';
import { Monitor, Smartphone, Download, Loader2, CheckCircle2, AlertTriangle, ChevronLeft } from 'lucide-react';
import { ClButton, ClModal, ClSkeleton } from './cl';
import { unwrapHistoryTransferKey } from '../utils/historyTransferKey';
import { HISTORY_REFUSED_LEGACY_REQUESTER, HISTORY_REFUSED_MOBILE_TO_DESKTOP } from '../utils/historyRequestProof';
import { HistoryPayloadRefusedError } from '../utils/historyPayloadFormat';

interface Props {
    userId: string | null;
    token: string | null;
    deviceId: string | null;
    historyDelivered: {
        /** C-2 — ECIES envelope only this device can open. Preferred. */
        wrapped_transfer_key_b64?: string;
        /** LEGACY plaintext key; only from a pre-2026-08-30 approver. */
        transfer_key_b64?: string;
        transfer_meta?: any;
    } | null;
    clearHistoryDelivered: () => void;
    historyDeclined: { device_id: string; reason: string | null } | null;
    setHistoryDeclined: (v: null) => void;
}

interface DeviceInfo {
    device_id: string;
    device_name: string;
    platform: string;
    last_seen_at: string | null;
}

type ModalState = 'idle' | 'picking_device' | 'requesting' | 'timed_out' | 'declined' | 'importing' | 'done' | 'blocked';

const TIMEOUT_SECS = 60;

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function platformIcon(platform: string, size = 20) {
    const p = (platform || '').toLowerCase();
    if (p.includes('mac') || p.includes('iphone') || p.includes('ios') || p.includes('android'))
        return <Smartphone size={size} />;
    return <Monitor size={size} />;
}

function relativeTime(iso: string | null): string {
    if (!iso) return 'Unknown';
    const ms = Date.now() - Date.parse(iso);
    if (ms < 60_000) return 'Just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
}

export const HistorySyncBanner: React.FC<Props> = ({
    userId,
    token,
    deviceId,
    historyDelivered,
    clearHistoryDelivered,
    historyDeclined,
    setHistoryDeclined,
}) => {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<ModalState>('idle');
    const [statusText, setStatusText] = useState('');
    const [countdown, setCountdown] = useState(TIMEOUT_SECS);
    const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [devicesLoading, setDevicesLoading] = useState(false);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
    /** Copy for the `blocked` state — a dead end the user can act on, rather
     *  than a spinner or a generic failure. Set by whichever C-2b refusal
     *  fired; see the three call sites. */
    const [blockedText, setBlockedText] = useState('');

    /** Name of the device we asked, for the blocked-state copy. A broadcast
     *  request (no device picked) can't name the responder, so fall back to
     *  wording that still tells the user what to do. */
    const peerName = devices.find(d => d.device_id === selectedDeviceId)?.device_name ?? null;

    useEffect(() => {
        if (!userId || !token) return;

        // Only prompt when there's at least one OTHER device to sync from —
        // a single-device account has nothing to pull history from.
        let cancelled = false;
        (async () => {
            // MUST establish that the account's records are actually READABLE
            // before deciding "this device has no history". Message records
            // load in secureLocalStore's second phase, and after an in-session
            // account switch they load inside the rebind instead — read either
            // window too early and you see null, offer to pull history from
            // another device, and overwrite history this device already has.
            // That is the same class of data-loss the device-sync audit had to
            // fix once. `hasAny` now throws rather than answering `false` from
            // a namespace it cannot see; treat that exactly like the device
            // probe failing below — stay closed.
            let hasHistory: boolean;
            try {
                hasHistory = (await messageStore.hasAny('dm', userId))
                    || (await messageStore.hasAny('channel', userId));
            } catch (err) {
                console.warn('[HistorySyncModal] local history not readable — not prompting', err);
                return;
            }
            if (cancelled) return;

            const dismissed = !!secureLocalStore.getItem(`cipherline_sync_dismissed_${userId}`);
            if (hasHistory || dismissed) return;

            try {
                const { data } = await axios.get<DeviceInfo[]>(`${API_BASE}/devices`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const others = data.filter(d => d.device_id !== deviceId);
                if (cancelled) return;
                setDevices(others);
                if (others.length > 0) setOpen(true);
            } catch (err) {
                // On failure, stay closed rather than prompting a sync that can't complete.
                console.warn('[HistorySyncModal] device probe failed:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [userId, token, deviceId]);

    const dismiss = useCallback(() => {
        if (countdownRef.current) clearInterval(countdownRef.current);
        if (userId) secureLocalStore.setItem(`cipherline_sync_dismissed_${userId}`, '1');
        clearHistoryDelivered();
        setOpen(false);
    }, [userId, clearHistoryDelivered]);

    const startCountdown = useCallback(() => {
        setCountdown(TIMEOUT_SECS);
        if (countdownRef.current) clearInterval(countdownRef.current);
        countdownRef.current = setInterval(() => {
            setCountdown(n => {
                if (n <= 1) {
                    clearInterval(countdownRef.current!);
                    setState('timed_out');
                    return 0;
                }
                return n - 1;
            });
        }, 1000);
    }, []);

    const fetchDevices = useCallback(async () => {
        if (!token) return;
        setDevicesLoading(true);
        try {
            const { data } = await axios.get<DeviceInfo[]>(`${API_BASE}/devices`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            // Exclude this device from the list
            setDevices(data.filter(d => d.device_id !== deviceId));
        } catch (err) {
            console.warn('[HistorySyncModal] device fetch failed:', err);
            setDevices([]);
        } finally {
            setDevicesLoading(false);
        }
    }, [token, deviceId]);

    const goPickDevice = useCallback(() => {
        setState('picking_device');
        setSelectedDeviceId(null);
        fetchDevices();
    }, [fetchDevices]);

    const sendRequest = useCallback(async (targetDeviceId: string | null) => {
        if (!token || !deviceId || !userId) return;

        // C-2b: sign the capability advertisement with this device's identity
        // key BEFORE announcing anything. A bare `accepts_wrapped_key: true`
        // is a boolean the relaying server can flip, and flipping it used to
        // make the approver send the raw history key in the clear. The
        // signature covers the capability itself, so the flag is no longer
        // something the server can meaningfully edit.
        const capabilityTs = Math.floor(Date.now() / 1000);
        let proof: { identityPub: string; sig: string } | null = null;
        try {
            proof = (await window.electronAPI?.getHistoryRequestProof(userId, deviceId, capabilityTs)) ?? null;
        } catch (err) {
            console.warn('[HistorySyncModal] capability proof failed:', err);
        }
        if (!proof?.sig) {
            // Never send an unsigned request as a "best effort". An unsigned
            // request is exactly what a current approver refuses, so this would
            // buy a confusing decline instead of a clear message — and on an
            // older approver it would quietly take the plaintext path.
            setBlockedText(
                'This device couldn’t prove its own identity key, so we didn’t ask for your history. '
                + 'Restart Cipherline and try again.',
            );
            setState('blocked');
            return;
        }

        setState('requesting');
        startCountdown();
        try {
            await axios.post(
                `${API_BASE}/devices/history-request`,
                {
                    ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
                    // Kept for the approver's logging and for older approvers
                    // that only understand this field. It is NOT what a current
                    // approver decides on — the signature below is.
                    accepts_wrapped_key: true,
                    capability_sig_b64: proof.sig,
                    capability_ts: capabilityTs,
                },
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
            );
        } catch (err: any) {
            console.warn('[HistorySyncModal] request failed:', err?.response?.data?.message ?? err?.message);
        }
    }, [token, deviceId, userId, startCountdown]);

    // Handle incoming history delivery (device:approved with transfer_key_b64).
    useEffect(() => {
        if (!historyDelivered || state === 'importing' || state === 'done') return;
        if (countdownRef.current) clearInterval(countdownRef.current);

        // C-2b — the requester half of the refusal. A delivery carrying only
        // the legacy plaintext key means the APPROVER is running a client that
        // predates the wrapped path: it has already POSTed the AES key for this
        // whole export to the server in the clear, and the server already holds
        // the matching ciphertext.
        //
        // Importing it anyway would "work", and that is the problem — the sync
        // would complete while the guarantee the product makes about it was
        // false, with nothing on screen to say so. Refuse, and name the device
        // the user has to update. Checked BEFORE `setState('importing')` so the
        // user never sees a progress label for a transfer that will not happen.
        if (!historyDelivered.wrapped_transfer_key_b64 && historyDelivered.transfer_key_b64) {
            console.warn('[HistorySyncModal] refusing plaintext transfer key from a legacy approver');
            setBlockedText(
                `${peerName ?? 'Your other device'} sent your history using an old, less private method — `
                + 'the encryption key would have passed through our servers. We didn’t import it. '
                + `Update Cipherline on ${peerName ?? 'that device'} and sync again.`,
            );
            setState('blocked');
            clearHistoryDelivered();
            return;
        }

        const doImport = async () => {
            setState('importing');
            const meta = historyDelivered.transfer_meta;
            const total = meta?.included_message_count ?? null;
            setStatusText(total != null
                ? `Importing ${total} message${total === 1 ? '' : 's'}…`
                : 'Downloading history…');

            try {
                const { data: backup } = await axios.get(`${API_BASE}/history/backup`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const encryptedData = b64ToBytes(backup.data_b64);

                // C-2 / C-2b: the ECIES envelope is the ONLY accepted form.
                // This used to read `?: historyDelivered.transfer_key_b64` — a
                // silent fallback to the legacy plaintext key, which is the key
                // the server got handed in the clear. The guard above already
                // returns before reaching here in that case; the fallback is
                // removed as well so there is no expression left that could
                // consume a plaintext key if that guard were ever edited out.
                const keyB64 = await unwrapHistoryTransferKey(
                    historyDelivered.wrapped_transfer_key_b64!, deviceId!,
                );
                if (!keyB64) throw new Error('history delivery carried no transfer key');
                const rawKey = b64ToBytes(keyB64);
                const aesKey = await window.crypto.subtle.importKey(
                    'raw', rawKey, { name: 'AES-GCM' }, true, ['decrypt'],
                );
                const iv = encryptedData.slice(0, 12);
                const ct = encryptedData.slice(12);
                const decryptedBuffer = await window.crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv }, aesKey, ct,
                );
                setStatusText('Applying history…');
                await importLocalHistory(userId!, new Blob([decryptedBuffer], { type: 'application/json' }));
                clearHistoryDelivered();
                setState('done');
                setStatusText('History synced successfully.');
                setTimeout(dismiss, 2500);
            } catch (err) {
                console.warn('[HistorySyncModal] import failed:', err);
                clearHistoryDelivered();
                // A refused payload (a phone's history, another account's,
                // a damaged file) is refused BEFORE anything is written — see
                // utils/historyPayloadFormat.ts — so say what it was rather
                // than offering a retry of the same thing.
                if (err instanceof HistoryPayloadRefusedError) {
                    setBlockedText(err.message);
                    setState('blocked');
                    return;
                }
                setState('timed_out');
                setStatusText('Import failed — you can try again or start fresh.');
            }
        };

        doImport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyDelivered]);

    useEffect(() => {
        if (!historyDeclined || state !== 'requesting') return;
        if (countdownRef.current) clearInterval(countdownRef.current);

        // C-2b — a machine-readable refusal, not a human "no thanks". A current
        // approver sends this when it could not verify THIS device's capability
        // advertisement. On a current requester that normally means the
        // signature did not survive the trip, which is itself worth saying out
        // loud rather than rendering as a plain "declined".
        if (historyDeclined.reason === HISTORY_REFUSED_LEGACY_REQUESTER) {
            setBlockedText(
                'Your other device couldn’t confirm this one can receive history securely, so it didn’t send it. '
                + 'Make sure both devices are on the latest version of Cipherline, then try again.',
            );
            setState('blocked');
            setHistoryDeclined(null);
            return;
        }

        // Sent by the mobile app (from 2026-09-24) when THIS device asks a
        // phone for history: desktop cannot read a phone's history format
        // yet, and the phone refuses rather than sending something that
        // would only fail here. Not a person saying no.
        if (historyDeclined.reason === HISTORY_REFUSED_MOBILE_TO_DESKTOP) {
            setBlockedText(
                'Your phone can’t send its history to a computer yet. Nothing on this computer was changed — '
                + 'you can sync from another computer instead, or start fresh.',
            );
            setState('blocked');
            setHistoryDeclined(null);
            return;
        }

        setState('declined');
        setHistoryDeclined(null);
    }, [historyDeclined, state, setHistoryDeclined]);

    useEffect(() => () => { if (countdownRef.current) clearInterval(countdownRef.current); }, []);

    if (!open) return null;

    return (
        <ClModal
            open={open}
            onClose={state === 'importing' ? () => {} : dismiss}
            closeOnOverlay={state !== 'importing'}
            width={420}
            // The "choose a device" step maps over every OTHER device on the
            // account with no cap and no inner scroller, so height grows with
            // the device count: 668px at 8 devices, 774px at 10 (27px off the
            // top, unreachable). Devices accumulate per install/reinstall, so
            // this is unbounded from our side. No escaping children — the rows
            // are plain buttons.
            cardClassName="mcard--scroll"
            cardStyle={{ padding: '28px' }}
        >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 16 }}>

                {/* Shared icon */}
                <div style={{
                    width: 56, height: 56, borderRadius: 16,
                    background: state === 'done' ? 'rgba(34,197,94,.12)' : 'rgba(37,224,200,.1)',
                    border: `1px solid ${state === 'done' ? 'rgba(34,197,94,.25)' : 'rgba(37,224,200,.2)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    {state === 'importing' && <Loader2 size={24} style={{ color: 'var(--cl-lume)' }} className="animate-spin" />}
                    {state === 'done' && <CheckCircle2 size={24} style={{ color: '#22c55e' }} />}
                    {(state === 'timed_out' || state === 'declined' || state === 'blocked') && <AlertTriangle size={24} style={{ color: 'var(--cl-glow)' }} />}
                    {(state === 'idle' || state === 'picking_device' || state === 'requesting') && <Download size={24} style={{ color: 'var(--cl-lume)' }} />}
                </div>

                {/* idle */}
                {state === 'idle' && (
                    <>
                        <div>
                            <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>No message history</h2>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                                This device doesn't have any messages yet. Bring history over from another signed-in device, or start fresh.
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                            <ClButton fullWidth variant="ghost" style={{ flex: 1 }} onClick={dismiss}>Start fresh</ClButton>
                            <ClButton fullWidth style={{ flex: 1 }} onClick={goPickDevice}>Sync from device</ClButton>
                        </div>
                    </>
                )}

                {/* picking_device */}
                {state === 'picking_device' && (
                    <>
                        <div style={{ width: '100%', textAlign: 'left' }}>
                            <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>Choose a device</h2>
                            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                                Select which device should send your history.
                            </p>

                            {devicesLoading && (
                                /* skeleton rows, not a spinner — kit rule for content loading */
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
                                    {[0, 1].map(i => (
                                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <ClSkeleton variant="avt" style={{ width: 28, height: 28 }} />
                                            <ClSkeleton variant="ln" style={{ width: 180 }} />
                                        </div>
                                    ))}
                                </div>
                            )}

                            {!devicesLoading && devices.length === 0 && (
                                <div style={{ fontSize: 13, color: 'var(--cl-muted)', padding: '12px 0' }}>
                                    No other devices found. Sign in on another device first.
                                </div>
                            )}

                            {!devicesLoading && devices.map(d => {
                                const selected = selectedDeviceId === d.device_id;
                                return (
                                    <button
                                        key={d.device_id}
                                        onClick={() => setSelectedDeviceId(d.device_id)}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                                            padding: '10px 14px', marginBottom: 8, borderRadius: 12, cursor: 'pointer',
                                            background: selected ? 'rgba(37,224,200,.1)' : 'var(--cl-sink)',
                                            border: `1.5px solid ${selected ? 'var(--cl-lume)' : 'var(--cl-border)'}`,
                                            textAlign: 'left', transition: 'all .15s',
                                        }}
                                    >
                                        <span style={{ color: selected ? 'var(--cl-lume)' : 'var(--cl-muted)', flexShrink: 0 }}>
                                            {platformIcon(d.platform, 18)}
                                        </span>
                                        <span style={{ flex: 1, minWidth: 0 }}>
                                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--cl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {d.device_name}
                                            </span>
                                            <span style={{ display: 'block', fontSize: 11, color: 'var(--cl-faint)', marginTop: 1 }}>
                                                {d.platform} · last seen {relativeTime(d.last_seen_at)}
                                            </span>
                                        </span>
                                        <span style={{
                                            width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                                            border: `2px solid ${selected ? 'var(--cl-lume)' : 'var(--cl-border)'}`,
                                            background: selected ? 'var(--cl-lume)' : 'transparent',
                                            transition: 'all .15s',
                                        }} />
                                    </button>
                                );
                            })}
                        </div>

                        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                            <ClButton fullWidth variant="ghost" style={{ flex: 1 }} onClick={() => setState('idle')}>
                                <ChevronLeft size={14} /> Back
                            </ClButton>
                            <ClButton
                                fullWidth
                                style={{ flex: 2 }}
                                disabled={!selectedDeviceId && devices.length > 0}
                                onClick={() => sendRequest(selectedDeviceId)}
                            >
                                Send request
                            </ClButton>
                        </div>
                    </>
                )}

                {/* requesting */}
                {state === 'requesting' && (
                    <>
                        <div>
                            <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>Waiting for another device…</h2>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                                Open Cipherline on your other device and approve the history transfer when prompted.
                            </p>
                        </div>
                        <div style={{
                            width: '100%', background: 'var(--cl-sink)', borderRadius: 12,
                            border: '1px solid var(--cl-border)', padding: '12px 16px',
                            display: 'flex', alignItems: 'center', gap: 10,
                        }}>
                            <Loader2 size={16} style={{ color: 'var(--cl-lume)', flexShrink: 0 }} className="animate-spin" />
                            <span style={{ fontSize: 13, color: 'var(--cl-muted)', flex: 1 }}>Listening for response…</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--cl-lume)', fontVariantNumeric: 'tabular-nums' }}>{countdown}s</span>
                        </div>
                        <ClButton fullWidth variant="ghost" onClick={dismiss}>Cancel</ClButton>
                    </>
                )}

                {/* timed_out */}
                {state === 'timed_out' && (
                    <>
                        <div>
                            <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>No response</h2>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                                {statusText || 'Make sure your other device is open and signed in, then try again.'}
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                            <ClButton fullWidth variant="ghost" style={{ flex: 1 }} onClick={dismiss}>Dismiss</ClButton>
                            <ClButton fullWidth style={{ flex: 1 }} onClick={goPickDevice}>Try again</ClButton>
                        </div>
                    </>
                )}

                {/* declined */}
                {state === 'declined' && (
                    <>
                        <div>
                            <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>Transfer declined</h2>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                                The other device declined the sync. You can try a different device or start fresh.
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                            <ClButton fullWidth variant="ghost" style={{ flex: 1 }} onClick={dismiss}>Start fresh</ClButton>
                            <ClButton fullWidth style={{ flex: 1 }} onClick={goPickDevice}>Try again</ClButton>
                        </div>
                    </>
                )}

                {/* blocked — C-2b. A dead end WITH an instruction, which is the
                    whole point: the owner authorised breaking history sync for
                    clients that can't do the wrapped path, but not breaking it
                    silently. Every `blockedText` names the device to act on and
                    what to do to it, so "Try again" is the natural next step
                    once the user has done that — it is not a retry of the same
                    failing thing. "Start fresh" stays available for a user who
                    would rather not wait on an update. */}
                {state === 'blocked' && (
                    <>
                        <div>
                            <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>
                                Couldn’t sync your history
                            </h2>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                                {blockedText}
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                            <ClButton fullWidth variant="ghost" style={{ flex: 1 }} onClick={dismiss}>Start fresh</ClButton>
                            <ClButton fullWidth style={{ flex: 1 }} onClick={goPickDevice}>Try again</ClButton>
                        </div>
                    </>
                )}

                {/* importing */}
                {state === 'importing' && (
                    <div>
                        <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: 'var(--cl-text)' }}>Importing history…</h2>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>{statusText}</p>
                    </div>
                )}

                {/* done */}
                {state === 'done' && (
                    <div>
                        <h2 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: '#22c55e' }}>History synced</h2>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)' }}>{statusText}</p>
                    </div>
                )}
            </div>
        </ClModal>
    );
};

export default HistorySyncBanner;
