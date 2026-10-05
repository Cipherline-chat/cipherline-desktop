import React from 'react';
import { useModalExit } from '../hooks/useModalExit';
import { ClButton, ClCheckbox, ClModal } from './cl';

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

    const confirmDisabled = !!(state.isGroup && !deleteDataChecked);
    const confirmVariant = (deleteDataChecked || state.isGroup) ? 'danger' : 'primary';

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={400}
            cardStyle={{ padding: 32 }}
            label={state.isGroup ? 'Leave Group?' : 'Close Chat?'}
        >
            <h2 className="text-xl font-bold text-cl-text mb-2" style={{ marginTop: 0 }}>
                {state.isGroup ? 'Leave Group?' : 'Close Chat?'}
            </h2>
            <p className="text-cl-faint" style={{ fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '24px' }}>
                {state.isGroup ? (
                    <>Leaving <strong className="text-cl-text">{state.title}</strong> will permanently delete your local chat history. You won't be able to rejoin unless added again.</>
                ) : (
                    <>Are you sure you want to close your chat with <strong className="text-cl-text">{state.title}</strong>? It will remain hidden until a new message is exchanged.</>
                )}
            </p>

            {/* For groups: require checkbox before enabling Leave. For DMs: show optional delete history */}
            <div className="mb-6">
                <ClCheckbox
                    checked={deleteDataChecked}
                    onChange={setDeleteDataChecked}
                    label={state.isGroup
                        ? 'I understand my chat history will be deleted'
                        : 'Delete all local chat history forever'}
                />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
                <ClButton
                    type="button"
                    variant="ghost"
                    fullWidth
                    onClick={handleClose}
                >
                    Cancel
                </ClButton>
                <ClButton
                    type="button"
                    variant={confirmVariant}
                    fullWidth
                    disabled={confirmDisabled}
                    onClick={() => {
                        onConfirm();
                        handleClose();
                    }}
                >
                    {state.isGroup ? 'Leave Group' : (deleteDataChecked ? 'Delete & Close' : 'Close DM')}
                </ClButton>
            </div>
        </ClModal>
    );
};
