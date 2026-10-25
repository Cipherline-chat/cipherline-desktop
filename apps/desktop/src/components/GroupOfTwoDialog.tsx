import React, { useEffect, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import { ClButton, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText, DialogError, useInitialFocus } from './dialog/DialogFrame';
import { useModalExit } from '../hooks/useModalExit';
import { Keys } from './mascot/Keys';

/**
 * "That's… a DM with extra steps." — the friendly interception shown when
 * someone creates a group chat that is just them plus one other person.
 * Egg logic and copy: utils/groupOfTwo.ts. It NEVER blocks: "Make the group
 * anyway" is always there, Escape / the backdrop simply hand them back to the
 * group form, and nothing is created until they pick one.
 *
 * Primary = Open DM (the safe, sensible outcome gets Enter); secondary = carry
 * on exactly as before. Focus lands on the primary a beat after open, and
 * ClModal restores it to the opener (the group form's submit) on close.
 */
interface GroupOfTwoDialogProps {
    name: string;
    title: string;
    body: string;
    /** The DM request is in flight (both buttons wait; Escape still backs out). */
    busy?: boolean;
    /** The DM couldn't be opened — shown inline; "anyway" stays available. */
    error?: string | null;
    onOpenDm: () => void;
    onProceed: () => void;
    /** Escape / backdrop: back to the group form, nothing created. */
    onDismiss: () => void;
}

export const GroupOfTwoDialog: React.FC<GroupOfTwoDialogProps> = ({
    name, title, body, busy = false, error, onOpenDm, onProceed, onDismiss,
}) => {
    const { closing, handleClose } = useModalExit(onDismiss, 220);
    const primarySlot = useRef<HTMLDivElement>(null);
    useInitialFocus(primarySlot, !closing);
    // ClModal's own first-focus runs on a frame that can land AFTER the 80 ms
    // above on a cold first paint, leaving focus on "anyway"; a second, later
    // pass keeps Enter meaning the sensible thing.
    useEffect(() => {
        if (closing) return;
        const t = window.setTimeout(() => {
            const slot = primarySlot.current;
            if (slot && !slot.contains(document.activeElement)) {
                slot.querySelector<HTMLElement>('button:not([disabled])')?.focus();
            }
        }, 320);
        return () => window.clearTimeout(t);
    }, [closing]);

    return (
        <ClModal
            open={!closing}
            onClose={() => { if (!busy) handleClose(); }}
            width={460}
            label={title}
            cardClassName="dlg-card dlg-card--confirm"
            // Above the group form it was raised from (the cropper's trick).
            overlayStyle={{ zIndex: 10001 }}
        >
            <DialogHeader icon={<MessageCircle size={18} strokeWidth={2.2} />} title={title} />
            <DialogBody>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ flexShrink: 0 }}>
                        <Keys size={54} interactive={false} waveOnMount={false} ariaLabel="Keys, unimpressed" />
                    </span>
                    <DialogText>{body}</DialogText>
                </div>
            </DialogBody>
            {error && <DialogError>{error}</DialogError>}
            <DialogFooter>
                <ClButton variant="ghost" size="sm" disabled={busy} onClick={onProceed}>
                    Make the group anyway
                </ClButton>
                <div className="dlg-focus-slot" ref={primarySlot}>
                    <ClButton size="sm" loading={busy} disabled={busy} onClick={onOpenDm}>
                        Open DM with {name}
                    </ClButton>
                </div>
            </DialogFooter>
        </ClModal>
    );
};

export default GroupOfTwoDialog;
