import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Cloud, FolderOpen, Laptop, Smartphone, Wifi } from 'lucide-react';
import { ClButton } from '../ClButton';
import { ClModal } from '../cl/ClModal';
import { useAuth } from '../../contexts/AuthContext';
import { useOwnDevicePresence } from '../../hooks/useOwnDevicePresence';
import { nt } from '../../utils/nearStrings';
import { probeNearTransfer } from '../../utils/nearFlag';
import { ownTransferCapable, pickRows, type PickRow } from '../../utils/nearOwnTransfer';
import { openOwnTransferPicker } from '../../utils/ownTransferPicker';
import { NearText } from './NearParts';
import { XferHead, lastActiveText } from './TransferParts';
import '../../styles/near.css';

/** Where the existing restore rows live (BackupSection is wrapped in an element with this id when the card is on). */
export const RESTORE_ANCHOR_ID = 'nr-restore-anchor';

function scrollToRestore(): void {
    const el = document.getElementById(RESTORE_ANCHOR_ID);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}

/**
 * Settings, Storage, first card: "Move your history" (flow F). Renders nothing unless the bridge reports the local transfer
 * available (the helper exists and starts).
 *
 * Transfer from another device (contract section 7): opens the app's one device picker (`utils/ownTransferPicker.ts`, rendered by
 * `NearTransferHost`), whose Continue asks the chosen device through the host's own-device role (`utils/nearOwnTransfer.ts`); the
 * rest of the flow (the wait, the other device's sheet, the banner) is `OwnTransferHost`.
 */
export const MoveHistoryCard: React.FC = () => {
    const [enabled, setEnabled] = useState(false);
    useEffect(() => {
        let live = true;
        void probeNearTransfer().then(c => { if (live) setEnabled(c !== null); });
        return () => { live = false; };
    }, []);
    if (!enabled) return null;
    const canTransfer = ownTransferCapable();
    return (
        <div className="sd-card" data-testid="move-history">
            <h3 style={{ margin: '0 0 8px' }}>{nt('f.card')}</h3>
            <div className="nr-list">
                {canTransfer && <Row icon={<ArrowDownToLine size={18} />} title={nt('f.transfer.t')} value={nt('f.transfer.v')} action={<ClButton size="sm" onClick={() => openOwnTransferPicker()}>{nt('f.transfer.btn')}</ClButton>} />}
                <Row icon={<FolderOpen size={18} />} title={nt('f.file.t')} value={nt('f.file.v')} action={<ClButton size="sm" variant="ghost" onClick={scrollToRestore}>{nt('f.file.btn')}</ClButton>} />
                <Row icon={<Cloud size={18} />} title={nt('f.drive.t')} value={nt('f.drive.v')} action={<ClButton size="sm" variant="ghost" onClick={scrollToRestore}>{nt('f.drive.btn')}</ClButton>} />
            </div>
        </div>
    );
};

const Row: React.FC<{ icon: React.ReactNode; title: string; value: string; action: React.ReactNode }> = ({ icon, title, value, action }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12, alignItems: 'center', padding: '8px 2px' }}>
        <span className="nr-tile lume" style={{ width: 36, height: 36, borderRadius: 11 }}>{icon}</span>
        <span><div style={{ fontWeight: 800, color: 'var(--cl-text)', fontSize: 14.5 }}>{title}</div><div style={{ color: 'var(--cl-muted)', fontSize: 12.5, fontWeight: 600 }}>{value}</div></span>
        <span>{action}</span>
    </div>
);

/**
 * F-pick: this account's other devices, seeded presence (never polled). Online desktops and every phone can be picked (a phone's
 * socket carries no device id, so its presence is unknown: the row says to open Cipherline on it); an offline desktop is disabled
 * with a note. The same-network rule is said up front. Keyboard: one tab stop for the list (roving tabindex), Up / Down move and
 * select, Enter continues; Esc closes.
 */
