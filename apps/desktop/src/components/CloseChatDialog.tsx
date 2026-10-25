import React, { useRef } from 'react';
import { EyeOff, LogOut } from 'lucide-react';
import { useModalExit } from '../hooks/useModalExit';
import { ClButton, ClCheckbox, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText, useInitialFocus } from './dialog/DialogFrame';

interface CloseChatDialogProps {
    state: { id: string; title: string; isGroup?: boolean };
    deleteDataChecked: boolean;
    setDeleteDataChecked: (v: boolean) => void;
    onConfirm: () => void;
    onClose: () => void;
}

/**
 * Confirm dialog for closing a DM or leaving a group. Extracted from Dashboard
 * so it can use the standard modal entrance/exit animations and click-outside
 * dismissal via `useModalExit`.
 */
export const CloseChatDialog: React.FC<CloseChatDialogProps> = ({
    state,
    deleteDataChecked,
    setDeleteDataChecked,
    onConfirm,
    onClose,
}) => {
    // 260ms matches ClModal's own internal exit-animation timer (see
    // ClModal.tsx's setTimeout before unmount) — useModalExit's 150ms default
    // would fire first and unmount this component (and ClModal with it)
    // mid-animation, same reasoning as SoloKickDialog.tsx's identical call.
    const { closing, handleClose } = useModalExit(onClose, 260);
    const cancelSlot = useRef<HTMLSpanElement>(null);
    // The checkbox comes first in DOM order, so ClModal would focus it; this
    // dialog can delete history, so initial focus belongs on the safe button.
    useInitialFocus(cancelSlot, !closing);

    const confirmDisabled = !!(state.isGroup && !deleteDataChecked);
    const confirmVariant = (deleteDataChecked || state.isGroup) ? 'danger' : 'primary';
    const title = state.isGroup ? 'Leave group?' : 'Close chat?';

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={420}
            cardClassName="dlg-card dlg-card--confirm"
            label={title}
        >
            <DialogHeader
                tone={confirmVariant === 'danger' ? 'danger' : 'default'}
                icon={state.isGroup ? <LogOut size={18} strokeWidth={2.2} /> : <EyeOff size={18} strokeWidth={2.2} />}
                title={title}
            />
            <DialogBody>
                <DialogText>
                    {state.isGroup ? (
                        <>Leaving <strong>{state.title}</strong> will permanently delete your local chat history. You won't be able to rejoin unless added again.</>
                    ) : (
                        <>Close your chat with <strong>{state.title}</strong>? It stays hidden until a new message is exchanged.</>
                    )}
                </DialogText>

                {/* For groups: require the checkbox before enabling Leave. For DMs: optional delete history. */}
                <div style={{ marginTop: 14 }}>
                    <ClCheckbox
                        checked={deleteDataChecked}
                        onChange={setDeleteDataChecked}
                        label={state.isGroup
                            ? 'I understand my chat history will be deleted'
                            : 'Also delete all local chat history forever'}
                    />
                </div>
            </DialogBody>
            <DialogFooter hint={confirmDisabled ? <span>Tick the box to continue</span> : undefined}>
                <span ref={cancelSlot} className="dlg-focus-slot">
                    <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>
                        Cancel
                    </ClButton>
                </span>
                <ClButton
                    type="button"
                    variant={confirmVariant}
                    size="sm"
                    disabled={confirmDisabled}
                    onClick={() => {
                        onConfirm();
                        handleClose();
                    }}
                >
                    {state.isGroup ? 'Leave group' : (deleteDataChecked ? 'Delete & close' : 'Close chat')}
                </ClButton>
            </DialogFooter>
        </ClModal>
    );
};
