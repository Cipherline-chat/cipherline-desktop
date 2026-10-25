import React from 'react';
import { Clock, ShieldCheck } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter } from './dialog/DialogFrame';
import { DialogCopy } from './dialog/DialogExtras';
import type { BackupStaleWarning } from '../services/driveBackup';

/**
 * Advisory: the file is older than the last backup this device wrote here.
 * Info-styled, primary action proceeds. Closing it any other way (backdrop,
 * Esc) is a decline, which leaves the device untouched — never a silent
 * restore. Extracted from BackupSection so it can be rendered on its own.
 */
export const StaleBackupModal: React.FC<{
    /** null = closed. */
    warning: BackupStaleWarning | null;
    onDecide: (restoreAnyway: boolean) => void;
}> = ({ warning, onDecide }) => (
    <ClModal open={!!warning} onClose={() => onDecide(false)} width={440} label={warning?.title ?? 'Older backup'} cardClassName="dlg-card">
        <DialogHeader
            icon={<Clock size={19} strokeWidth={2.2} />}
            title={warning?.title}
            subtitle="Check before you restore."
        />
        <DialogBody>
            <DialogCopy>{warning?.message}</DialogCopy>
        </DialogBody>
        <DialogFooter hint={<><ShieldCheck size={13} aria-hidden /> Cancel changes nothing</>}>
            <ClButton variant="ghost" size="sm" onClick={() => onDecide(false)}>Cancel</ClButton>
            <ClButton size="sm" onClick={() => onDecide(true)}>Restore anyway</ClButton>
        </DialogFooter>
    </ClModal>
);

export default StaleBackupModal;
