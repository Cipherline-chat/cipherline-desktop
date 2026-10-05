/**
 * HistoryRequestModal — shown on the existing (approver) device when a newly-signed-in
 * device sends a history-sync request. The approver picks range + per-type toggles;
 * the modal then filters local history, bundles attachment ciphertexts, encrypts,
 * uploads, and delivers the one-time AES key via POST /v1/devices/:id/deliver-history.
 *
 * C-2: that key is ECIES-wrapped to the REQUESTING DEVICE's signed prekey
 * (`wrapHistoryTransferKey`), so the server relays an envelope it cannot open
 * instead of the raw AES key it used to be handed in plaintext.
 *
 * C-2b — THIS MODAL IS THE ENFORCEMENT POINT for the downgrade fix.
 *
 * Which path ran used to be decided by the requester's `accepts_wrapped_key`
 * flag, relayed unauthenticated through the server. Flipping it to false made
 * this modal fall back to POSTing the raw AES key for the whole export — and
 * the server already holds that export's ciphertext. One edited field in
 * transit undid C-2 entirely.
 *
 * So: before ANY history is packaged, the requester's signed capability
 * advertisement is verified against the identity key in its own key bundle. If
 * it does not verify — stripped signature, forged signature, stale timestamp,
 * or a genuinely old client that never had one — this modal REFUSES. It does
 * not send a plaintext key; there is no longer any input the server can supply
 * that makes it do so. That refusal is what breaks compatibility with clients
 * predating the wrapped path, and it is deliberate: signing alone would not
 * close anything, because a relay that can strip a boolean can strip a
 * signature and make a modern requester look legacy.
 *
 * The check runs on MOUNT, before the user is offered a range picker, so a
 * refusal costs nothing: no history export, no encryption, no upload of a blob
 * whose key will never be delivered.
 *
 * Decline path posts to `/v1/devices/:id/decline-history`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { exportLocalHistory } from '../utils/crypto';
import { useModalExit } from '../hooks/useModalExit';
import { RANGE_CHOICES } from '../utils/historyTransfer';
import {
    fetchOwnDeviceKeyBundle, wrapHistoryTransferKey, type PrekeyBundleEntry,
} from '../utils/historyTransferKey';
import {
    verifyHistoryRequestAdvertisement, HISTORY_REFUSED_LEGACY_REQUESTER,
} from '../utils/historyRequestProof';
import { shouldShowQrAuthorisedLine } from '../utils/recentTransfers';
import { Monitor, Smartphone, X, Loader2, AlertTriangle, MessageSquare, Image as ImageIcon, Users, QrCode } from 'lucide-react';
import { ClButton, ClCheckbox, ClModal } from './cl';

interface HistoryRequest {
    device_id: string;
    device_name: string;
    platform: string;
    requested_at: string;
    /** C-2 — requester can unwrap an ECIES-wrapped transfer key.
     *  C-2b — advisory only. Never branched on; see `verdict` below. */
    accepts_wrapped_key?: boolean;
    /** C-2b — Ed25519 signature over the canonical advertisement. */
    capability_sig_b64?: string;
    /** C-2b — unix seconds the advertisement was signed at. */
    capability_ts?: number;
    /** QR transfer authorisation (docs/QR-LINKING.md §3) — additive, optional
     *  fields on the EXISTING `device:history_request` event. Display copy
     *  only ("authorised by a code scanned on this device"); both absent from
     *  an ordinary in-app request, so the modal looks exactly as it did
     *  before this field existed. Never a trust decision — the C-2b
     *  verification above is identical either way. */
    via?: 'qr';
    transfer_id?: string;
}

