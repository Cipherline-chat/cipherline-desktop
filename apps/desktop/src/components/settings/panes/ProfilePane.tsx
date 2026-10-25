import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { Image as ImageIcon, Camera, Trash2, Lock, Check, Loader2, AlertCircle, Maximize2, Share2 } from 'lucide-react';
import { ClButton, ClInput, ClTextarea, ClImageCropper, ClSegment, ClToggle } from '../../cl';
import { SettingsDisclosure } from '../SettingsDisclosure';
import { SettingsDisclosureFlatCards } from '../settingsDisclosureFlat';
import { REVEAL_EVENT } from '../revealSetting';
import { ProfilePreviewCard } from './ProfilePreviewCard';
import { previewCardData, type ProfilePreviewData } from './profilePreviewData';
import { ProfileFullView } from '../../profile/ProfileFullView';
import { ProfileShareDialog } from '../../profile/ProfileShareDialog';
import { useProfileConnections } from '../../../hooks/useProfileConnections';
import '../../../styles/settings-ui.css';
import '../../../styles/profile-settings.css';
import { useMostPlayed } from '../../../hooks/useMostPlayed';
import { getTracker } from '../../../utils/achievements/tracker';
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
import { fetchProfile, noteProfileEdited, type PublicProfile } from '../../../utils/profileCache';
import { ProPill } from '../../ProPill';
import { AVATAR_OUTPUT, BANNER_OUTPUT } from '../../../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../../../utils/imageUploadValidation';
import { useToast } from '../../../contexts/ToastContext';
import { padDiscriminator } from '@cipherline/shared';
import { ProfileVisibilitySection, type PreviewVisibility } from './ProfileVisibilitySection';
import { ProfileCosmeticsSection } from './ProfileCosmeticsSection';
import { ProfileExtrasSection } from './ProfileExtrasSection';
import { sanitizeLinks } from '../../../utils/profileLinks';
import { AnimatedImageDialog } from './AnimatedImageDialog';
import { isAnimatedFile, animatedPickError } from '../../../utils/animatedImage';
import { readTheme } from '../../../utils/profileTheme';
import { showcaseBlocksOf } from '../../../utils/profileExtras';
import { deviceTimeZone, isValidTimeZone, listTimeZones, type ViewAs } from '../../../utils/profileVisibility';
import { usernameFieldState, usernameBlocksSave, usernameSaveError } from '../../../utils/usernameField';
import { requestOpenSettings } from '../../../utils/openSettingsRequest';
import { useSteamCard } from '../../../hooks/useProfileRelations';
import { readItemOptions } from '../../../utils/profileCosmetics';

/**
 * Surface · Profile — a live card and five tabs.
 *
 * A sticky live preview (beside the form on a wide pane, above it on a narrow
 * one): the SAME card other people see when they click you (the preview
 * popover), drawn from your drafts, as "Everyone" or "A friend", with "Full
 * profile" and "Share" under it. Beside it, tabs - Basics, Style, Showcase,
 * Privacy, Security - so every part is one click away and none sits below the
 * fold (owner, 2026-10-24: the customization was missed because it was a
 * scroll away). Hidden tabs stay mounted; the settings search opens the right
 * one (revealSetting, data-reveal-closed):
 *
 *  - Basics: your header (banner + avatar, changed in place), username + #tag,
 *    about me, and an opt-in local time. No Save button (owner, 2026-10-24):
 *    a new avatar / banner saves as soon as you confirm it; about me and the
 *    time zone save themselves a moment after you stop typing; everything
 *    still pending (incl. a new username, which is never saved mid-typing
 *    because it costs you a new #tag and a 24 h cooldown) saves when you leave
 *    the Profile pane or close Settings. A failure there comes back as a toast
 *    that reopens this pane. The preview header says "Saving" / "Saved".
 *  - Style: theme, decoration, effect - an inline studio: pick one, its
 *    options appear right beside the preview (ProfileCosmeticsSection).
 *  - Showcase: your level, and the sections of your card in order, each opening
 *    its own content editor (games, links, interests, eggs, achievements).
 *  - Who can see this: one preset, per-field overrides folded below.
 *
 * Below: one Security card (2FA, recovery key, password).
 */

/** Bio placeholder pool — rotates per focus (personality doctrine: owned slot, ≥3 lines). */
const BIO_PLACEHOLDERS = [
    'Tell us a little about yourself…',
    '160 characters of plausible deniability.',
    'Keep it cryptic.',
    'The bio is optional. The mystery is free.',
];

