/**
 * ConfirmDialog — styled confirmation modal for destructive actions.
 *
 * Drop-in replacement for `window.confirm()`. Same house pattern as ClConfirm
 * (components/dialog/DialogFrame): danger icon tile, title, body text, footer
 * with Cancel + the destructive button. Differs from ClConfirm only in API
 * shape — it is driven by a `ConfirmOptions` object and ALWAYS destructive,
 * and it plays its exit animation before invoking EITHER callback.
 *
 * Usage:
 *   const [pending, setPending] = useState<ConfirmOptions | null>(null);
 *
 *   // Trigger from a button / context-menu item:
 *   setPending({
 *     title: 'Delete "general"?',
 *     message: 'This channel will be permanently removed.',
 *     confirmLabel: 'Delete',
 *     onConfirm: () => deleteChannel(id),
 *   });
 *
 *   // Render once in the component tree:
 *   {pending && (
 *     <ConfirmDialog
 *       {...pending}
 *       onCancel={() => setPending(null)}
 *       onConfirm={() => { pending.onConfirm(); setPending(null); }}
 *     />
 *   )}
 */

import React, { useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ClButton, ClModal } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText } from '../dialog/DialogFrame';

/** Exit-animation window before the chosen callback runs. ClModal's own exit
 *  transition is ~180ms; the parent unmounts this component right after the
 *  callback, so this must not exceed ClModal's 260ms unmount timer. */
const EXIT_MS = 200;

export interface ConfirmOptions {
    title: string;
    /**
     * Body text under the title. Omit it for a bare yes/no: the dialog is then
     * just the icon + title over the buttons.
     */
    message?: string;
    /** Button label — defaults to "Delete" */
    confirmLabel?: string;
    /**
     * Quiet secondary line in the footer, left of the buttons — for teaching a
     * shortcut that skips this dialog next time ("Hold Shift…"). Deliberately
     * dimmer than `message`: it is a thing to notice on the second or third
     * visit, not another sentence to read before deciding. Omit it and nothing
     * renders.
     */
    hint?: React.ReactNode;
    /** Callback invoked when the user confirms. */
    onConfirm: () => void;
}

interface Props extends ConfirmOptions {
    onCancel: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({
    title,
    message,
    confirmLabel = 'Delete',
    hint,
    onConfirm,
    onCancel,
}) => {
    const [closing, setClosing] = useState(false);
    const pendingActionRef = useRef<(() => void) | null>(null);

    // Cancel, Confirm, Escape and backdrop-click all play the exit animation
    // (a hard cut reads as abrupt next to every other modal in the app) and only
    // THEN invoke whichever callback the user picked.
    const startClose = (action: () => void) => {
        if (closing) return;
        pendingActionRef.current = action;
        setClosing(true);
        window.setTimeout(() => { pendingActionRef.current?.(); }, EXIT_MS);
    };

    // Focus: ClModal moves focus to its first focusable element on open — the
    // Cancel button here — so Enter can never confirm a destructive action by
    // accident (P2-REND-4). Escape = Cancel through ClModal's shared escape
    // layer, so on top of an editor or a menu this dialog is the only thing the
    // press closes.
    return (
        <ClModal
            open={!closing}
            onClose={() => startClose(onCancel)}
            cardClassName="dlg-card dlg-card--confirm"
            label={title}
        >
            <DialogHeader tone="danger" icon={<AlertTriangle size={18} strokeWidth={2.2} />} title={title} />
            {message && (
                <DialogBody>
                    <DialogText>{message}</DialogText>
                </DialogBody>
            )}
            <DialogFooter hint={hint}>
                <ClButton variant="ghost" size="sm" onClick={() => startClose(onCancel)}>Cancel</ClButton>
                <ClButton variant="danger" size="sm" onClick={() => startClose(onConfirm)}>{confirmLabel}</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default ConfirmDialog;
