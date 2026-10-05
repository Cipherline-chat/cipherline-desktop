import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { Camera, Save, Loader2, Search, UserPlus, Users, X } from 'lucide-react';
import { useAttachments } from '../hooks/useAttachments';
import { useAvatarBroadcast } from '../hooks/useAvatarBroadcast';
import { EncryptedAvatar } from './EncryptedAvatar';
import { saveAvatarKey } from '../utils/avatarKeyStore';
import { useModalExit } from '../hooks/useModalExit';
import { AVATAR_OUTPUT } from '../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../utils/imageUploadValidation';
import { useToast } from '../contexts/ToastContext';
import { ClButton, ClCheckbox, ClInput, ClModal, ClSearch, ClImageCropper } from './cl';

interface GroupSettingsModalProps {
    conversationId: string;
    conversationTitle: string;
    avatarUrl?: string;
    onClose: () => void;
    onGroupLeft: () => void;
    onGroupUpdated?: (newTitle: string, newAvatarUrl: string) => void;
}

export const GroupSettingsModal: React.FC<GroupSettingsModalProps> = ({ conversationId, conversationTitle, avatarUrl: initialAvatarUrl, onClose, onGroupUpdated }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { token, user, deviceId } = useAuth();
    const [members, setMembers] = useState<any[]>([]);
    const [friends, setFriends] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [friendSearch, setFriendSearch] = useState('');
    // Staged multi-select + confirm, matching CreateGroupModal's member
    // picker — was previously a search dropdown that invited a friend the
    // instant you clicked their row (one at a time, no way to review the
    // set before it happened).
    const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
    const [isAddingMembers, setIsAddingMembers] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [title, setTitle] = useState(conversationTitle);
    const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl || '');
    const [avatarFile, setAvatarFile] = useState<Blob | null>(null);
    /** The picked image awaiting crop. Non-null ⇒ the cropper is open. */
    const [cropFile, setCropFile] = useState<File | null>(null);
    const [saving, setSaving] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    // P2-REND-13: track latest blob URL so unmount cleanup revokes it (empty-deps effect).
    const avatarUrlRef = useRef(avatarUrl);
    avatarUrlRef.current = avatarUrl;

    useEffect(() => {
        return () => {
            if (avatarUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(avatarUrlRef.current);
        };
    }, []);

    const { uploadEncryptedFile } = useAttachments(token);
    const toast = useToast();
    const { broadcastGroupAvatarKey } = useAvatarBroadcast(token, user?.user_id || null);

    const fetchMembers = async () => {
        setLoading(true);
        try {
            const devicesRes = await axios.get(`${API_BASE}/conversations/${conversationId}/devices`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'x-device-id': deviceId || '00000000-0000-0000-0000-000000000000'
                }
            });

            const uniqueUsers = new Map();
            devicesRes.data.forEach((d: any) => {
                if (d.user_id && !uniqueUsers.has(d.user_id)) {
                    uniqueUsers.set(d.user_id, { user_id: d.user_id, username: d.username, avatar_url: d.avatar_url });
                }
            });

            if (!uniqueUsers.has(user!.user_id)) {
                uniqueUsers.set(user!.user_id, {
                    user_id: user!.user_id,
                    username: user!.username || 'You',
                    avatar_url: user?.avatar_url ?? null,
                });
            }

            setMembers(Array.from(uniqueUsers.values()));
        } catch (err) {
            console.error('Failed to fetch members:', err);
        }

        try {
            const friendsRes = await axios.get(`${API_BASE}/friends`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setFriends(friendsRes.data.accepted || []);
        } catch (err) {
            console.error('Failed to fetch friends:', err);
        }

        setLoading(false);
    };

    useEffect(() => { fetchMembers(); }, [conversationId]);

    const memberIds = new Set(members.map((m: any) => m.user_id));
    const filteredFriends = friends.filter(f =>
        !memberIds.has(f.user_id) &&
        (friendSearch === '' || f.username.toLowerCase().includes(friendSearch.toLowerCase()))
    );

    const toggleSelectedToAdd = (friendUserId: string) => {
        setSelectedToAdd(prev => {
            const next = new Set(prev);
            if (next.has(friendUserId)) next.delete(friendUserId);
            else next.add(friendUserId);
            return next;
        });
        setError(null);
    };

    const handleAddSelectedMembers = async () => {
        if (selectedToAdd.size === 0) return;
        setError(null);
        setSuccess(null);
        setIsAddingMembers(true);
        const ids = Array.from(selectedToAdd);
        const results = await Promise.allSettled(
            ids.map(id => axios.post(`${API_BASE}/conversations/${conversationId}/invite`, {
                user_id: id,
            }, { headers: { Authorization: `Bearer ${token}` } })),
        );
        const failed = results.filter(r => r.status === 'rejected').length;
        const added = ids.length - failed;
        if (added > 0) setSuccess(`${added} ${added === 1 ? 'member' : 'members'} added to the group`);
        if (failed > 0) setError(`Failed to add ${failed} ${failed === 1 ? 'member' : 'members'}.`);
        setSelectedToAdd(new Set());
        setIsAddingMembers(false);
        fetchMembers();
    };

    const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const result = validateImageUpload(e.target.files?.[0]);
        // Always clear the input: without this, cancelling the cropper and
        // re-picking the same file fires no change event.
        if (e.target) e.target.value = '';
        if (!result.ok) {
            toast.push({ kind: 'error', title: 'Invalid group icon', message: result.reason });
            return;
        }
        if (result.file) setCropFile(result.file);
    };

    /** The cropper hands back the final square JPEG; upload stays deferred to save. */
    const handleCropped = (blob: Blob) => {
        setCropFile(null);
        setAvatarFile(blob);
        setAvatarUrl(prev => {
            if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
        });
    };

    const handleSaveGroup = async () => {
        if (!token) return;
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            let finalAttachmentId = avatarUrl;

            if (avatarFile) {
                const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(
                    avatarFile, 'group_avatar.jpg', 'image/jpeg', conversationId,
                    // signal, serverId unused; purpose is the load-bearing one —
                    // without it the server refuses to store the icon's key.
                    undefined, undefined, 'group_icon',
                );
                finalAttachmentId = attachmentId;
                await saveAvatarKey(attachmentId, keyB64, nonceB64);
                await broadcastGroupAvatarKey(conversationId, attachmentId, keyB64, nonceB64);
            }

            await axios.patch(`${API_BASE}/conversations/${conversationId}`, {
                title: title,
                avatar_attachment: finalAttachmentId
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setAvatarFile(null);
            setSuccess('Group updated successfully');
            if (onGroupUpdated) onGroupUpdated(title, finalAttachmentId);
        } catch (err: any) {
            console.error('Failed to save group settings', err);
            setError(err?.response?.data?.message || 'Failed to update group.');
        } finally {
            setSaving(false);
        }
    };

    /**
     * Overlay-close guard for the host modal.
     *
     * Escape itself no longer needs this: ClModal's Escape now goes through
     * the shared escapeStack (see utils/escapeStack.ts), so with the cropper
     * open its layer is on top and a press closes ONLY the cropper. This guard
     * remains for a backdrop click reaching the host's `onClose` while a crop
     * is in progress — swallow it and close the cropper first rather than
     * discarding unsaved edits underneath it.
     */
    const requestClose = () => {
        if (cropFile) { setCropFile(null); return; }
        handleClose();
    };

    return (
      <>
        <ClModal
            open={!closing}
            onClose={requestClose}
            width={460}
            cardStyle={{ padding: '32px', maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}
            cardClassName="custom-scrollbar"
        >
                {/* Header */}
                <div className="flex justify-between items-center">
                    <h2 className="m-0 text-cl-text text-xl font-semibold tracking-tight">Manage Group</h2>
                    <ClButton
                        variant="ghost"
                        icon
                        onClick={handleClose}
                    >
                        <X size={18} />
                    </ClButton>
                </div>

                {/* Avatar + name */}
                <div className="flex flex-col items-center gap-4 py-2">
                    <div className="relative group">
                        <div className="w-24 h-24 rounded-full border-2 border-cl-border flex items-center justify-center overflow-hidden">
                            <EncryptedAvatar attachmentId={avatarUrl} token={token} isGroup className="w-full h-full" fallbackSize={40} />
                        </div>
                        {/* Plain button, not ClButton — the kit's .cap fixes its own
                            size/background/radius and ClButton puts the `style` prop
                            on the outer wrapper, not .cap, so this rendered as two
                            overlapping teal circles (a correctly-sized 32px wrapper
                            underneath the kit's default 46px icon-button surface).
                            Same fix already applied in CreateGroupModal.tsx. */}
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="cl-avatar-corner-badge"
                            aria-label="Change group photo"
                        >
                            <Camera size={14} />
                        </button>
                    </div>
                    <input type="file" ref={fileInputRef} onChange={handleAvatarChange} className="hidden" accept={IMAGE_ACCEPT_ATTR} />

                    <div className="w-full space-y-1.5">
                        <label className="text-[11px] font-bold text-cl-faint uppercase tracking-wider ml-1">Group Name</label>
                        <ClInput
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Enter group name…"
                        />
                    </div>

                    <ClButton
                        fullWidth
                        onClick={handleSaveGroup}
                        loading={saving}
                        disabled={saving || (title === conversationTitle && !avatarFile)}
                    >
                        <Save size={16} />
                        Save Changes
                    </ClButton>
                </div>

                {error && (
                    <div className="text-cl-flash bg-cl-flash/10 px-4 py-3 rounded-lg text-sm font-medium border border-cl-flash/20">
                        {error}
                    </div>
                )}
                {success && (
                    <div className="text-cl-ok bg-cl-ok/10 px-4 py-3 rounded-lg text-sm font-medium border border-cl-ok/20">
                        {success}
                    </div>
                )}

                {/* Members */}
                <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold text-cl-faint m-0 uppercase tracking-wider">
                        Members ({members.length})
                    </h3>
                    <div className="max-h-[180px] overflow-y-auto bg-cl-sink rounded-xl border border-white/5 p-2 flex flex-col gap-1 custom-scrollbar">
                        {loading ? (
                            <div className="text-cl-faint text-center py-4 text-sm font-medium">Loading members…</div>
                        ) : members.map((m: any) => (
                            <div key={m.user_id} className="flex items-center p-2 rounded-lg hover:bg-white/5 transition-colors">
                                <div className="w-8 h-8 rounded-full flex items-center justify-center mr-3 shrink-0 overflow-hidden">
                                    <EncryptedAvatar
                                        attachmentId={m.avatar_url ?? null}
                                        userId={m.user_id}
                                        token={token}
                                        className="w-full h-full"
                                        fallbackSize={16}
                                    />
                                </div>
                                <span className="flex-1 text-sm font-medium text-cl-text truncate">
                                    {m.username}
                                    {m.user_id === user?.user_id && (
                                        <span className="text-cl-faint italic ml-1 text-xs">(You)</span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Add members — restyled to match CreateGroupModal's member picker:
                    ClSearch, a persistent checkbox list instead of a dropdown that
                    invited on click, and a staged multi-select + confirm instead of
                    inviting one friend at a time as soon as you clicked their row. */}
                <div className="flex flex-col gap-2">
                    <label className="flex items-center justify-between text-[13px] font-semibold text-cl-faint m-0 uppercase tracking-wide">
                        <span>Add Members</span>
                        {selectedToAdd.size > 0 && (
                            <span className="text-cl-lume normal-case font-normal tracking-normal">
                                {selectedToAdd.size} selected
                            </span>
                        )}
                    </label>

                    <ClSearch
                        icon={<Search size={15} />}
                        type="text"
                        value={friendSearch}
                        onChange={e => setFriendSearch(e.target.value)}
                        placeholder="Search friends"
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

                    {selectedToAdd.size > 0 && (
                        <ClButton fullWidth onClick={handleAddSelectedMembers} loading={isAddingMembers} disabled={isAddingMembers}>
                            <UserPlus size={16} />
                            Add {selectedToAdd.size} {selectedToAdd.size === 1 ? 'Member' : 'Members'}
                        </ClButton>
                    )}
                </div>

                <ClButton variant="ghost" fullWidth onClick={handleClose}>Done</ClButton>
        </ClModal>

        <ClImageCropper
            open={!!cropFile}
            file={cropFile}
            outputWidth={AVATAR_OUTPUT.width}
            outputHeight={AVATAR_OUTPUT.height}
            shape="circle"
            title="Position the group photo"
            onCancel={() => setCropFile(null)}
            onConfirm={handleCropped}
        />
      </>
    );
};
