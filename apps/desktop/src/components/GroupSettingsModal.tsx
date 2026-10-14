import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import { useAuth } from '../contexts/AuthContext';
import { Camera, Save, X } from 'lucide-react';
import { useAttachments } from '../hooks/useAttachments';
import { useAvatarBroadcast } from '../hooks/useAvatarBroadcast';
import { EncryptedAvatar } from './EncryptedAvatar';
import { saveAvatarKey } from '../utils/avatarKeyStore';
import { useModalExit } from '../hooks/useModalExit';
import { AVATAR_OUTPUT } from '../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../utils/imageUploadValidation';
import { useToast } from '../contexts/ToastContext';
import { ClButton, ClInput, ClModal, ClImageCropper } from './cl';
import { AddGroupMembersPicker } from './AddGroupMembersPicker';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const [members, setMembers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
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
            const devicesRes = await axios.get(apiUrl`/conversations/${conversationId}/devices`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'x-device-id': deviceId || '00000000-0000-0000-0000-000000000000'
                }
            });

            const uniqueUsers = new Map();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
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

        setLoading(false);
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per conversation; fetchMembers is a per-render closure and including it would refetch on every render
    useEffect(() => { fetchMembers(); }, [conversationId]);

    // Friend list, search, staged multi-select and the invite calls live in
    // AddGroupMembersPicker (shared with the right-hand panel's "+").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const memberIds = useMemo(() => new Set(members.map((m: any) => m.user_id)), [members]);

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

            await axios.patch(apiUrl`/conversations/${conversationId}`, {
                title: title,
                avatar_attachment: finalAttachmentId
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setAvatarFile(null);
            setSuccess('Group updated successfully');
            if (onGroupUpdated) onGroupUpdated(title, finalAttachmentId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
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
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
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

                {/* Add members — the shared picker (friend search, staged
                    multi-select + confirm, 200-member cap, added/failed messaging).
                    Re-load the member list above once an add settles. */}
                <AddGroupMembersPicker
                    conversationId={conversationId}
                    memberIds={memberIds}
                    membersLoading={loading}
                    onResult={() => { fetchMembers(); }}
                />

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
