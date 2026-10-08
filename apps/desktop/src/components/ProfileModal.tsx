import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { MessageSquare, Pencil, MoreVertical, PhoneCall, Server, UserPlus, UserMinus, Ban, AtSign, Check, X, Flag } from 'lucide-react';
import { API_BASE } from '../constants';
import { EncryptedAvatar } from './EncryptedAvatar';
import { ImageLightbox } from './ImageLightbox';
import { GameControllerIcon } from './GameControllerIcon';
import { MobileStatusGlyph } from './MobileStatusGlyph';
import { STATUS_CONFIG } from '../hooks/useUserStatus';
import type { FriendStatusEntry, UserStatus } from '../hooks/useUserStatus';
import { useEncryptedAvatar } from '../hooks/useEncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { useContextMenu } from '../hooks/useContextMenu';
import { useEscape } from '../hooks/useEscape';
import { formatLastSeen } from '../utils/formatLastSeen';
import { fetchProfile as fetchProfileCached, peekProfile, __profilePrefetchTuning, type PublicProfile } from '../utils/profileCache';
import { lookupUserAvatarId, lookupUserBannerId } from '../utils/peerIdentityCache';
import { roleColorHexFromInt } from '../utils/roleColor';
import { ClButton, ClInput } from './cl';
// The card's markup is shared with the onboarding profile preview (so the two
// cannot drift) — see ProfileCardParts.tsx.
import {
    PROFILE_CARD_FRAME_CLASS, PROFILE_CARD_IDENTITY_CLASS, PROFILE_CARD_INFO_CLASS, PROFILE_CARD_WIDTH,
    ProfileCardAbout, ProfileCardAvatar, ProfileCardBanner, ProfileCardEyebrow as Eyebrow, ProfileCardFooter,
    ProfileCardHairline, ProfileCardNameRow, ProfileCardStatusDot, ProfileCardStatusLabel, ProfileCardStatusLine,
} from './ProfileCardParts';

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
}

const CARD_WIDTH = PROFILE_CARD_WIDTH;
// Conservative estimate used for viewport-edge clamping. A taller card just
// gets `max-height: calc(100vh - 16px)` and scrolls internally.
const ESTIMATED_CARD_HEIGHT = 500;
const MARGIN = 8;

