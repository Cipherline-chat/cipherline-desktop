import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { MessageSquare, Pencil, MoreVertical, PhoneCall, Server, UserPlus, UserMinus, Ban, AtSign, Check, X, Flag, Share2 } from 'lucide-react';
import { apiUrl } from '../utils/apiPath';
import { ImageLightbox } from './ImageLightbox';
import { MobileStatusGlyph } from './MobileStatusGlyph';
import { STATUS_CONFIG } from '../hooks/useUserStatus';
import type { FriendStatusEntry, UserStatus } from '../hooks/useUserStatus';
import { useEncryptedAvatar } from '../hooks/useEncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { useContextMenu } from '../hooks/useContextMenu';
import { useEscape } from '../hooks/useEscape';
import { formatLastSeen } from '../utils/formatLastSeen';
import { isFriendsOnly } from '../utils/profileVisibility';
import { sanitizeLinks } from '../utils/profileLinks';
import { readTheme } from '../utils/profileTheme';
import { getVerificationState } from '../utils/keyVerification';
import { fetchProfile as fetchProfileCached, peekProfile, __profilePrefetchTuning, type PublicProfile } from '../utils/profileCache';
import { lookupUserAvatarId, lookupUserBannerId } from '../utils/peerIdentityCache';
import { roleColorHexFromInt } from '../utils/roleColor';
import { ClButton, ClInput } from './cl';
import { ProfileCardSection } from './ProfileCardParts';
import { ProfilePopoutCard, OpenProfileButton } from './profile/ProfilePopoutCard';
import { ProfileFullView } from './profile/ProfileFullView';
import { ProfileShareDialog } from './profile/ProfileShareDialog';
import type { ProfileCardData, ProfileFullTab } from './profile/profileCardData';
import { useProfileActivity } from '../hooks/useProfileActivity';
import { useProfileConnections } from '../hooks/useProfileConnections';
import { placePopover, type Placement } from '../utils/popoverPlacement';
import { StatusLine } from './StatusLine';
import { useMostPlayed } from '../hooks/useMostPlayed';
import { ProfileNoteField } from './profile/ProfileNoteField';
import { HighFiveButton } from './profile/HighFiveButton';
import { cleanInterests, showcaseBlocksOf } from '../utils/profileExtras';
import { anniversaryYearsFor } from '../utils/profileMoments';
import { readItemOptions } from '../utils/profileCosmetics';
import { useMutuals, useSteamCard } from '../hooks/useProfileRelations';
import { useOpenProfile } from '../contexts/ProfileOpenContext';

export interface ProfileModalProps {
    userId: string;
    onClose: () => void;
    token: string;
    currentUserId: string;
    /** Live status map from useUserStatus — no extra fetch needed for status/game */
    friendStatuses: Record<string, FriendStatusEntry>;
    /** Own status when viewing own profile */
    myStatus?: UserStatus;
    myGame?: string | null;
    /** Own custom status when viewing own profile (the cached profile can be stale after an edit). */
    myCustom?: { text: string; emoji: string; expiresAt: string | null };
    onMessage?: (userId: string) => void;
    /** Opens Settings > My Profile tab — only shown when viewing own profile */
    onOpenSettings?: () => void;
    /** Whether the target user is a current accepted friend — toggles "Remove friend" visibility */
    isFriend?: boolean;
    /** Fires the "Add Friend" action when the viewer is not yet friends with the target.
     *  Receives the target's username + discriminator so the caller can hit
     *  POST /v1/friends/request with the same payload AddFriendModal uses. */
    onSendFriendRequest?: (userId: string, username: string, discriminator: number | null) => void;
    /** Action-menu handlers — only relevant for other users' profiles */
    onCall?: (userId: string) => void;
    onAddToGroup?: (friend: { user_id: string; username: string; avatar_url: string | null }) => void;
    onRemoveFriend?: (userId: string, username: string) => void;
    onBlock?: (userId: string, username: string) => void;
    onReport?: (userId: string, username: string) => void;
    /** Viewport coordinates the popover should open near (typically the click
     *  point). If omitted, the popover opens at top-center. */
    anchor?: { x: number; y: number } | null;
    /**
     * When the profile is opened from a server context, these carry the
     * available roles and the member's assigned role IDs so we can render
     * role chips below the bio. Both must be provided or neither is shown.
     */
    serverRoles?: Array<{ role_id: string; name: string; color: number }>;
    memberRoleIds?: string[];
    /** When the viewer belongs to servers, show an "Invite to Server" picker.
     *  Each item: server name + onSelect handler that sends the invite. */
    inviteToServerItems?: Array<{ label: string; onSelect: () => void }>;
    /**
     * Server context for nickname editing. When provided (profile opened from
     * a server member list), allows changing the target's nickname if the
     * viewer has the requisite permission (CHANGE_NICKNAME for own nick,
     * MANAGE_NICKNAMES for others').
     */
    serverId?: string;
    /** Target user's current server nickname (null = using account username). */
    currentNickname?: string | null;
    /** Viewer is allowed to set the target's nickname in this server. */
    canSetNickname?: boolean;
    /** Called when the viewer saves a new nickname (null = reset to username). */
    onSetNickname?: (userId: string, nickname: string | null) => Promise<void>;
    /** Open straight into the nickname editor (see ProfileOpenContext's
     *  matching field) instead of waiting for the viewer to find the "More"
     *  menu's "Change Nickname" row. Fires once, as soon as the effective
     *  nickname is known — immediately if `currentNickname` was supplied,
     *  otherwise after this component's own lazy fetch resolves. No-op
     *  unless `canSetNickname` is also true. */
    autoEditNickname?: boolean;
    /** A mutual server's row pressed: go to that server (the popover closes). */
    onOpenServer?: (serverId: string) => void;
    /** The viewer's icon for a server they are in (mutual-server rows). */
    renderServerIcon?: (serverId: string, name: string) => React.ReactNode;
}

