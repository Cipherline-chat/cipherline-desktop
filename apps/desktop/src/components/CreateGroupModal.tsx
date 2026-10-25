import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from '../utils/apiPath';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useAttachments } from '../hooks/useAttachments';
import { useAvatarBroadcast } from '../hooks/useAvatarBroadcast';
import { saveAvatarKey } from '../utils/avatarKeyStore';
import { AVATAR_OUTPUT } from '../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../utils/imageUploadValidation';
import { Users, Camera, X } from 'lucide-react';
import { useModalExit } from '../hooks/useModalExit';
import { ClButton, ClInput, ClModal, ClImageCropper } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from './dialog/DialogFrame';
import { MemberPicker } from './peoplePicker/MemberPicker';
import { GROUP_MAX_MEMBERS } from '../utils/groupAddMembers';
import { GroupOfTwoDialog } from './GroupOfTwoDialog';
import { eggCountNow, noteEggNow } from '../hooks/useEasterEggs';
import { recordEggFound } from '../utils/eggProgress';
import {
    GROUP_OF_TWO_INSISTED, GROUP_OF_TWO_SHOWN, groupOfTwoCopy, groupOfTwoTarget, type GroupOfTwoPerson,
} from '../utils/groupOfTwo';
import { startDirectMessage, type StartedDm } from '../utils/startDirectMessage';

interface CreateGroupModalProps {
    onClose: () => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    onGroupCreated: (group: any) => void;
    /** Users to pre-select when the modal opens (e.g. from "Add to Group → Create New") */
    preSelectedUsers?: { user_id: string; username: string; avatar_url?: string }[];
    /**
     * Open an existing/new 1:1 instead (the "group of two" egg's primary
     * button). The host closes this modal's group form by unmounting it; it
     * should do what the New Message dialog does on `onDMStarted`. Omit it and
     * the egg never appears — there would be nowhere to send the user.
     */
    onOpenDm?: (chat: StartedDm) => void;
}

const PLACEHOLDERS = [
    'e.g. The Cipherline Squad',
    'e.g. Secret Cuttlefish Society',
    'e.g. Operation Deep Blue',
    'e.g. The Encrypted Ones',
    'e.g. Just Between Us',
];

/** How many friends can be picked: the server's member cap minus you. */
const MAX_GROUP_PICKS = GROUP_MAX_MEMBERS - 1;

