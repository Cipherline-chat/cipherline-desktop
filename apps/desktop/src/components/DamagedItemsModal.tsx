import React, { useEffect, useRef } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter } from './dialog/DialogFrame';
import { DialogCopy } from './dialog/DialogExtras';

/**
 * Asked before damaged records are removed from this device
 * (secureLocalStore.discardUnreadableRecords). Two reasons to ask:
 *   - 'remove':  Settings → Backup → "Remove damaged items".
 *   - 'restore': a restore is about to write over records this device cannot
 *                read. Written over a held record it would stay in memory and be
 *                gone after the next restart, so the damaged ones go first.
 *
 * The safe choice is the default everywhere, exactly like ShrinkBackupModal:
 * "Keep them" is primary and focused (Enter keeps), and closing any other way
 * keeps them. Removing needs a deliberate click.
 */
export interface DamagedItemsAsk {
    mode: 'remove' | 'restore';
    /** How many records could not be read. */
    count: number;
}

export const DamagedItemsModal: React.FC<{
    /** null = closed. */
    ask: DamagedItemsAsk | null;
    onDecide: (remove: boolean) => void;
}> = ({ ask, onDecide }) => {
    const keepWrap = useRef<HTMLSpanElement>(null);
    const open = !!ask;
    useEffect(() => {
        if (!open) return;
        let inner = 0;
        const outer = requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => { keepWrap.current?.querySelector('button')?.focus(); });
        });
        return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }, [open]);
    const n = ask?.count ?? 0;
    const things = `${n} item${n === 1 ? '' : 's'}`;
    const restore = ask?.mode === 'restore';
    const title = restore ? 'Replace damaged items with your backup?' : 'Remove damaged items?';
    return (
        <ClModal open={open} onClose={() => onDecide(false)} width={520} label={title} cardClassName="dlg-card">
            <DialogHeader
                icon={<AlertTriangle size={19} strokeWidth={2.2} />}
                title={title}
                subtitle={restore ? 'Some data on this device can’t be read.' : 'Cipherline can’t read part of what’s stored here.'}
            />
            <DialogBody>
                <DialogCopy>
                    {restore
                        ? `${things} on this device couldn’t be read — usually after a crash or a power loss. Restoring needs to replace ${n === 1 ? 'it' : 'them'}, so ${n === 1 ? 'it' : 'they'} will be removed first. Whatever is in ${n === 1 ? 'it' : 'them'} and isn’t in your backup is gone.`
                        : `${things} couldn’t be read — usually after a crash or a power loss — so ${n === 1 ? 'it is' : 'they are'} kept as ${n === 1 ? 'it is' : 'they are'} and new messages for ${n === 1 ? 'it' : 'them'} wait on the server. Removing ${n === 1 ? 'it' : 'them'} lets Cipherline save there again.`}
                </DialogCopy>
                <DialogCopy>
                    {restore
                        ? 'Nothing else is touched. Keep them to cancel the restore.'
                        : 'Your last backup still has its copy of anything it held, and Restore can bring it back. Nothing else is removed.'}
                </DialogCopy>
            </DialogBody>
            <DialogFooter hint={<><ShieldCheck size={13} aria-hidden /> Keeping is safe</>}>
                <ClButton variant="ghost" size="sm" onClick={() => onDecide(true)}>{restore ? 'Remove and restore' : 'Remove damaged items'}</ClButton>
                <span ref={keepWrap} style={{ display: 'contents' }}>
                    <ClButton size="sm" onClick={() => onDecide(false)}>Keep them</ClButton>
                </span>
            </DialogFooter>
        </ClModal>
    );
};

export default DamagedItemsModal;
