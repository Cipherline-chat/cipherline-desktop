/**
 * StaleDevicesDialog — "Still using these devices?" (stale-device policy).
 *
 * Shown by StaleDevicesHost on the user's ACTIVE device when another of their
 * devices has not been seen for 30 days, and once more at 180 days. Calm and
 * dismissible: every row has Remove and Keep, and closing the dialog (Done,
 * Escape, backdrop) keeps whatever is left — which is recorded server-side,
 * so the prompt does not come back for that tier on any of the user's devices.
 * Remove goes through the house destructive confirm (ConfirmDialog) and then
 * the existing revoke route.
 *
 * Presentational: the host owns fetching and the network calls.
 */
import React from 'react';
import { Laptop, Monitor, Smartphone, MonitorSmartphone } from 'lucide-react';
import { ClButton, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText } from './dialog/DialogFrame';
import { platformLabel } from '../utils/deviceApprovalEvents';
import { formatLastActive, staleBadgeLabel, staleDialogCopy, staleTierOf, type OwnDevice } from '../utils/staleDevices';
import '../styles/stale-devices.css';

function platformIcon(platform: string) {
    const p = (platform || '').toLowerCase();
    if (p.includes('android') || p.includes('ios') || p.includes('mobile')) return <Smartphone size={16} />;
    if (p.includes('mac') || p.includes('darwin')) return <Laptop size={16} />;
    return <Monitor size={16} />;
}

export interface StaleRowState {
    busy?: 'removing' | 'keeping';
    error?: string;
}

/** The rows alone — rendered by the dialog, and on their own in tests. */
export const StaleDeviceRows: React.FC<{
    devices: OwnDevice[];
    state?: Record<string, StaleRowState>;
    onRemove: (d: OwnDevice) => void;
    onKeep: (d: OwnDevice) => void;
}> = ({ devices, state = {}, onRemove, onKeep }) => (
    <div className="stale-list" role="list" data-testid="stale-device-rows">
        {devices.map(d => {
            const s = state[d.device_id] ?? {};
            const last = formatLastActive(d.last_active_on);
            const badge = staleBadgeLabel(staleTierOf(d));
            const name = d.device_name || 'Unnamed device';
            return (
                <div key={d.device_id} className="stale-row" role="listitem" data-testid={`stale-row-${d.device_id}`}>
                    <span className="stale-tile" aria-hidden="true">{platformIcon(d.platform)}</span>
                    <div className="stale-meta">
                        <div className="stale-name">
                            <span className="stale-name-text" title={name}>{name}</span>
                        </div>
                        <div className="stale-sub" title={badge ?? undefined}>
                            {platformLabel(d.platform)}
                            {last ? <> · <span className={staleTierOf(d) === '180d' ? 'stale-when stale-when--old' : 'stale-when'}>last active {last}</span></> : null}
                        </div>
                        {s.error && <div className="stale-err" role="alert">{s.error}</div>}
                    </div>
                    <div className="stale-actions" role="group" aria-label={name}>
                        <ClButton
                            variant="ghost" size="sm" disabled={!!s.busy}
                            onClick={() => onKeep(d)}
                        >
                            {s.busy === 'keeping' ? 'Keeping…' : 'Keep'}
                        </ClButton>
                        <ClButton
                            variant="ghost" size="sm" className="stale-remove" disabled={!!s.busy}
                            onClick={() => onRemove(d)}
                        >
                            {s.busy === 'removing' ? 'Removing…' : 'Remove'}
                        </ClButton>
                    </div>
                </div>
            );
        })}
    </div>
);

export const StaleDevicesDialog: React.FC<{
    devices: OwnDevice[];
    state: Record<string, StaleRowState>;
    onRemove: (d: OwnDevice) => void;
    onKeep: (d: OwnDevice) => void;
    /** Done / Escape / backdrop — keeps every device still listed. */
    onDone: () => void;
    busy?: boolean;
}> = ({ devices, state, onRemove, onKeep, onDone, busy }) => {
    const copy = staleDialogCopy(devices);
    return (
        <ClModal open onClose={onDone} width={540} label={copy.title} cardClassName="dlg-card">
            <DialogHeader icon={<MonitorSmartphone size={18} />} title={copy.title} subtitle={copy.subtitle} />
            <DialogBody>
                <DialogText>
                    Each of your devices keeps its own keys and still gets a copy of every message. Remove the
                    ones you no longer have — they are signed out right away.
                    {copy.autoRemove ? <> {copy.autoRemove}</> : null}
                </DialogText>
                <StaleDeviceRows devices={devices} state={state} onRemove={onRemove} onKeep={onKeep} />
            </DialogBody>
            <DialogFooter hint={copy.hint}>
                <ClButton size="sm" onClick={onDone} disabled={busy}>Done</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default StaleDevicesDialog;