export const CreateGroupModal: React.FC<CreateGroupModalProps> = ({ onClose, onGroupCreated, preSelectedUsers, onOpenDm }) => {
    const { token, deviceId, userId } = useAuth();
    const toast = useToast();
    const { uploadEncryptedFile } = useAttachments(token);
    const { broadcastGroupAvatarKey } = useAvatarBroadcast(token, userId);
    const { closing, handleClose } = useModalExit(onClose, 260);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const [friends, setFriends] = useState<any[]>([]);
    const [loadingFriends, setLoadingFriends] = useState(true);
    const [friendsFailed, setFriendsFailed] = useState(false);
    const [friendsReload, setFriendsReload] = useState(0);

    const [groupName, setGroupName] = useState('');
    const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(
        new Set((preSelectedUsers || []).map(u => u.user_id))
    );
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [egg, setEgg] = useState<string | null>(null);
    const placeholderIdx = useRef(Math.floor(Math.random() * PLACEHOLDERS.length));

    // ── Egg: a "group" of you + one person ───────────────────────────────────
    // Hooked into handleCreate (the one submit path), so it fires whichever
    // door the user came in by: New Message's group link, the sidebar button,
    // Add-to-group → Create new, a keyboard shortcut.
    const [twoOf, setTwoOf] = useState<{ person: GroupOfTwoPerson; shown: number } | null>(null);
    const [dmBusy, setDmBusy] = useState(false);
    const [dmError, setDmError] = useState<string | null>(null);

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
            if (isMounted) { setFriends(res.data.accepted || []); setFriendsFailed(false); setLoadingFriends(false); }
        }).catch(() => {
            if (isMounted) { setFriendsFailed(true); setLoadingFriends(false); }
        });
        return () => { isMounted = false; };
    }, [token, friendsReload]);

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

    const handleCreate = async (opts?: { skipGroupOfTwo?: boolean }) => {
        if (!groupName.trim()) {
            setError('Group name is required');
            return;
        }
        if (selectedFriendIds.size === 0) {
            setError('Select at least one friend');
            return;
        }

        if (!opts?.skipGroupOfTwo && onOpenDm) {
            const person = groupOfTwoTarget({
                selectedIds: Array.from(selectedFriendIds),
                people: [...friends, ...(preSelectedUsers ?? [])],
                insistedCount: eggCountNow(GROUP_OF_TWO_INSISTED),
            });
            if (person) {
                const shown = eggCountNow(GROUP_OF_TWO_SHOWN);
                noteEggNow(GROUP_OF_TWO_SHOWN);
                recordEggFound('group-of-two');
                setDmError(null);
                setTwoOf({ person, shown });
                return;
            }
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
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
                await axios.patch(apiUrl`/conversations/${conversationId}`, {
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

    const openDmInstead = async () => {
        if (!twoOf || !onOpenDm || dmBusy) return;
        setDmBusy(true);
        setDmError(null);
        try {
            const chat = await startDirectMessage({ token, deviceId, person: twoOf.person });
            onOpenDm(chat);
            setTwoOf(null);
            handleClose();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setDmError(
                err?.response?.status === 403
                    ? `You can't message ${twoOf.person.username} right now. Make the group anyway, or sort out the friendship first.`
                    : `Couldn't open your chat with ${twoOf.person.username}. Check your connection, or make the group anyway.`,
            );
        } finally {
            setDmBusy(false);
        }
    };

    const makeGroupAnyway = () => {
        if (dmBusy) return;
        noteEggNow(GROUP_OF_TWO_INSISTED);
        setTwoOf(null);
        void handleCreate({ skipGroupOfTwo: true });
    };

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

    const atCap = selectedFriendIds.size >= MAX_GROUP_PICKS;
    const ready = !!groupName.trim() && selectedFriendIds.size > 0;
    let hint: React.ReactNode;
    if (atCap) hint = <span><span className="dlg-hint-strong">Group limit reached</span> ({GROUP_MAX_MEMBERS} with you)</span>;
    else if (selectedFriendIds.size > 0) hint = <><Users size={14} /><span><span className="dlg-hint-strong">{selectedFriendIds.size}</span> selected</span></>;
    else hint = <span>Pick at least one friend</span>;

    return (
      <>
        <ClModal
            open={!closing}
            onClose={requestClose}
            width={480}
            label="Create group chat"
            cardClassName="dlg-card"
        >
          <form className="dlg-form" noValidate onSubmit={(e) => { e.preventDefault(); if (!isCreating && !twoOf) void handleCreate(); }}>
            <DialogHeader
                icon={<Users size={19} strokeWidth={2.2} />}
                title="New group chat"
                subtitle="Name it, add a photo, and pick who's in."
            />
            <DialogBody>
                {/* Photo + name — plain buttons throughout, not ClButton: the kit's
                    `.cap` fixes its own size/background/radius and ClButton puts the
                    `style` prop on the outer wrapper, so a small round camera badge
                    built from ClButton silently renders at the kit's default 46px
                    icon-button size instead of whatever size is asked for. */}
                <div className="dlg-identity">
                    <div className="relative shrink-0">
                        <button
                            type="button"
                            onClick={() => avatarInputRef.current?.click()}
                            className="cl-newgroup-avatar-picker group"
                            aria-label="Set a group photo"
                        >
                            {avatarPreview ? (
                                <img src={avatarPreview} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <Camera size={22} className="text-cl-faint" />
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
                    <div className="dlg-field" style={{ flex: 1, minWidth: 0 }}>
                        <label className="dlg-label" htmlFor="create-group-name">Group name</label>
                        <ClInput
                            id="create-group-name"
                            type="text"
                            value={groupName}
                            onChange={handleNameChange}
                            placeholder={PLACEHOLDERS[placeholderIdx.current]}
                            autoFocus
                            autoComplete="off"
                        />
                    </div>
                </div>
                {avatarError && <div className="dlg-help" style={{ color: 'var(--cl-flash, #FF6B5E)', marginTop: 8 }}>{avatarError}</div>}
                {egg && <div className="text-[12px] font-bold text-cl-lume" style={{ marginTop: 8 }}>{egg}</div>}

                <div className="dlg-label" style={{ margin: '18px 0 8px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Members</span>
                    {preSelectedUsers && preSelectedUsers.length > 0 && (
                        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 700 }}>
                            {preSelectedUsers.map(u => u.username).join(', ')} pre-added
                        </span>
                    )}
                </div>
                <MemberPicker
                    people={friends}
                    loading={loadingFriends}
                    loadFailed={friendsFailed}
                    onRetry={() => { setLoadingFriends(true); setFriendsFailed(false); setFriendsReload(k => k + 1); }}
                    selection={Array.from(selectedFriendIds)}
                    onSelectionChange={(next) => { setSelectedFriendIds(new Set(next)); setError(null); }}
                    max={MAX_GROUP_PICKS}
                    token={token}
                    knownPeople={preSelectedUsers}
                    ariaLabel="Search friends to add"
                    emptyTitle="No friends yet"
                    emptyBody="Add a friend first, then you can start a group with them."
                    onSubmit={() => { if (!isCreating && !twoOf) void handleCreate(); }}
                    disabled={isCreating}
                    compact
                />
            </DialogBody>
            {error && <DialogError>{error}</DialogError>}
            <DialogFooter hint={hint}>
                <ClButton type="button" variant="ghost" size="sm" disabled={isCreating} onClick={handleClose}>
                    Cancel
                </ClButton>
                <ClButton
                    type="submit"
                    size="sm"
                    disabled={isCreating || !ready}
                    loading={isCreating}
                    tooltip={!ready ? 'Name the group and pick a friend' : undefined}
                >
                    Create group
                </ClButton>
            </DialogFooter>
          </form>
        </ClModal>

        {twoOf && (
            <GroupOfTwoDialog
                name={twoOf.person.username}
                {...groupOfTwoCopy(twoOf.shown, twoOf.person.username)}
                busy={dmBusy}
                error={dmError}
                onOpenDm={() => { void openDmInstead(); }}
                onProceed={makeGroupAnyway}
                onDismiss={() => { setTwoOf(null); setDmError(null); }}
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
