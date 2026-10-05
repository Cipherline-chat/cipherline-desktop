import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useAttachments } from '../hooks/useAttachments';
import { useAvatarBroadcast } from '../hooks/useAvatarBroadcast';
import { saveAvatarKey } from '../utils/avatarKeyStore';
import { AVATAR_OUTPUT } from '../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../utils/imageUploadValidation';
import { Search, Loader2, Users, Camera, X } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { ClButton, ClInput, ClSearch, ClCheckbox, ClModal, ClImageCropper } from './cl';

interface CreateGroupModalProps {
    onClose: () => void;
    onGroupCreated: (group: any) => void;
    /** Users to pre-select when the modal opens (e.g. from "Add to Group → Create New") */
    preSelectedUsers?: { user_id: string; username: string; avatar_url?: string }[];
}

const PLACEHOLDERS = [
    'e.g. The Cipherline Squad',
    'e.g. Secret Cuttlefish Society',
    'e.g. Operation Deep Blue',
    'e.g. The Encrypted Ones',
    'e.g. Just Between Us',
];

export const CreateGroupModal: React.FC<CreateGroupModalProps> = ({ onClose, onGroupCreated, preSelectedUsers }) => {
    const { token, deviceId, userId } = useAuth();
    const toast = useToast();
    const { uploadEncryptedFile } = useAttachments(token);
    const { broadcastGroupAvatarKey } = useAvatarBroadcast(token, userId);
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [friends, setFriends] = useState<any[]>([]);
    const [loadingFriends, setLoadingFriends] = useState(true);

    const [groupName, setGroupName] = useState('');
    const [search, setSearch] = useState('');
    const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(
        new Set((preSelectedUsers || []).map(u => u.user_id))
    );
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [egg, setEgg] = useState<string | null>(null);
    const placeholderIdx = useRef(Math.floor(Math.random() * PLACEHOLDERS.length));

    // ── Group photo ────────────────────────────────────────────────────────────
    // No conversation exists yet to attach an attachment to (same situation as
    // account registration), so the picked image is held as a local Blob and
    // only actually uploaded once the group's real id comes back from the
    // create call — see handleCreate.
    const [avatarBlob, setAvatarBlob] = useState<Blob | null>(null);
    const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
    const [avatarError, setAvatarError] = useState<string | null>(null);
    /** The picked image awaiting crop. Non-null ⇒ the cropper is open. */
    const [cropFile, setCropFile] = useState<File | null>(null);
    const avatarInputRef = useRef<HTMLInputElement>(null);

    const handlePickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
        setAvatarError(null);
        const result = validateImageUpload(e.target.files?.[0]);
        // Always clear the input: without this, cancelling the cropper and
        // re-picking the same file fires no change event.
        if (e.target) e.target.value = '';
        if (!result.ok) { setAvatarError(result.reason); return; }
        if (!result.file) return;
        setCropFile(result.file);
    };

    const handleCropped = (blob: Blob) => {
        setCropFile(null);
        setAvatarBlob(blob);
        setAvatarPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
    };

    const clearAvatar = () => {
        setAvatarBlob(null);
        setAvatarPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    };

    // Revoke the object URL on unmount so a cancelled create doesn't leak it.
    useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);

    useEffect(() => {
        let isMounted = true;
        axios.get(`${API_BASE}/friends`, {
            headers: { Authorization: `Bearer ${token}` }
        }).then(res => {
            if (isMounted) { setFriends(res.data.accepted || []); setLoadingFriends(false); }
        }).catch(() => {
            if (isMounted) setLoadingFriends(false);
        });
        return () => { isMounted = false; };
    }, [token]);

    const toggleFriend = (id: string) => {
        const next = new Set(selectedFriendIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedFriendIds(next);
        setError(null);
    };

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        setGroupName(v);
        setError(null);
        if (v.trim().toLowerCase() === 'cuttlefish') {
            setEgg('👁 the cuttlefish hears all.');
        } else {
            setEgg(null);
        }
    };

    const handleCreate = async () => {
        if (!groupName.trim()) {
            setError('Group name is required');
            return;
        }
        if (selectedFriendIds.size === 0) {
            setError('Select at least one friend');
            return;
        }

        setIsCreating(true);
        setError(null);
        let conversationId: string | null = null;
        try {
            const res = await axios.post(`${API_BASE}/conversations/group`, {
                title: groupName.trim(),
                initial_user_ids: Array.from(selectedFriendIds),
            }, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
            });
            conversationId = res.data.conversation_id;
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Failed to create group');
            setIsCreating(false);
            return;
        }

        // The group exists now — attach the photo if one was picked. Same
        // encrypt-upload-then-PATCH sequence GroupSettingsModal uses to change
        // it later. Failure here is non-fatal: the group is real and the members
        // are in it, so losing the create flow over a flaky upload would be
        // worse than a group that starts without a photo (settable afterward).
        if (avatarBlob && conversationId) {
            try {
                const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(
                    avatarBlob, 'group_avatar.jpg', 'image/jpeg', conversationId,
                    // signal, serverId unused; purpose is the load-bearing one —
                    // without it the server refuses to store the icon's key.
                    undefined, undefined, 'group_icon',
                );
                await saveAvatarKey(attachmentId, keyB64, nonceB64);
                await broadcastGroupAvatarKey(conversationId, attachmentId, keyB64, nonceB64);
                await axios.patch(`${API_BASE}/conversations/${conversationId}`, {
                    avatar_attachment: attachmentId,
                }, { headers: { Authorization: `Bearer ${token}` } });
            } catch {
                toast.push({
                    kind: 'error',
                    title: 'Photo not set',
                    message: 'The group was created, but its photo failed to upload. You can set one from group settings.',
                });
            }
        }

        onGroupCreated({
            id: conversationId,
            title: groupName.trim(),
            type: 'group'
        });
        handleClose();
    };

    const filteredFriends = friends.filter(f => f.username.toLowerCase().includes(search.toLowerCase()));

    /**
     * Overlay-close guard for the host modal.
     *
     * Escape itself no longer needs this: ClModal's Escape now goes through
     * the shared escapeStack (see utils/escapeStack.ts), so with the cropper
     * open its layer is on top and a press closes ONLY the cropper. This guard
     * remains for a backdrop click reaching the host's `onClose` while a
     * half-picked group is in progress — swallow it and close the cropper
     * first rather than losing the group underneath it.
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
            width={450}
            cardStyle={{ padding: '32px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
            {/* Header */}
            <div className="flex items-start justify-between mb-5 shrink-0">
                <h2 className="text-xl font-bold text-cl-text m-0">Create Group Chat</h2>
                <ClButton icon variant="ghost" onClick={handleClose} tooltip="Close">
                    <X size={18} />
                </ClButton>
            </div>

            {error && (
                <div className="text-cl-flash font-medium text-[13px] mb-4 bg-cl-flash/10 border border-cl-flash/20 px-3 py-2 rounded-lg shrink-0">
                    {error}
                </div>
            )}

            {/* Photo + name — plain buttons throughout, not ClButton: the kit's
                `.cap` fixes its own size/background/radius and ClButton puts the
                `style` prop on the outer wrapper, so a small round camera badge
                built from ClButton silently renders at the kit's default 46px
                icon-button size instead of whatever size is asked for. */}
            <div className="flex flex-col items-center gap-3 mb-5 shrink-0">
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => avatarInputRef.current?.click()}
                        className="cl-newgroup-avatar-picker group"
                        aria-label="Set a group photo"
                    >
                        {avatarPreview ? (
                            <img src={avatarPreview} alt="" className="w-full h-full object-cover" />
                        ) : (
                            <Users size={26} className="text-cl-faint" />
                        )}
                        <span className="cl-newgroup-avatar-hint">
                            <Camera size={18} className="text-white" />
                        </span>
                    </button>
                    {avatarPreview && (
                        <button
                            type="button"
                            onClick={clearAvatar}
                            className="cl-newgroup-avatar-remove"
                            aria-label="Remove photo"
                        >
                            <X size={11} />
                        </button>
                    )}
                </div>
                <input
                    ref={avatarInputRef}
                    type="file"
                    accept={IMAGE_ACCEPT_ATTR}
                    onChange={handlePickAvatar}
                    className="hidden"
                />
                {avatarError && (
                    <p className="text-[11px] text-cl-flash -mt-1">{avatarError}</p>
                )}

                <div className="w-full">
                    <ClInput
                        type="text"
                        aria-label="Group name"
                        value={groupName}
                        onChange={handleNameChange}
                        placeholder={PLACEHOLDERS[placeholderIdx.current]}
                        autoFocus
                    />
                    {egg && (
                        <p className="text-[11px] font-bold text-cl-lume mt-1.5 ml-1">{egg}</p>
                    )}
                </div>
            </div>

            {/* Member picker */}
            <div className="mb-2 flex-1 flex flex-col min-h-0">
                <label className="flex items-center justify-between text-[13px] font-semibold text-cl-faint mb-2 uppercase tracking-wide">
                    <span>Members</span>
                    <span className="text-cl-lume">
                        {selectedFriendIds.size} selected
                        {preSelectedUsers && preSelectedUsers.length > 0 && (
                            <span className="text-cl-faint font-normal normal-case tracking-normal ml-1">
                                ({preSelectedUsers.map(u => u.username).join(', ')} pre-added)
                            </span>
                        )}
                    </span>
                </label>

                <div className="mb-3">
                    <ClSearch
                        icon={<Search size={15} />}
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search friends"
                    />
                </div>

                <div className="overflow-y-auto bg-cl-deep border border-white/5 rounded-xl p-2 custom-scrollbar flex-1"
                    style={{ minHeight: '160px', maxHeight: '240px' }}
                >
                    {loadingFriends ? (
                        <div className="flex items-center justify-center h-full text-cl-faint">
                            <Loader2 className="w-6 h-6 animate-spin" />
                        </div>
                    ) : friends.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full py-6 text-center">
                            <Users className="w-8 h-8 mb-2 text-cl-faint opacity-50" />
                            <span className="text-sm text-cl-faint">Your circle is empty — add friends first.</span>
                        </div>
                    ) : filteredFriends.length === 0 ? (
                        <div className="text-center text-cl-faint py-6 text-sm">
                            No friends match &ldquo;{search}&rdquo;
                        </div>
                    ) : (
                        filteredFriends.map(f => {
                            const isSelected = selectedFriendIds.has(f.user_id);
                            return (
                                <ClButton
                                    type="button"
                                    key={f.user_id}
                                    variant="ghost"
                                    row
                                    fullWidth
                                    onClick={() => toggleFriend(f.user_id)}
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
                                            attachmentId={f.avatar_url}
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
            </div>

            <div className="flex justify-end gap-2.5 mt-5 shrink-0">
                <ClButton type="button" variant="ghost" disabled={isCreating} onClick={handleClose}>
                    Cancel
                </ClButton>
                <ClButton
                    type="button"
                    disabled={isCreating || selectedFriendIds.size === 0 || !groupName.trim()}
                    loading={isCreating}
                    onClick={handleCreate}
                >
                    Create
                </ClButton>
            </div>
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
