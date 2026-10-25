import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Camera, Settings2, UserPlus } from 'lucide-react';
import { apiUrl } from '../utils/apiPath';
import { useAuth } from '../contexts/AuthContext';
import { useAttachments } from '../hooks/useAttachments';
import { useAvatarBroadcast } from '../hooks/useAvatarBroadcast';
import { EncryptedAvatar } from './EncryptedAvatar';
import { GroupBackdrop } from './GroupBackdrop';
import { memberCountLabel } from './GroupContextHeader';
import { saveAvatarKey } from '../utils/avatarKeyStore';
import { useModalExit } from '../hooks/useModalExit';
import { AVATAR_OUTPUT } from '../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../utils/imageUploadValidation';
import { useToast } from '../contexts/ToastContext';
import { ClButton, ClInput, ClModal, ClImageCropper } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError, DialogOk, DialogField } from './dialog/DialogFrame';
import { AddGroupMembersModal } from './AddGroupMembersModal';
import '../styles/dialog-extras.css';
import '../styles/group-settings.css';

interface GroupSettingsModalProps {
    conversationId: string;
    conversationTitle: string;
    avatarUrl?: string;
    onClose: () => void;
    onGroupLeft: () => void;
    onGroupUpdated?: (newTitle: string, newAvatarUrl: string) => void;
}

interface GroupMember { user_id: string; username: string; avatar_url: string | null }

