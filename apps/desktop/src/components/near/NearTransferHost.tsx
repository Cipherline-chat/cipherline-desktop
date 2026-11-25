import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ClModal } from '../cl/ClModal';
import { ClButton } from '../ClButton';
import { NearProgress } from './NearParts';
import { TransferBanner } from './TransferBanner';
import { useAuth } from '../../contexts/AuthContext';
import { useNearSession } from '../../hooks/useNearSession';
import { nt } from '../../utils/nearStrings';
import { EtaTracker, formatBytes, formatCount, percent } from '../../utils/nearModel';
import { probeNearTransfer } from '../../utils/nearFlag';
import { createVaultHistoryPort, type NearHistoryPort } from '../../utils/nearHistoryPort';
import { getTransferRunner } from '../../utils/nearTransferRunner';
import { transferBannerView, InterruptWatch, type TransferControls } from '../../utils/nearTransferView';
import { nearBridge, nearTransferKeyBytes, bridgeMessage } from '../../utils/nearBridge';
import { ownPeerName, requestOwnTransfer, type PickRow } from '../../utils/nearOwnTransfer';
import { closeOwnTransferPicker, ownTransferPickerOpen, rememberAskedDevice, subscribeOwnTransferPicker } from '../../utils/ownTransferPicker';
import { PickDeviceDialog } from './MoveHistoryCard';
import { OwnTransferHost, useOwnControlSender } from './OwnTransferHost';
import { NearGatePrompt } from './NearGatePrompt';
import '../../styles/near.css';

/** What the bridge can do: Pause / Resume only when the host exposes them (contract 11.9); never faked. */
// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function transferControls(api: { nearTransferPause?: unknown; nearTransferResume?: unknown } | null | undefined = nearBridge()): TransferControls {
    return { pause: typeof api?.nearTransferPause === 'function' && typeof api?.nearTransferResume === 'function', cancel: true, details: true };
}

export interface NearTransferHostProps {
    /** A call is live: the reload that applies an imported history's settings waits until it ends. */
    inCall?: boolean;
    /** Test seams. */
    portFor?: (userId: string, token: string | null) => NearHistoryPort | null;
    now?: () => number;
    reload?: () => void;
}

/** After a received history has been imported, the app reloads (like Settings, Backup, Restore): most settings, emojis, sounds
 *  and keybinds are read once at start, and a running app would keep showing, and on the next change re-save, what it had
 *  before the import. Long enough for the "Your history is here" banner to be read. Never under a live call. */
export const RELOAD_AFTER_IMPORT_MS = 3500;

async function flushAndReload(): Promise<void> {
    try {
        const { default: store } = await import('../../utils/secureLocalStore');
        await store.flushNow();
    } catch { /* reload anyway: the debounce flush already ran or runs on unload */ }
    window.location.reload();
}

/**
 * Mounted once in the signed-in app. Renders nothing at all unless the bridge reports the local transfer available (the
 * helper exists and starts). The transfer is always on (the server-relayed history sync it replaced is gone, and the old
 * `VITE_NEAR_TRANSFER` build flag with it); a build without the helper says so on the sign-in history step instead.
 *
 * This is the transfer-only host: the one device picker (`utils/ownTransferPicker.ts`), the own-device wait / holder sheet
 * (`OwnTransferHost`), the progress banner with Pause / Details / Cancel, the stop dialog, the password gate, and the carrier
 * of the helper's outgoing control messages. The proximity sign-in surfaces (incoming-device banner, Add a device, the
 * approve-only pointer) are not part of this build.
 */
export const NearTransferHost: React.FC<NearTransferHostProps> = (props) => {
    const [enabled, setEnabled] = useState(false);
    useEffect(() => {
        let live = true;
        void probeNearTransfer().then(c => { if (live) setEnabled(c !== null); });
        return () => { live = false; };
    }, []);
    return enabled ? <NearTransferHostInner {...props} /> : null;
};

