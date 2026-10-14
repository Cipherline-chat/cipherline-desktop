import React, { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { useModalExit } from '../hooks/useModalExit';
import { ClButton, ClModal } from './cl';
import { AddGroupMembersPicker, type AddGroupMembersResult } from './AddGroupMembersPicker';

/** How long the success message stays up before the modal closes itself. */
export const ADD_MEMBERS_CLOSE_DELAY_MS = 900;

interface AddGroupMembersModalProps {
    conversationId: string;
    conversationTitle: string;
    /** user_ids already in the group (the panel's current member list). */
    memberIds: readonly string[];
    onClose: () => void;
    /** Called once per Add press so the host can refresh its member list right away. */
    onAdded: (result: AddGroupMembersResult) => void;
}

/**
 * "Add people to <group>" — opened by the "+" beside the right-hand panel's
 * Members heading. A thin ClModal around AddGroupMembersPicker (the same picker
 * GroupSettingsModal embeds). After a fully-successful add it shows the
 * picker's success message for a beat, then closes; if any invite failed it
 * stays open so the error can be read and the rest retried.
 */
export const AddGroupMembersModal: React.FC<AddGroupMembersModalProps> = ({
    conversationId, conversationTitle, memberIds, onClose, onAdded,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const memberIdSet = useMemo(() => new Set(memberIds), [memberIds]);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handleCloseRef = useRef(handleClose);
    useEffect(() => { handleCloseRef.current = handleClose; });

    useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

    const handleResult = (result: AddGroupMembersResult) => {
        onAdded(result);
        if (result.failedCount === 0 && result.added.length > 0) {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            closeTimer.current = setTimeout(() => handleCloseRef.current(), ADD_MEMBERS_CLOSE_DELAY_MS);
        }
    };

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={440}
            label={`Add people to ${conversationTitle}`}
            cardStyle={{ padding: '28px 28px 24px', maxHeight: '82vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}
            cardClassName="custom-scrollbar"
        >
            <div className="flex items-start justify-between shrink-0">
                <div className="min-w-0">
                    <h2 className="text-xl font-bold text-cl-text mt-0 mb-1 truncate">
                        Add people to {conversationTitle}
                    </h2>
                    <p className="text-[13px] text-cl-faint m-0">Pick friends to bring into this group.</p>
                </div>
                <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={16} />
                </ClButton>
            </div>

            <AddGroupMembersPicker
                conversationId={conversationId}
                memberIds={memberIdSet}
                showLabel={false}
                autoFocusSearch
                onResult={handleResult}
            />

            <ClButton variant="ghost" fullWidth onClick={handleClose}>Done</ClButton>
        </ClModal>
    );
};