export const GroupSettingsModal: React.FC<GroupSettingsModalProps> = ({ conversationId, conversationTitle, avatarUrl: initialAvatarUrl, onClose, onGroupUpdated }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { token, user, deviceId } = useAuth();
    const [members, setMembers] = useState<GroupMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [membersFailed, setMembersFailed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [title, setTitle] = useState(conversationTitle);
    /** What the server has now (name + picture id) — the baseline "changed" is measured against. */
    const [savedTitle, setSavedTitle] = useState(conversationTitle);
    const [savedAttachment, setSavedAttachment] = useState(initialAvatarUrl || '');
    /** Local preview (blob:) of a picked-and-cropped picture, unsaved or just saved. */
    const [previewUrl, setPreviewUrl] = useState('');
    const [avatarFile, setAvatarFile] = useState<Blob | null>(null);
    /** The picked image awaiting crop. Non-null ⇒ the cropper is open. */
    const [cropFile, setCropFile] = useState<File | null>(null);
    const [saving, setSaving] = useState(false);
    const [addPeopleOpen, setAddPeopleOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // P2-REND-13: track latest blob URL so unmount cleanup revokes it (empty-deps effect).
    const previewUrlRef = useRef(previewUrl);
    useEffect(() => { previewUrlRef.current = previewUrl; });

    useEffect(() => {
        return () => {
            if (previewUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(previewUrlRef.current);
        };
    }, []);

    // ClModal focuses the card's FIRST focusable — the picture button, which would
    // open with its "Change" overlay + focus ring showing. The name is the common
    // edit, so land there (after ClModal's own focus move, same 80ms as useInitialFocus).
    useEffect(() => {
        const t = window.setTimeout(() => document.getElementById('group-settings-name')?.focus(), 80);
        return () => window.clearTimeout(t);
    }, []);

    const { uploadEncryptedFile } = useAttachments(token);
    const toast = useToast();
    const { broadcastGroupAvatarKey } = useAvatarBroadcast(token, user?.user_id || null);

    /** What the picture slot shows: the local preview if there is one, else the stored attachment. */
    const picture = previewUrl || savedAttachment;

    const fetchMembers = async () => {
        setLoading(true);
        setMembersFailed(false);
        try {
            const devicesRes = await axios.get(apiUrl`/conversations/${conversationId}/devices`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'x-device-id': deviceId || '00000000-0000-0000-0000-000000000000'
                }
            });

            const uniqueUsers = new Map<string, GroupMember>();
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
            setMembersFailed(true);
        }

        setLoading(false);
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per conversation; fetchMembers is a per-render closure and including it would refetch on every render
    useEffect(() => { fetchMembers(); }, [conversationId]);

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
        setSuccess(null);
        setPreviewUrl(prev => {
            if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
        });
    };

    const trimmedTitle = title.trim();
    const dirty = trimmedTitle !== savedTitle.trim() || !!avatarFile;
    const canSave = dirty && !!trimmedTitle && !saving;

    const handleSaveGroup = async () => {
        if (!token || !canSave) return;
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            let finalAttachmentId = savedAttachment;

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
                title: trimmedTitle,
                avatar_attachment: finalAttachmentId
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setAvatarFile(null);
            setSavedAttachment(finalAttachmentId);
            setSavedTitle(trimmedTitle);
            setTitle(trimmedTitle);
            setSuccess('Group updated');
            if (onGroupUpdated) onGroupUpdated(trimmedTitle, finalAttachmentId);
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
     * Escape itself no longer needs this: ClModal's Escape goes through the
     * shared escapeStack (see utils/escapeStack.ts), so with the cropper or the
     * add-people dialog open its layer is on top and a press closes ONLY that
     * layer. This guard remains for a backdrop click reaching the host's
     * `onClose` while a crop is in progress — swallow it and close the cropper
     * first rather than discarding unsaved edits underneath it.
     */
    const requestClose = () => {
        if (cropFile) { setCropFile(null); return; }
        if (addPeopleOpen) return;
        handleClose();
    };

    let hint: React.ReactNode;
    if (saving) hint = <span>Saving…</span>;
    else if (dirty && !trimmedTitle) hint = <span>Give the group a name to save</span>;
    else if (dirty) hint = <span className="dlg-hint-strong">Unsaved changes</span>;
    else hint = <span>Change the name or photo to save</span>;

    return (
      <>
        <ClModal
            open={!closing}
            onClose={requestClose}
            width={480}
            label="Group settings"
            cardClassName="dlg-card"
        >
          <form className="dlg-form" noValidate onSubmit={(e) => { e.preventDefault(); void handleSaveGroup(); }}>
            <DialogHeader
                icon={<Settings2 size={19} strokeWidth={2.2} />}
                title="Group settings"
                subtitle="Rename the group, change its photo, and see who's in."
            />
            <DialogBody>
                {/* Banner: the group picture, blurred + darkened (the same treatment as
                    the right-hand panel's card), with the real picture on top to edit. */}
                <div className="cl-group-hero cl-group-hero--banner" data-testid="group-settings-banner">
                    <GroupBackdrop attachmentId={picture} token={token} />
                    <div className="cl-group-hero-copy">
                        {/* Plain button, not ClButton — the kit's .cap fixes its own
                            size/background/radius (same reason as CreateGroupModal). */}
                        <button
                            type="button"
                            className="cl-group-pic-btn"
                            onClick={() => fileInputRef.current?.click()}
                            aria-label="Change group photo"
                            disabled={saving}
                        >
                            <EncryptedAvatar attachmentId={picture} token={token} isGroup className="w-full h-full" fallbackSize={38} />
                            <span className="cl-group-pic-btn-overlay" aria-hidden="true">
                                <Camera size={18} />
                                Change
                            </span>
                        </button>
                    </div>
                </div>
                <input type="file" ref={fileInputRef} onChange={handleAvatarChange} className="hidden" accept={IMAGE_ACCEPT_ATTR} />

                <div style={{ marginTop: 16 }}>
                    <DialogField label="Group name" htmlFor="group-settings-name">
                        <ClInput
                            id="group-settings-name"
                            type="text"
                            value={title}
                            onChange={(e) => { setTitle(e.target.value); setSuccess(null); }}
                            placeholder="Enter group name…"
                            autoComplete="off"
                        />
                    </DialogField>
                </div>

                <div className="gset-members-head">
                    <div className="gset-members-title">
                        <span>Members</span>
                        {!loading && !membersFailed && (
                            <span className="gset-count" data-testid="member-count" title={memberCountLabel(members.length)}>{members.length}</span>
                        )}
                    </div>
                    <ClButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAddPeopleOpen(true)}
                        disabled={loading || membersFailed}
                    >
                        <UserPlus size={14} />
                        Add people
                    </ClButton>
                </div>
                <div className="gset-members custom-scrollbar" aria-busy={loading}>
                    {loading ? (
                        <div className="gset-members-note">Loading members…</div>
                    ) : membersFailed ? (
                        <div className="gset-members-note">
                            Couldn't load members.{' '}
                            <button type="button" className="dlg-linkbtn" onClick={() => { void fetchMembers(); }}>Try again</button>
                        </div>
                    ) : members.map((m) => (
                        <div key={m.user_id} className="gset-member">
                            <div className="gset-member-av">
                                <EncryptedAvatar
                                    attachmentId={m.avatar_url ?? null}
                                    userId={m.user_id}
                                    token={token}
                                    className="w-full h-full"
                                    fallbackSize={16}
                                />
                            </div>
                            <span className="gset-member-name">
                                {m.username}
                                {m.user_id === user?.user_id && <span className="gset-you">(You)</span>}
                            </span>
                        </div>
                    ))}
                </div>
            </DialogBody>
            {error && <DialogError>{error}</DialogError>}
            {success && <DialogOk>{success}</DialogOk>}
            <DialogFooter hint={hint}>
                <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>{success && !dirty ? 'Done' : 'Cancel'}</ClButton>
                <ClButton type="submit" size="sm" loading={saving} disabled={!canSave}>Save</ClButton>
            </DialogFooter>
          </form>
        </ClModal>

        {/* Stacked above this dialog; outside the <form> so nothing it renders can submit it.
            Shares the invite logic (useGroupMemberInvites) with the panel's "+". */}
        {addPeopleOpen && !closing && (
            <AddGroupMembersModal
                conversationId={conversationId}
                conversationTitle={title.trim() || conversationTitle}
                memberIds={members.map(m => m.user_id)}
                onClose={() => setAddPeopleOpen(false)}
                onAdded={() => { void fetchMembers(); }}
            />
        )}

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