const NearTransferHostInner: React.FC<NearTransferHostProps> = ({ portFor, now = Date.now, inCall = false, reload }) => {
    const { token, userId, deviceId } = useAuth();
    const snap = useNearSession();
    const pickerOpen = useSyncExternalStore(subscribeOwnTransferPicker, ownTransferPickerOpen, ownTransferPickerOpen);
    const [pickErr, setPickErr] = useState<string | null>(null);
    const [asking, setAsking] = useState(false);
    const onPick = useCallback(async (row: PickRow) => {
        setPickErr(null); setAsking(true);
        try {
            rememberAskedDevice(row.name);
            await requestOwnTransfer(window.electronAPI, row, deviceId);
            closeOwnTransferPicker(true);
        } catch (e) { setPickErr(bridgeMessage(e, 'Couldn’t ask that device. Try again.')); } finally { setAsking(false); }
    }, [deviceId]);
    const runner = getTransferRunner();
    const run = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
    const [details, setDetails] = useState(false);
    const [confirmStop, setConfirmStop] = useState(false);
    const [dismissed, setDismissed] = useState<string | null>(null);
    useOwnControlSender(); // own-device control messages out through the E2EE self-fan-out
    const eta = useRef(new EtaTracker());
    const [etaText, setEtaText] = useState<string | null>(null);

    const port = useMemo<NearHistoryPort | null>(() => {
        if (!userId) return null;
        return (portFor ?? ((u, t) => createVaultHistoryPort({ userId: u, token: t ?? undefined, transferKey: () => nearTransferKeyBytes() })))(userId, token);
    }, [userId, token, portFor]);

    // A received history is in: reload to apply its settings (see RELOAD_AFTER_IMPORT_MS), once per import, never under a call.
    const imported = run.direction === 'receive' && !!run.counts && !run.running && !run.applying && !run.error;
    const reloadedFor = useRef<number | null>(null);
    useEffect(() => {
        if (!imported || inCall || reloadedFor.current === run.finishedAt) return;
        const id = setTimeout(() => { reloadedFor.current = run.finishedAt; (reload ?? (() => { void flushAndReload(); }))(); }, RELOAD_AFTER_IMPORT_MS);
        return () => clearTimeout(id);
    }, [imported, inCall, run.finishedAt, reload]);

    // ETA: only after >= 10 s of steady throughput and >= 5 %.
    useEffect(() => {
        const t = snap?.transfer;
        if (!t) { eta.current.reset(); setEtaText(null); return; }
        const n = now();
        eta.current.push(n, t.bytesDone);
        setEtaText(eta.current.eta(n, t.bytesDone, t.bytesTotal));
    }, [snap?.transfer, now]);

    // B7: a transfer whose connection dropped and never came back is ended here (the host would retry for ever).
    const watch = useRef(new InterruptWatch());
    const snapNow = snap && (snap.role === 'own_receiver' || snap.role === 'own_sender') ? snap : null;
    useEffect(() => {
        const w = watch.current;
        const check = (): void => {
            if (!w.gaveUp(now(), snapNow)) return;
            void nearBridge()?.nearCancel?.().catch(() => undefined);
            runner.giveUp();
        };
        check();
        const left = w.remainingMs(now());
        if (left == null) return;
        const id = setTimeout(check, left + 50);
        return () => clearTimeout(id);
    }, [snapNow, now, runner]);

    const own = snap?.role === 'own_receiver' || snap?.role === 'own_sender';
    const device = ownPeerName(snap, run.device || 'your other device');
    const direction: 'send' | 'receive' = snap?.role === 'own_sender' ? 'send' : 'receive';
    const view = snap && own ? transferBannerView(snap, { device, direction, eta: etaText, controls: transferControls(), applying: run.applying, counts: run.counts, stopped: run.stopped, gaveUp: run.gaveUp }) : null;
    const viewKey = view ? `${view.kind}:${snap?.linkId ?? ''}` : null;

    const stop = useCallback((keep = false) => {
        void nearBridge()?.nearCancel?.().catch(() => undefined);
        runner.stop({ keep });
        setConfirmStop(false); setDetails(false);
    }, [runner]);
    // Contract 11.9: Pause / Resume are offered only when the bridge has them (the host answers with an error otherwise).
    const pauseOr = (m: 'nearTransferPause' | 'nearTransferResume') => () => { void nearBridge()?.[m]?.().catch(() => undefined); };
    // Contract 11.10: "Keep what arrived" is offered to the RECEIVER once some parts are in, and only if the port can apply them.
    const canKeep = direction === 'receive' && !!port?.importPartial && (snap?.transfer?.recordsDone ?? 0) > 0;

    return (
        <>
            {view && viewKey !== dismissed && (
                <TransferBanner
                    view={view}
                    direction={direction}
                    onPause={pauseOr('nearTransferPause')}
                    onResume={pauseOr('nearTransferResume')}
                    onDetails={() => setDetails(true)}
                    onCancel={() => setConfirmStop(true)}
                    onDismiss={() => setDismissed(viewKey)}
                />
            )}
            <PickDeviceDialog open={pickerOpen} onClose={() => { setPickErr(null); closeOwnTransferPicker(false); }} onPick={(r) => { void onPick(r); }} error={pickErr} busy={asking} />
            <OwnTransferHost port={port} now={now} />
            <NearGatePrompt />
            <DetailsDialog open={details} onClose={() => setDetails(false)} snapshot={snap} device={device} direction={direction} eta={etaText} onCancel={() => { setDetails(false); setConfirmStop(true); }} />
            <StopTransferDialog open={confirmStop} onClose={() => setConfirmStop(false)} onStop={() => stop(false)} onKeep={canKeep ? () => stop(true) : undefined} arrived={canKeep ? formatBytes(snap?.transfer?.bytesDone ?? 0) : undefined} />
        </>
    );
};