/**
 * C-2b gate states.
 *   checking — verifying the advertisement; nothing has been packaged yet.
 *   ok       — verified; the transfer may proceed, wrapped-only.
 *   refused  — the requester cannot receive a wrapped key. NO key of any form
 *              is sent. The requester is declined with a machine-readable
 *              reason so its own UI can say what to do.
 *   error    — we could not reach the key bundle to decide. Distinct from
 *              `refused` on purpose: this is transient and retryable, and it
 *              must NOT auto-decline the requester, which would turn a blip
 *              into a dead-end for a perfectly modern device.
 */
type Verdict = 'checking' | 'ok' | 'refused' | 'error';

interface Props {
    request: HistoryRequest;
    onClose: () => void;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function platformIcon(platform: string) {
    const p = (platform || '').toLowerCase();
    if (p.includes('mac') || p.includes('iphone') || p.includes('ios') || p.includes('android'))
        return <Smartphone size={20} />;
    return <Monitor size={20} />;
}

export const HistoryRequestModal: React.FC<Props> = ({ request, onClose }) => {
    const { token, user, deviceId } = useAuth();
    const { closing, handleClose } = useModalExit(onClose, 260);

    // Range selection — null = all time, matches RANGE_CHOICES values
    const [rangeDays, setRangeDays] = useState<number | null>(30);

    // Per-type toggles
    const [includeDmMsgs,      setIncludeDmMsgs]      = useState(true);
    const [includeDmAtts,      setIncludeDmAtts]       = useState(true);
    const [includeGroupMsgs,   setIncludeGroupMsgs]    = useState(true);
    const [includeGroupAtts,   setIncludeGroupAtts]    = useState(true);
    const [includeServerMsgs,  setIncludeServerMsgs]   = useState(true);
    const [includeServerAtts,  setIncludeServerAtts]   = useState(true);

    // 25 MB per-file cap — true = skip oversized attachments
    const [skipLargeAtts, setSkipLargeAtts] = useState(false);
    const MAX_ATT_BYTES = 25 * 1024 * 1024; // 25 MB

    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number; bytes: number } | null>(null);
    const [working, setWorking] = useState(false);

    // C-2b gate. `bundle` is the requester's key bundle fetched ONCE: the same
    // entry is used to verify the advertisement and, later, to wrap the
    // transfer key — so the identity key that vouched for the request is
    // provably the identity key the history gets encrypted to. Re-fetching at
    // send time would let the server serve a different key to each step.
    const [verdict, setVerdict] = useState<Verdict>('checking');
    const [bundle, setBundle] = useState<PrekeyBundleEntry | null>(null);
    const [verifyAttempt, setVerifyAttempt] = useState(0);

    // The app renders under React.StrictMode (`src/main.tsx`), which invokes
    // effects TWICE in development. Without this guard the refusal path would
    // POST `decline-history` twice per request — two `device:history_declined`
    // events at the requester and, worse, two
    // `historyTransfer key_form=refused` lines, silently doubling the
    // rollout-drain number the launch-checklist gate is read off. Keyed by
    // device id so a genuinely new request from another device still declines.
    const declinedForRef = useRef<string | null>(null);

    const postDecline = useCallback(async (reason: string) => {
        try {
            await axios.post(
                `${API_BASE}/devices/${request.device_id}/decline-history`,
                { reason },
                { headers: { Authorization: `Bearer ${token}` } },
            );
        } catch (err) {
            console.warn('[HistoryRequestModal] decline failed:', err);
        }
    }, [request.device_id, token]);

