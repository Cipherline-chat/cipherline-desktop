import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { ClModal } from '../cl/ClModal';
import { ClButton } from '../ClButton';
import { useAuth } from '../../contexts/AuthContext';
import { useNearSession } from '../../hooks/useNearSession';
import { API_BASE } from '../../constants';
import { apiUrl } from '../../utils/apiPath';
import { encryptAndAddress } from '../../utils/encryptAndAddress';
import { nt } from '../../utils/nearStrings';
import { formatBytes, formatCount } from '../../utils/nearModel';
import { ownPeerName, splitHolderLabel, isPhonePlatform } from '../../utils/nearOwnTransfer';
import { nearBridge } from '../../utils/nearBridge';
import { createOwnControlSender } from '../../utils/nearOwnTransport';
import { openOwnTransferPicker } from '../../utils/ownTransferPicker';
import { reportBeta } from '../../utils/betaDiagnostics/reporter';
import type { HistoryEstimate } from '../../utils/nearHistoryPort';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Ban, Clock, HardDrive, Laptop, ShieldCheck, Smartphone, WifiOff, XCircle } from 'lucide-react';
import { NearText } from './NearParts';
import { OutcomeDialog, XferHead, type TileTone } from './TransferParts';
import { getTransferRunner } from '../../utils/nearTransferRunner';
import type { NearHistoryPort } from '../../utils/nearHistoryPort';
import type { NearHistoryApi } from '../../utils/nearHistoryTransfer';
import '../../styles/near.css';

/** How long the asker waits with no answer before the wait screen explains the usual causes (the host itself waits ~5 minutes). */
export const SLOW_ANSWER_MS = 20_000;

/** Which ending dialog a finished session gets, or null (no dialog: done, the user's own cancel, a holder's sheet that timed out,
 *  a failure mid-transfer that the banner explains). Every ending says nothing was changed and what to do next.
 *  - refused `no_proximity`: not on the same network (both sides);  refused `denied`: the holder said not now (asker);
 *  - refused `busy`: the holder was in another session and its engine declined (asker; the person was never asked);
 *  - expired (asker): no answer in time, which is also what an OLD version of Cipherline looks like (it never answers), so the copy
 *    says to update it;  failed with "free space" (receiver): not enough disk;  cancelled `peer_cancelled`: the other side stopped;
 *  - failed before any byte moved (asker): could not start. */
// eslint-disable-next-line react-refresh/only-export-components -- co-located pure helper (tested); splitting the file would only affect dev Fast Refresh
export function endingFor(snap: { role?: string | null; state: string; error?: { code: string; message: string }; transfer?: unknown }, device: string): { kind: string; icon: React.ReactNode; tone: TileTone; title: string; body?: string } | null {
    const asker = snap.role === 'own_receiver';
    const code = snap.error?.code ?? '';
    if (snap.state === 'refused' && code === 'no_proximity') return { kind: 'nonet', icon: <WifiOff size={24} />, tone: 'warn', title: nt('f.nonet.title', { device }), body: nt('f.nonet.body', { device }) };
    if (snap.state === 'refused' && code === 'denied' && asker) return { kind: 'declined', icon: <Ban size={24} />, tone: 'neutral', title: nt('f.declined.title', { device }), body: nt('f.declined', { device }) };
    // the other device's ENGINE declined because it was in another session (answer revision 2), not its person
    if (snap.state === 'refused' && code === 'busy' && asker) return { kind: 'busy', icon: <Clock size={24} />, tone: 'warn', title: nt('f.busy.title', { device }), body: nt('f.busy.body', { device }) };
    if (snap.state === 'expired' && asker) return { kind: 'noanswer', icon: <Clock size={24} />, tone: 'warn', title: nt('f.noanswer.title', { device }), body: nt('f.noanswer.body', { device }) };
    if (snap.state === 'failed' && /free space/i.test(snap.error?.message ?? '')) return { kind: 'space', icon: <HardDrive size={24} />, tone: 'warn', title: nt('f.space.title'), body: nt('f.space.body', { device }) };
    if (snap.state === 'cancelled' && code === 'peer_cancelled') return { kind: 'peercancel', icon: <XCircle size={24} />, tone: 'neutral', title: nt('f.peercancel.title', { device }), body: nt('f.peercancel.body') };
    if (snap.state === 'failed' && asker && !snap.transfer) return { kind: 'failed', icon: <AlertTriangle size={24} />, tone: 'danger', title: nt('f.failed.title'), body: nt('f.failed.body') };
    return null;
}

/** The OS-level nudge for a holder sheet that opened while this window is not in front: a notification and (Windows) a taskbar flash.
 *  Clicking the notification brings the window forward (main's handler); an empty `conv_id` opens no conversation. Best effort. */