/** The preview popover's width. Sized so the card fits an 800x600 window beside a member list. */
export const POPOUT_WIDTH = 320;
const MARGIN = 12;

export const ProfileModal: React.FC<ProfileModalProps> = ({
    userId,
    onClose,
    token,
    currentUserId,
    friendStatuses,
    myStatus,
    myGame,
    myCustom,
    onMessage,
    onSendFriendRequest,
    onOpenSettings,
    isFriend = false,
    onCall,
    onAddToGroup,
    onRemoveFriend,
    onBlock,
    onReport,
    anchor = null,
    serverRoles,
    memberRoleIds,
    inviteToServerItems,
    serverId,
    currentNickname,
    canSetNickname = false,
    onSetNickname,
    autoEditNickname = false,
    onOpenServer,
    renderServerIcon,
}) => {
    // Preview (the anchored popover) or the full profile (a large modal).
    const [view, setView] = useState<{ mode: 'preview' | 'full'; tab: ProfileFullTab }>({ mode: 'preview', tab: 'overview' });
    // Opening another person from inside (a mutual friend) starts on their Overview, in the same mode.
    const [seenUser, setSeenUser] = useState(userId);
    if (seenUser !== userId) { setSeenUser(userId); setView((v) => ({ mode: v.mode, tab: 'overview' })); }
    const openFull = useCallback((tab: ProfileFullTab = 'overview') => setView({ mode: 'full', tab }), []);

    // Focus goes back to whatever opened the profile (the avatar, the name, the menu row) when it closes.
    const openerRef = React.useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);
    useEffect(() => () => {
        const el = openerRef.current as HTMLElement | null;
        if (el && el.isConnected && typeof el.focus === 'function' && el !== document.body) el.focus({ preventScroll: true });
    }, []);

    // Where the popover goes (utils/popoverPlacement): beside the click, never
    // under the titlebar, the whole card on screen. Placed from the MEASURED
    // card before paint, and again whenever the card or the window resizes.
    const cardRef = React.useRef<HTMLDivElement>(null);
    const place = useCallback((h: number) => placePopover({
        anchor, size: { w: POPOUT_WIDTH, h }, viewport: { w: window.innerWidth, h: window.innerHeight }, margin: MARGIN,
    }), [anchor]);
    const [pos, setPos] = useState<Placement>(() => (typeof window === 'undefined'
        ? { left: 0, top: 0, maxHeight: null, side: 'center' }
        : placePopover({ anchor, size: { w: POPOUT_WIDTH, h: 460 }, viewport: { w: window.innerWidth, h: window.innerHeight }, margin: MARGIN })));
    const inPreview = view.mode === 'preview';
    React.useLayoutEffect(() => {
        if (!inPreview) return;
        const frame = cardRef.current;
        const card = frame?.firstElementChild as HTMLElement | null | undefined;
        if (!frame || !card) return;
        const fit = () => {
            const next = place(card.offsetHeight);
            setPos((prev) => (prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight && prev.side === next.side ? prev : next));
        };
        fit();
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
        ro?.observe(card);
        window.addEventListener('resize', fit);
        return () => { ro?.disconnect(); window.removeEventListener('resize', fit); };
    }, [place, inPreview]);

    const isOwnProfile = userId === currentUserId;

    // Seeded from the session profile cache: a re-open paints the whole card
    // on its first frame and revalidates underneath (see utils/profileCache).
    const [profile, setProfile] = useState<PublicProfile | null>(() => peekProfile(userId));
    const [loading, setLoading] = useState(() => !peekProfile(userId));
    const [error, setError] = useState<string | null>(null);

    // Most played: the server answers a stranger with the same empty list as a
    // user with nothing, so a stranger's card never fetches it (and never shows it).
    const mayReadActivity = userId === currentUserId || isFriend;
    const mostPlayed = useMostPlayed(mayReadActivity ? userId : null, userId === currentUserId);
    // Your own interests, to highlight the ones you share (others' cards only).
    const [myInterests, setMyInterests] = useState<string[] | null>(() => (peekProfile(currentUserId)?.interests ? cleanInterests(peekProfile(currentUserId)?.interests) : null));

    // Which images to show. The profile response is the authority once it is
    // here; before that, the ids this device already knows — the friends list,
    // an earlier open, last session's identity cache — so both images start
    // (or paint from the decrypted-blob cache) on the click instead of one
    // profile round trip later. A stale id survives at most that one round
    // trip, and the hook keeps showing it until the replacement has decrypted,
    // so a change never flashes the placeholder.
    const avatarId = profile ? profile.avatar_url : lookupUserAvatarId(userId);
    const bannerId = profile ? profile.banner_url : lookupUserBannerId(userId);

    // When the profile is opened from a call tile (no pre-fetched role/member data),
    // lazy-fetch the server roles and this member's role IDs + nickname.
    const [fetchedRoles, setFetchedRoles] = useState<Array<{ role_id: string; name: string; color: number }> | null>(null);
    const [fetchedMemberRoleIds, setFetchedMemberRoleIds] = useState<string[] | null>(null);
    const [fetchedNickname, setFetchedNickname] = useState<string | null | undefined>(undefined); // undefined = not yet fetched

    const needsLazyFetch = !!serverId && !serverRoles && !memberRoleIds;

    // Effective values — props take priority (pre-fetched by caller), lazy-fetch fills in when missing.
    const effectiveServerRoles = serverRoles ?? fetchedRoles ?? undefined;
    const effectiveMemberRoleIds = memberRoleIds ?? fetchedMemberRoleIds ?? undefined;
    // currentNickname prop takes priority; fetchedNickname fills in when opened from a call.
    const effectiveNickname = currentNickname !== undefined ? currentNickname : fetchedNickname;

    useEffect(() => {
        if (!needsLazyFetch || !token) return;
        let cancelled = false;
        const fetchServerCtx = async () => {
            try {
                const [rolesRes, membersRes] = await Promise.all([
                    axios.get(apiUrl`/servers/${serverId}/roles`, { headers: { Authorization: `Bearer ${token}` } }),
                    axios.get(apiUrl`/servers/${serverId}/members`, { headers: { Authorization: `Bearer ${token}` } }),
                ]);
                if (cancelled) return;
                const roles: Array<{ role_id: string; name: string; color: number; is_everyone?: boolean }> = rolesRes.data;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
                const member = (membersRes.data as any[]).find(m => m.user_id === userId);
                setFetchedRoles(roles.filter(r => !r.is_everyone));
                setFetchedMemberRoleIds(member?.role_ids ?? []);
                setFetchedNickname(member?.nickname ?? null);
            } catch {
                // Non-fatal — profile still opens, just no role chips
            }
        };
        fetchServerCtx();
        return () => { cancelled = true; };
    }, [needsLazyFetch, serverId, userId, token]);
    // Profile-modal "More" menu — uses useContextMenu so the dropdown
    // portals to body (the modal itself caps width at max-w-md, and the
    // dropdown sat at right-0 inside the absolute-positioned trigger;
    // viewport-clamping was already mostly fine here, but this gives us
    // consistent behavior with every other menu in the app).
    const profileMenu = useContextMenu();
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const { closing, handleClose } = useModalExit(onClose);

    // Nickname editing
    const [nicknameEditOpen, setNicknameEditOpen] = useState(false);
    const [nicknameInput, setNicknameInput] = useState('');
    const [nicknameSaving, setNicknameSaving] = useState(false);
    const [nicknameError, setNicknameError] = useState<string | null>(null);

    const openNicknameEdit = () => {
        setNicknameInput(effectiveNickname ?? '');
        setNicknameError(null);
        setNicknameEditOpen(true);
    };
    const closeNicknameEdit = () => {
        setNicknameEditOpen(false);
        setNicknameError(null);
    };
    // A layer of its own: Escape backs out of the nickname edit without
    // closing the profile popover underneath it.
    useEscape(closeNicknameEdit, nicknameEditOpen);
    const saveNickname = async () => {
        if (!onSetNickname) return;
        setNicknameSaving(true);
        setNicknameError(null);
        try {
            const trimmed = nicknameInput.trim();
            await onSetNickname(userId, trimmed || null);
            // Update local fetched state so the display refreshes immediately
            // (for call-opened profiles where currentNickname prop updates async).
            setFetchedNickname(trimmed || null);
            setNicknameEditOpen(false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (e: any) {
            setNicknameError(e?.response?.data?.message || 'Failed to update nickname');
        } finally {
            setNicknameSaving(false);
        }
    };

    // Auto-open the nickname editor when the caller asked for it (the call
    // participant self-menu's "Change Nickname" shortcut, which skips the
    // "View Profile" step entirely). Waits for the effective nickname to be
    // known — either it arrived via the `currentNickname` prop already, or
    // (the call-tile path) this component's own lazy fetch above resolves
    // `fetchedNickname` from `undefined` to a real value. A ref guards this
    // to fire at most once per mount; without it, `effectiveNickname`
    // changing again later (e.g. after a save) would reopen the editor.
    const autoEditFiredRef = React.useRef(false);
    useEffect(() => {
        if (autoEditFiredRef.current) return;
        if (!autoEditNickname || !canSetNickname) return;
        if (needsLazyFetch && fetchedNickname === undefined) return; // still fetching
        autoEditFiredRef.current = true;
        openNicknameEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoEditNickname, canSetNickname, needsLazyFetch, fetchedNickname]);

    // Resolved avatar blob URL for the lightbox (hook is cached — EncryptedAvatar
    // already loaded this, so this is essentially free).
    const avatarBlobUrl = useEncryptedAvatar(avatarId, token);

    // Stale-while-revalidate. A copy younger than FRESH_MS (a hover prefetch
    // moments ago, or the press that opened this card) is used as-is; anything
    // older is shown immediately and replaced when the fresh answer lands. The
    // request is shared with any prefetch already in flight for this user.
    const fetchProfile = useCallback(async () => {
        const cached = peekProfile(userId);
        setProfile(cached);
        setLoading(!cached);
        setError(null);
        try {
            const fresh = await fetchProfileCached(userId, token, { maxAgeMs: __profilePrefetchTuning.FRESH_MS });
            setProfile(fresh);
        } catch {
            // A cached card stays up on a failed revalidation; only a card
            // with nothing to show reports the error.
            if (!cached) setError('Could not load profile.');
        } finally {
            setLoading(false);
        }
    }, [userId, token]);

    useEffect(() => {
        void fetchProfile();
    }, [fetchProfile]);

    // Only when this card shows interests: read OUR OWN (cached) profile once to find the shared ones.
    const theirInterestCount = profile?.interests?.length ?? 0;
    useEffect(() => {
        if (isOwnProfile || theirInterestCount === 0 || !token || !currentUserId) return;
        let cancelled = false;
        fetchProfileCached(currentUserId, token, { maxAgeMs: __profilePrefetchTuning.FRESH_MS })
            .then((me) => { if (!cancelled) setMyInterests(cleanInterests(me.interests)); })
            .catch(() => { /* no highlighting */ });
        return () => { cancelled = true; };
    }, [isOwnProfile, theirInterestCount, token, currentUserId]);

    // Esc dismisses the popover through the shared stack. ImageLightbox and
    // the More menu (ContextMenu, via useContextMenu) each push their own
    // layer only while THEY are open, and — being opened on top of this one
    // — sit above it on the stack, so a press reaches them first and this
    // layer only fires once both are closed. No manual isOpen checks needed.
    useEscape(handleClose);

    // Determine live status and game:
    // For own profile use myStatus/myGame prop; for others use friendStatuses map.
    // Fall back to profile.status (from API) if not in the live map yet.
    const liveEntry: FriendStatusEntry = isOwnProfile
        ? {
              status: myStatus ?? (profile?.status ?? 'offline'),
              custom_status_text: myCustom ? (myCustom.text || null) : (profile?.custom_status_text ?? null),
              custom_status_emoji: myCustom ? (myCustom.emoji || null) : (profile?.custom_status_emoji ?? null),
              custom_status_expires_at: myCustom ? myCustom.expiresAt : (profile?.custom_status_expires_at ?? null),
              current_game: myGame ?? null,
          }
        : (friendStatuses[userId] ?? {
              status: profile?.status ?? 'offline',
              custom_status_text: profile?.custom_status_text ?? null,
              custom_status_emoji: profile?.custom_status_emoji ?? null,
              custom_status_expires_at: profile?.custom_status_expires_at ?? null,
              current_game: null,
              on_mobile: profile?.on_mobile ?? false,
          });

    const statusCfg = STATUS_CONFIG[liveEntry.status] ?? STATUS_CONFIG.offline;
    const onMobile = !isOwnProfile && liveEntry.status !== 'offline' && !!liveEntry.on_mobile;

    const displayName = profile?.username || '';

    const assignedRoles = React.useMemo(() => {
        if (!effectiveServerRoles || !effectiveMemberRoleIds) return [];
        return effectiveServerRoles.filter(r => effectiveMemberRoleIds.includes(r.role_id));
    }, [effectiveServerRoles, effectiveMemberRoleIds]);

    // "You verified their safety number": this device's own pinned-key state,
    // read locally. Nothing about it is sent to or known by the server.
    const verifiedByMe = !isOwnProfile && !!currentUserId && getVerificationState(currentUserId, userId) === 'verified';
    const playingNow = !!liveEntry.current_game && liveEntry.status !== 'offline' && !onMobile;
    // The celebration is for friends, on the day (local), and is skipped under reduced motion.
    const anniversary = !isOwnProfile && isFriend ? anniversaryYearsFor(userId) : 0;
    const lastSeen = liveEntry.status === 'offline' ? formatLastSeen(profile?.last_seen_at ?? null) : null;
    // Mutual friends / servers (others' cards only) and the verified Steam block (when there is one to see).
    const mutuals = useMutuals(isOwnProfile ? null : userId, token);
    const steamCard = useSteamCard(profile?.steam?.steam_id ? userId : null, token);
    const openProfile = useOpenProfile();

    // Everything the card draws, from the profile response (the server already
    // withheld whatever this viewer may not see).
    const cardData: ProfileCardData | null = profile ? {
        name: displayName,
        discriminator: profile.discriminator,
        theme: readTheme(profile.profile_theme),
        decoration: profile.avatar_decoration ?? null,
        effect: profile.profile_effect ?? null,
        decorationOptions: readItemOptions(profile.cosmetic_options?.d, 'decoration', profile.avatar_decoration),
        effectOptions: readItemOptions(profile.cosmetic_options?.e, 'effect', profile.profile_effect),
        // Card hover animation: removed on owner request 2026-10-23; the server field users.hover_animation is now unused by the desktop.
        isPro: profile.is_pro,
        proSince: profile.pro_since,
        badges: profile.badges,
        level: profile.level,
        bio: profile.bio,
        bioFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'bio'),
        timeZone: profile.time_zone ?? null,
        localTimeFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'local_time'),
        friendsSince: profile.friends_since ?? null,
        anniversaryYears: anniversary,
        highFiveCount: profile.high_five_count ?? 0,
        blocks: showcaseBlocksOf(profile.showcase).blocks,
        topAchievements: showcaseBlocksOf(profile.showcase).top_achievements,
        games: profile.widgets?.games ?? [],
        gamesFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'widgets'),
        links: sanitizeLinks(profile.links),
        linksFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'links'),
        interests: cleanInterests(profile.interests),
        myInterests: isOwnProfile ? null : (myInterests ?? []),
        interestsFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'widgets'),
        achievementCount: profile.achievement_count ?? null,
        mostPlayed: mostPlayed.games,
        verified: verifiedByMe,
        steam: profile.steam?.steam_id ? { steamId: profile.steam.steam_id, personaName: steamCard?.persona_name ?? null, avatar: steamCard?.avatar ?? null } : null,
    } : null;

    const handleAddToGroup = () => {
        if (!profile) return;
        onAddToGroup?.({
            user_id: profile.user_id,
            username: profile.username,
            avatar_url: profile.avatar_url,
        });
    };
    const handleRemoveFriend = () => {
        if (!profile) return;
        onRemoveFriend?.(profile.user_id, profile.username);
    };
    const handleBlock = () => {
        if (!profile) return;
        onBlock?.(profile.user_id, profile.username);
    };
    const handleReport = () => {
        if (!profile) return;
        onReport?.(profile.user_id, profile.username);
    };

    const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        // Items built fresh per click so isFriend / canSetNickname stay current.
        const menuItems = [
            ...(isFriend && onMessage ? [{ icon: <MessageSquare />, label: 'Message', onSelect: () => onMessage(userId) }] : []),
            ...(isFriend && onCall ? [{ icon: <PhoneCall />, label: 'Call', onSelect: () => onCall(userId) }] : []),
            ...(isFriend && onAddToGroup ? [{ icon: <UserPlus />, label: 'Add to Group Chat', onSelect: handleAddToGroup }] : []),
            ...(isFriend && inviteToServerItems?.length ? [{
                icon: <Server />, label: 'Invite to Server', onSelect: () => {},
                submenu: inviteToServerItems.map(it => ({ label: it.label, onSelect: it.onSelect })),
            }] : []),
            // Nickname change — viewer has MANAGE_NICKNAMES for this server member
            ...(serverId && canSetNickname && onSetNickname ? [{ icon: <AtSign />, label: 'Change Nickname', onSelect: openNicknameEdit }] : []),
            ...(isFriend ? [{ divider: true as const }] : []),
            ...(isFriend ? [{ icon: <UserMinus />, label: 'Remove Friend', danger: true, onSelect: handleRemoveFriend }] : []),
            { icon: <Ban />, label: 'Block', danger: true, onSelect: handleBlock },
            ...(onReport ? [{ icon: <Flag />, label: 'Report User', danger: true, onSelect: handleReport }] : []),
        ];
        if (menuItems.length > 0) profileMenu.open(e, menuItems, displayName);
    };

    // What they are doing right now, and their connected accounts (integration seams: INTEGRATION_SLOTS.md).
    const activities = useProfileActivity({ userId, isSelf: isOwnProfile, profile, liveGame: playingNow ? liveEntry.current_game ?? null : null, status: liveEntry.status });
    const connections = useProfileConnections({ userId, isSelf: isOwnProfile, profile, steamPersona: steamCard?.persona_name ?? null });
    const [shareOpen, setShareOpen] = useState(false);

    // Presence + custom status (the game is the activity row below it).
    const presenceNode = profile ? (
        <>
            <span className="pcd-status-line">
                {lastSeen ? <span>{lastSeen}</span> : (
                    <>
                        <span className="pcd-status-dot" style={{ backgroundColor: statusCfg.color }} aria-hidden="true" />
                        <b style={{ color: statusCfg.color }}>{statusCfg.label}</b>
                        {onMobile && <span>· on mobile</span>}
                    </>
                )}
            </span>
            {/* Custom status (offline = none; expired = none). */}
            {liveEntry.status !== 'offline' && (
                <StatusLine entry={{ ...liveEntry, current_game: null }} userId={userId} animate className="pcd-custom" />
            )}
        </>
    ) : null;

    const nicknameSection = profile && serverId ? (
        <ProfileCardSection title="Server nickname" testId="profile-nickname">
            {nicknameEditOpen ? (
                <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                        <ClInput
                            autoFocus
                            value={nicknameInput}
                            onChange={e => setNicknameInput(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); saveNickname(); }
                            }}
                            maxLength={32}
                            placeholder={profile?.username ?? 'Nickname (leave blank to reset)'}
                            aria-label="Server nickname"
                            onClick={e => e.stopPropagation()}
                        />
                        <ClButton icon variant="ok" size="sm" onClick={(e) => { e.stopPropagation(); saveNickname(); }} disabled={nicknameSaving} tooltip="Save">
                            <Check size={13} strokeWidth={2.5} />
                        </ClButton>
                        <ClButton icon variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); closeNicknameEdit(); }} disabled={nicknameSaving} tooltip="Cancel">
                            <X size={13} />
                        </ClButton>
                    </div>
                    {nicknameError && <p className="text-[11px] text-cl-flash m-0" role="alert">{nicknameError}</p>}
                    <p className="text-[11px] text-cl-faint m-0">Leave blank to use their username.</p>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <span className="text-[13px] text-cl-muted">
                        {effectiveNickname ?? <span className="text-cl-faint">None</span>}
                    </span>
                    {canSetNickname && onSetNickname && (
                        <ClButton icon variant="ghost" className="clb--icon-xs" onClick={(e) => { e.stopPropagation(); openNicknameEdit(); }} tooltip="Edit nickname">
                            <Pencil size={10} />
                        </ClButton>
                    )}
                </div>
            )}
        </ProfileCardSection>
    ) : null;

    const rolesSection = assignedRoles.length > 0 ? (
        <ProfileCardSection title={`Roles · ${assignedRoles.length}`} testId="profile-roles">
            <ul className="pcd-chips">
                {assignedRoles.map(r => {
                    const hex = roleColorHexFromInt(r.color);
                    return (
                        <li
                            key={r.role_id}
                            className="pcd-role"
                            style={{
                                color: hex ?? 'rgba(244,247,255,0.8)',
                                backgroundColor: hex ? `${hex}1f` : 'rgba(255,255,255,0.06)',
                            }}
                        >
                            <i style={{ backgroundColor: hex ?? 'rgba(255,255,255,0.35)' }} aria-hidden="true" />
                            {r.name}
                        </li>
                    );
                })}
            </ul>
        </ProfileCardSection>
    ) : null;

    // The preview shows server context only while it matters there: the roles, and the nickname while it is being edited.
    const previewExtras = profile && (rolesSection || nicknameEditOpen) ? <>{nicknameEditOpen && nicknameSection}{rolesSection}</> : null;
    const fullExtras = profile && (nicknameSection || rolesSection) ? (
        <section className="pfp-panel-card pfp-server">{nicknameSection}{rolesSection}</section>
    ) : null;

    const messageOrAdd = (fullWidth: boolean) => profile && !isOwnProfile ? (
        isFriend && onMessage ? (
            <ClButton variant="primary" fullWidth={fullWidth} onClick={() => onMessage(userId)}>
                <MessageSquare size={14} />
                Message
            </ClButton>
        ) : !isFriend && onSendFriendRequest ? (
            <ClButton variant="primary" fullWidth={fullWidth} onClick={() => onSendFriendRequest(userId, profile.username, profile.discriminator ?? null)}>
                <UserPlus size={14} />
                Add friend
            </ClButton>
        ) : null
    ) : null;

    const previewActions = profile ? (
        isOwnProfile ? (
            <>
                <ClButton variant="ghost" fullWidth onClick={() => { handleClose(); onOpenSettings?.(); }}>
                    <Pencil size={14} />
                    Edit profile
                </ClButton>
                <button type="button" className="ppo-icon-btn" onClick={(e) => { e.stopPropagation(); setShareOpen(true); }} aria-label="Share your profile" title="Share your profile" data-testid="share-profile">
                    <Share2 size={15} aria-hidden="true" />
                </button>
                <OpenProfileButton onClick={() => openFull('overview')} />
            </>
        ) : (
            <>
                {messageOrAdd(true) ?? <span />}
                <HighFiveButton userId={userId} token={token} count={profile.high_five_count ?? 0} />
                <OpenProfileButton onClick={() => openFull('overview')} />
            </>
        )
    ) : null;

    const fullActions = profile ? (
        isOwnProfile ? (
            <>
                <ClButton variant="ghost" onClick={() => { handleClose(); onOpenSettings?.(); }}>
                    <Pencil size={14} />
                    Edit profile
                </ClButton>
                <ClButton variant="primary" onClick={() => setShareOpen(true)}>
                    <Share2 size={14} />
                    Share
                </ClButton>
            </>
        ) : (
            <>
                {messageOrAdd(false)}
                <HighFiveButton userId={userId} token={token} count={profile.high_five_count ?? 0} />
            </>
        )
    ) : null;

    const menuButton = !isOwnProfile && profile ? (
        <button type="button" className="pcd-menu-btn" aria-label="More actions" title="More actions" onClick={openMenu} data-testid="profile-more">
            <MoreVertical size={16} aria-hidden="true" />
        </button>
    ) : undefined;

    const avatarBadge = !loading && (onMobile ? (
        <span className="pcd-mobile" title={`${statusCfg.label} · on mobile`}>
            <MobileStatusGlyph status={liveEntry.status} size={16} />
        </span>
    ) : (
        <span className="pcd-dot" style={{ backgroundColor: statusCfg.color }} title={statusCfg.label} />
    ));

    return (
        <>
            {view.mode === 'preview' ? (
                <>
                    {/* Transparent click-catcher: outside clicks close, no dim. Stacked above the
                        fullscreen call overlay (z-[9999]) so a profile opened from a tile shows. */}
                    <div className="fixed inset-0 z-[10000]" onClick={handleClose} style={{ background: 'transparent' }} />
                    <div
                        ref={cardRef}
                        role="dialog"
                        aria-label={displayName ? `${displayName}'s profile` : 'Profile'}
                        className="custom-scrollbar fixed z-[10001] ppo-pop"
                        data-closing={closing ? 'true' : undefined}
                        data-side={pos.side}
                        data-testid="profile-popover"
                        style={{
                            left: pos.left,
                            top: pos.top,
                            width: POPOUT_WIDTH,
                            ...(pos.maxHeight !== null ? {
                                maxHeight: pos.maxHeight, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain',
                            } as const : null),
                        }}
                        onClick={(e) => { e.stopPropagation(); }}
                    >
                        <ProfilePopoutCard
                            userId={userId}
                            token={token}
                            isSelf={isOwnProfile}
                            className="ppo--float"
                            data={cardData}
                            avatarId={avatarId}
                            bannerId={bannerId}
                            bannerFriendsOnly={isFriendsOnly(profile?.friends_only_fields, 'banner')}
                            loading={loading}
                            error={error}
                            onRetry={() => void fetchProfile()}
                            presence={presenceNode}
                            activities={activities}
                            avatarBadge={avatarBadge}
                            menu={menuButton}
                            extras={previewExtras}
                            actions={previewActions}
                            mutuals={mutuals.data}
                            onOpenFull={openFull}
                        />
                    </div>
                </>
            ) : (
                <div className="pfp-layer" data-testid="profile-full-layer">
                    <ProfileFullView
                        key={`${userId}:${view.tab}`}
                        userId={userId}
                        token={token}
                        isSelf={isOwnProfile}
                        data={cardData}
                        profile={profile}
                        avatarId={avatarId}
                        bannerId={bannerId}
                        bannerFriendsOnly={isFriendsOnly(profile?.friends_only_fields, 'banner')}
                        loading={loading}
                        error={error}
                        onRetry={() => void fetchProfile()}
                        presence={presenceNode}
                        activities={activities}
                        connections={connections}
                        avatarBadge={avatarBadge}
                        onAvatarClick={avatarBlobUrl ? () => setLightboxOpen(true) : undefined}
                        actions={fullActions}
                        menu={menuButton}
                        extras={fullExtras}
                        note={!isOwnProfile && profile ? <ProfileNoteField userId={userId} /> : null}
                        mutuals={isOwnProfile ? null : mutuals.data}
                        initialTab={view.tab}
                        onClose={handleClose}
                        closing={closing}
                        onOpenUser={openProfile ? (uid, at) => openProfile(uid, at) : undefined}
                        onOpenServer={onOpenServer ? (sid) => { onOpenServer(sid); handleClose(); } : undefined}
                        renderServerIcon={renderServerIcon}
                    />
                </div>
            )}

            {/* Avatar lightbox: a sibling, so the profile stays mounted underneath */}
            {lightboxOpen && avatarBlobUrl && (
                <ImageLightbox
                    src={avatarBlobUrl}
                    alt={displayName}
                    onClose={() => setLightboxOpen(false)}
                />
            )}

            {shareOpen && profile && isOwnProfile && (
                <ProfileShareDialog
                    token={token}
                    userId={userId}
                    data={cardData}
                    avatarId={avatarId}
                    bannerId={bannerId}
                    onClose={() => setShareOpen(false)}
                />
            )}

            {profileMenu.menu}
        </>
    );
};