    useEffect(() => {
        if (!user?.user_id || !token) {
            // Must NOT leave `verdict` on 'checking': that renders a spinner
            // with no terminal state, which is precisely the never-resolving
            // outcome this change exists to eliminate. Dashboard only mounts
            // this modal when signed in, so this is defensive — but "defensive"
            // is not a reason to ship a hang.
            setVerdict('error');
            return;
        }
        let cancelled = false;

        (async () => {
            setVerdict('checking');
            let entry: PrekeyBundleEntry;
            try {
                entry = await fetchOwnDeviceKeyBundle(request.device_id, user.user_id, token);
            } catch (err) {
                // Could not obtain the key material to judge by. Not a verdict
                // about the requester — do not decline it, let the user retry.
                console.warn('[HistoryRequestModal] key bundle fetch failed:', err);
                if (!cancelled) setVerdict('error');
                return;
            }
            if (cancelled) return;

            const result = verifyHistoryRequestAdvertisement({
                userId: user.user_id,
                requestingDeviceId: request.device_id,
                identityKeyPubB64: entry.identity_key_pub_b64,
                capabilitySigB64: request.capability_sig_b64,
                capabilityTs: request.capability_ts,
            });

            if (cancelled) return;

            if (!result.ok) {
                // Deliberately identical handling for "no signature" (an old
                // client, or one the server stripped) and "bad signature" (a
                // forgery). Treating them differently would hand the server a
                // way to pick which branch it lands on.
                console.warn(`[HistoryRequestModal] refusing history transfer: ${result.reason}`);
                setVerdict('refused');
                setBundle(null);
                // Tell the requester WHY, so it can render something actionable
                // instead of counting down to a timeout. Also the signal the
                // rollout-drain log counts (`historyTransfer key_form=refused`).
                if (declinedForRef.current !== request.device_id) {
                    declinedForRef.current = request.device_id;
                    void postDecline(HISTORY_REFUSED_LEGACY_REQUESTER);
                }
                return;
            }

            setBundle(entry);
            setVerdict('ok');
        })();

        return () => { cancelled = true; };
    }, [request.device_id, request.capability_sig_b64, request.capability_ts,
        user?.user_id, token, postDecline, verifyAttempt]);

    const handleDecline = async () => {
        await postDecline('user_declined');
        handleClose();
    };