type PaneTab = 'basics' | 'style' | 'showcase' | 'privacy' | 'security';
const PANE_TABS: ReadonlyArray<{ id: PaneTab; label: string }> = [
    { id: 'basics', label: 'Basics' },
    { id: 'style', label: 'Style' },
    { id: 'showcase', label: 'Showcase' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'security', label: 'Security' },
];

/** A tab's body. Stays mounted while hidden; a settings-search hit inside it brings it forward. */
const PaneTabPanel: React.FC<{ id: PaneTab; idBase: string; active: boolean; onReveal: () => void; children: React.ReactNode }> = ({ id, idBase, active, onReveal, children }) => {
    const ref = useRef<HTMLDivElement>(null);
    const onRevealRef = useRef(onReveal);
    useEffect(() => { onRevealRef.current = onReveal; });
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const fn = () => onRevealRef.current();
        el.addEventListener(REVEAL_EVENT, fn);
        return () => el.removeEventListener(REVEAL_EVENT, fn);
    }, []);
    return (
        <div ref={ref} role="tabpanel" id={`${idBase}-${id}`} aria-labelledby={`${idBase}-tab-${id}`} hidden={!active}
            data-reveal-closed={active ? undefined : 'true'} className="pp-tabpanel" data-testid={`profile-pane-${id}`}>
            {children}
        </div>
    );
};

/** How long after the last keystroke about me / time zone save themselves. */
export const AUTOSAVE_MS = 1200;
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