function clampAnchor(anchor: { x: number; y: number } | null): { left: number; top: number } {
    if (typeof window === 'undefined' || !anchor) {
        // Default: top-center fallback (used when no click anchor available).
        return {
            left: Math.max(MARGIN, Math.floor(((typeof window !== 'undefined' ? window.innerWidth : 1024) - CARD_WIDTH) / 2)),
            top: 80,
        };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Center the card horizontally on the cursor, drop it ~8px below.
    const desiredLeft = anchor.x - CARD_WIDTH / 2;
    const desiredTop = anchor.y + 8;
    return {
        left: Math.max(MARGIN, Math.min(vw - CARD_WIDTH - MARGIN, desiredLeft)),
        top: Math.max(MARGIN, Math.min(vh - ESTIMATED_CARD_HEIGHT - MARGIN, desiredTop)),
    };
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
    userId,
    onClose,
    token,
    currentUserId,
    friendStatuses,
    myStatus,
    myGame,
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
}) => {
    // Clamped position computed once per anchor — recomputed only if anchor
    // changes (effectively never during the popover's lifetime).
    const { left, top } = React.useMemo(() => clampAnchor(anchor), [anchor]);

    // The anchor clamp works off ESTIMATED_CARD_HEIGHT; real profiles vary
    // (roles, long bios, load states). Watch the card's actual height and
    // raise it off the bottom edge so it FITS instead of growing a scrollbar —
    // scrolling remains only for cards genuinely taller than the viewport.
    const cardRef = React.useRef<HTMLDivElement>(null);
    const [topAdj, setTopAdj] = React.useState(top);
    React.useLayoutEffect(() => { setTopAdj(top); }, [top]);
    React.useEffect(() => {
        const el = cardRef.current;
        if (!el) return;
        const fit = () => {
            const h = el.offsetHeight;
            const maxTop = Math.max(MARGIN, window.innerHeight - h - MARGIN);
            setTopAdj(prev => {
                const next = Math.min(top, maxTop);
                return Math.abs(next - prev) < 1 ? prev : next;
            });
        };
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        window.addEventListener('resize', fit);
        return () => { ro.disconnect(); window.removeEventListener('resize', fit); };
    }, [top]);

    const isOwnProfile = userId === currentUserId;

    // Seeded from the session profile cache: a re-open paints the whole card
    // on its first frame and revalidates underneath (see utils/profileCache).
    const [profile, setProfile] = useState<PublicProfile | null>(() => peekProfile(userId));
    const [loading, setLoading] = useState(() => !peekProfile(userId));
    const [error, setError] = useState<string | null>(null);

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
                    axios.get(`${API_BASE}/servers/${serverId}/roles`, { headers: { Authorization: `Bearer ${token}` } }),
                    axios.get(`${API_BASE}/servers/${serverId}/members`, { headers: { Authorization: `Bearer ${token}` } }),
                ]);
                if (cancelled) return;
                const roles: Array<{ role_id: string; name: string; color: number; is_everyone?: boolean }> = rolesRes.data;
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
              custom_status_text: profile?.custom_status_text ?? null,
              custom_status_emoji: profile?.custom_status_emoji ?? null,
              current_game: myGame ?? null,
          }
        : (friendStatuses[userId] ?? {
              status: profile?.status ?? 'offline',
              custom_status_text: profile?.custom_status_text ?? null,
              custom_status_emoji: profile?.custom_status_emoji ?? null,
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

    // Details below the divider — bio, server nickname, roles.
    const hasDetails = !!(profile?.bio || serverId || assignedRoles.length > 0);

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

    return (
        <>
            {/* Transparent click-catcher — captures outside clicks, no dim/blur.
                Stacked above the fullscreen call overlay (z-[9999]) so the
                profile popover is visible when opened from a fullscreen tile. */}
            <div
                className="fixed inset-0 z-[10000]"
                onClick={handleClose}
                style={{ background: 'transparent' }}
            />

            {/* Popover card — positioned near the cursor click, clamped to the viewport.
                On close, plays a short reverse fade/scale via animate-out classes. */}
            <div
                ref={cardRef}
                className={`custom-scrollbar fixed z-[10001] ${PROFILE_CARD_FRAME_CLASS} ${closing ? 'fade-pop-exit' : 'profile-popover-anim'}`}
                style={{
                    left,
                    top: topAdj,
                    width: CARD_WIDTH,
                    // The fit effect above raises the card off the bottom edge, so
                    // this cap only bites when the card is taller than the window.
                    maxHeight: 'calc(100vh - 16px)',
                    overflowY: 'auto',
                    // Setting overflow-y alone computes overflow-x to auto too —
                    // any absolutely-positioned child poking past the edge (e.g.
                    // a button tooltip) would grow a horizontal scrollbar.
                    overflowX: 'hidden',
                    overscrollBehavior: 'contain',
                }}
                onClick={(e) => {
                    // Click inside the card just stops propagation —
                    // useContextMenu owns its own outside-click dismissal.
                    e.stopPropagation();
                }}
            >
                {/* Banner — rounded top corners (matching the card's 20px), fades into card bg at the bottom */}
                <ProfileCardBanner
                    attachmentId={bannerId}
                    fallbackAvatarAttachmentId={avatarId}
                    userId={userId}
                    token={token}
                />

                {/* 3-dots menu — top-right over banner, only for other users' profiles.
                    Items built fresh per click so isFriend / canSetNickname stays current. Portals to body
                    via useContextMenu, never clipped by the modal's overflow.
                    Native title, not the kit tooltip: the tooltip pill is a no-wrap
                    absolute child that pokes past the card's right edge (the button sits
                    12px from it) — the overflow source behind the horizontal scrollbar,
                    and it would clip badly under the card's overflow-x:hidden anyway. */}
                {!isOwnProfile && (
                    <div className="absolute top-3 right-3 z-20" title="More actions">
                        <ClButton
                            icon
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                                e.stopPropagation();
                                const menuItems = [
                                    ...(isFriend && onMessage ? [{
                                        icon: <MessageSquare />, label: 'Message',
                                        onSelect: () => onMessage(userId),
                                    }] : []),
                                    ...(isFriend && onCall ? [{
                                        icon: <PhoneCall />, label: 'Call',
                                        onSelect: () => onCall(userId),
                                    }] : []),
                                    ...(isFriend && onAddToGroup ? [{
                                        icon: <UserPlus />, label: 'Add to Group Chat',
                                        onSelect: handleAddToGroup,
                                    }] : []),
                                    ...(isFriend && inviteToServerItems?.length ? [{
                                        icon: <Server />, label: 'Invite to Server',
                                        onSelect: () => {},
                                        submenu: inviteToServerItems.map(it => ({
                                            label: it.label,
                                            onSelect: it.onSelect,
                                        })),
                                    }] : []),
                                    // Nickname change — viewer has MANAGE_NICKNAMES for this server member
                                    ...(serverId && canSetNickname && onSetNickname ? [{
                                        icon: <AtSign />, label: 'Change Nickname',
                                        onSelect: openNicknameEdit,
                                    }] : []),
                                    ...(isFriend ? [{ divider: true as const }] : []),
                                    ...(isFriend ? [{ icon: <UserMinus />, label: 'Remove Friend', danger: true, onSelect: handleRemoveFriend }] : []),
                                    { icon: <Ban />, label: 'Block', danger: true, onSelect: handleBlock },
                                    ...(onReport ? [{ icon: <Flag />, label: 'Report User', danger: true, onSelect: handleReport }] : []),
                                ];
                                if (menuItems.length > 0) {
                                    profileMenu.open(e, menuItems, displayName);
                                }
                            }}
                        >
                            <MoreVertical size={16} />
                        </ClButton>
                    </div>
                )}

                {/* Avatar — overlaps banner, horizontally centered, clickable to enlarge,
                    status badge in the corner (ringed to separate it from the avatar face). */}
                <ProfileCardAvatar
                    ariaLabel="View avatar"
                    title={avatarBlobUrl ? 'View avatar' : undefined}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (avatarBlobUrl) setLightboxOpen(true);
                    }}
                    interactionClassName={avatarBlobUrl ? 'cursor-zoom-in hover:scale-[1.04]' : 'cursor-default'}
                    badge={!loading && (onMobile ? (
                        <span
                            className="absolute flex items-center justify-center rounded-[6px] ring-[3px] ring-[#131A30] bg-[#131A30]"
                            style={{ right: 4, bottom: 0 }}
                        >
                            <MobileStatusGlyph status={liveEntry.status} size={16} />
                        </span>
                    ) : (
                        <ProfileCardStatusDot color={statusCfg.color} title={statusCfg.label} />
                    ))}
                >
                    {/* Skeleton only while there is genuinely nothing to show:
                        no profile yet AND no avatar id known for this user. */}
                    {loading && !avatarId ? (
                        <div className="w-full h-full bg-white/5 animate-pulse" />
                    ) : (
                        <EncryptedAvatar
                            attachmentId={avatarId}
                            userId={userId}
                            token={token}
                            className="w-full h-full"
                            fallbackSize={40}
                            disableClickProfile
                            bypassFriendGate
                        />
                    )}
                </ProfileCardAvatar>

                {/* Info block — left-aligned */}
                <div className={PROFILE_CARD_INFO_CLASS}>
                    {loading ? (
                        <div className="space-y-2 animate-pulse">
                            <div className="h-5 bg-white/10 rounded-lg w-3/4" />
                            <div className="h-3.5 bg-white/5 rounded-lg w-1/2" />
                            <div className="h-3 bg-white/5 rounded-lg w-2/3 mt-2" />
                        </div>
                    ) : error ? (
                        <p className="text-sm text-cl-flash">{error}</p>
                    ) : profile ? (
                        <>
                            {/* Identity — centered under the centered avatar so the card
                                reads as one column instead of two competing alignments. */}
                            <div className={PROFILE_CARD_IDENTITY_CLASS}>
                                <ProfileCardNameRow
                                    name={displayName}
                                    discriminator={profile.discriminator}
                                    isPro={profile.is_pro}
                                    badges={profile.badges}
                                />

                                {/* Status label / last seen */}
                                <ProfileCardStatusLine>
                                    {liveEntry.status === 'offline' && formatLastSeen(profile.last_seen_at)
                                        ? <span className="text-[12px] text-cl-faint">{formatLastSeen(profile.last_seen_at)}</span>
                                        : <ProfileCardStatusLabel color={statusCfg.color} label={onMobile ? `${statusCfg.label} · on mobile` : statusCfg.label} />
                                    }
                                </ProfileCardStatusLine>

                                {/* Game activity — hidden when offline so the "playing"
                                    signal isn't leaked. */}
                                {liveEntry.current_game && liveEntry.status !== 'offline' && !onMobile && (
                                    <div className="flex items-center gap-2 mt-2 text-[13px] text-cl-muted max-w-full">
                                        <GameControllerIcon size={18} className="text-cl-ok shrink-0" />
                                        <span className="truncate">Playing {liveEntry.current_game}</span>
                                    </div>
                                )}

                                {/* Custom status */}
                                {(liveEntry.custom_status_emoji || liveEntry.custom_status_text) && (
                                    <p className="text-[12.5px] text-cl-muted mt-1.5 truncate max-w-full m-0">
                                        {liveEntry.custom_status_emoji && (
                                            <span className="mr-1">{liveEntry.custom_status_emoji}</span>
                                        )}
                                        {liveEntry.custom_status_text}
                                    </p>
                                )}
                            </div>

                            {/* Hairline between identity and the detail sections */}
                            {hasDetails && <ProfileCardHairline />}

                            {/* Bio */}
                            {profile.bio && <ProfileCardAbout bio={profile.bio} />}

                            {/* Server nickname — shown when in server context */}
                            {serverId && (
                                <div className={profile.bio ? 'mt-3.5' : undefined}>
                                    <Eyebrow>Server Nickname</Eyebrow>
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
                                                    onClick={e => e.stopPropagation()}
                                                />
                                                <ClButton
                                                    icon
                                                    variant="ok"
                                                    size="sm"
                                                    onClick={(e) => { e.stopPropagation(); saveNickname(); }}
                                                    disabled={nicknameSaving}
                                                    tooltip="Save"
                                                >
                                                    <Check size={13} strokeWidth={2.5} />
                                                </ClButton>
                                                <ClButton
                                                    icon
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={(e) => { e.stopPropagation(); closeNicknameEdit(); }}
                                                    disabled={nicknameSaving}
                                                    tooltip="Cancel"
                                                >
                                                    <X size={13} />
                                                </ClButton>
                                            </div>
                                            {nicknameError && (
                                                <p className="text-[11px] text-cl-flash">{nicknameError}</p>
                                            )}
                                            <p className="text-[11px] text-white/25">Leave blank to reset to account username</p>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <span className="text-[13px] text-cl-muted">
                                                {effectiveNickname ?? <span className="text-white/30 italic">None</span>}
                                            </span>
                                            {canSetNickname && onSetNickname && (
                                                <ClButton
                                                    icon
                                                    variant="ghost"
                                                    className="clb--icon-xs"
                                                    onClick={(e) => { e.stopPropagation(); openNicknameEdit(); }}
                                                    tooltip="Edit nickname"
                                                >
                                                    <Pencil size={10} />
                                                </ClButton>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Server roles — only rendered when profile opened from server context */}
                            {assignedRoles.length > 0 && (
                                <div className="mt-4">
                                    <Eyebrow>Roles — {assignedRoles.length}</Eyebrow>
                                    <div className="flex flex-wrap gap-1.5 mt-0.5">
                                        {assignedRoles.map(r => {
                                            const hex = roleColorHexFromInt(r.color);
                                            return (
                                                <span
                                                    key={r.role_id}
                                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold border"
                                                    style={{
                                                        color: hex ?? 'rgba(255,255,255,0.75)',
                                                        borderColor: hex ? `${hex}40` : 'rgba(255,255,255,0.10)',
                                                        backgroundColor: hex ? `${hex}18` : 'rgba(255,255,255,0.05)',
                                                    }}
                                                >
                                                    <span
                                                        className="w-2 h-2 rounded-full shrink-0"
                                                        style={{ backgroundColor: hex ?? 'rgba(255,255,255,0.35)' }}
                                                    />
                                                    {r.name}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </>
                    ) : null}
                </div>

                {/* Bottom action — full-width */}
                {profile && (
                    <ProfileCardFooter>
                        {isOwnProfile ? (
                            <ClButton
                                variant="ghost"
                                fullWidth
                                onClick={() => { handleClose(); onOpenSettings?.(); }}
                            >
                                <Pencil size={14} />
                                Edit Profile
                            </ClButton>
                        ) : isFriend && onMessage ? (
                            <ClButton
                                variant="primary"
                                fullWidth
                                onClick={() => onMessage(userId)}
                            >
                                <MessageSquare size={14} />
                                Message
                            </ClButton>
                        ) : !isFriend && onSendFriendRequest && profile ? (
                            <ClButton
                                variant="primary"
                                fullWidth
                                onClick={() => onSendFriendRequest(userId, profile.username, profile.discriminator ?? null)}
                            >
                                <UserPlus size={14} />
                                Add Friend
                            </ClButton>
                        ) : null}

                    </ProfileCardFooter>
                )}
            </div>

            {/* Avatar lightbox — rendered as a sibling so the popover stays mounted underneath */}
            {lightboxOpen && avatarBlobUrl && (
                <ImageLightbox
                    src={avatarBlobUrl}
                    alt={displayName}
                    onClose={() => setLightboxOpen(false)}
                />
            )}

            {profileMenu.menu}
        </>
    );
};
