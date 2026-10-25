import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Loader2, Search, UserPlus, Users } from 'lucide-react';
import { API_BASE } from '../constants';
import { apiUrl } from '../utils/apiPath';
import { useAuth } from '../contexts/AuthContext';
import { EncryptedAvatar } from './EncryptedAvatar';
import { ClButton, ClCheckbox, ClSearch } from './cl';
import { GROUP_MAX_MEMBERS, remainingGroupSlots } from '../utils/groupAddMembers';

export interface AddedMember {
    user_id: string;
    username: string;
    avatar_url?: string | null;
}

interface FriendRow {
    user_id: string;
    username: string;
    avatar_url?: string | null;
}

export interface AddGroupMembersResult {
    /** Friends the server accepted. */
    added: AddedMember[];
    /** How many invites were rejected (network, not-a-mutual-friend, group full…). */
    failedCount: number;
}

interface AddGroupMembersPickerProps {
    conversationId: string;
    /** user_ids already in the group — they are never offered. */
    memberIds: ReadonlySet<string>;
    /** Host's member list is still loading: show the spinner, not "everyone is in". */
    membersLoading?: boolean;
    /** Show the "Add Members" label row (a hosting modal may supply its own title). */
    showLabel?: boolean;
    autoFocusSearch?: boolean;
    /** Fires once per Add press, after every invite has settled. */
    onResult?: (result: AddGroupMembersResult) => void;
}

/**
 * State + invite logic shared by the inline picker (GroupSettingsModal) and the
 * "Add people" dialog (AddGroupMembersModal): the friends fetch, the staged
 * selection, the 200-member cap and the one-invite-per-person fan-out.
 */
