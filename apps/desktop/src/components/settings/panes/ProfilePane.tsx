import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { Save, Image as ImageIcon, Camera, Trash2, Lock, RotateCcw, Crown } from 'lucide-react';
import { ClButton, ClInput, ClTextarea, ClImageCropper, ClRole } from '../../cl';
import { useSubscription } from '../../../contexts/SubscriptionContext';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import { Banner } from '../../Banner';
import RecoveryKeyCard from '../../RecoveryKeyCard';
import { TotpSettingsCard } from '../../auth/TotpSettingsCard';
import { ChangePasswordModal } from '../../auth/ChangePasswordModal';
import axios from 'axios';
import { API_BASE } from '../../../constants';
import { useAttachments } from '../../../hooks/useAttachments';
import { useAvatarBroadcast } from '../../../hooks/useAvatarBroadcast';
import { saveAvatarKey } from '../../../utils/avatarKeyStore';
import { uploadAvatarBlob } from '../../../utils/avatarUpload';
import { AVATAR_OUTPUT, BANNER_OUTPUT } from '../../../utils/imageCrop';
import { useReportDirty } from '../../../hooks/useUnsavedChangesGuard';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../../../utils/imageUploadValidation';
import { useToast } from '../../../contexts/ToastContext';
import { padDiscriminator, USERNAME_REGEX } from '@cipherline/shared';

/**
 * Surface · Profile — Descent redesign (phase 1).
 *
 * One identity card: banner and avatar manage themselves on hover (no
 * floating remove-button row), name + tag read as a heading, and a
 * dirty-state save bar springs up only when there is actually something to
 * save. Below it, one unified Security card: 2FA, recovery key, password.
 */

/** Bio placeholder pool — rotates per focus (personality doctrine: owned slot, ≥3 lines). */
const BIO_PLACEHOLDERS = [
    'Tell us a little about yourself…',
    '160 characters of plausible deniability.',
    'Keep it cryptic.',
    'The bio is optional. The mystery is free.',
];