    const handleSend = async () => {
        if (!user?.user_id || !token) { setError('Not signed in.'); return; }
        // C-2b belt and braces. The refusal states already replace this button
        // with a dead end, but the transfer must be impossible to start without
        // a verified bundle in hand even if a future render path forgets that.
        if (verdict !== 'ok' || !bundle) {
            setError('This device could not be verified. Refusing to send history.');
            return;
        }
        setWorking(true); setError(null);

        try {
            setStatus('Packaging history…');
            const historyBlob = await exportLocalHistory(user.user_id, {
                rangeDays,
                includeDmMessages:        includeDmMsgs,
                includeDmAttachments:     includeDmAtts,
                includeGroupMessages:     includeGroupMsgs,
                includeGroupAttachments:  includeGroupAtts,
                includeServerMessages:    includeServerMsgs,
                includeServerAttachments: includeServerAtts,
                maxAttachmentSizeBytes:   skipLargeAtts ? MAX_ATT_BYTES : undefined,
                token,
                onAttachmentProgress: (done, total, bytes) => setProgress({ done, total, bytes }),
            });
            const historyBuffer = await historyBlob.arrayBuffer();

            setStatus('Encrypting…');
            setProgress(null);
            const aesKey = await window.crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
            );
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedBuf = await window.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv }, aesKey, historyBuffer,
            );
            const combined = new Uint8Array(iv.byteLength + encryptedBuf.byteLength);
            combined.set(iv, 0);
            combined.set(new Uint8Array(encryptedBuf), iv.byteLength);
            const rawKey = await window.crypto.subtle.exportKey('raw', aesKey);
            const transferKeyB64 = btoa(String.fromCharCode(...new Uint8Array(rawKey)));

            setStatus('Uploading…');
            const { data: { backup_id } } = await axios.post(
                `${API_BASE}/history/backup`,
                { size_bytes: combined.byteLength },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            // Send as Blob so browsers/Electron handle the binary body reliably.
            await axios.post(
                `${API_BASE}/history/upload/${backup_id}`,
                new Blob([combined], { type: 'application/octet-stream' }),
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' } },
            );

            let meta: any = null;
            try {
                const v = JSON.parse(await historyBlob.text());
                meta = v?.transferMeta ?? null;
            } catch { /* non-fatal */ }

            setStatus('Delivering key…');

            // C-2 / C-2b: wrap the AES key to the requesting device so the
            // server relays an envelope it cannot open.
            //
            // There is NO conditional here any more, and that is the fix. This
            // used to read `if (request.accepts_wrapped_key)` with a plaintext
            // `else` — a branch selected by an unauthenticated field the server
            // relayed, i.e. a downgrade switch the server held. The capability
            // is now established before any of this runs, by verifying a
            // signature over a message that names the capability, and the
            // plaintext branch is gone rather than merely disfavoured.
            //
            // A failure here surfaces as an error. It must never fall back —
            // that would silently hand the key to the server, which is the
            // whole defect.
            const wrappedTransferKeyB64 = await wrapHistoryTransferKey(
                transferKeyB64, bundle, user.user_id, deviceId,
            );

            await axios.post(
                `${API_BASE}/devices/${request.device_id}/deliver-history`,
                {
                    // Wrapped only. `transfer_key_b64` is never populated by a
                    // current client; the API still accepts it solely for
                    // approvers that predate the wrapped path talking to
                    // requesters of the same vintage.
                    wrapped_transfer_key_b64: wrappedTransferKeyB64,
                    range_days: rangeDays,
                    include_attachments: includeDmAtts || includeGroupAtts || includeServerAtts,
                    included_message_count: meta?.included_message_count ?? 0,
                    included_byte_size: combined.byteLength,
                },
                { headers: { Authorization: `Bearer ${token}` } },
            );

            setStatus('Done — history sent.');
            setTimeout(handleClose, 1200);
        } catch (err: any) {
            console.error('[HistoryRequestModal] send failed', err);
            setError(err?.response?.data?.message || err?.message || 'Transfer failed.');
            setWorking(false);
            setStatus(null);
        }
    };

    const noneSelected = !includeDmMsgs && !includeDmAtts && !includeGroupMsgs && !includeGroupAtts && !includeServerMsgs && !includeServerAtts;

    // C-2b gate — everything except `ok` ends here, before any range picker or
    // "Send history" button exists to be clicked.
    if (verdict !== 'ok') {
        const refused = verdict === 'refused';
        return (
            <ClModal open={!closing} onClose={handleClose} width={460} cardStyle={{ padding: '28px' }}>
                <div className="flex items-start gap-4 mb-5">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                        refused
                            ? 'bg-cl-glow/10 border border-cl-glow/25 text-cl-glow'
                            : 'bg-cl-lume/10 border border-cl-lume/20 text-cl-lume'
                    }`}>
                        {verdict === 'checking' ? <Loader2 size={20} className="animate-spin" /> : <AlertTriangle size={20} />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-lg font-bold text-cl-text mb-0.5 mt-0">
                            {verdict === 'checking' && 'Checking that device…'}
                            {verdict === 'error'    && 'Couldn’t verify that device'}
                            {refused                && 'That device needs an update'}
                        </h2>
                        <p className="text-sm text-cl-muted leading-snug m-0">
                            {verdict === 'checking' && (
                                <>Confirming <span className="text-cl-text font-semibold">{request.device_name}</span> can
                                receive your history securely.</>
                            )}
                            {verdict === 'error' && (
                                <>We couldn’t reach the key information for{' '}
                                <span className="text-cl-text font-semibold">{request.device_name}</span>. Check your
                                connection and try again.</>
                            )}
                            {/* The one message the user must act on. It names the
                                device, says what to do, and says it on the device
                                the user is actually looking at — they clicked
                                through to this modal here. */}
                            {refused && (
                                <>Update Cipherline on{' '}
                                <span className="text-cl-text font-semibold">{request.device_name}</span>, then ask it to
                                sync again. This version is too old to receive your history without handing the
                                encryption key to the server, so we didn’t send it.</>
                            )}
                        </p>
                    </div>
                    <ClButton icon variant="ghost" onClick={handleClose} aria-label="Close" className="shrink-0">
                        <X size={18} />
                    </ClButton>
                </div>

                <div className="flex gap-3">
                    <ClButton fullWidth variant={verdict === 'error' ? 'ghost' : 'primary'} style={{ flex: 1 }} onClick={handleClose}>
                        {refused ? 'Got it' : 'Close'}
                    </ClButton>
                    {verdict === 'error' && (
                        <ClButton fullWidth style={{ flex: 1 }} onClick={() => setVerifyAttempt(n => n + 1)}>
                            Try again
                        </ClButton>
                    )}
                </div>
            </ClModal>
        );
    }

    return (
        <ClModal
            open={!closing}
            onClose={working ? () => {} : handleClose}
            closeOnOverlay={!working}
            width={460}
            // Tallest modal in the app: the header, five wrapping range chips,
            // three TypeSections (label + two checkboxes each), the >25 MB
            // toggle, a disclaimer and the action row measure 877px at 1280x720
            // — 78px off the top, which centred-flex overflow cannot scroll
            // back to, so "Decline"/"Send history" sit below the fold with the
            // device name above it out of reach. Nothing here escapes the card
            // (checkboxes and chips only), so the cap is safe.
            cardClassName="mcard--scroll"
            cardStyle={{ padding: '28px' }}
        >
            {/* Header */}
            <div className="flex items-start gap-4 mb-5">
                <div className="w-12 h-12 rounded-2xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center shrink-0 text-cl-lume">
                    {platformIcon(request.platform)}
                </div>
                <div className="flex-1 min-w-0">
                    <h2 className="text-lg font-bold text-cl-text mb-0.5 mt-0">Send history to this device</h2>
                    <p className="text-sm text-cl-muted leading-snug m-0">
                        <span className="text-cl-text font-semibold">{request.device_name}</span> is requesting message history. Choose what to send.
                    </p>
                    {/* docs/QR-LINKING.md §3 — the request came through a QR scan on
                        this device rather than a remote "sync from device" tap, so
                        say so: the human confirming below should know it was a
                        physical gesture. Absent (undefined) for every request that
                        did not go through xfer, so the modal is unchanged for those.
                        QR-6 (adversarial review): `via` alone is an unverifiable
                        server claim — a compromised API pod could attach it to any
                        request, including a remote attacker's, and this line would
                        assert a physical event that never happened. `via` is now
                        necessary but not sufficient: the line only renders when
                        `transfer_id` also matches a transfer THIS device actually
                        opened (`shouldShowQrAuthorisedLine`, via
                        `recentTransfers.ts`). Otherwise it renders NOTHING — not a
                        hedged version of the claim, nothing. */}
                    {shouldShowQrAuthorisedLine(request) && (
                        <p className="text-xs text-cl-lume flex items-center gap-1 mt-1.5 mb-0">
                            <QrCode size={12} /> Authorised by a code scanned on this device
                        </p>
                    )}
                </div>
                {!working && (
                    <ClButton icon variant="ghost" onClick={handleClose} aria-label="Close" className="shrink-0">
                        <X size={18} />
                    </ClButton>
                )}
            </div>

            {/* Range chips */}
            <div className="mb-4">
                <p className="text-xs font-semibold text-cl-muted uppercase tracking-wider mb-2">Time range</p>
                <div className="flex flex-wrap gap-2">
                    {RANGE_CHOICES.map(({ value, label }) => {
                        const isSelected = rangeDays === value;
                        return (
                            <button
                                key={String(value)}
                                disabled={working}
                                onClick={() => setRangeDays(value)}
                                style={{
                                    padding: '4px 12px',
                                    borderRadius: 8,
                                    fontSize: 13,
                                    fontWeight: isSelected ? 600 : 400,
                                    cursor: working ? 'not-allowed' : 'pointer',
                                    border: `1px solid ${isSelected ? 'var(--cl-lume)' : 'var(--cl-border)'}`,
                                    background: isSelected ? 'rgba(37,224,200,.12)' : 'var(--cl-sink)',
                                    color: isSelected ? 'var(--cl-lume)' : 'var(--cl-text)',
                                    transition: 'all .15s',
                                }}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Content type sections */}
            <div className="bg-cl-sink border border-cl-border rounded-xl overflow-hidden mb-4">
                <TypeSection
                    icon={<MessageSquare size={14} />}
                    label="Direct messages"
                    msgChecked={includeDmMsgs} onMsgChange={setIncludeDmMsgs}
                    attChecked={includeDmAtts} onAttChange={setIncludeDmAtts}
                    disabled={working}
                    divider={false}
                />
                <TypeSection
                    icon={<Users size={14} />}
                    label="Group chats"
                    msgChecked={includeGroupMsgs} onMsgChange={setIncludeGroupMsgs}
                    attChecked={includeGroupAtts} onAttChange={setIncludeGroupAtts}
                    disabled={working}
                />
                <TypeSection
                    icon={<ImageIcon size={14} />}
                    label="Servers"
                    msgChecked={includeServerMsgs} onMsgChange={setIncludeServerMsgs}
                    attChecked={includeServerAtts} onAttChange={setIncludeServerAtts}
                    disabled={working}
                />
            </div>

            {/* 25 MB per-file cap */}
            <div className="px-1 mb-3">
                <ClCheckbox
                    checked={skipLargeAtts}
                    onChange={v => setSkipLargeAtts(v)}
                    disabled={working}
                    label="Skip attachments over 25 MB"
                />
            </div>

            <p className="text-[12px] text-cl-faint leading-relaxed mb-4">
                Sending is a copy — messages stay on this device. Data is encrypted with a one-time key only the new device can read.
            </p>

            {status && (
                <div className="text-cl-lume bg-cl-lume/[0.08] border border-cl-lume/25 rounded-xl px-3 py-2 mb-3 text-[13px] flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin shrink-0" />
                    <span className="flex-1">{status}</span>
                    {progress && progress.total > 0 && (
                        <span className="text-[11px] text-cl-lume/70 tabular-nums">
                            {progress.done}/{progress.total} · {formatBytes(progress.bytes)}
                        </span>
                    )}
                </div>
            )}

            {error && (
                <div className="text-cl-flash bg-cl-flash/10 border border-cl-flash/25 rounded-xl px-3 py-2 mb-3 text-[13px] flex items-start gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>{error}</span>
                </div>
            )}

            <div className="flex gap-3">
                <ClButton fullWidth variant="ghost" style={{ flex: 1 }} disabled={working} onClick={handleDecline}>
                    Decline
                </ClButton>
                <ClButton fullWidth style={{ flex: 1 }} loading={working} disabled={noneSelected} onClick={handleSend} pressAnim="send">
                    Send history
                </ClButton>
            </div>
        </ClModal>
    );
};

interface TypeSectionProps {
    icon: React.ReactNode;
    label: string;
    msgChecked: boolean; onMsgChange: (v: boolean) => void;
    attChecked: boolean; onAttChange: (v: boolean) => void;
    disabled: boolean;
    divider?: boolean;
}

function TypeSection({
    icon, label, msgChecked, onMsgChange, attChecked, onAttChange, disabled, divider = true,
}: TypeSectionProps) {
    return (
        <div style={{ borderTop: divider ? '1px solid var(--cl-border)' : undefined, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ color: 'var(--cl-muted)' }}>{icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--cl-text)' }}>{label}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ClCheckbox checked={msgChecked} onChange={v => onMsgChange(v)} disabled={disabled} label="Messages" />
                <ClCheckbox checked={attChecked} onChange={v => onAttChange(v)} disabled={disabled} label="Attachments" />
            </div>
        </div>
    );
}