// eslint-disable-next-line react-refresh/only-export-components -- co-located pure helper (tested); splitting the file would only affect dev Fast Refresh
export function notifyHolderSheet(device: string, api: { notifShow?: (p: { id: string; title: string; body: string; conv_id: string }) => Promise<void>; notifFlashTaskbar?: () => Promise<void> } | undefined = typeof window !== 'undefined' ? window.electronAPI : undefined, focused: boolean = typeof document !== 'undefined' && document.hasFocus()): boolean {
    if (focused || !api) return false;
    void api.notifShow?.({ id: 'near-own-offer', title: nt('f.snd.notify.title', { device }), body: nt('f.snd.notify.body'), conv_id: '' })?.catch?.(() => undefined);
    void api.notifFlashTaskbar?.()?.catch?.(() => undefined);
    return true;
}

/**
 * Transfer between this account's own devices (contract section 7), the page's half: the wait screen on the device that asked, the
 * sheet on the device that holds the history, and the hand-off to the transfer runner once the other person said yes. The banner and
 * its Pause / Cancel are the same `TransferBanner` the sign-in transfer uses (mounted by `NearDeviceHost`).
 */
export const OwnTransferHost: React.FC<{ port: NearHistoryPort | null; now?: () => number }> = ({ port, now = Date.now }) => {
    const snap = useNearSession();
    const runner = getTransferRunner();
    const started = useRef(false);
    const [approving, setApproving] = useState(false);
    const [failed, setFailed] = useState(false);
    const [closedSeq, setClosedSeq] = useState(-1);

    const [slow, setSlow] = useState(false);

    const role = snap?.role;
    const own = role === 'own_receiver' || role === 'own_sender';
    // The asker's host only knows the other side as "Your other device"; the picker remembered which one it asked (ownPeerName).
    const device = ownPeerName(snap);
    const holder = splitHolderLabel(device);
    const terminal = !!snap &&['done', 'refused', 'expired', 'cancelled', 'failed'].includes(snap.state);

    // A session that has ended (or not begun) lets the next one start its transfer.
    useEffect(() => { if (!snap || terminal || snap.state === 'idle') { started.current = false; setFailed(false); setApproving(false); } }, [snap, terminal]);

    // The device that asked: once approved, receive. (The sender starts from its sheet's button, below.)
    useEffect(() => {
        const api = nearBridge();
        if (!api || !port || !snap || snap.role !== 'own_receiver' || snap.state !== 'approved' || started.current) return;
        started.current = true;
        void runner.startReceive({ api: api as unknown as NearHistoryApi, port, device, now });
    }, [snap, port, runner, device, now]);

    // The asker's wait: after a while with no answer, say what usually causes it (Cipherline closed on the other device, another
    // network, or a version from before this transfer existed: such a device never answers, it does not say no).
    const waiting = role === 'own_receiver' && snap?.state === 'awaiting_approval';
    useEffect(() => {
        setSlow(false);
        if (!waiting) return;
        const id = setTimeout(() => setSlow(true), SLOW_ANSWER_MS);
        return () => clearTimeout(id);
    }, [waiting, snap?.linkId]);

    // The holder's sheet says what would be sent (counts and size, local only: nothing is sent before Send history).
    const sheet = role === 'own_sender' && (snap?.state === 'awaiting_approval' || snap?.state === 'approving');
    const [estimate, setEstimate] = useState<HistoryEstimate | null | 'loading'>('loading');
    useEffect(() => {
        if (!sheet) return;
        if (!port) { setEstimate(null); return; }
        let live = true;
        setEstimate('loading');
        port.estimate().then(e => { if (live) setEstimate(e); }, () => { if (live) setEstimate(null); });
        return () => { live = false; };
    }, [sheet, port, snap?.linkId]);

    // The holder's sheet opens inside the app window, which is often behind other windows or in the tray: without a nudge the person
    // never sees it and the asking device waits for nothing (owner report 2026-11-25, "the PC said no"). One OS notification per offer
    // (no content beyond the asking device's sanitised name) and a taskbar flash, only when this window is not focused.
    const notified = useRef<string | null>(null);
    const sheetKey = sheet ? `${snap?.linkId ?? ''}:${holder.name}` : null;
    useEffect(() => {
        if (!sheetKey || notified.current === sheetKey) return;
        notified.current = sheetKey;
        notifyHolderSheet(holder.name);
    }, [sheetKey, holder.name]);

    // Beta diagnostics (opt-in, scrubbed): which ending a transfer reached, never a name, an address or any content. Once per session.
    const endingKind = own && snap ? endingFor(snap, '')?.kind ?? null : null;
    const reported = useRef<number>(-1);
    useEffect(() => {
        if (!endingKind || !snap || reported.current === snap.seq) return;
        reported.current = snap.seq;
        reportBeta('history_sync_failed', { stage: `near_${endingKind}`, role: snap.role === 'own_receiver' ? 'receiver' : 'sender' });
    }, [endingKind, snap]);

    if (!own || !snap) return null;

    const approve = async () => {
        const api = nearBridge();
        if (!api?.nearApprove || approving) return;
        setApproving(true); setFailed(false);
        try {
            const r = await api.nearApprove();
            if (r.result !== 'approved') { setFailed(true); return; }
            if (port && !started.current) {
                started.current = true;
                // not awaited: the banner (outside this dialog) shows it; the runner outlives the sheet
                void runner.startSend({ api: api as unknown as NearHistoryApi, port, includeAttachments: true, device, now });
            }
        } catch { setFailed(true); } finally { setApproving(false); }
    };
    const decline = () => { void nearBridge()?.nearRefuse?.().catch(() => undefined); };
    const cancel = () => { void nearBridge()?.nearCancel?.().catch(() => undefined); };
    const close = () => setClosedSeq(snap.seq);
    const retry = () => { setClosedSeq(snap.seq); openOwnTransferPicker(); };

    if (role === 'own_receiver' && snap.state === 'awaiting_approval') {
        return (
            <ClModal open onClose={cancel} width={480} label={nt('f.wait.title', { device })}>
                <div className="nr-modal" data-testid="own-wait" role="status">
                    <XferHead icon={<ArrowDownToLine size={24} />} title={nt('f.wait.title', { device })} />
                    <ol className="nr-steps">
                        <li><span><NearText k="f.wait.s1" vars={{ device }} /></span></li>
                        <li><span><NearText k="f.wait.s2" /></span></li>
                        <li><span><NearText k="f.wait.s3" /></span></li>
                    </ol>
                    {slow
                        ? <div className="nr-hint warn" data-testid="own-wait-slow"><AlertTriangle size={16} aria-hidden /><p>{nt('f.wait.slow', { device })}</p></div>
                        : <div className="nr-waitline"><span className="nr-spin" aria-hidden />{nt('e.int.t', { device })}…</div>}
                    <div className="foot"><ClButton variant="ghost" autoFocus onClick={cancel}>{nt('common.cancel')}</ClButton></div>
                </div>
            </ClModal>
        );
    }
    if (sheet) {
        const phone = isPhonePlatform(snap.peer?.platform) || /iphone|android|phone/i.test(holder.detail);
        const est = estimate === 'loading' ? null : estimate;
        return (
            <ClModal open onClose={decline} width={480} label={nt('f.snd.title', { device: holder.name })}>
                <div className="nr-modal" data-testid="own-send-sheet">
                    <XferHead icon={<ArrowUpFromLine size={24} />} title={nt('f.snd.title', { device: holder.name })} body={nt('f.snd.asked', { device: holder.name })} />
                    <div className="nr-who">
                        <span className="ic" aria-hidden>{phone ? <Smartphone size={20} /> : <Laptop size={20} />}</span>
                        <span><div className="n">{holder.name}</div>{holder.detail && <div className="d">{holder.detail}</div>}</span>
                    </div>
                    <div className="nr-what">
                        <span className="k">{nt('f.snd.what')}</span>
                        <span className={`v${estimate === 'loading' ? ' loading' : ''}`} data-testid="own-send-size">
                            {estimate === 'loading' ? nt('f.snd.size.loading') : est ? nt('f.snd.size', { messages: formatCount(est.messages), attachments: formatCount(est.attachments), size: formatBytes(est.totalBytes) }) : nt('f.snd.size.none')}
                        </span>
                    </div>
                    <div className="nr-hint"><ShieldCheck size={16} aria-hidden /><p>{nt('f.snd.how', { device: holder.name })}</p></div>
                    {failed && <p role="alert" className="nr-alert" data-testid="own-send-failed">{nt('b.ap.bioFail')}</p>}
                    <div className="foot">
                        <ClButton variant="ghost" onClick={decline}>{nt('common.notNow')}</ClButton>
                        <ClButton autoFocus loading={approving} disabled={approving} onClick={() => { void approve(); }}>{nt('f.snd.btn')}</ClButton>
                    </div>
                </div>
            </ClModal>
        );
    }
    const outcome = endingFor(snap, device);
    if (snap.seq > closedSeq && outcome) {
        return <OutcomeDialog {...outcome} onClose={close} onRetry={role === 'own_receiver' ? retry : undefined} />;
    }
    return null;
};

/** Carries the host's outgoing own-device control messages through this page's E2EE self-fan-out (see utils/nearOwnTransport.ts). */
// eslint-disable-next-line react-refresh/only-export-components -- co-located hook export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function useOwnControlSender(): void {
    const { token, userId, deviceId } = useAuth();
    useEffect(() => {
        const api = nearBridge();
        if (!api?.onNearOwnOut || !token || !userId || !deviceId) return;
        const h = { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } };
        const send = createOwnControlSender({
            userId, deviceId,
            selfConversationId: async () => String((await axios.post(`${API_BASE}/conversations/dm`, { other_user_id: userId }, h)).data.conversation_id),
            listDevices: async (c) => { const r = await axios.get(apiUrl`/conversations/${c}/devices?claim_otp=1`, h); return Array.isArray(r.data) ? r.data : []; },
            encryptAndAddress: (p, u, d, s) => encryptAndAddress(p, u, d, s),
            post: async (b) => { await axios.post(`${API_BASE}/messages/send`, b, h); },
        });
        return api.onNearOwnOut(m => { void send(m.to, m.content); });
    }, [token, userId, deviceId]);
}
