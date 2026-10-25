import React, { useEffect, useMemo, useRef } from 'react';
import { UserPlus, Users } from 'lucide-react';
import { useModalExit } from '../hooks/useModalExit';
import { ClButton, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError, DialogOk } from './dialog/DialogFrame';
import { MemberPicker } from './peoplePicker/MemberPicker';
import { useGroupMemberInvites, type AddGroupMembersResult } from './AddGroupMembersPicker';
import { GROUP_MAX_MEMBERS } from '../utils/groupAddMembers';

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
 * Members heading. A dialog-frame card around the shared MemberPicker; the
 * invite logic is `useGroupMemberInvites` (the same hook behind the inline
 * AddGroupMembersPicker that GroupSettingsModal embeds). After a
 * fully-successful add it shows the success message for a beat, then closes;
 * if any invite failed it stays open so the error can be read and the rest
 * retried.
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

    const {
        token, friends, loading, friendsFailed, reloadFriends, remaining, atCap,
        selectedToAdd, setSelection, isAddingMembers, error, success, handleAddSelectedMembers,
    } = useGroupMemberInvites({ conversationId, memberIds: memberIdSet, onResult: handleResult });

    const candidates = useMemo(() => friends.filter(f => !memberIdSet.has(f.user_id)), [friends, memberIdSet]);
    const count = selectedToAdd.size;

    let hint: React.ReactNode;
    if (remaining === 0) hint = <span><span className="dlg-hint-strong">Group is full</span> ({GROUP_MAX_MEMBERS} members)</span>;
    else if (atCap && count > 0) hint = <span><span className="dlg-hint-strong">Group limit reached</span> ({GROUP_MAX_MEMBERS} max)</span>;
    else if (count > 0) hint = <><Users size={14} /><span><span className="dlg-hint-strong">{count}</span> selected</span></>;
    else hint = <span data-testid="group-size-note">{memberIdSet.size} / {GROUP_MAX_MEMBERS} members</span>;

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={480}
            label={`Add people to ${conversationTitle}`}
            cardClassName="dlg-card"
        >
            <DialogHeader
                icon={<UserPlus size={19} strokeWidth={2.2} />}
                title={<>Add people to {conversationTitle}</>}
                subtitle="Pick friends to bring into this group."
            />
            <DialogBody>
                <MemberPicker
                    people={candidates}
                    loading={loading}
                    loadFailed={friendsFailed}
                    onRetry={reloadFriends}
                    selection={Array.from(selectedToAdd)}
                    onSelectionChange={setSelection}
                    max={remaining}
                    token={token}
                    ariaLabel="Search friends to add"
                    emptyTitle={friends.length === 0 ? 'No friends yet' : 'Everyone is already in'}
                    emptyBody={friends.length === 0 ? 'Add a friend first, then you can bring them in.' : 'All your friends are already in this group.'}
                    onSubmit={() => { if (!isAddingMembers) void handleAddSelectedMembers(); }}
                    disabled={isAddingMembers}
                    autoFocus
                />
            </DialogBody>
            {error && <DialogError>{error}</DialogError>}
            {success && <DialogOk>{success}</DialogOk>}
            <DialogFooter hint={hint}>
                <ClButton variant="ghost" size="sm" onClick={handleClose}>{success ? 'Done' : 'Cancel'}</ClButton>
                <ClButton
                    size="sm"
                    onClick={() => { void handleAddSelectedMembers(); }}
                    loading={isAddingMembers}
                    disabled={isAddingMembers || count === 0 || count > remaining}
                    tooltip={count === 0 ? 'Pick at least one friend' : undefined}
                >
                    {count > 0 ? `Add ${count} ${count === 1 ? 'member' : 'members'}` : 'Add members'}
                </ClButton>
            </DialogFooter>
        </ClModal>
    );
};