/** Cancel asks first (spec E-stop): keep going, or stop. The RECEIVER, once some parts are in, may also keep what arrived
 *  (contract 11.10: the verified records of the stopped transfer are applied through the normal import path; the rest can be
 *  moved later from Settings, Storage). Without `onKeep` the choice is keep going or discard. */
export const StopTransferDialog: React.FC<{ open: boolean; onClose: () => void; onStop: () => void; onKeep?: () => void; arrived?: string }> = ({ open, onClose, onStop, onKeep, arrived }) => (
    <ClModal open={open} onClose={onClose} width={440} label={nt('e.stop.t')}>
        <div className="nr-modal" data-testid="stop-transfer">
            <h2>{nt('e.stop.t')}</h2>
            <p>{(onKeep ? nt('e.stop.s', { done: arrived ?? '' }) : nt('e.stopped.s')).replace(/\*\*(.+?)\*\*/g, '$1')}</p>
            <div className="foot">
                <ClButton autoFocus onClick={onClose}>{nt('e.stop.goOn')}</ClButton>
                {onKeep && <ClButton variant="ghost" onClick={onKeep}>{nt('e.stop.keep')}</ClButton>}
                <ClButton variant="danger" onClick={onStop}>{nt('e.stop.discard')}</ClButton>
            </div>
        </div>
    </ClModal>
);

export const DetailsDialog: React.FC<{
    open: boolean; onClose: () => void; snapshot: ReturnType<typeof useNearSession>; device: string;
    direction: 'send' | 'receive'; eta: string | null; onCancel: () => void;
}> = ({ open, onClose, snapshot, device, direction, eta, onCancel }) => {
    const t = snapshot?.transfer;
    const pct = t ? percent(t) : 0;
    return (
        <ClModal open={open && !!t} onClose={onClose} width={440} label={nt('e.det.title')}>
            <div className="nr-modal" data-testid="transfer-details">
                <h2>{nt('e.det.title')}</h2>
                <NearProgress pct={pct} state={snapshot?.state === 'transfer_paused' ? 'interrupted' : 'moving'} label={nt('e.a11y.progress', { pct })} />
                <dl className="nr-dl">
                    <dt>{nt('e.det.from')}</dt><dd>{direction === 'receive' ? device : nt('common.thisComputer')}</dd>
                    <dt>{nt('e.det.recv')}</dt><dd>{t ? `${formatBytes(t.bytesDone)} / ${formatBytes(t.bytesTotal)}` : ''}</dd>
                    <dt>{nt('e.det.items')}</dt><dd>{t ? `${formatCount(t.recordsDone)} / ${formatCount(t.recordsTotal)}` : ''}</dd>
                    <dt>{nt('e.det.left')}</dt><dd>{eta ?? nt('e.det.left.unknown')}</dd>
                </dl>
                <div className="foot">
                    <ClButton variant="ghost" onClick={onCancel}>{nt('e.cancel')}</ClButton>
                    <ClButton onClick={onClose}>{nt('common.close')}</ClButton>
                </div>
            </div>
        </ClModal>
    );
};
