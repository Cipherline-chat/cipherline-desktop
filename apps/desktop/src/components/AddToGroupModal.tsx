import React, { useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import { useAuth } from '../contexts/AuthContext';
import { Search, Plus, CheckCircle, Users } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { ClModal, ClButton, ClSearch } from './cl';
import { DialogHeader, DialogBody, DialogFooter } from './dialog/DialogFrame';

interface AddToGroupModalProps {
    targetUser: { user_id: string; username: string; avatar_url?: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    myGroups: any[];
    onClose: () => void;
    onGroupJoined: (groupConvId: string) => void;
    onCreateNew: () => void;
}

export const AddToGroupModal: React.FC<AddToGroupModalProps> = ({
    targetUser,
    myGroups,
    onClose,
    onGroupJoined,
    onCreateNew,
}) => {
    const { token } = useAuth();
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [search, setSearch] = useState('');
    const [addingId, setAddingId] = useState<string | null>(null);
    const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const handleAdd = async (group: any) => {
        if (addingId || addedIds.has(group.conversation_id)) return;
        setAddingId(group.conversation_id);
        setErrors(prev => { const n = { ...prev }; delete n[group.conversation_id]; return n; });
        try {
            await axios.post(
                apiUrl`/conversations/${group.conversation_id}/invite`,
                { user_id: targetUser.user_id },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setAddedIds(prev => new Set(prev).add(group.conversation_id));
            setTimeout(() => onGroupJoined(group.conversation_id), 800);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            const msg = err?.response?.data?.message || 'Failed to add';
            setErrors(prev => ({ ...prev, [group.conversation_id]: msg }));
        } finally {
            setAddingId(null);
        }
    };

    const filtered = myGroups.filter(g =>
        (g.title || '').toLowerCase().includes(search.toLowerCase())
    );

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={460}
            label={`Add ${targetUser.username} to a group`}
            cardClassName="dlg-card"
        >
            <DialogHeader
                icon={<Users size={19} strokeWidth={2.2} />}
                title="Add to group"
                subtitle={<>Add <b style={{ color: 'var(--cl-text, #F4F7FF)' }}>{targetUser.username}</b> to a group chat.</>}
            />
            <DialogBody>
                {myGroups.length > 0 && (
                    <ClSearch
                        autoFocus
                        icon={<Search size={15} />}
                        type="text"
                        aria-label="Search your groups"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search your groups"
                    />
                )}
                <div className="dlg-list custom-scrollbar">
                    {filtered.length === 0 ? (
                        <div className="dlg-empty">
                            <Users size={26} aria-hidden="true" />
                            <span>{search ? `No groups match “${search}”` : 'No groups yet'}</span>
                            {!search && <span style={{ fontWeight: 600 }}>Start one with {targetUser.username}.</span>}
                        </div>
                    ) : (
                        filtered.map(group => {
                            const isAdding = addingId === group.conversation_id;
                            const isAdded = addedIds.has(group.conversation_id);
                            const errMsg = errors[group.conversation_id];
                            return (
                                <div key={group.conversation_id}>
                                    <div className="dlg-row">
                                        <div className="dlg-row-av">
                                            <EncryptedAvatar
                                                attachmentId={group.avatar_url ?? null}
                                                token={token}
                                                isGroup
                                                className="w-full h-full"
                                                fallbackSize={16}
                                            />
                                        </div>
                                        <span className="dlg-row-title">{group.title}</span>
                                        <ClButton
                                            onClick={() => handleAdd(group)}
                                            disabled={!!addingId || isAdded}
                                            loading={isAdding}
                                            variant={isAdded ? 'ok' : 'ghost'}
                                            size="sm"
                                        >
                                            {isAdded
                                                ? <><CheckCircle size={12} /> Added</>
                                                : 'Add'
                                            }
                                        </ClButton>
                                    </div>
                                    {errMsg && <div className="dlg-row-err" role="alert">{errMsg}</div>}
                                </div>
                            );
                        })
                    )}
                </div>
            </DialogBody>
            <DialogFooter hint={myGroups.length > 0 ? <span>{myGroups.length} {myGroups.length === 1 ? 'group' : 'groups'}</span> : <span>{targetUser.username} will be pre-selected</span>}>
                <ClButton variant="ghost" size="sm" onClick={handleClose}>Cancel</ClButton>
                <ClButton size="sm" onClick={onCreateNew}><Plus size={15} strokeWidth={2.5} />New group</ClButton>
            </DialogFooter>
        </ClModal>
    );
};