export const PickDeviceDialog: React.FC<{ open: boolean; onClose: () => void; onPick?: (row: PickRow) => void; error?: string | null; busy?: boolean }> = ({ open, onClose, onPick, error, busy = false }) => {
    const { token, deviceId } = useAuth();
    const { devices, loading } = useOwnDevicePresence(token);
    const rows = useMemo(() => pickRows(devices, deviceId), [devices, deviceId]);
    const [sel, setSel] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { if (open) setSel(rows.find(r => r.selectable)?.deviceId ?? null); }, [open, rows]);
    const focusRow = (id: string) => { listRef.current?.querySelector<HTMLButtonElement>(`[data-device="${CSS.escape(id)}"]`)?.focus(); };
    const move = (dir: 1 | -1) => {
        const on = rows.filter(r => r.selectable);
        if (!on.length) return;
        const i = on.findIndex(r => r.deviceId === sel);
        const next = on[(i + dir + on.length) % on.length].deviceId;
        setSel(next); focusRow(next);
    };
    const chosen = rows.find(r => r.deviceId === sel && r.selectable);
    const go = () => { if (chosen && onPick && !busy) onPick(chosen); };
    const showLoading = loading && rows.length === 0;
    return (
        // The list has one row per other device of the account, with no cap: the card scrolls inside the viewport (mcard--scroll).
        <ClModal open={open} onClose={onClose} width={500} label={nt('f.pick.title')} cardClassName="mcard--scroll">
            <div className="nr-modal" data-testid="pick-device">
                <XferHead icon={<ArrowDownToLine size={24} />} title={nt('f.pick.title')} body={nt('f.pick.sub')} />
                <div className="nr-hint"><Wifi size={16} aria-hidden /><p><NearText k="f.pick.net" /></p></div>
                {showLoading ? (
                    <div className="nr-list" aria-busy="true" aria-label={nt('f.pick.loading')} data-testid="pick-loading">
                        <div className="nr-skel" /><div className="nr-skel" />
                    </div>
                ) : rows.length === 0 ? <p data-testid="pick-none">{nt('f.pick.none')}</p> : (
                    <div className="nr-list" role="radiogroup" aria-label={nt('f.pick.title')} ref={listRef}
                        onKeyDown={e => {
                            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); move(1); }
                            else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
                            else if (e.key === 'Enter') { e.preventDefault(); go(); }
                        }}>
                        {rows.map(r => {
                            const checked = sel === r.deviceId;
                            const ago = lastActiveText(r.lastActive);
                            return (
                                <button key={r.deviceId} type="button" role="radio" data-device={r.deviceId} aria-checked={checked} disabled={!r.selectable}
                                    tabIndex={checked || (!sel && r.selectable) ? 0 : -1} className="nr-opt" onClick={() => setSel(r.deviceId)} onDoubleClick={() => { setSel(r.deviceId); if (r.selectable && onPick && !busy) onPick(r); }}>
                                    <span className="nr-tile lume" style={{ width: 36, height: 36, borderRadius: 11 }} aria-hidden>{r.phone ? <Smartphone size={18} /> : <Laptop size={18} />}</span>
                                    <span>
                                        <div className="nm">{r.name}</div>
                                        <div className="sub">
                                            {r.online ? <><span className="dot" aria-hidden />{nt('f.pick.online', { platform: r.platform })}</> : ago ? nt('f.pick.offline', { platform: r.platform, date: ago }) : r.platform}
                                        </div>
                                    </span>
                                    {!r.selectable ? <span className="note">{nt('f.pick.offline.note')}</span> : !r.online ? <span className="note">{nt('f.pick.phone.note')}</span> : <span />}
                                </button>
                            );
                        })}
                    </div>
                )}
                {error && <p role="alert" className="nr-alert" data-testid="pick-error">{error}</p>}
                <div className="foot">
                    <ClButton variant="ghost" onClick={onClose}>{nt('common.cancel')}</ClButton>
                    <ClButton disabled={!chosen || !onPick || busy} loading={busy} onClick={go}>{busy ? nt('f.pick.asking') : nt('common.continue')}</ClButton>
                </div>
            </div>
        </ClModal>
    );
};