export const ProfilePane: React.FC<{ onDirtyChange?: (dirty: boolean) => void }> = () => {
    const { user, token, refreshProfile } = useAuth();
    const subscription = useSubscription();
    // Same rule as the server's badge (getPublicProfile): effective status
    // 'active' - paying, comped, or in a live trial. Display only.
    const isPro = subscription.isPaid;
    // Your own public profile, as other people get it: the Pro "member since"
    // month, your badges and your achievement count, for the preview. One
    // source of truth (the same response others see), cached for 30s.
    const [ownPublic, setOwnPublic] = useState<PublicProfile | null>(null);
    useEffect(() => {
        if (!user?.user_id || !token) return;
        let cancelled = false;
        fetchProfile(user.user_id, token, { maxAgeMs: 30_000 })
            .then((p) => { if (!cancelled) setOwnPublic(p); })
            .catch(() => { /* decoration: the preview draws without them */ });
        return () => { cancelled = true; };
    }, [user?.user_id, token]);
    const proSince = ownPublic?.pro_since ?? null;
    const toast = useToast();

    const [usernameDraft, setUsernameDraft] = useState(user?.username || '');
    const [bio, setBio] = useState(user?.bio || '');
    // Opt-in time zone. Empty = unset.
    const [timeZone, setTimeZone] = useState(user?.time_zone || '');
    const suggestedZone = useMemo(() => deviceTimeZone(), []);
    const zoneOptions = useMemo(() => listTimeZones(), []);
    const timeZoneInvalid = timeZone.trim() !== '' && !isValidTimeZone(timeZone.trim());
    // (An empty zone = local time not shown.)
    const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null);
    const [bannerUrl, setBannerUrl] = useState<string | null>(user?.banner_url ?? null);
    const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
    const [showPwModal, setShowPwModal] = useState(false);
    const [bioPlaceholder, setBioPlaceholder] = useState(BIO_PLACEHOLDERS[0]);
    /** A username rejection from the last save (filter / cooldown / clash),
     *  for the value it was rejected on. */
    const [usernameServerError, setUsernameServerError] = useState<{ value: string; message: string } | null>(null);
    /** `next_change_at` from a 429, so the field locks at once instead of
     *  waiting for /auth/me to catch up. */
    const [lockedUntil, setLockedUntil] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    /** The image awaiting crop, and which surface it was picked for. */
    const [cropTarget, setCropTarget] = useState<{ kind: 'avatar' | 'banner'; file: File } | null>(null);
    /** An animated pick (GIF / animated WebP): kept as-is, previewed instead of cropped. */
    const [animatedTarget, setAnimatedTarget] = useState<{ kind: 'avatar' | 'banner'; file: File } | null>(null);
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

    // The username field: format, the shared profanity filter, and the 24 h
    // change cooldown — mirrored for UX; the server enforces all three.
    const nextUsernameChangeAt = lockedUntil ?? user?.next_username_change_at ?? null;
    const usernameField = usernameFieldState({
        draft: usernameDraft,
        current: user?.username || '',
        nextChangeAt: nextUsernameChangeAt,
        pending: user?.username_pending === true,
        now,
    });
    const usernameLocked = usernameField.kind === 'locked';
    const usernameInvalid = usernameBlocksSave(usernameField);
    // Tick while locked so "again in N h" counts down and the field unlocks on time.
    useEffect(() => {
        if (!nextUsernameChangeAt) return;
        const t = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(t);
    }, [nextUsernameChangeAt]);
    // While locked the field shows (and saves) the current name, whatever
    // the draft holds, so a stale draft can never ride along with a bio save.
    const effectiveUsernameDraft = usernameLocked ? (user?.username || '') : usernameDraft;
    const usernameErrorFor = usernameServerError && usernameServerError.value === usernameDraft.trim() ? usernameServerError.message : null;

    // ── saving without a Save button ─────────────────────────────────────────
    const latest = useRef({
        username: effectiveUsernameDraft, bio, timeZone, user, token, usernameInvalid: false, timeZoneInvalid: false,
    });
    useLayoutEffect(() => {
        latest.current = { username: effectiveUsernameDraft, bio, timeZone, user, token, usernameInvalid, timeZoneInvalid };
    });
    /** What differs from the server copy, field by field (valid values only). */
    const pendingBody = (fields: ReadonlyArray<'username' | 'bio' | 'time_zone'>): Record<string, unknown> => {
        const body: Record<string, unknown> = {};
        const u = latest.current;
        if (fields.includes('username') && !u.usernameInvalid && u.username.trim() && u.username.trim() !== (u.user?.username || '')) body.username = u.username.trim();
        if (fields.includes('bio') && u.bio !== (u.user?.bio || '')) body.bio = u.bio;
        if (fields.includes('time_zone') && !u.timeZoneInvalid && u.timeZone.trim() !== (u.user?.time_zone || '')) body.time_zone = u.timeZone.trim();
        return body;
    };
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const savedTimer = useRef<number | null>(null);
    const showSaved = useCallback(() => {
        if (!mounted.current) return;
        setSaveState({ kind: 'saved' });
        if (savedTimer.current) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => { if (mounted.current) setSaveState({ kind: 'idle' }); }, 2200);
    }, []);

    /**
     * PATCH `body` (only the keys that changed). Errors: while the pane is
     * open they show inline (a username problem next to the field too); after
     * it closed, as a toast that reopens Settings > Profile.
     */
    const patchProfile = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
        const tok = latest.current.token;
        if (!tok || Object.keys(body).length === 0) return true;
        if (mounted.current) setSaveState({ kind: 'saving' });
        try {
            await axios.patch(`${API_BASE}/auth/profile`, body, { headers: { Authorization: `Bearer ${tok}` } });
            noteProfileEdited(latest.current.user?.user_id, body as { avatar_url?: string | null; banner_url?: string | null });
            await refreshProfile();
            showSaved();
            return true;
        } catch (err) {
            console.error('Failed to save profile', err);
            const nameErr = body.username !== undefined ? usernameSaveError(err) : null;
            const m = axios.isAxiosError(err) && err.response?.status === 400
                ? (err.response.data as { message?: string | string[] } | undefined)?.message
                : undefined;
            const detail = nameErr?.message ?? ((Array.isArray(m) ? m[0] : m) || 'Your profile could not be saved. Please try again.');
            if (mounted.current) {
                setSaveState({ kind: 'error', message: detail });
                if (nameErr) {
                    setUsernameServerError({ value: String(body.username), message: nameErr.message });
                    if (nameErr.nextChangeAt) {
                        setLockedUntil(nameErr.nextChangeAt);
                        setUsernameDraft(latest.current.user?.username || '');
                        setNow(Date.now());
                        void refreshProfile();
                    }
                }
            } else {
                toast.push({
                    kind: 'error', title: 'Profile not saved', message: detail,
                    action: { label: 'Open profile', onClick: () => requestOpenSettings('profile') },
                });
            }
            return false;
        }
    }, [refreshProfile, toast, showSaved]);

    // About me / time zone save themselves a moment after typing stops (a crash loses nothing).
    useEffect(() => {
        if (Object.keys(pendingBody(['bio', 'time_zone'])).length === 0) return;
        const t = window.setTimeout(() => {
            for (const [k, v] of Object.entries(pendingBody(['bio', 'time_zone']))) void patchProfile({ [k]: v });
        }, AUTOSAVE_MS);
        return () => window.clearTimeout(t);
    }, [bio, timeZone, timeZoneInvalid, patchProfile]);

    // Leaving the pane (another pane, or Settings closing) saves whatever is still pending.
    useEffect(() => () => {
        // One PATCH per field, so a rejected one (a taken name, a filtered bio) never holds back the others.
        const body = pendingBody(['username', 'bio', 'time_zone']);
        for (const [k, v] of Object.entries(body)) void patchProfile({ [k]: v });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on unmount, with the latest drafts
    }, []);

    /** Hand a picked file to the cropper; it returns the final blob via onConfirm. */
    const pickForCrop = async (
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
        if (!result.file) return;
        // Animated files skip the crop (it would flatten them to a still JPEG).
        if (await isAnimatedFile(result.file)) {
            const tooBig = animatedPickError(result.file);
            if (tooBig) {
                toast.push({ kind: 'error', title: kind === 'avatar' ? 'Invalid avatar' : 'Invalid banner', message: tooBig });
                return;
            }
            setAnimatedTarget({ kind, file: result.file });
            return;
        }
        setCropTarget({ kind, file: result.file });
    };

    const handleCropped = (blob: Blob, kindOverride?: 'avatar' | 'banner') => {
        const kind = kindOverride ?? cropTarget?.kind;
        setCropTarget(null);
        if (kind === 'avatar') {
            setAvatarUrl(prev => {
                if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
                return URL.createObjectURL(blob);
            });
            void saveImage('avatar', blob);
        } else if (kind === 'banner') {
            setBannerUrl(prev => {
                if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
                return URL.createObjectURL(blob);
            });
            void saveImage('banner', blob);
        }
    };

    /**
     * A confirmed avatar / banner is encrypted, uploaded and saved at once; null
     * removes it. Uploads keep their own MIME type (an animated pick stays
     * animated): avatarFile.type || 'image/jpeg', bannerFile.type || 'image/jpeg'.
     */
    const saveImage = async (kind: 'avatar' | 'banner', file: Blob | null) => {
        if (!token) return;
        setSaveState({ kind: 'saving' });
        try {
            let id: string | null = null;
            if (file && kind === 'avatar') {
                const avatarFile = file;
                id = await uploadAvatarBlob(avatarFile, { uploadEncryptedFile, broadcastProfileAvatarKey }, 'avatar.jpg', avatarFile.type || 'image/jpeg');
            } else if (file) {
                const bannerFile = file;
                const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(bannerFile, 'banner.jpg', bannerFile.type || 'image/jpeg');
                id = attachmentId;
                await saveAvatarKey(attachmentId, keyB64, nonceB64);
                await broadcastProfileAvatarKey(attachmentId, keyB64, nonceB64);
            }
            const ok = await patchProfile(kind === 'avatar' ? { avatar_url: id } : { banner_url: id });
            if (!ok) return;
            if (kind === 'avatar') { if (!id) setAvatarUrl(null); } else if (!id) setBannerUrl(null);
        } catch (err) {
            console.error('Failed to upload profile image', err);
            if (mounted.current) setSaveState({ kind: 'error', message: kind === 'avatar' ? 'Your avatar could not be uploaded. Try again.' : 'Your banner could not be uploaded. Try again.' });
        }
    };

    // Identity shared by the sticky live preview and the pickers' thumbnails.
    const previewBase = {
        userId: user?.user_id,
        token: token ?? null,
        username: effectiveUsernameDraft.trim() || user?.username || '',
        discriminator: user?.discriminator,
        timeZone,
        bio,
        bannerAttachmentId: bannerUrl && !bannerUrl.startsWith('blob:') ? (user?.banner_url ?? null) : null,
        bannerSrc: bannerUrl?.startsWith('blob:') ? bannerUrl : null,
        avatarAttachmentId: avatarUrl || null,
    };

    // The sections report their drafts here so ONE card previews everything.
    const [live, setLive] = useState<Partial<ProfilePreviewData>>({});
    const onPreview = useCallback((patch: Partial<ProfilePreviewData>) => {
        setLive((prev) => {
            const keys = Object.keys(patch) as Array<keyof ProfilePreviewData>;
            return keys.every((k) => prev[k] === patch[k]) ? prev : { ...prev, ...patch };
        });
    }, []);
    const [viewAs, setViewAs] = useState<ViewAs>('everyone');
    const [view, setView] = useState<PreviewVisibility>({ seen: { bio: true, banner: true, local_time: true, widgets: true, links: true }, friendsOnly: [] });
    const onView = useCallback((v: PreviewVisibility) => {
        setView((prev) => (JSON.stringify(prev) === JSON.stringify(v) ? prev : v));
    }, []);

    // Your verified Steam, as the card shows it (persona + avatar from the server).
    const ownSteam = useSteamCard(user?.steam ? user.user_id : null, token ?? null);

    // Your most played reaches friends only while you share it (Personalize > Activity).
    const mostPlayed = useMostPlayed(user?.user_id, true);
    const sharesMostPlayed = getTracker()?.getState().prefs.mostPlayed ?? false;

    const previewData: ProfilePreviewData = {
        ...previewBase,
        theme: readTheme(user?.profile_theme), decoration: user?.avatar_decoration ?? null, effect: user?.profile_effect ?? null,
        decorationOptions: readItemOptions(user?.cosmetic_options?.d, 'decoration', user?.avatar_decoration),
        effectOptions: readItemOptions(user?.cosmetic_options?.e, 'effect', user?.profile_effect),
        level: user?.profile_level?.level ?? 0,
        games: user?.widget_games ?? [], links: sanitizeLinks(user?.profile_links),
        steam: user?.steam ? { steamId: user.steam.steam_id, personaName: ownSteam?.persona_name ?? null, avatar: ownSteam?.avatar ?? null } : null,
        blocks: showcaseBlocksOf(user?.profile_showcase).blocks, topAchievements: showcaseBlocksOf(user?.profile_showcase).top_achievements,
        interests: user?.interests ?? [],
        isPro, proSince: isPro ? proSince : null, badges: ownPublic?.badges ?? [],
        achievementCount: ownPublic?.achievement_count ?? null, highFiveCount: user?.high_five_count ?? ownPublic?.high_five_count ?? 0,
        mostPlayed: sharesMostPlayed ? mostPlayed.games : [],
        ...live,
        // The identity drafts always win over anything a section last reported.
        ...previewBase,
    };

    const refreshAfter = async (body: Record<string, unknown>) => {
        noteProfileEdited(user?.user_id, body);
        await refreshProfile();
    };

    // Tabs, and the two things the preview opens: your full profile and your share card.
    const [tab, setTab] = useState<PaneTab>('basics');
    const tabsId = React.useId();
    const tabsRef = useRef<HTMLDivElement>(null);
    const onTabKey = (e: React.KeyboardEvent) => {
        const i = PANE_TABS.findIndex((t) => t.id === tab);
        let j = i;
        if (e.key === 'ArrowRight') j = (i + 1) % PANE_TABS.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + PANE_TABS.length) % PANE_TABS.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = PANE_TABS.length - 1;
        else return;
        e.preventDefault();
        setTab(PANE_TABS[j].id);
        tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
    };
    const [fullOpen, setFullOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const ownConnections = useProfileConnections({ userId: user?.user_id ?? '', isSelf: true, profile: ownPublic, steamPersona: ownSteam?.persona_name ?? null });
    const ownCard = previewCardData(previewData, view.seen, view.friendsOnly, viewAs === 'friend');

    const bioLen = bio.length;
    const showsTime = timeZone !== '';
    const basicsSummary = [
        user?.username ? `${user.username}${user.discriminator != null ? `#${padDiscriminator(user.discriminator)}` : ''}` : null,
        bio.trim() ? 'bio' : 'no bio',
        showsTime ? 'local time shown' : null,
    ].filter(Boolean).join(', ');

    return (
        <div className="pp-wrap">
            <div className="pp-layout">
                {/* ── Sticky live preview: your card exactly as the chosen audience sees it ── */}
                <aside className="pp-aside" aria-label="Profile preview">
                    <div className="pp-aside-card">
                        <div className="pp-aside-head">
                            <h3 className="pp-aside-title">Preview as</h3>
                            <SaveStatus state={saveState} />
                            <ClSegment
                                options={[{ value: 'everyone', label: 'Everyone' }, { value: 'friend', label: 'A friend' }]}
                                value={viewAs}
                                onChange={setViewAs}
                            />
                        </div>
                        <div className="pp-card-zoom">
                            <ProfilePreviewCard
                                data={previewData}
                                seen={view.seen}
                                showLocks={viewAs === 'friend'}
                                friendsOnly={view.friendsOnly}
                                label={`Preview of your profile as seen by ${viewAs === 'friend' ? 'a friend' : 'everyone'}`}
                                onOpenFull={() => setFullOpen(true)}
                            />
                        </div>
                        <div className="pp-aside-actions">
                            <button type="button" className="ps-ghost" onClick={() => setFullOpen(true)} data-testid="pp-open-full">
                                <Maximize2 size={13} aria-hidden="true" /> Full profile
                            </button>
                            <button type="button" className="ps-ghost" onClick={() => setShareOpen(true)} data-testid="pp-share">
                                <Share2 size={13} aria-hidden="true" /> Share
                            </button>
                        </div>
                    </div>
                </aside>

                <div className="pp-main">
                    <div ref={tabsRef} className="pp-tabs" role="tablist" aria-label="Profile settings" onKeyDown={onTabKey}>
                        {PANE_TABS.map((t) => (
                            <button key={t.id} type="button" role="tab" id={`${tabsId}-tab-${t.id}`} aria-selected={tab === t.id}
                                aria-controls={`${tabsId}-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className="pp-tab"
                                data-testid={`profile-pane-tab-${t.id}`} onClick={() => setTab(t.id)}>
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <SettingsDisclosureFlatCards.Provider value={true}>
                    <PaneTabPanel id="basics" idBase={tabsId} active={tab === 'basics'} onReveal={() => setTab('basics')}>
                    {/* ── Basics ─────────────────────────────────────────────── */}
                    <SettingsDisclosure
                        id="profile.basics" variant="card" defaultOpen title="Basics" summary={basicsSummary}
                        labels={['Display name', 'Username', 'Time zone', 'Local time', 'About me', 'Avatar', 'Banner']}
                    >
                        {/* The header, as it sits on your card: the banner (the card's own shape) with your
                            avatar overlapping its lower edge. Nothing dark behind them: below the banner is the
                            section itself, like the card's body. */}
                        <div className="ps-head">
                            <div className="ps-head-banner">
                                {bannerUrl?.startsWith('blob:') ? (
                                    <div className="cipherline-banner ps-head-banner-img">
                                        <div className="cipherline-banner-fallback" />
                                        <img src={bannerUrl} alt="" className="cipherline-banner-img" />
                                    </div>
                                ) : (
                                    <Banner
                                        attachmentId={bannerUrl ? (user?.banner_url ?? null) : null}
                                        fallbackAvatarAttachmentId={avatarUrl || (user?.avatar_url ?? null)}
                                        fallbackUserId={user?.user_id}
                                        token={token ?? ''}
                                        aspectRatio="360 / 112"
                                        animate
                                    />
                                )}
                                <div className="ps-head-banner-btn">
                                    <button type="button" className="ps-ghost ps-ghost--on-image" onClick={() => bannerFileInputRef.current?.click()}>
                                        <ImageIcon size={13} aria-hidden="true" /> {bannerUrl ? 'Change banner' : 'Add a banner'}
                                    </button>
                                    {bannerUrl && (
                                        <button type="button" className="ps-ghost ps-ghost--on-image ps-ghost--icon" aria-label="Remove banner" title="Remove banner"
                                            onClick={() => { setBannerUrl(''); void saveImage('banner', null); }}>
                                            <Trash2 size={13} aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="ps-head-row">
                                <button type="button" className="ps-head-av" aria-label="Change avatar" onClick={() => fileInputRef.current?.click()}>
                                    <EncryptedAvatar
                                        attachmentId={avatarUrl || null}
                                        userId={user?.user_id}
                                        token={token}
                                        className="w-full h-full object-cover"
                                        fallbackSize={28}
                                        disableClickProfile
                                        animate
                                    />
                                    <span className="ps-head-av-cam" aria-hidden="true"><Camera size={18} /></span>
                                </button>
                                <div className="ps-head-btns">
                                    <button type="button" className="ps-ghost" onClick={() => fileInputRef.current?.click()}>
                                        <Camera size={13} aria-hidden="true" /> {avatarUrl ? 'Change avatar' : 'Add an avatar'}
                                    </button>
                                    {avatarUrl && (
                                        <button type="button" className="ps-ghost ps-ghost--icon" aria-label="Remove avatar" title="Remove avatar"
                                            onClick={() => { setAvatarUrl(''); void saveImage('avatar', null); }}>
                                            <Trash2 size={13} aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <input type="file" accept={IMAGE_ACCEPT_ATTR} className="hidden" ref={fileInputRef} onChange={(e) => void pickForCrop('avatar', e)} />
                            <input type="file" accept={IMAGE_ACCEPT_ATTR} className="hidden" ref={bannerFileInputRef} onChange={(e) => void pickForCrop('banner', e)} />
                        </div>
                        {/* Truthful copy (2026-10-06): the avatar is the one profile image with a
                            public, unencrypted copy (the referral page shows it). utils/publicAvatar.ts. */}
                        <p className="ps-note">Your avatar is public: it shows on your invite link. Chats, files and calls stay encrypted.</p>

                        <div className="ps-fields">
                            <div className="cl-fld" style={{ margin: 0 }}>
                                <label htmlFor="pf-username" className="flex items-center gap-2">Username {isPro && <ProPill proSince={isPro ? proSince : null} />}</label>
                                <div className="ps-tagbox">
                                    <div className="flex-1">
                                        <ClInput
                                            id="pf-username"
                                            type="text"
                                            value={effectiveUsernameDraft}
                                            onChange={(e) => setUsernameDraft(e.target.value)}
                                            placeholder="Username"
                                            maxLength={32}
                                            minLength={3}
                                            disabled={usernameLocked}
                                            aria-invalid={usernameInvalid || !!usernameErrorFor}
                                            aria-describedby="sd-username-msg"
                                            style={{ width: '100%' }}
                                        />
                                    </div>
                                    {user?.discriminator !== null && user?.discriminator !== undefined && (
                                        <span className="ps-tag" aria-label={`Your tag ${padDiscriminator(user.discriminator)}`}>#{padDiscriminator(user.discriminator)}</span>
                                    )}
                                </div>
                                <div id="sd-username-msg" aria-live="polite">
                                    {usernameField.kind === 'locked' && (
                                        <p className="ps-note flex items-center gap-1" style={{ marginTop: 6 }}>
                                            <Lock size={11} aria-hidden /> {usernameField.message}
                                        </p>
                                    )}
                                    {(usernameField.kind === 'invalid' || usernameField.kind === 'not_allowed') && (
                                        <p className="cl-fmsg">{usernameField.message}</p>
                                    )}
                                    {usernameField.kind === 'ok' && usernameErrorFor && (
                                        <p className="cl-fmsg">{usernameErrorFor}</p>
                                    )}
                                    {usernameField.kind === 'ok' && !usernameErrorFor && (
                                        <p className="ps-note" style={{ marginTop: 6, color: 'var(--cl-glow)' }}>
                                            Saves when you leave this page, with a new #tag under this name. You can change it once every 24 hours.
                                        </p>
                                    )}
                                </div>
                            </div>

                            <div className="cl-fld ps-rel" style={{ margin: 0 }}>
                                <label htmlFor="pf-bio">About me</label>
                                <span className="ps-count ps-count--corner" aria-live="polite" data-warm={bioLen >= 140 && bioLen < 160 ? '' : undefined} data-full={bioLen >= 160 ? '' : undefined}>{bioLen} / 160</span>
                                <ClTextarea
                                    id="pf-bio"
                                    value={bio}
                                    onChange={(e) => setBio(e.target.value)}
                                    onFocus={() => setBioPlaceholder(BIO_PLACEHOLDERS[(bioFocusCount.current++) % BIO_PLACEHOLDERS.length])}
                                    placeholder={bioPlaceholder}
                                    maxLength={160}
                                    style={{ width: '100%', height: 84, resize: 'none' }}
                                />
                            </div>

                            <div>
                                <div className="ps-toggle-row">
                                    <div>
                                        <b id="pf-time-label">Show my local time</b>
                                        <span>People see the time where you are, never the zone name.</span>
                                    </div>
                                    <ClToggle
                                        checked={showsTime}
                                        aria-label="Show my local time"
                                        onChange={(on) => setTimeZone(on ? (suggestedZone || 'UTC') : '')}
                                    />
                                </div>
                                {showsTime && (
                                    <div className="cl-fld" style={{ margin: '10px 0 0' }}>
                                        <label htmlFor="pf-time-zone">Time zone</label>
                                        <ClInput
                                            id="pf-time-zone"
                                            type="text"
                                            list="pf-time-zone-list"
                                            value={timeZone}
                                            onChange={(e) => setTimeZone(e.target.value)}
                                            placeholder={suggestedZone || 'Europe/Paris'}
                                            maxLength={64}
                                            aria-invalid={timeZoneInvalid}
                                            aria-describedby="pf-time-zone-msg"
                                            style={{ width: '100%' }}
                                        />
                                        <datalist id="pf-time-zone-list">
                                            {zoneOptions.map((z) => <option key={z} value={z} />)}
                                        </datalist>
                                        <div id="pf-time-zone-msg" aria-live="polite">
                                            {timeZoneInvalid
                                                ? <p className="cl-fmsg">Pick a zone from the list, like Europe/Paris.</p>
                                                : suggestedZone && timeZone !== suggestedZone
                                                    ? <p className="ps-note" style={{ marginTop: 6 }}>This device says {suggestedZone}. <button type="button" className="pcd-link-btn" onClick={() => setTimeZone(suggestedZone)}>Use it</button></p>
                                                    : null}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </SettingsDisclosure>
                    </PaneTabPanel>

                    {/* ── Style ──────────────────────────────────────────────── */}
                    <PaneTabPanel id="style" idBase={tabsId} active={tab === 'style'} onReveal={() => setTab('style')}>
                    <ProfileCosmeticsSection
                        token={token}
                        saved={{
                            profile_theme: user?.profile_theme, avatar_decoration: user?.avatar_decoration, profile_effect: user?.profile_effect,
                            cosmetic_options: user?.cosmetic_options ?? null,
                            cosmetic_claims: user?.cosmetic_claims ?? [],
                        }}
                        base={previewBase}
                        level={user?.profile_level?.level ?? 0}
                        onPreview={onPreview}
                        onSaved={refreshAfter}
                        active={tab === 'style'}
                    />
                    </PaneTabPanel>

                    {/* ── Showcase: level + the card's sections and their content ── */}
                    <PaneTabPanel id="showcase" idBase={tabsId} active={tab === 'showcase'} onReveal={() => setTab('showcase')}>
                    <ProfileExtrasSection
                        token={token}
                        userId={user?.user_id}
                        saved={{
                            profile_level: user?.profile_level, profile_showcase: user?.profile_showcase,
                            interests: user?.interests,
                            widget_games: user?.widget_games, profile_links: user?.profile_links, steam: user?.steam ?? null,
                        }}
                        onPreview={onPreview}
                        onSaved={refreshAfter}
                    />
                    </PaneTabPanel>

                    {/* ── Who can see this ───────────────────────────────────── */}
                    <PaneTabPanel id="privacy" idBase={tabsId} active={tab === 'privacy'} onReveal={() => setTab('privacy')}>
                    <ProfileVisibilitySection
                        token={token}
                        saved={user?.profile_visibility}
                        viewAs={viewAs}
                        onView={onView}
                        onSaved={refreshAfter}
                    />
                    </PaneTabPanel>

                    {/* ── Security ───────────────────────────────────────────── */}
                    <PaneTabPanel id="security" idBase={tabsId} active={tab === 'security'} onReveal={() => setTab('security')}>
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
                    </PaneTabPanel>
                    </SettingsDisclosureFlatCards.Provider>
                </div>
            </div>

            {fullOpen && user?.user_id && createPortal(
                <div className="pfp-layer" data-testid="pp-full-layer">
                    <ProfileFullView
                        userId={user.user_id} token={token ?? ''} isSelf data={ownCard} profile={ownPublic}
                        avatarId={previewData.avatarAttachmentId} bannerId={view.seen.banner ? previewData.bannerAttachmentId : null}
                        presence={<span className="pcd-status-line"><span className="pcd-status-dot" style={{ backgroundColor: '#4ADE80' }} aria-hidden="true" /><b style={{ color: '#4ADE80' }}>Online</b></span>}
                        avatarBadge={<span className="pcd-dot" style={{ backgroundColor: '#4ADE80' }} title="Online" />}
                        connections={ownConnections}
                        actions={<button type="button" className="ps-ghost" onClick={() => { setFullOpen(false); setShareOpen(true); }}><Share2 size={13} aria-hidden="true" /> Share</button>}
                        onClose={() => setFullOpen(false)}
                    />
                </div>,
                document.body,
            )}
            {shareOpen && user?.user_id && createPortal(
                <ProfileShareDialog token={token ?? ''} userId={user.user_id} data={ownCard}
                    avatarId={previewData.avatarAttachmentId} bannerId={previewData.bannerAttachmentId} onClose={() => setShareOpen(false)} />,
                document.body,
            )}

            <ChangePasswordModal open={showPwModal} onClose={() => setShowPwModal(false)} />

            <ClImageCropper
                open={!!cropTarget}
                file={cropTarget?.file ?? null}
                outputWidth={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.width : AVATAR_OUTPUT.width}
                outputHeight={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.height : AVATAR_OUTPUT.height}
                shape={cropTarget?.kind === 'banner' ? 'rect' : 'circle'}
                title={cropTarget?.kind === 'banner' ? 'Position your banner' : 'Position your avatar'}
                onCancel={() => setCropTarget(null)}
                onConfirm={(blob) => handleCropped(blob)}
            />

            <AnimatedImageDialog
                target={animatedTarget}
                onCancel={() => setAnimatedTarget(null)}
                onConfirm={(file) => { const k = animatedTarget?.kind; setAnimatedTarget(null); handleCropped(file, k); }}
            />
        </div>
    );
};

/** "Saving", "Saved" or the error, beside "Preview as": the only save UI the pane has. */
const SaveStatus: React.FC<{ state: SaveState }> = ({ state }) => (
    <span className="ps-save" data-kind={state.kind} role="status" aria-live="polite">
        {state.kind === 'saving' && <><Loader2 size={12} className="ps-spin" aria-hidden="true" /> Saving</>}
        {state.kind === 'saved' && <><Check size={12} strokeWidth={3} aria-hidden="true" /> Saved</>}
        {state.kind === 'error' && <span title={state.message}><AlertCircle size={12} aria-hidden="true" /> Not saved: {state.message}</span>}
    </span>
);
