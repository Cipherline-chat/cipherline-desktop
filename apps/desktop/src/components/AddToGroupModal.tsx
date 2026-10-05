import React, { useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { Search, Plus, CheckCircle, X } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { ClModal, ClButton, ClSearch } from './cl';

interface AddToGroupModalProps {
    targetUser: { user_id: string; username: string; avatar_url?: string };
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

    const handleAdd = async (group: any) => {
        if (addingId || addedIds.has(group.conversation_id)) return;
        setAddingId(group.conversation_id);
        setErrors(prev => { const n = { ...prev }; delete n[group.conversation_id]; return n; });
        try {
            await axios.post(
                `${API_BASE}/conversations/${group.conversation_id}/invite`,
                { user_id: targetUser.user_id },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setAddedIds(prev => new Set(prev).add(group.conversation_id));
            setTimeout(() => onGroupJoined(group.conversation_id), 800);
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
            width={440}
            cardStyle={{ padding: '28px 28px 24px', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
        >
            {/* Header */}
            <div className="flex items-start justify-between mb-5 shrink-0">
                <div>
                    <h2 className="text-xl font-bold text-cl-text mt-0 mb-1">Add to Group</h2>
                    <p className="text-[13px] text-cl-faint">
                        Adding <span className="text-cl-muted font-semibold">{targetUser.username}</span>
                    </p>
                </div>
                <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                    <X size={16} />
                </ClButton>
            </div>

            {/* Create New Group CTA — a plain button, not ClButton. ClButton applies
                its `style` prop to the outer wrapper while the visible surface is
                the inner `.cap`, which has its own fixed padding, background and
                (for ghost) justify-content:center — so the intended teal tint,
                left-alignment and padding never reached anything. The button
                rendered with a plain dark-surface fill, centered content, and
                doubled padding (wrapper padding stacked on cap's own). */}
            <button type="button" onClick={onCreateNew} className="cl-newgroup-cta">
                <span className="cl-newgroup-cta-icon">
                    <Plus size={16} strokeWidth={2.5} />
                </span>
                <span className="cl-newgroup-cta-text">
                    <span className="cl-newgroup-cta-title">Create New Group</span>
                    <span className="cl-newgroup-cta-sub">{targetUser.username} will be pre-selected</span>
                </span>
            </button>

            {/* Existing groups section */}
            {myGroups.length > 0 && (
                <>
                    <div className="flex items-center gap-3 mb-4 shrink-0">
                        <div className="h-px bg-white/[0.06] flex-1" />
                        <span className="text-[11px] font-semibold text-cl-faint uppercase tracking-widest whitespace-nowrap">
                            Add to Existing Group
                        </span>
                        <div className="h-px bg-white/[0.06] flex-1" />
                    </div>

                    <div className="mb-3 shrink-0">
                        <ClSearch
                            autoFocus
                            icon={<Search size={15} />}
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search your groups"
                        />
                    </div>

                    <div
                        className="overflow-y-auto bg-cl-sink border border-white/5 rounded-xl p-2 custom-scrollbar flex-1"
                        style={{ maxHeight: '300px' }}
                    >
                        {filtered.length === 0 ? (
                            <div className="text-center text-cl-faint py-8 text-sm">
                                {search ? `No groups match "${search}"` : 'No groups yet'}
                            </div>
                        ) : (
                            filtered.map(group => {
                                const isAdding = addingId === group.conversation_id;
                                const isAdded = addedIds.has(group.conversation_id);
                                const errMsg = errors[group.conversation_id];
                                return (
                                    <div key={group.conversation_id} className="mb-0.5">
                                        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors">
                                            <div className="w-9 h-9 rounded-full border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                                                <EncryptedAvatar
                                                    attachmentId={group.avatar_url ?? null}
                                                    token={token}
                                                    isGroup
                                                    className="w-full h-full"
                                                    fallbackSize={16}
                                                />
                                            </div>
                                            <span className="text-[14px] font-semibold text-cl-muted truncate flex-1">
                                                {group.title}
                                            </span>
                                            <ClButton
                                                onClick={() => handleAdd(group)}
                                                disabled={!!addingId || isAdded}
                                                loading={isAdding}
                                                variant={isAdded ? 'ok' : 'primary'}
                                                size="sm"
                                            >
                                                {isAdded
                                                    ? <><CheckCircle size={12} /> Added</>
                                                    : 'Add'
                                                }
                                            </ClButton>
                                        </div>
                                        {errMsg && (
                                            <p className="text-cl-flash text-[11px] px-3 -mt-1 pb-1">{errMsg}</p>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </>
            )}

            <div className="mt-4 shrink-0">
                <ClButton variant="ghost" fullWidth onClick={handleClose}>Cancel</ClButton>
            </div>
        </ClModal>
    );
};
