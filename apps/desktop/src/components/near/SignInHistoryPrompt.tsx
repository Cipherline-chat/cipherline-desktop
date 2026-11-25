import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { ArrowDownToLine, FolderOpen, Wifi, WifiOff } from 'lucide-react';
import { ClModal } from '../cl/ClModal';
import { ClButton } from '../ClButton';
import { API_BASE } from '../../constants';
import secureLocalStore from '../../utils/secureLocalStore';
import * as messageStore from '../../utils/messageStore';
import { nt } from '../../utils/nearStrings';
import { probeNearTransfer } from '../../utils/nearFlag';
import { ownTransferCapable } from '../../utils/nearOwnTransfer';
import { openOwnTransferPicker } from '../../utils/ownTransferPicker';
import type { NearCapabilities } from '../../types/near';
import { NearText } from './NearParts';
import { Choice, XferHead } from './TransferParts';
import '../../styles/near.css';

export interface SignInHistoryPromptProps {
    userId: string | null;
    token: string | null;
    deviceId: string | null;
    /** Opens Settings, Storage (restore a backup). Absent: the button is not offered. */
    onOpenStorage?: () => void;
    /** Test seams. */
    probe?: () => Promise<NearCapabilities | null>;
    hasHistory?: (userId: string) => Promise<boolean>;
    listOtherDevices?: (token: string, deviceId: string | null) => Promise<number>;
}

const defaultProbe = (): Promise<NearCapabilities | null> => probeNearTransfer();

async function defaultHasHistory(userId: string): Promise<boolean> {
    return (await messageStore.hasAny('dm', userId)) || (await messageStore.hasAny('channel', userId));
}

async function defaultOtherDevices(token: string, deviceId: string | null): Promise<number> {
    const { data } = await axios.get<{ device_id: string }[]>(`${API_BASE}/devices`, { headers: { Authorization: `Bearer ${token}` } });
    return Array.isArray(data) ? data.filter(d => d && d.device_id !== deviceId).length : 0;
}

/**
 * The sign-in history step: a freshly signed-in device with no messages, on an account that has other devices, is offered to
 * bring its history over. Since 2026-11-24 that is the local-network own-device transfer (contract section 7), the ONLY way
 * history moves between devices: "Transfer history" opens the app's device picker, the chosen device confirms (account
 * password on a computer, biometrics on a phone), and the bytes go straight between the two over the local network, with
 * progress, pause / resume and "keep what arrived" in the transfer banner (`NearTransferHost`). The server-relayed sync
 * (`POST /v1/devices/history-request`, `device:history_request` / `device:approved` / `device:history_declined`,
 * `HistorySyncBanner`, `HistoryRequestModal`) is gone from this app.
 *
 * A build that cannot run the transfer (no helper, or it does not start) still shows the step, and says so plainly, with a
 * restore-a-backup way out, rather than silently offering nothing.
 *
 * When it opens (unchanged from the old prompt): the account's records are READABLE and empty (a store that is not readable yet
 * keeps it closed: offering to pull history over a device that already has it is the data-loss class the device-sync audit
 * fixed), the person has not chosen "Start fresh" before, and the account has at least one other device.
 */
export const SignInHistoryPrompt: React.FC<SignInHistoryPromptProps> = ({
    userId, token, deviceId, onOpenStorage,
    probe = defaultProbe, hasHistory = defaultHasHistory, listOtherDevices = defaultOtherDevices,
}) => {
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState(false);
    const [others, setOthers] = useState(0);

    useEffect(() => {
        if (!userId || !token) return;
        let cancelled = false;
        (async () => {
            let has: boolean;
            try { has = await hasHistory(userId); } catch (err) {
                console.warn('[SignInHistoryPrompt] local history not readable, not prompting', err);
                return;
            }
            // Set once "Start fresh" is chosen. The SAME key the old server-relayed prompt used, so nobody who already said no to it
            // is asked again (classified in services/backupRegistry.ts).
            if (cancelled || has || secureLocalStore.getItem(`cipherline_sync_dismissed_${userId}`)) return;
            let others = 0;
            try { others = await listOtherDevices(token, deviceId); } catch (err) {
                console.warn('[SignInHistoryPrompt] device list failed, not prompting', err);
                return;
            }
            if (cancelled || others === 0) return;
            const caps = await probe().catch(() => null);
            if (cancelled) return;
            setAvailable(caps !== null && ownTransferCapable());
            setOthers(others);
            setOpen(true);
        })();
        return () => { cancelled = true; };
    }, [userId, token, deviceId, probe, hasHistory, listOtherDevices]);

    const startFresh = useCallback(() => {
        if (userId) secureLocalStore.setItem(`cipherline_sync_dismissed_${userId}`, '1');
        setOpen(false);
    }, [userId]);

    const transfer = useCallback(() => {
        setOpen(false);
        // Closing the picker without asking a device puts this step back; asking one hands over to the wait screen.
        openOwnTransferPicker({ onCancel: () => setOpen(true) });
    }, []);

    const restore = useCallback(() => { setOpen(false); onOpenStorage?.(); }, [onOpenStorage]);

    if (!open) return null;
    const title = available ? nt('s.t') : nt('f.unavail.title');
    return (
        <ClModal open onClose={startFresh} width={500} label={title}>
            <div className="nr-modal" data-testid={available ? 'signin-history' : 'signin-history-unavailable'}>
                <XferHead
                    icon={available ? <ArrowDownToLine size={24} /> : <WifiOff size={24} />}
                    tone={available ? 'lume' : 'warn'}
                    title={title}
                    body={available ? nt('s.s') : nt('f.unavail.body')}
                />
                {available && (
                    <div className="nr-hint" data-testid="signin-history-net"><Wifi size={16} aria-hidden /><p><NearText k="s.net" /></p></div>
                )}
                <div className="nr-choices">
                    {available && (
                        <Choice primary autoFocus testId="signin-history-transfer" icon={<ArrowDownToLine size={20} />} title={nt('s.go')}
                            value={others === 1 ? nt('s.go.v1') : nt('s.go.v', { n: others })} onClick={transfer} />
                    )}
                    {onOpenStorage && (
                        <Choice autoFocus={!available} testId="signin-history-restore" icon={<FolderOpen size={20} />} title={nt('s.restore')} value={nt('s.restore.v')} onClick={restore} />
                    )}
                </div>
                <div className="foot">
                    <ClButton variant="ghost" onClick={startFresh}>{nt('s.fresh')}</ClButton>
                </div>
            </div>
        </ClModal>
    );
};
