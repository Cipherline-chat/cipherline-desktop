import React, { useEffect, useRef } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter } from './dialog/DialogFrame';
import { DialogCopy } from './dialog/DialogExtras';
import type { BackupShrinkWarning } from '../services/driveBackup';

/**
 * Asked before a backup replaces one that holds far more conversations
 * (services/backupShrinkGuard.ts). The safe choice is the default everywhere:
 * keeping the existing backup is the primary button AND the one focused on
 * open (so Enter keeps it), and closing the dialog any other way (backdrop,
 * Esc) keeps it too — replacing needs a deliberate click on "Replace anyway".
 */
export const ShrinkBackupModal: React.FC<{
    /** null = closed. */
    warning: BackupShrinkWarning | null;
    onDecide: (replace: boolean) => void;
}> = ({ warning, onDecide }) => {
    const keepWrap = useRef<HTMLSpanElement>(null);
    const open = !!warning;
    useEffect(() => {
        if (!open) return;
        // ClModal focuses its FIRST focusable child on the frame after opening,
        // which here is "Replace anyway". Move focus to the safe button after it.
        let inner = 0;
        const outer = requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => { keepWrap.current?.querySelector('button')?.focus(); });
        });
        return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }, [open]);
    return (
        <ClModal open={open} onClose={() => onDecide(false)} width={520} label={warning?.title ?? 'Replace your backup?'} cardClassName="dlg-card">
            <DialogHeader
                icon={<AlertTriangle size={19} strokeWidth={2.2} />}
                title={warning?.title}
                subtitle="Check before you back up."
            />
            <DialogBody>
                <DialogCopy>{warning?.message}</DialogCopy>
                <DialogCopy>
                    If your history should be on this device, keep the existing backup and restart Cipherline.
                </DialogCopy>
            </DialogBody>
            <DialogFooter hint={<><ShieldCheck size={13} aria-hidden /> Keeping is safe</>}>
                <ClButton variant="ghost" size="sm" onClick={() => onDecide(true)}>Replace anyway</ClButton>
                <span ref={keepWrap} style={{ display: 'contents' }}>
                    <ClButton size="sm" onClick={() => onDecide(false)}>Keep existing backup</ClButton>
                </span>
            </DialogFooter>
        </ClModal>
    );
};

export default ShrinkBackupModal;