export const ProfilePane: React.FC<{ onDirtyChange?: (dirty: boolean) => void }> = ({ onDirtyChange }) => {
    const { user, token, refreshProfile } = useAuth();
    const subscription = useSubscription();
    // Same rule as the server's badge: paying or comped, not a trial.
    const isPro = subscription.isPaid && subscription.status?.subscription_status !== 'trial';
    const toast = useToast();

    const [usernameDraft, setUsernameDraft] = useState(user?.username || '');
    const [bio, setBio] = useState(user?.bio || '');
    const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null);
    const [avatarFile, setAvatarFile] = useState<Blob | null>(null);
    const [bannerUrl, setBannerUrl] = useState<string | null>(user?.banner_url ?? null);
    const [bannerFile, setBannerFile] = useState<Blob | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [showPwModal, setShowPwModal] = useState(false);
    const [bioPlaceholder, setBioPlaceholder] = useState(BIO_PLACEHOLDERS[0]);
    /** The image awaiting crop, and which surface it was picked for. */
    const [cropTarget, setCropTarget] = useState<{ kind: 'avatar' | 'banner'; file: File } | null>(null);
    const bioFocusCount = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const bannerFileInputRef = useRef<HTMLInputElement>(null);

    // P2-REND-13: track latest blob URLs so the unmount cleanup always revokes
    // the most-recent preview URL, even though the cleanup effect has empty deps.
    const avatarUrlRef = useRef<string | null>(avatarUrl);
    avatarUrlRef.current = avatarUrl;
    const bannerUrlRef = useRef<string | null>(bannerUrl);
    bannerUrlRef.current = bannerUrl;
    useEffect(() => {
        return () => {
            if (avatarUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(avatarUrlRef.current);
            if (bannerUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(bannerUrlRef.current);
        };
    }, []);

    const { uploadEncryptedFile } = useAttachments(token);
    const { broadcastProfileAvatarKey } = useAvatarBroadcast(token, user?.user_id || null);

    // Anything to save? Compares drafts against the profile the server knows.
    const dirty = useMemo(() => {
        const baseName = user?.username || '';
        const baseBio = user?.bio || '';
        if (usernameDraft.trim() !== baseName) return true;
        if (bio !== baseBio) return true;
        if (avatarFile || bannerFile) return true;
        if (avatarUrl === '' && user?.avatar_url) return true;   // pending removal
        if (bannerUrl === '' && user?.banner_url) return true;   // pending removal
        return false;
    }, [usernameDraft, bio, avatarFile, bannerFile, avatarUrl, bannerUrl, user]);

    useReportDirty(dirty, onDirtyChange);

    const usernameInvalid = usernameDraft.trim() !== '' && !USERNAME_REGEX.test(usernameDraft.trim());

    const handleReset = () => {
        if (avatarUrl?.startsWith('blob:')) URL.revokeObjectURL(avatarUrl);
        if (bannerUrl?.startsWith('blob:')) URL.revokeObjectURL(bannerUrl);
        setUsernameDraft(user?.username || '');
        setBio(user?.bio || '');
        setAvatarUrl(user?.avatar_url ?? null);
        setBannerUrl(user?.banner_url ?? null);
        setAvatarFile(null);
        setBannerFile(null);
    };

    /** Hand a picked file to the cropper; it returns the final blob via onConfirm. */
    const pickForCrop = (
        kind: 'avatar' | 'banner',
        e: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const result = validateImageUpload(e.target.files?.[0]);
        // Always clear the input: without this, cancelling the cropper and
        // re-picking the same file fires no change event.
        if (e.target) e.target.value = '';
        if (!result.ok) {
            toast.push({
                kind: 'error',
                title: kind === 'avatar' ? 'Invalid avatar' : 'Invalid banner',
                message: result.reason,
            });
            return;
        }
        if (result.file) setCropTarget({ kind, file: result.file });
    };

    const handleCropped = (blob: Blob) => {
        const kind = cropTarget?.kind;
        setCropTarget(null);
        if (kind === 'avatar') {
            setAvatarFile(blob);
            setAvatarUrl(prev => {
                if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
                return URL.createObjectURL(blob);
            });
        } else if (kind === 'banner') {
            setBannerFile(blob);
            setBannerUrl(prev => {
                if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
                return URL.createObjectURL(blob);
            });
        }
    };

    const handleSaveProfile = async () => {
        if (!token) return;
        setSaving(true);
        try {
            let finalAvatarId: string | null | undefined = avatarUrl === null ? undefined : avatarUrl;
            let finalBannerId: string | null | undefined = bannerUrl === null ? undefined : bannerUrl;
            if (avatarFile) {
                finalAvatarId = await uploadAvatarBlob(avatarFile, { uploadEncryptedFile, broadcastProfileAvatarKey });
            }
            if (bannerFile) {
                const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(bannerFile, 'banner.jpg', 'image/jpeg');
                finalBannerId = attachmentId;
                await saveAvatarKey(attachmentId, keyB64, nonceB64);
                await broadcastProfileAvatarKey(attachmentId, keyB64, nonceB64);
            }
            const patchBody: Record<string, unknown> = { bio };
            if (usernameDraft.trim() && usernameDraft.trim() !== user?.username) {
                patchBody.username = usernameDraft.trim();
            }
            if (finalAvatarId !== undefined) patchBody.avatar_url = finalAvatarId === '' ? null : finalAvatarId;
            if (finalBannerId !== undefined) patchBody.banner_url = finalBannerId === '' ? null : finalBannerId;
            await axios.patch(`${API_BASE}/auth/profile`, patchBody, {
                headers: { Authorization: `Bearer ${token}` }
            });
            await refreshProfile();
            // Sync drafts to the just-saved ids so the save bar retracts
            // (blob previews keep displaying the new image either way).
            if (finalAvatarId !== undefined && !avatarUrl?.startsWith('blob:')) {
                setAvatarUrl(finalAvatarId === '' ? null : finalAvatarId);
            }
            if (finalBannerId !== undefined && !bannerUrl?.startsWith('blob:')) {
                setBannerUrl(finalBannerId === '' ? null : finalBannerId);
            }
            setAvatarFile(null);
            setBannerFile(null);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            console.error('Failed to save profile', err);
            toast.push({ kind: 'error', title: 'Save Failed', message: 'Failed to save profile. Please try again.' });
        } finally {
            setSaving(false);
        }
    };

    const bioLen = bio.length;
    const bioCountClass = bioLen >= 160 ? ' sd-full' : bioLen >= 140 ? ' sd-warm' : '';

    return (
        <>
            {/* ── The identity card ─────────────────────────────────────── */}
            <div className="sd-card sd-card--bare">
                <div className="sd-id">
                    {/* Banner: hover reveals change hint + remove action */}
                    <div className="sd-id-banner" onClick={() => bannerFileInputRef.current?.click()}>
                        {bannerUrl?.startsWith('blob:') ? (
                            <div className="cipherline-banner" style={{ height: 150 }}>
                                <div className="cipherline-banner-fallback" />
                                <img src={bannerUrl} alt="" className="cipherline-banner-img" />
                            </div>
                        ) : (
                            <Banner
                                attachmentId={bannerUrl ? (user?.banner_url ?? null) : null}
                                fallbackAvatarAttachmentId={avatarUrl || (user?.avatar_url ?? null)}
                                fallbackUserId={user?.user_id}
                                token={token ?? ''}
                                height={150}
                            />
                        )}
                        <div className="sd-id-bhint"><span><ImageIcon size={14} /> Change banner</span></div>
                        {bannerUrl && (
                            <div className="sd-id-bactions" onClick={e => e.stopPropagation()}>
                                <ClButton icon variant="ghost" size="sm" tooltip="Remove banner"
                                    onClick={() => { setBannerUrl(''); setBannerFile(null); }}>
                                    <Trash2 size={13} />
                                </ClButton>
                            </div>
                        )}
                        <input type="file" accept={IMAGE_ACCEPT_ATTR} className="hidden" ref={bannerFileInputRef} onChange={(e) => pickForCrop('banner', e)} />
                    </div>

                    {/* Avatar + name */}
                    <div className="sd-id-head">
                        <div
                            className="sd-id-av"
                            style={{ '--tw-ring-color': 'var(--cl-deep)' } as React.CSSProperties}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <EncryptedAvatar
                                attachmentId={avatarUrl || null}
                                userId={user?.user_id}
                                token={token}
                                className="w-[72px] h-[72px] object-cover ring-4"
                                fallbackSize={28}
                                disableClickProfile
                            />
                            <div className="sd-id-avhint"><Camera size={16} /></div>
                            {avatarUrl && (
                                // stopPropagation because the whole .sd-id-av is a
                                // click target that opens the file picker — without
                                // it, removing the avatar would immediately reopen
                                // the picker. Same reason the banner's action does it.
                                <div className="sd-id-avactions" onClick={e => e.stopPropagation()}>
                                    <ClButton icon variant="ghost" size="sm" tooltip="Remove avatar"
                                        onClick={() => setAvatarUrl('')}>
                                        <Trash2 size={12} />
                                    </ClButton>
                                </div>
                            )}
                            <input type="file" accept={IMAGE_ACCEPT_ATTR} className="hidden" ref={fileInputRef} onChange={(e) => pickForCrop('avatar', e)} />
                        </div>
                        <div className="sd-id-who">
                            <b>{user?.username}</b>
                            {user?.discriminator !== null && user?.discriminator !== undefined && (
                                <span className="sd-id-tag">#{padDiscriminator(user.discriminator)}</span>
                            )}
                            {isPro && (
                                <ClRole variant="gold" style={{ fontSize: 11, marginLeft: 6 }}>
                                    <Crown size={11} aria-hidden /> Pro
                                </ClRole>
                            )}
                        </div>
                    </div>

                    {/* Fields */}
                    <div className="sd-id-fields">
                        <div className="cl-fld">
                            <label>Username</label>
                            <div className="flex items-stretch gap-2">
                                <div className="flex-1">
                                    <ClInput
                                        type="text"
                                        value={usernameDraft}
                                        onChange={(e) => setUsernameDraft(e.target.value)}
                                        placeholder="Username"
                                        maxLength={32}
                                        minLength={3}
                                        style={{ width: '100%' }}
                                    />
                                </div>
                                {user?.discriminator !== null && user?.discriminator !== undefined && (
                                    <span className="flex items-center px-3 text-[13px] font-semibold rounded-xl tracking-wide select-none" style={{ background: 'rgba(0,0,0,.3)', border: '1px solid var(--cl-border)', color: 'var(--cl-muted)', fontFamily: 'var(--cl-font-mono)' }}>
                                        #{padDiscriminator(user.discriminator)}
                                    </span>
                                )}
                            </div>
                            {usernameInvalid && (
                                <p className="cl-fmsg">3–32 characters — letters, digits, underscore.</p>
                            )}
                            {!usernameInvalid && usernameDraft.trim() !== '' && usernameDraft.trim() !== user?.username && (
                                <p className="text-[11px] mt-1" style={{ color: 'var(--cl-glow)' }}>Saving will reassign your #tag under the new name.</p>
                            )}
                        </div>

                        <div className="cl-fld">
                            <label>About me</label>
                            <ClTextarea
                                value={bio}
                                onChange={(e) => setBio(e.target.value)}
                                onFocus={() => setBioPlaceholder(BIO_PLACEHOLDERS[(bioFocusCount.current++) % BIO_PLACEHOLDERS.length])}
                                placeholder={bioPlaceholder}
                                maxLength={160}
                                style={{ width: '100%', height: 88, resize: 'none' }}
                            />
                            <div className={`sd-bio-count${bioCountClass}`}>{bioLen} / 160</div>
                        </div>
                    </div>

                    {/* Save bar — springs up only when something changed */}
                    <div className={`sd-savebar-wrap${dirty || saving ? ' sd-open' : ''}`}>
                        <div className="sd-savebar">
                            <p>{saving ? 'Saving…' : 'You have unsaved changes.'}</p>
                            <ClButton variant="ghost" size="sm" onClick={handleReset} disabled={saving}>
                                <RotateCcw size={13} /> Reset
                            </ClButton>
                            <ClButton size="sm" onClick={handleSaveProfile} disabled={saving || usernameInvalid} loading={saving}>
                                <Save size={14} /> Save changes
                            </ClButton>
                        </div>
                    </div>
                    {/* Post-save confirmation rides the same slot, then retracts */}
                    <div className={`sd-savebar-wrap${!dirty && !saving && saved ? ' sd-open' : ''}`}>
                        <div className="sd-savebar">
                            <p style={{ color: 'var(--cl-lume)' }}>Saved.</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Security ─────────────────────────────────────────────── */}
            <div className="sd-card">
                <h3>Security</h3>
                <p className="sd-sub">Second factors and the keys that guard this device.</p>
                <div className="flex flex-col gap-3">
                    <TotpSettingsCard bare />
                    <RecoveryKeyCard />
                    <div className="sd-secrow" style={{ paddingBottom: 0 }}>
                        <span className="sd-sic"><Lock size={16} /></span>
                        <div className="sd-smeta">
                            <b>Change password</b>
                            <span>You will be signed out of all other sessions.</span>
                        </div>
                        <ClButton size="sm" variant="ghost" onClick={() => setShowPwModal(true)}>
                            Change…
                        </ClButton>
                    </div>
                </div>
            </div>

            <ChangePasswordModal open={showPwModal} onClose={() => setShowPwModal(false)} />

            <ClImageCropper
                open={!!cropTarget}
                file={cropTarget?.file ?? null}
                outputWidth={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.width : AVATAR_OUTPUT.width}
                outputHeight={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.height : AVATAR_OUTPUT.height}
                shape={cropTarget?.kind === 'banner' ? 'rect' : 'circle'}
                title={cropTarget?.kind === 'banner' ? 'Position your banner' : 'Position your avatar'}
                onCancel={() => setCropTarget(null)}
                onConfirm={handleCropped}
            />
        </>
    );
};
