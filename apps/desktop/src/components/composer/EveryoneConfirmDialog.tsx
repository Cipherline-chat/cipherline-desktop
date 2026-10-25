/**
 * "Mention everyone?" — asked before an @everyone / @here goes out to a server
 * with more than 100 members (utils/composerFun.ts needsEveryoneConfirm).
 *
 * The house dialog (ClModal + DialogFrame), not a destructive confirm: the
 * action is legitimate, so the confirm button is primary, not danger. Focus
 * still starts on Cancel (ClModal focuses the first focusable child) — the
 * dialog usually appears in answer to Enter, and a second Enter must never be
 * what sends a ping to a thousand people. Escape / backdrop = Cancel.
 *
 * Both choices play the modal's exit before their callback runs, matching
 * primitives/ConfirmDialog. Cancel touches nothing: the draft is still in the
 * composer, exactly as typed.
 */
import React, { useRef, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { ClButton, ClModal } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText } from '../dialog/DialogFrame';
import { everyoneConfirmCopy } from '../../utils/composerFun';

/** Must stay under ClModal's ~260ms unmount timer (see primitives/ConfirmDialog). */
const EXIT_MS = 200;

export interface EveryoneConfirmDialogProps {
    kind: 'everyone' | 'here';
    memberCount: number;
    onConfirm: () => void;
    onCancel: () => void;
}

export const EveryoneConfirmDialog: React.FC<EveryoneConfirmDialogProps> = ({ kind, memberCount, onConfirm, onCancel }) => {
    const [closing, setClosing] = useState(false);
    const pending = useRef<(() => void) | null>(null);
    const copy = everyoneConfirmCopy(kind, memberCount);
    // A ref, not just the state: two clicks inside one frame (a double-click)
    // both see `closing === false` — and a second confirm would send twice.
    const answered = useRef(false);
    const close = (action: () => void) => {
        if (closing || answered.current) return;
        answered.current = true;
        pending.current = action;
        setClosing(true);
        window.setTimeout(() => pending.current?.(), EXIT_MS);
    };
    return (
        <ClModal
            open={!closing}
            onClose={() => close(onCancel)}
            cardClassName="dlg-card dlg-card--confirm"
            label={copy.title}
        >
            <DialogHeader tone="warn" icon={<Megaphone size={18} strokeWidth={2.2} />} title={copy.title} />
            <DialogBody>
                <DialogText>{copy.message}</DialogText>
            </DialogBody>
            <DialogFooter>
                <ClButton variant="ghost" size="sm" onClick={() => close(onCancel)}>Cancel</ClButton>
                <ClButton variant="primary" size="sm" onClick={() => close(onConfirm)}>{copy.confirmLabel}</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default EveryoneConfirmDialog;