// eslint-disable-next-line react-refresh/only-export-components -- co-located hook shared with AddGroupMembersModal; splitting the file would only affect dev Fast Refresh
export function useGroupMemberInvites({ conversationId, memberIds, membersLoading = false, onResult }: {
    conversationId: string;
    memberIds: ReadonlySet<string>;
    membersLoading?: boolean;
    onResult?: (result: AddGroupMembersResult) => void;
}) {
    const { token } = useAuth();
    const [friends, setFriends] = useState<FriendRow[]>([]);
    const [friendsLoading, setFriendsLoading] = useState(true);
    const [friendsFailed, setFriendsFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [friendSearch, setFriendSearch] = useState('');
    const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
    const [isAddingMembers, setIsAddingMembers] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` } });
                if (!cancelled) { setFriends(res.data.accepted || []); setFriendsFailed(false); }
            } catch (err) {
                console.error('Failed to fetch friends:', err);
                if (!cancelled) setFriendsFailed(true);
            } finally {
                if (!cancelled) setFriendsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [token, reloadKey]);
    const reloadFriends = () => { setFriendsLoading(true); setFriendsFailed(false); setReloadKey(k => k + 1); };

    const loading = friendsLoading || membersLoading;
    const remaining = remainingGroupSlots(memberIds.size);
    const atCap = selectedToAdd.size >= remaining;

    const filteredFriends = useMemo(() => friends.filter(f =>
        !memberIds.has(f.user_id) &&
        (friendSearch === '' || f.username.toLowerCase().includes(friendSearch.toLowerCase()))
    ), [friends, memberIds, friendSearch]);

    const toggleSelectedToAdd = (friendUserId: string) => {
        setSelectedToAdd(prev => {
            const next = new Set(prev);
            if (next.has(friendUserId)) next.delete(friendUserId);
            else if (next.size < remaining) next.add(friendUserId);
            return next;
        });
        setError(null);
    };

    /** Replace the staged selection (the dialog's picker owns toggling); clears a stale error like a toggle does. */
    const setSelection = (ids: readonly string[]) => {
        setSelectedToAdd(new Set(ids.slice(0, remaining)));
        setError(null);
    };

    const handleAddSelectedMembers = async () => {
        if (selectedToAdd.size === 0 || selectedToAdd.size > remaining) return;
        setError(null);
        setSuccess(null);
        setIsAddingMembers(true);
        const ids = Array.from(selectedToAdd);
        const results = await Promise.allSettled(
            ids.map(id => axios.post(apiUrl`/conversations/${conversationId}/invite`, {
                user_id: id,
            }, { headers: { Authorization: `Bearer ${token}` } })),
        );
        const failed = results.filter(r => r.status === 'rejected').length;
        const added = ids.length - failed;
        if (added > 0) setSuccess(`${added} ${added === 1 ? 'member' : 'members'} added to the group`);
        if (failed > 0) setError(`Failed to add ${failed} ${failed === 1 ? 'member' : 'members'}.`);
        setSelectedToAdd(new Set());
        setIsAddingMembers(false);
        onResult?.({
            added: ids
                .filter((_, i) => results[i].status === 'fulfilled')
                .map(id => {
                    const f = friends.find(x => x.user_id === id);
                    return { user_id: id, username: f?.username ?? '', avatar_url: f?.avatar_url ?? null };
                }),
            failedCount: failed,
        });
    };

    return {
        token, friends, loading, friendsFailed, reloadFriends,
        remaining, atCap, filteredFriends, friendSearch, setFriendSearch,
        selectedToAdd, setSelection, toggleSelectedToAdd, isAddingMembers,
        error, success, handleAddSelectedMembers,
    };
}

/**
 * Friend picker + staged multi-select + "Add N Members" for an existing group.
 * Extracted from GroupSettingsModal so the right-hand panel's "+" can reuse it.
 *
 * Staged multi-select + confirm, styled to match CreateGroupModal's member
 * picker (ClSearch + persistent checkbox list). Invites go out one
 * `POST /conversations/:id/invite` per person (the endpoint takes a single
 * `user_id`), settled together, and the outcome is reported as added/failed
 * counts. Only mutual friends are offered because the server rejects anyone
 * else; the 200-member cap is mirrored for UX (the server stays authoritative).
 */
export const AddGroupMembersPicker: React.FC<AddGroupMembersPickerProps> = ({
    conversationId, memberIds, membersLoading = false, showLabel = true, autoFocusSearch = false, onResult,
}) => {
    const {
        token, friends, loading, remaining, atCap, filteredFriends, friendSearch, setFriendSearch,
        selectedToAdd, toggleSelectedToAdd, isAddingMembers, error, success, handleAddSelectedMembers,
    } = useGroupMemberInvites({ conversationId, memberIds, membersLoading, onResult });

    return (
        <div className="flex flex-col gap-2">
            {showLabel ? (
                <label className="flex items-center justify-between text-[13px] font-semibold text-cl-faint m-0 uppercase tracking-wide">
                    <span>Add Members</span>
                    {selectedToAdd.size > 0 && (
                        <span className="text-cl-lume normal-case font-normal tracking-normal">
                            {selectedToAdd.size} selected
                        </span>
                    )}
                </label>
            ) : null}

            <ClSearch
                icon={<Search size={15} />}
                type="text"
                value={friendSearch}
                onChange={e => setFriendSearch(e.target.value)}
                placeholder="Search friends"
                autoFocus={autoFocusSearch}
            />

            <div
                className="overflow-y-auto bg-cl-deep border border-white/5 rounded-xl p-2 custom-scrollbar"
                style={{ minHeight: '120px', maxHeight: '200px' }}
            >
                {loading ? (
                    <div className="flex items-center justify-center h-full py-6 text-cl-faint">
                        <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                ) : friends.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 text-center">
                        <Users className="w-7 h-7 mb-2 text-cl-faint opacity-50" />
                        <span className="text-sm text-cl-faint">Your circle is empty — add friends first.</span>
                    </div>
                ) : filteredFriends.length === 0 ? (
                    <div className="text-center text-cl-faint py-6 text-sm">
                        {friendSearch ? `No friends match "${friendSearch}"` : 'All your friends are already in this group'}
                    </div>
                ) : (
                    filteredFriends.map(f => {
                        const isSelected = selectedToAdd.has(f.user_id);
                        return (
                            <ClButton
                                type="button"
                                key={f.user_id}
                                variant="ghost"
                                row
                                fullWidth
                                disabled={!isSelected && atCap}
                                onClick={() => toggleSelectedToAdd(f.user_id)}
                                style={{
                                    marginBottom: 2,
                                    background: isSelected ? 'rgba(37,224,200,0.08)' : 'transparent',
                                }}
                            >
                                <div
                                    className="w-9 h-9 rounded-full overflow-hidden shrink-0"
                                    style={{
                                        boxShadow: isSelected ? '0 0 0 2px var(--cl-lume)' : '0 0 0 1px var(--cl-border)',
                                        transition: 'box-shadow .15s ease',
                                    }}
                                >
                                    <EncryptedAvatar
                                        attachmentId={f.avatar_url ?? null}
                                        userId={f.user_id}
                                        token={token}
                                        className="w-full h-full"
                                        fallbackSize={17}
                                        disableClickProfile
                                    />
                                </div>
                                <span className="text-[14px] font-semibold text-cl-text truncate flex-1 text-left">
                                    {f.username}
                                </span>
                                <span className="pointer-events-none shrink-0">
                                    <ClCheckbox checked={isSelected} onChange={() => {}} />
                                </span>
                            </ClButton>
                        );
                    })
                )}
            </div>

            {!loading && (
                <div className="flex items-center justify-between gap-3 text-[12px]">
                    <span
                        data-testid="group-size-note"
                        className={remaining === 0 || (atCap && selectedToAdd.size > 0) ? 'text-cl-flash' : 'text-cl-faint'}
                    >
                        {remaining === 0
                            ? `This group is full (${GROUP_MAX_MEMBERS} members).`
                            : atCap && selectedToAdd.size > 0
                                ? `Group limit reached — ${GROUP_MAX_MEMBERS} members max.`
                                : `${memberIds.size} / ${GROUP_MAX_MEMBERS} members`}
                    </span>
                    {/* With no label row above the search, the running count lives here
                        (same line as the size note, so selecting never shifts the layout). */}
                    {!showLabel && selectedToAdd.size > 0 && (
                        <span className="text-cl-lume shrink-0">{selectedToAdd.size} selected</span>
                    )}
                </div>
            )}

            {error && (
                <div role="alert" className="text-cl-flash bg-cl-flash/10 px-4 py-3 rounded-lg text-sm font-medium border border-cl-flash/20">
                    {error}
                </div>
            )}
            {success && (
                <div role="status" className="text-cl-ok bg-cl-ok/10 px-4 py-3 rounded-lg text-sm font-medium border border-cl-ok/20">
                    {success}
                </div>
            )}

            {selectedToAdd.size > 0 && (
                <ClButton
                    fullWidth
                    onClick={handleAddSelectedMembers}
                    loading={isAddingMembers}
                    disabled={isAddingMembers || selectedToAdd.size > remaining}
                >
                    <UserPlus size={16} />
                    Add {selectedToAdd.size} {selectedToAdd.size === 1 ? 'Member' : 'Members'}
                </ClButton>
            )}
        </div>
    );
};
