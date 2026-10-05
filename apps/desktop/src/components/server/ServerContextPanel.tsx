/**
 * ServerContextPanel — right-hand panel shown when viewing a server channel.
 *
 * Layout (top → bottom):
 *   1. Channel info header (name, topic, server name)
 *   2. Voice Channels section — shows every voice channel; if participants are
 *      present they're listed inline with avatar + status (always visible, even
 *      if you're not in the channel yourself).
 *   3. Members list — grouped ONLINE / OFFLINE, with real avatars, status dots,
 *      and a context menu matching the group-chat member panel exactly.
 */

import secureLocalStore from '../../utils/secureLocalStore';
import { getGroupRowPosition, getGroupRowRoundingClass, type GroupRowPosition } from '../../utils/hoistedGroupRow';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import axios from 'axios';
import { Volume2, MoreVertical, ChevronDown, ChevronRight, User, MessageSquare, PhoneCall, UserMinus, UserPlus, Ban, Flag, Link as LinkIcon, LogOut, Radio, Edit3, Folder, Plus, Pencil, Trash2, Crown, Shield, VolumeX, Gavel, Lock, Pin, X, Search, Video, Monitor, MicOff, VideoOff, MonitorOff, HeadphoneOff, Headphones, PencilOff, PenLine } from 'lucide-react';
import {
    annotationStore, ownedGrantTracks, selectCanGrantAnnotation, selectGrantTarget, isScreenShareTrack,
} from '../../utils/annotationStore';
import { AnnotationGrantBadge } from '../call/AnnotationGrantBadge';
import {
    DndContext, DragOverlay, PointerSensor, KeyboardSensor,
    useSensor, useSensors, useDraggable, useDroppable,
    type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import {
    SortableContext, useSortable,
    verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ChannelInfo, HuddleCallInfo, CategoryInfo, ServerInfo } from '../../hooks/useServers';
import {
    PT_PREFIX, CALL_DROP_PREFIX, HUDDLE_DROP_PREFIX,
    parseParticipantDragId, parseMoveDropTarget,
    type ParsedParticipantDrag,
} from './moveDrag';
import { API_BASE } from '../../constants';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { StatusIcon } from '../StatusPicker';
import { GameControllerIcon } from '../GameControllerIcon';
import { STATUS_CONFIG, type UserStatus, type FriendStatusEntry } from '../../hooks/useUserStatus';
import { resolvePresence } from '../../utils/presenceState';
import { useContextMenu } from '../../hooks/useContextMenu';
import type { ContextMenuItem } from '../primitives/ContextMenu';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { HuddleButton } from './HuddleButton';
import { HuddleCallCard } from './HuddleCallCard';
import { ChannelMessageSearch, type SearchableMessage } from './ChannelMessageSearch';
import { CategoryFormDialog } from './CategoryFormDialog';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { ConfirmDialog, type ConfirmOptions } from '../primitives/ConfirmDialog';
import { Permissions, hasPermission } from '@cipherline/shared';
import { getHighestRoleColor, getTopHoistedRole } from '../../utils/roleColor';
import { useCallContextSafe, useCallTelemetrySafe } from '../../contexts/CallContext';
import { SpeakingRing } from '../call/SpeakingRing';
import { PopoverMenu, calcPopoverPos } from '../call/PopoverMenu';
import { usePersistentVolume, usePersistentNsEnabled } from '../call/VideoTile';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import ReactDOM from 'react-dom';
import { SignalBars, signalQuality } from '../call/CallStatsPill';
import { pingColor } from '../../hooks/useCallStats';
import { ClButton, ClInput, ClModal, ClSearch } from '../cl';
import { FlatIconBtn } from '../primitives/HoverActions';
import { writeToClipboard } from '../../utils/clipboard';
import { useToast } from '../../contexts/ToastContext';
import { canOfferFriendGatedAction } from '../../utils/friendGatedActions';
import { isHuddleAtCallLimit } from '../../utils/huddleCallLimit';
import { callNamingOf, canRenameHuddleCall, liveCallTitle, type CallNamingSettings } from '../../utils/callNaming';
import { nudges } from '../../utils/firstWeekNudgeStore';

// ── Sortable wrappers for Huddle DnD ────────────────────────────────────────

function HuddleDropIndicator({ position = 'top' }: { position?: 'top' | 'bottom' }) {
    const posClass = position === 'top' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2';
    return (
        <div className={`absolute ${posClass} left-1 right-1 z-30 pointer-events-none flex items-center`}>
            <div className="w-2 h-2 rounded-full bg-cl-lume shrink-0 -ml-1" />
            <div className="flex-1 h-0.5 bg-cl-lume rounded-r-full" />
        </div>
    );
}

/** Entire huddle card is draggable — no grip button. */
function SortableHuddleItem({ huddle, disabled, isDragging, dropLine, children }: {
    huddle: ChannelInfo;
    disabled: boolean;
    isDragging: boolean;
    dropLine: 'top' | 'bottom' | null;
    children: React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
        id: `hd:${huddle.channel_id}`,
        disabled,
    });
    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className="relative"
            {...(disabled ? {} : { ...attributes, ...listeners })}
        >
            {dropLine === 'top' && <HuddleDropIndicator position="top" />}
            <div style={{ opacity: isDragging ? 0.35 : 1 }} className={disabled ? '' : 'touch-none select-none'}>
                {children}
            </div>
            {dropLine === 'bottom' && <HuddleDropIndicator position="bottom" />}
        </div>
    );
}

// ── Force-move drag-and-drop (MOVE_MEMBERS) ─────────────────────────────────
//
// Drag a participant out of one call and drop them on another. These share the
// huddle-reorder DndContext below rather than nesting a second one, and are
// told apart by an id prefix — the same convention the reorder code already
// uses for `hd:` / `hcat:`:
//
//   pt:{callId}:{userId}  draggable — a participant row
//   call:{callId}         droppable — an existing call
//   hud:{huddleId}        droppable — a Calls channel with no active call
//
/** Wraps a participant row so it can be picked up and carried to another call.
 *  `disabled` covers both "you lack MOVE_MEMBERS" and "this row is you"
 *  (dragging yourself is handled by the caller as an ordinary join).
 *
 *  pointerdown is stopped at this level so the enclosing SortableHuddleItem —
 *  whose whole card is its own drag activator — never starts a huddle reorder
 *  from a pointer-down that began on a participant. This is dnd-kit's
 *  documented approach for nested draggables and keeps the huddle's existing
 *  grab-anywhere behaviour intact for managers. */
function DraggableParticipant({ callId, userId, disabled, children }: {
    callId: string;
    userId: string;
    disabled: boolean;
    children: React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `${PT_PREFIX}${callId}:${userId}`,
        disabled,
    });
    if (disabled) return <>{children}</>;
    const { onPointerDown, ...restListeners } = (listeners ?? {}) as Record<string, any>;
    return (
        <div
            ref={setNodeRef}
            {...attributes}
            {...restListeners}
            onPointerDown={(e: React.PointerEvent) => { e.stopPropagation(); onPointerDown?.(e); }}
            className={`cl-move-src${isDragging ? ' is-dragging' : ''}`}
        >
            {children}
        </div>
    );
}

/** Drop zone around a call (or an empty Calls channel). `eligible` is false
 *  for the participant's own current call and while nothing is being dragged,
 *  which keeps the highlight off targets that would be a no-op. */
function MoveDropZone({ id, eligible, children }: {
    id: string;
    eligible: boolean;
    children: React.ReactNode;
}) {
    const { setNodeRef, isOver } = useDroppable({ id, disabled: !eligible });
    return (
        <div
            ref={setNodeRef}
            className={eligible ? `cl-move-dst${isOver ? ' is-over' : ''}` : undefined}
        >
            {children}
            {eligible && isOver && (
                <div className="cl-move-hint" aria-hidden>
                    <PhoneCall className="w-3.5 h-3.5" />
                    <span>Move here</span>
                </div>
            )}
        </div>
    );
}

/** Huddle category section — header row is the drag activator. */
function SortableHuddleCatSection({ catId, disabled, isDragging, dropLine, children }: {
    catId: string;
    disabled: boolean;
    isDragging: boolean;
    dropLine: 'top' | 'bottom' | null;
    children: (
        setHeaderRef: (el: HTMLElement | null) => void,
        headerDragProps: React.HTMLAttributes<HTMLElement>,
    ) => React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
        id: `hcat:${catId}`,
        disabled,
    });
    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className="relative"
        >
            {dropLine === 'top' && <HuddleDropIndicator position="top" />}
            <div style={{ opacity: isDragging ? 0.35 : 1 }}>
                {children(
                    setActivatorNodeRef as (el: HTMLElement | null) => void,
                    disabled ? {} : { ...attributes, ...listeners } as React.HTMLAttributes<HTMLElement>,
                )}
            </div>
            {dropLine === 'bottom' && <HuddleDropIndicator position="bottom" />}
        </div>
    );
}

interface ServerMember {
    user_id: string;
    username: string;
    discriminator: number | null;
    nickname: string | null;
    avatar_url: string | null;
    status: string;
    /** From the roster fetch — present on phones only. Newer servers only. */
    on_mobile?: boolean;
    joined_at: string;
    muted_until: string | null;
    /** Role IDs assigned to this member (excludes @everyone — that's implicit). */
    role_ids: string[];
}

interface RoleInfo {
    role_id: string;
    name: string;
    color: number;    // 24-bit packed int; -1 = no color
    position: number;
    hoisted: boolean;
    is_everyone: boolean;
}

interface Props {
    server: ServerInfo;
    channel: ChannelInfo;
    token: string | null;
    userId: string | null;
    /**
     * Caller's resolved server-level permission bitfield. Use with
     * `hasPermission` from `@cipherline/shared`. Passed from Dashboard which
     * fetches it via `GET /v1/servers/:id/me/permissions`. 0n = no perms (default).
     */
    myPermissions?: bigint;
    /**
     * Per-channel resolved permission bitfields. Key = channel_id, value = bigint.
     * Used to gate CONNECT on voice and huddle channel rows without an extra API
     * round-trip — populated from the my_permissions field on each ChannelInfo
     * (injected by the channel list endpoint and parsed in Dashboard).
     */
    channelPermissionsMap?: Record<string, bigint>;

    // Voice participants (channel_id → user_id[]), kept live by WS events
    allChannels: ChannelInfo[];
    voiceParticipants: Record<string, string[]>;

    // Status / presence
    friendStatuses: Record<string, { status: string; current_game?: string | null; on_mobile?: boolean }>;
    /** True once a complete presence snapshot has been applied: from then on
     *  a member absent from `friendStatuses` is offline, not whatever the
     *  roster said when it was fetched (see utils/presenceState.ts). */
    presenceAuthoritative?: boolean;
    myStatus: string;
    myCurrentGame: string | null;

    // Social graph
    globalFriends: { accepted: Array<{ user_id: string; username: string; avatar_url?: string }> } | null;
    conversations: Array<{ conversation_id: string; type: string; other_user_id?: string }>;
    sentFriendRequests: Set<string>;
    setSentFriendRequests: React.Dispatch<React.SetStateAction<Set<string>>>;

    /** Channel ID the local user is currently connected to (if any). */
    activeVoiceChannelId?: string | null;

    /** Active calls under any Huddle in this server, keyed by huddle channel id. */
    huddleCalls?: Record<string, HuddleCallInfo[]>;
    /** Call_id of the call the local user is currently in (Huddle path). */
    activeHuddleCallId?: string | null;
    /**
     * Real, derived encryption state of the local user's OWN active Huddle
     * call — 'connecting' while no confirmed room key is in hand yet,
     * 'connected' once one is (mirrors callsChannelGate in Dashboard.tsx).
     * Only ever applied to the row whose call matches activeHuddleCallId —
     * this device has no way to know another participant's key state, so
     * every other row's padlock is omitted rather than guessed.
     */
    myCallEncryptionState?: 'connecting' | 'connected' | 'mixed' | null;
    /** All categories for this server. Right panel filters to kind='huddle'. */
    categories?: CategoryInfo[];
    /** Decrypted messages for the active text channel. Empty in voice mode. */
    searchableMessages?: SearchableMessage[];

    // Callbacks
    onOpenProfile: (uid: string, pos: { x: number; y: number }, roleCtx?: { roleIds: string[]; roles: RoleInfo[]; serverId?: string; currentNickname?: string | null; canSetNickname?: boolean }) => void;
    onStartChat: (chat: { id: string; title?: string; type?: string; other_user_id?: string; avatar_url?: string }) => void;
    /** Async — resolves the real conversation_id (creates DM if needed) then opens it. */
    onOpenDMWithUser: (userId: string, title: string, avatarUrl?: string) => Promise<void>;
    onStartCall: (uid: string) => void;
    onBlock: (uid: string, username: string) => void;
    /**
     * Open the abuse-report flow for a member.
     *
     * Dashboard has been passing this since the report feature landed, but the
     * prop was never declared here and never used — so `Report User` simply
     * didn't exist in the member menu, and there was no way to report someone
     * from a server at all. TypeScript was flagging it the whole time
     * (TS2322 "Property 'onReport' does not exist") among the file's other
     * pre-existing errors.
     */
    onReport?: (uid: string, username: string) => void;
    /** Called when the user clicks Join / switch on a voice channel. */
    onJoinVoiceChannel?: (channel: ChannelInfo) => void;
    /** Called when the user clicks a Huddle button — spawns a fresh call. */
    onSpawnHuddleCall?: (huddle: ChannelInfo) => void;
    /** Called when the user clicks Join on an existing call card. */
    onJoinExistingHuddleCall?: (callId: string, displayName: string) => void;
    /** Seconds remaining on a server-side call rate-limit cooldown (0 = no cooldown). */
    callCooldownSecs?: number;
    /** Called when the user clicks Leave on the active-self call card. */
    onLeaveHuddleCall?: () => void;
    /** Called when the user renames a call (spawner or MANAGE_CHANNELS). */
    onRenameHuddleCall?: (callId: string, name: string) => void;
    /** Called when the user clicks a search hit — jumps to that message in ChatPane. */
    onJumpToMessage?: (messageId: string) => void;
    /** Called after any category/channel mutation so Dashboard can reload. */
    onChannelsChanged?: () => void;
    /**
     * Called whenever the member→role-color map changes so siblings (ChatPane,
     * CallPane) can colour sender / participant names without fetching roles
     * themselves. Keys are user_ids; values are hex strings or null.
     */
    onMemberRoleColorsChange?: (colors: Record<string, string | null>) => void;
    /**
     * Called whenever the member list is (re)loaded. Keys are user_ids; values are
     * avatar attachment IDs (or null). Forwarded to CallPane → SidebarConference so
     * VideoTile always has avatars even before LiveKit participant metadata propagates.
     */
    onMemberAvatarMapChange?: (map: Record<string, string | null>) => void;
    /**
     * Called whenever the member list is (re)loaded. Keys are user_ids of members
     * who have a non-null server nickname; values are the nickname strings.
     * ChatPane uses this to display server nicknames instead of account usernames.
     */
    onMemberNicknamesChange?: (nicknames: Record<string, string>) => void;
    /**
     * Increment this to force a members+roles re-fetch. Useful after the
     * server settings modal closes (roles may have been created/deleted).
     */
    rolesRefreshKey?: number;
    /**
     * Returns submenu items for "Invite to Server ▸" for the given target user.
     * Supplied by Dashboard which owns the invite-send logic.
     */
    onBuildInviteToServerItems?: (targetUserId: string) => Array<{ label: string; onSelect: () => void }>;
    /**
     * When true, the right panel renders the pinned-messages portal target
     * (ChatPane portals PinnedMessagesPanel into #pinned-panel-root) instead of
     * the normal huddle/voice/members content. Toggled by the Pin button in the
     * ChatPane header.
     */
    showPinnedPanel?: boolean;
    /** Called when the pinned panel's close button is clicked. */
    onClosePinnedPanel?: () => void;
    /** Count of pinned messages for the active channel (badge on the pin button). */
    pinnedCount?: number;
    /**
     * Current search query forwarded to PinnedMessagesPanel when the pinned
     * panel is open. Controlled externally so Dashboard's single chatSearch
     * state doubles as the pinned-search query.
     */
    pinnedSearchQuery?: string;
    /** Called whenever the user types in the pinned-search input. */
    onPinnedSearchChange?: (q: string) => void;
}

export const ServerContextPanel: React.FC<Props> = ({
    server,
    channel,
    token,
    userId,
    myPermissions = 0n,
    allChannels,
    voiceParticipants,
    activeVoiceChannelId = null,
    huddleCalls = {},
    activeHuddleCallId = null,
    myCallEncryptionState = null,
    searchableMessages = [],
    friendStatuses,
    presenceAuthoritative = false,
    myStatus,
    myCurrentGame,
    globalFriends,
    sentFriendRequests,
    setSentFriendRequests,
    onOpenProfile,
    onOpenDMWithUser,
    onStartCall,
    onBlock,
    onReport,
    onJoinVoiceChannel,
    onSpawnHuddleCall,
    onJoinExistingHuddleCall,
    onLeaveHuddleCall,
    onRenameHuddleCall,
    onJumpToMessage,
    callCooldownSecs = 0,
    categories = [],
    onChannelsChanged,
    onMemberRoleColorsChange,
    onMemberAvatarMapChange,
    onMemberNicknamesChange,
    rolesRefreshKey,
    onBuildInviteToServerItems,
    channelPermissionsMap = {},
    showPinnedPanel = false,
    onClosePinnedPanel,
    pinnedSearchQuery = '',
    onPinnedSearchChange,
}) => {
    const [members, setMembers] = useState<ServerMember[]>([]);
    const [serverRoles, setServerRoles] = useState<RoleInfo[]>([]);
    const toast = useToast();

    /** Returns true if the current user has CONNECT permission on a given channel.
     *  Optimistic (true) when my_permissions hasn't loaded yet for that channel. */
    const canConnect = useCallback((channelId: string): boolean => {
        const p = channelPermissionsMap[channelId];
        if (p === undefined) return true; // not yet loaded — optimistic
        return !!(p & Permissions.CONNECT);
    }, [channelPermissionsMap]);

    // Compute userId→hex-color once and emit to parent whenever data changes.
    const memberRoleColors = useMemo<Record<string, string | null>>(() => {
        if (!serverRoles.length) return {};
        const map: Record<string, string | null> = {};
        for (const m of members) {
            map[m.user_id] = getHighestRoleColor(m.role_ids ?? [], serverRoles);
        }
        return map;
    }, [members, serverRoles]);
    // Use a ref so the effects below only re-run when the DATA changes, not when
    // the parent provides a fresh function identity on every render. Both callbacks
    // are inline arrows in Dashboard JSX — using them directly as effect deps
    // creates an infinite loop (callback changes → effect fires → setState → re-render → new callback → …).
    const onMemberRoleColorsChangeRef = useRef(onMemberRoleColorsChange);
    useEffect(() => { onMemberRoleColorsChangeRef.current = onMemberRoleColorsChange; });
    useEffect(() => { onMemberRoleColorsChangeRef.current?.(memberRoleColors); }, [memberRoleColors]);

    // Compute userId→nickname map and emit to parent whenever member list changes.
    const memberNicknames = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        for (const m of members) {
            if (m.nickname) map[m.user_id] = m.nickname;
        }
        return map;
    }, [members]);
    const onMemberNicknamesChangeRef = useRef(onMemberNicknamesChange);
    useEffect(() => { onMemberNicknamesChangeRef.current = onMemberNicknamesChange; });
    useEffect(() => { onMemberNicknamesChangeRef.current?.(memberNicknames); }, [memberNicknames]);
    const [loading, setLoading] = useState(false);
    const [voiceCollapsed, setVoiceCollapsed] = useState(false);
    /** Per-huddle expand state for the active-calls list under each button.
     *  Auto-expands when there are calls; user can manually collapse. */
    const [huddleExpanded, setHuddleExpanded] = useState<Record<string, boolean>>({});
    /** Rename-call dialog (replaces the old native window.prompt). */
    const [renameCall, setRenameCall] = useState<{ callId: string; name: string } | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    const commitRenameCall = () => {
        if (!renameCall) return;
        const next = renameDraft.replace(/[^a-zA-Z0-9 '\-_.]/g, '').trim();
        if (next && next !== renameCall.name) onRenameHuddleCall?.(renameCall.callId, next);
        setRenameCall(null);
    };
    /** Per-huddle-category collapse state. */
    const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
    /** Category form dialog state (right panel creates huddle categories). */
    const [categoryDialog, setCategoryDialog] = useState<
        | { mode: 'create' }
        | { mode: 'edit'; category: CategoryInfo }
        | null
    >(null);
    /** Huddle create dialog. `defaultCategoryId` is pre-filled when created from a category + button. */
    const [createHuddleSettings, setCreateHuddleSettings] = useState<{ defaultCategoryId: string | null } | null>(null);
    /** Huddle being edited/viewed. The dialog manages its own internal tab state. */
    const [huddleSettings, setHuddleSettings] = useState<ChannelInfo | null>(null);
    /** Pending destructive action awaiting styled confirmation. */
    const [pendingConfirm, setPendingConfirm] = useState<ConfirmOptions | null>(null);
    /** Nickname-change dialog target. Null = closed. */
    const [nicknameDialog, setNicknameDialog] = useState<{ userId: string; currentNickname: string | null; displayName: string } | null>(null);
    const [nicknameInput, setNicknameInput] = useState('');
    const [nicknameSaving, setNicknameSaving] = useState(false);
    const [nicknameError, setNicknameError] = useState<string | null>(null);
    const saveNickname = useCallback(async (targetUserId: string, value: string) => {
        if (nicknameSaving) return;
        setNicknameSaving(true);
        setNicknameError(null);
        try {
            await axios.patch(
                `${API_BASE}/servers/${server.server_id}/members/${targetUserId}/nickname`,
                { nickname: value.trim() },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            loadMembers();
            setNicknameDialog(null);
        } catch (err: any) {
            setNicknameError(err?.response?.data?.message || 'Failed to update nickname');
        } finally {
            setNicknameSaving(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nicknameSaving, server.server_id, token]);
    /** Locally-ignored member user_ids — suppresses their messages client-side. Persisted per user+server. */
    const [ignoredUsers, setIgnoredUsers] = useState<Set<string>>(() => {
        try {
            const raw = secureLocalStore.getItem(`cipherline_ignored_${userId}_${server.server_id}`);
            return new Set(raw ? JSON.parse(raw) : []);
        } catch { return new Set(); }
    });
    const toggleIgnore = (targetId: string) => {
        setIgnoredUsers(prev => {
            const next = new Set(prev);
            if (next.has(targetId)) next.delete(targetId); else next.add(targetId);
            try { secureLocalStore.setItem(`cipherline_ignored_${userId}_${server.server_id}`, JSON.stringify([...next])); } catch {}
            return next;
        });
    };
    // Member context menu — single hook owns one menu, items rebuilt per row.
    const memberMenu = useContextMenu();
    // Optimistic role ids: while the flyout is open we track local toggles here
    // so the checkbox flips instantly without waiting for loadMembers() to finish.
    const optimisticRoleIdsRef = useRef<Record<string, string[]>>({});
    // Always-fresh ref to buildMemberMenu so onSelect closures can rebuild items.
    const buildMemberMenuRef = useRef<
        ((m: ServerMember, displayName: string, roleIdsOverride?: string[]) => ContextMenuItem[]) | null
    >(null);
    // Voice-channel-row context menu (right-click on a voice channel name).
    const voiceMenu = useContextMenu();
    // Huddle / call right-click menu.
    const huddleMenu = useContextMenu();
    // Category header right-click menu.
    const catMenu = useContextMenu();
    // Blank-space right-click → create huddle / create category.
    const createMenu = useContextMenu();

    // canManage: true when the caller has MANAGE_CHANNELS (or ADMINISTRATOR,
    // which is implied by ALL_PERMISSIONS). Owners always have ALL_PERMISSIONS
    // from the API, so this correctly covers them too.
    const canManage = !!userId && (
        hasPermission(myPermissions, Permissions.MANAGE_CHANNELS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    const canKick = !!userId && (
        hasPermission(myPermissions, Permissions.KICK_MEMBERS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    const canBan = !!userId && (
        hasPermission(myPermissions, Permissions.BAN_MEMBERS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    const canManageRoles = !!userId && (
        hasPermission(myPermissions, Permissions.MANAGE_ROLES) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    const canChangeOwnNick = !!userId && (
        hasPermission(myPermissions, Permissions.CHANGE_NICKNAME) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    const canManageNick = !!userId && (
        hasPermission(myPermissions, Permissions.MANAGE_NICKNAMES) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    /** DEAFEN_MEMBERS gives the moderator the ability to server-mute any
     *  participant's mic / camera / screen-share track in any call on this
     *  server — not just calls the moderator is in. Powers the right-click
     *  menu on voice-channel and huddle-call participant rows below. */
    const canServerMute = !!userId && (
        hasPermission(myPermissions, Permissions.DEAFEN_MEMBERS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );
    /** MOVE_MEMBERS lets the moderator drag a participant from one call into
     *  another — including one that's at its member limit. The server still
     *  enforces that the moved member has CONNECT on the destination, so this
     *  can't be used to pull someone into a call their roles forbid. */
    const canMoveMembers = !!userId && (
        hasPermission(myPermissions, Permissions.MOVE_MEMBERS) ||
        hasPermission(myPermissions, Permissions.ADMINISTRATOR)
    );

    /** Server-side track-mute helper for the participant context menu. Pairs
     *  with `serverCallMute` on the API; uses the participant's call/room name
     *  (huddle call_id for huddle participants, voice channel's active session
     *  id for voice-channel participants). Errors are silent-toast — the menu
     *  closes immediately on click for snappy UX. */
    const serverMuteCallParticipant = React.useCallback(
        (roomName: string, targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => {
            if (!token || !roomName) return;
            axios.patch(
                `${API_BASE}/servers/${server.server_id}/members/${targetUserId}/call-mute`,
                { track_type: trackType, muted, room_name: roomName },
                { headers: { Authorization: `Bearer ${token}` } },
            ).catch(err => {
                console.error('[ServerContextPanel] server-mute failed:', err?.response?.data ?? err.message);
            });
        },
        [token, server.server_id],
    );

    // Track states published by SidebarConference into shared CallContext.
    // Declared here (not further down) because buildCallParticipantMenu and
    // the JSX for huddle rows below both depend on participantMetadata —
    // useCallback evaluates its deps array during render, so the binding has
    // to exist by then or we hit "Cannot access X before initialization".
    const callCtx = useCallContextSafe();
    // High-freq telemetry (speaking flags at 30 Hz, stats at 3 s) lives in a
    // separate context so only this component (which actually renders them) is
    // the one re-rendering at that cadence, not low-freq siblings.
    const callTelemetry = useCallTelemetrySafe();
    const participantTrackStates = callTelemetry?.participantTrackStates ?? {};
    const participantMetadata = callTelemetry?.participantMetadata ?? {};

    // Context menu instance for participants in active calls (voice channels +
    // huddles). Used when the local user is NOT in the participant's call —
    // they get the limited menu (View Profile + server moderation + Copy ID).
    // When the local user IS in the same call, we open a richer PopoverMenu
    // instead (state below), which adds local controls (volume, mute, NS,
    // hide video, hide screenshare) on top.
    const callParticipantMenu = useContextMenu();

    /** Open state for the rich call-participant popover (only used when local
     *  user is in the same call as the target). `uid` + `roomName` identify
     *  the target; `pos` is the absolute screen position from calcPopoverPos. */
    const [participantPopover, setParticipantPopover] = useState<{
        uid: string;
        displayName: string;
        roomName: string;
        pos: { top: number; left: number };
    } | null>(null);
    // Outside-click + global close-all-popovers dismissal for the popover.
    React.useEffect(() => {
        if (!participantPopover) return;
        const close = () => setParticipantPopover(null);
        window.addEventListener('close-all-popovers', close);
        return () => window.removeEventListener('close-all-popovers', close);
    }, [participantPopover]);

    /** Build the right-click menu shown on a call participant row. `roomName`
     *  is the LiveKit room identifier — `call_id` for huddles, `active_call_session_id`
     *  for voice channels. The server-moderation rows render as `checked` items
     *  reflecting current metadata state; clicking toggles. We snapshot the
     *  metadata at menu-open time, so flips after the menu is built come from a
     *  re-open (matches Discord behavior). */
    /** Participant currently being carried by a drag, or null. Drives the drag
     *  chip and tells the drop zones which of them are eligible. */
    const [movingParticipant, setMovingParticipant] = useState<ParsedParticipantDrag | null>(null);
    /** call_id that just received a moved member — drives the landing pulse. */
    const [landedCallId, setLandedCallId] = useState<string | null>(null);

    /** Fire the move. The server fans out the ordinary participant leave/join
     *  pair to everyone, so we deliberately do NOT mutate huddleCalls here —
     *  letting the WS round-trip be the single source of truth avoids a
     *  double-apply when the echo lands a moment later. */
    const commitMove = React.useCallback(async (
        targetUserId: string,
        dest: { kind: 'call'; callId: string } | { kind: 'huddle'; huddleId: string },
    ) => {
        if (!token) return;
        const url = dest.kind === 'call'
            ? `${API_BASE}/huddles/calls/${dest.callId}/move`
            : `${API_BASE}/huddles/${dest.huddleId}/move`;
        try {
            const res = await axios.post(url, { user_id: targetUserId },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
            const landed = res.data?.call_id ?? (dest.kind === 'call' ? dest.callId : null);
            if (landed) {
                setLandedCallId(landed);
                window.setTimeout(() => setLandedCallId(prev => (prev === landed ? null : prev)), 500);
            }
        } catch (err: any) {
            const msg = err?.response?.data?.message;
            toast.push({
                kind: 'error',
                title: "Couldn't move them",
                message: typeof msg === 'string' && msg
                    ? msg
                    : 'The move was rejected — they may have left the call already.',
            });
        }
    }, [token, toast]);

    /** "Move to ▸" submenu for a participant — the keyboard/right-click
     *  equivalent of dragging them onto another call. Returns [] when the
     *  action doesn't apply (no permission, it's you, they aren't in a call,
     *  or there's nowhere else to put them) so callers can spread it
     *  unconditionally. Destinations mirror the drop targets exactly: any
     *  other live call the viewer can reach, plus any Calls channel with no
     *  call running.
     *
     *  Reads huddles from `allChannels` rather than the optimistic-reorder
     *  copy further down — menu ordering doesn't need the in-flight drag
     *  state, and depending on it would force this above its own declaration. */
    const buildMoveToSubmenu = React.useCallback(
        (uid: string): import('../primitives/ContextMenu').ContextMenuItem[] => {
            if (!canMoveMembers || uid === userId) return [];
            const allCalls = Object.values(huddleCalls).flat();
            const sourceCall = allCalls.find(c => c.participants.includes(uid));
            if (!sourceCall) return [];

            const huddles = allChannels.filter(c => c.kind === 'huddle');
            const huddleName = (hid: string) =>
                huddles.find(h => h.channel_id === hid)?.name ?? 'Calls';

            const targets: import('../primitives/ContextMenu').ContextMenuItem[] = [];
            for (const c of allCalls) {
                if (c.call_id === sourceCall.call_id) continue;
                if (!canConnect(c.huddle_id)) continue;
                targets.push({
                    icon: <PhoneCall />,
                    label: `${c.name} · ${huddleName(c.huddle_id)}`,
                    onSelect: () => void commitMove(uid, { kind: 'call', callId: c.call_id }),
                });
            }
            for (const h of huddles) {
                if ((huddleCalls[h.channel_id] ?? []).length > 0) continue;
                if (!canConnect(h.channel_id)) continue;
                targets.push({
                    icon: <Radio />,
                    label: `New call in ${h.name}`,
                    onSelect: () => void commitMove(uid, { kind: 'huddle', huddleId: h.channel_id }),
                });
            }
            if (targets.length === 0) return [];
            return [
                { divider: true },
                // The parent row still needs an onSelect even though the
                // flyout does the work — opening the submenu IS the action.
                { icon: <LogOut />, label: 'Move to', onSelect: () => {}, submenu: targets },
            ];
        },
        [canMoveMembers, userId, huddleCalls, allChannels, canConnect, commitMove],
    );

    const buildCallParticipantMenu = React.useCallback(
        (uid: string, roomName: string | null, displayName: string) => {
            const items: import('../primitives/ContextMenu').ContextMenuItem[] = [
                {
                    icon: <User />, label: 'View Profile',
                    onSelect: () => onOpenProfile(uid, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, { roleIds: [], roles: [], serverId: server.server_id }),
                },
            ];
            items.push(...buildMoveToSubmenu(uid));
            // Server-side moderation block — only when caller has DEAFEN_MEMBERS
            // and is not acting on themselves, and we have a room to target.
            if (canServerMute && uid !== userId && roomName) {
                const meta = participantMetadata[uid];
                const mutedAudio  = !!meta?.serverMutedAudio;
                const deafened    = !!meta?.serverDeafened;
                const mutedVideo  = !!meta?.serverMutedVideo;
                const mutedScreen = !!meta?.serverMutedScreenShare;
                items.push({ divider: true });
                items.push({
                    icon: <MicOff />, label: 'Server Mute',
                    checked: mutedAudio,
                    onSelect: () => serverMuteCallParticipant(roomName, uid, 'audio', !mutedAudio),
                });
                items.push({
                    icon: <HeadphoneOff />, label: 'Server Deafen',
                    checked: deafened,
                    onSelect: () => serverMuteCallParticipant(roomName, uid, 'deafen', !deafened),
                });
                items.push({
                    icon: <VideoOff />, label: 'Disable Video',
                    checked: mutedVideo,
                    onSelect: () => serverMuteCallParticipant(roomName, uid, 'video', !mutedVideo),
                });
                items.push({
                    icon: <MonitorOff />, label: 'Disable Screen Share',
                    checked: mutedScreen,
                    onSelect: () => serverMuteCallParticipant(roomName, uid, 'screenshare', !mutedScreen),
                });
            }
            // Hand out or take back annotation access. Read straight off the
            // store at open time (menus are built on right-click, so this is
            // always current). Exactly one of the two can apply: "Stop" needs
            // them to hold a grant on a surface WE own, "Allow" needs them to
            // hold none and us to be publishing a surface to grant on — and a
            // grant list is authoritative from its owner alone, so neither
            // will ever offer an action every other client would ignore.
            // `userId` is nullable here (no signed-in id = no surfaces owned);
            // bind it once so the closures below cannot see a different value
            // than the check did.
            const me = userId;
            const annotState = annotationStore.getState();
            if (me && uid !== me && ownedGrantTracks(annotState, me, uid).length > 0) {
                items.push({ divider: true });
                items.push({
                    icon: <PencilOff />, label: 'Stop Annotating', danger: true,
                    onSelect: () => { annotationStore.revokeAllFrom(me, uid); },
                });
            } else if (me && selectCanGrantAnnotation(me, uid)(annotState)) {
                const target = selectGrantTarget(me)(annotState);
                items.push({ divider: true });
                items.push({
                    icon: <PenLine />,
                    label: target && isScreenShareTrack(target) ? 'Allow Annotating on Screen' : 'Allow Annotating',
                    onSelect: () => { annotationStore.grantOnOwnedSurface(me, uid); },
                });
            }
            // Report — this menu (unlike buildMemberMenu) has no Block, since
            // it's the lightweight preview menu for someone in a call you are
            // NOT currently in (or whose member record hasn't loaded yet);
            // Report is still the one moderation action that belongs here
            // regardless. Never shown on self — `uid !== userId` mirrors
            // buildMemberMenu's `!isSelf` gate.
            if (onReport && uid !== userId) {
                items.push({ divider: true });
                items.push({
                    icon: <Flag />, label: 'Report User', danger: true,
                    onSelect: () => onReport(uid, displayName),
                });
            }
            // Copy User ID — always available, useful for support/debugging.
            items.push({ divider: true });
            items.push({
                icon: <LinkIcon />, label: 'Copy User ID',
                onSelect: () => writeToClipboard(uid).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
            });
            return items;
        },
        [canServerMute, userId, onOpenProfile, server.server_id, serverMuteCallParticipant, participantMetadata, onReport],
    );


    // ── Huddle DnD state (optimistic reorder) ───────────────────────────
    const [localHuddles, setLocalHuddles] = useState<ChannelInfo[]>(() =>
        allChannels.filter(c => c.kind === 'huddle').sort((a, b) => a.position - b.position)
    );
    const [localHuddleCats, setLocalHuddleCats] = useState<CategoryInfo[]>(() =>
        categories.filter(c => c.kind === 'huddle').sort((a, b) => a.position - b.position)
    );
    const localHuddlesRef = useRef(localHuddles);
    const localHuddleCatsRef = useRef(localHuddleCats);
    const huddleBackupRef = useRef({ huddles: localHuddles, cats: localHuddleCats });

    useEffect(() => {
        const sorted = allChannels.filter(c => c.kind === 'huddle').sort((a, b) => a.position - b.position);
        setLocalHuddles(sorted);
        localHuddlesRef.current = sorted;
        huddleBackupRef.current.huddles = sorted;
    }, [allChannels]);

    useEffect(() => {
        const sorted = categories.filter(c => c.kind === 'huddle').sort((a, b) => a.position - b.position);
        setLocalHuddleCats(sorted);
        localHuddleCatsRef.current = sorted;
        huddleBackupRef.current.cats = sorted;
    }, [categories]);

    const [huddleActiveId, setHuddleActiveId] = useState<string | null>(null);
    const [huddleOverId,   setHuddleOverId]   = useState<string | null>(null);

    const huddleSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        // Keyboard drag (space to lift, arrows to move, space to drop) so the
        // gesture isn't pointer-only. The "Move to…" context submenu is the
        // primary non-pointer path; this is the belt-and-braces one.
        useSensor(KeyboardSensor),
    );

    function onHuddleDragStart({ active }: DragStartEvent) {
        const pt = parseParticipantDragId(active.id as string);
        if (pt) {
            setMovingParticipant(pt);
            return; // a move — none of the reorder bookkeeping below applies
        }
        setHuddleActiveId(active.id as string);
        setHuddleOverId(null);
        huddleBackupRef.current = {
            huddles: localHuddlesRef.current,
            cats: localHuddleCatsRef.current,
        };
    }

    function onHuddleDragOver({ active, over }: DragOverEvent) {
        const dragId = active.id as string;
        if (parseParticipantDragId(dragId)) return; // move drags need no reflow
        setHuddleOverId(over ? (over.id as string) : null);
        if (!over || !canManage) return;
        if (!dragId.startsWith('hd:')) return;

        const huddleId = dragId.slice(3);
        const hds = localHuddlesRef.current;
        const activeHd = hds.find(h => h.channel_id === huddleId);
        if (!activeHd) return;

        const currentCatId = activeHd.parent_category_id ?? null;
        const overId = over.id as string;

        let targetCatId: string | null = currentCatId;
        if (overId.startsWith('hd:')) {
            const overHd = hds.find(h => h.channel_id === overId.slice(3));
            if (overHd) targetCatId = overHd.parent_category_id ?? null;
        } else if (overId.startsWith('hcat:')) {
            targetCatId = overId.slice(5);
        }

        if (targetCatId === currentCatId) return;

        const targetHds = hds.filter(h => (h.parent_category_id ?? null) === targetCatId);
        const newPos = targetHds.length > 0
            ? Math.max(...targetHds.map(h => h.position)) + 1000
            : 1000;

        const newHuddles = hds.map(h =>
            h.channel_id === huddleId
                ? { ...h, parent_category_id: targetCatId, position: newPos }
                : h
        );
        setLocalHuddles(newHuddles);
        localHuddlesRef.current = newHuddles;
    }

    function onHuddleDragEnd({ active, over }: DragEndEvent) {
        // ── Force-move: dropped a participant on a call / Calls channel ──
        const pt = parseParticipantDragId(active.id as string);
        if (pt) {
            setMovingParticipant(null);
            if (!over) return;
            const dest = parseMoveDropTarget(over.id as string, pt.callId);
            if (!dest) return;
            // Dragging your OWN row is just a fast way to switch calls — no
            // permission needed, and it must go through the ordinary join so
            // the leave/spawn bookkeeping and the "switch calls?" prompt all
            // behave exactly as if the row had been clicked.
            if (pt.userId === userId) {
                if (dest.kind === 'call') {
                    const target = Object.values(huddleCalls).flat().find(c => c.call_id === dest.callId);
                    onJoinExistingHuddleCall?.(dest.callId, target?.name ?? 'Call');
                } else {
                    const hd = localHuddlesRef.current.find(h => h.channel_id === dest.huddleId);
                    if (hd) onSpawnHuddleCall?.(hd);
                }
                return;
            }
            if (!canMoveMembers) return;
            void commitMove(pt.userId, dest);
            return;
        }

        setHuddleActiveId(null);
        setHuddleOverId(null);

        if (!over || !canManage) {
            setLocalHuddles(huddleBackupRef.current.huddles);
            localHuddlesRef.current = huddleBackupRef.current.huddles;
            setLocalHuddleCats(huddleBackupRef.current.cats);
            localHuddleCatsRef.current = huddleBackupRef.current.cats;
            return;
        }

        const dragId = active.id as string;
        const overId = over.id as string;
        if (dragId === overId) return;

        const hds = localHuddlesRef.current;
        const hcats = localHuddleCatsRef.current;

        // ── Huddle-category reorder ────────────────────────────────────
        if (dragId.startsWith('hcat:') && overId.startsWith('hcat:')) {
            const activeIdx = hcats.findIndex(c => c.category_id === dragId.slice(5));
            const overIdx   = hcats.findIndex(c => c.category_id === overId.slice(5));
            if (activeIdx === -1 || overIdx === -1) return;

            const newCats = arrayMove(hcats, activeIdx, overIdx).map((c, i) => ({
                ...c, position: (i + 1) * 1000,
            }));
            setLocalHuddleCats(newCats);
            localHuddleCatsRef.current = newCats;

            axios.patch(`${API_BASE}/servers/${server.server_id}/categories/reorder`, {
                category_ids: newCats.map(c => c.category_id),
            }, { headers: { Authorization: `Bearer ${token}` } })
                .then(() => onChannelsChanged?.())
                .catch(() => {
                    setLocalHuddleCats(huddleBackupRef.current.cats);
                    localHuddleCatsRef.current = huddleBackupRef.current.cats;
                });
            return;
        }

        // ── Huddle reorder / move ──────────────────────────────────────
        if (dragId.startsWith('hd:')) {
            const huddleId = dragId.slice(3);
            const activeHd = hds.find(h => h.channel_id === huddleId);
            if (!activeHd) return;

            const catId = activeHd.parent_category_id ?? null;
            let finalHuddles = hds;

            if (overId.startsWith('hd:')) {
                const overHuddleId = overId.slice(3);
                const overHd = hds.find(h => h.channel_id === overHuddleId);

                if (overHd && (overHd.parent_category_id ?? null) === catId) {
                    const containerHds = hds
                        .filter(h => (h.parent_category_id ?? null) === catId)
                        .sort((a, b) => a.position - b.position);
                    const fromIdx = containerHds.findIndex(h => h.channel_id === huddleId);
                    const toIdx   = containerHds.findIndex(h => h.channel_id === overHuddleId);

                    if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                        const reordered = arrayMove(containerHds, fromIdx, toIdx)
                            .map((h, i) => ({ ...h, position: (i + 1) * 1000 }));
                        finalHuddles = [
                            ...hds.filter(h => (h.parent_category_id ?? null) !== catId),
                            ...reordered,
                        ];
                        setLocalHuddles(finalHuddles);
                        localHuddlesRef.current = finalHuddles;
                    }
                }
            }

            const sortedHCats = [...hcats].sort((a, b) => a.position - b.position);
            const uncatHds = finalHuddles
                .filter(h => !h.parent_category_id)
                .sort((a, b) => a.position - b.position);
            const catHds = sortedHCats.flatMap(cat =>
                finalHuddles
                    .filter(h => h.parent_category_id === cat.category_id)
                    .sort((a, b) => a.position - b.position)
            );

            const items = [...uncatHds, ...catHds].map(h => ({
                channel_id: h.channel_id,
                parent_category_id: h.parent_category_id ?? null,
            }));
            if (items.length === 0) return;

            axios.patch(`${API_BASE}/servers/${server.server_id}/channels/reorder`, { items }, {
                headers: { Authorization: `Bearer ${token}` },
            })
                .then(() => onChannelsChanged?.())
                .catch(() => {
                    setLocalHuddles(huddleBackupRef.current.huddles);
                    localHuddlesRef.current = huddleBackupRef.current.huddles;
                });
        }
    }

    // (Member-menu dismissal lives inside useContextMenu — no extra wiring.)

    const loadMembers = useCallback(() => {
        if (!token || !server.server_id) return;
        setLoading(true);
        Promise.all([
            axios.get(`${API_BASE}/servers/${server.server_id}/members`, {
                headers: { Authorization: `Bearer ${token}` },
            }),
            axios.get(`${API_BASE}/servers/${server.server_id}/roles`, {
                headers: { Authorization: `Bearer ${token}` },
            }).catch(() => ({ data: [] })),
        ]).then(([membersRes, rolesRes]) => {
            setMembers(membersRes.data ?? []);
            setServerRoles(rolesRes.data ?? []);
            const avatarMap: Record<string, string | null> = {};
            for (const m of (membersRes.data ?? [])) {
                avatarMap[m.user_id] = m.avatar_url ?? null;
            }
            onMemberAvatarMapChange?.(avatarMap);
        }).catch(err => {
            console.error('[ServerContextPanel] Failed to load members:', err);
        }).finally(() => {
            setLoading(false);
        });
    }, [token, server.server_id]);

    // Also re-fetch when rolesRefreshKey changes (settings modal closed after
    // creating/editing roles so the right-click role menu stays up to date).
    useEffect(() => { loadMembers(); }, [loadMembers, rolesRefreshKey]);

    // Helper: live status for a member
    // Server-enforced enum — status strings that reach the client are always
    // one of UserStatus's four values, but the prop chain (ServerMember.status,
    // myStatus, friendStatuses[...].status) types them loosely as `string`.
    //
    // The roster's `m.status` is only a fallback, and only until the first
    // complete presence snapshot: the roster is fetched when the server is
    // opened, not on reconnect, so after an outage of our own it can say
    // "online" about someone who left an hour ago.
    const livePresence = (m: ServerMember): { status: UserStatus; onMobile: boolean } =>
        m.user_id === userId
            ? { status: myStatus as UserStatus, onMobile: false }
            : resolvePresence(friendStatuses[m.user_id] as FriendStatusEntry | undefined, m, presenceAuthoritative);
    const liveStatus = (m: ServerMember): UserStatus => livePresence(m).status;
    const liveOnMobile = (m: ServerMember): boolean => livePresence(m).onMobile;

    // Games are a desktop signal — none while only on a phone.
    const liveGame = (m: ServerMember) =>
        m.user_id === userId
            ? myCurrentGame
            : (liveOnMobile(m) ? null : (friendStatuses[m.user_id]?.current_game ?? null));

    // Build lookup map for voice participant info
    const memberMap = new Map(members.map(m => [m.user_id, m]));

    // (callCtx + participantTrackStates + participantMetadata moved to the top
    // of the component — see the block above the canServerMute helper. They
    // were declared here originally, but the buildCallParticipantMenu
    // useCallback (declared higher up) reads `participantMetadata` in its
    // deps array, which is evaluated during render BEFORE this line ran —
    // hit TDZ as "Cannot access participantMetadata before initialization".)

    // Voice channels with participants
    const voiceChannels = useMemo(() => allChannels.filter(c => c.kind === 'voice'), [allChannels]);

    // Huddle categories: use localHuddleCats (DnD-aware), preserve user order.
    const huddleCategories = useMemo(() => localHuddleCats, [localHuddleCats]);

    // Group huddles by parent_category_id; preserve user-defined position order.
    const huddleGroups = useMemo(() => {
        const sorted = [...localHuddles].sort((a, b) => a.position - b.position);
        const uncategorized = sorted.filter(h => !h.parent_category_id);
        const byCat: Record<string, ChannelInfo[]> = {};
        for (const h of sorted) {
            if (h.parent_category_id) (byCat[h.parent_category_id] ||= []).push(h);
        }
        return { uncategorized, byCat };
    }, [localHuddles]);
    // ── Huddle drop-line helper ──────────────────────────────────────────
    const getHuddleDropLine = (
        itemKey: string,
        containerKeys: string[],
    ): 'top' | 'bottom' | null => {
        if (!huddleActiveId || huddleOverId !== itemKey) return null;
        const aIdx = containerKeys.indexOf(huddleActiveId);
        const oIdx = containerKeys.indexOf(itemKey);
        if (oIdx === -1) return null;
        return (aIdx === -1 || aIdx < oIdx) ? 'bottom' : 'top';
    };

    // Search bar visible only in text-channel mode (no point in voice/huddle).
    const showSearch = channel.kind === 'text';

    // Auto-expand any Huddle that has active calls.
    // If the user manually collapsed a Huddle and a new call arrives, clear
    // the override so the ?? default (calls.length > 0 → true) kicks in again.
    useEffect(() => {
        setHuddleExpanded(prev => {
            let changed = false;
            const next = { ...prev };
            for (const h of localHuddles) {
                const hasCalls = (huddleCalls[h.channel_id]?.length ?? 0) > 0;
                if (hasCalls && prev[h.channel_id] === false) {
                    // Clear the explicit-false override so ?? true takes over
                    delete next[h.channel_id];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [huddleCalls, localHuddles]);

    // ── Hoisted-role grouping ───────────────────────────────────────────────
    // ONLINE members are grouped by their highest-position hoisted role
    // (roles with "Display members separately" checked). A member whose top
    // role is not hoisted falls down to their next highest hoisted role; if
    // none, they land in the generic "Members" bucket at the bottom of online.
    // Name colour is independent — driven by the highest-position role with a
    // real colour (getHighestRoleColor), handled separately below.
    // ALL OFFLINE members go into a single flat "Offline" section at the very
    // bottom of the panel regardless of role — keeps the list compact.
    const memberGroups = useMemo(() => {
        const onlineByRole = new Map<string, ServerMember[]>();
        const onlineNoRole: ServerMember[] = [];
        const allOffline:   ServerMember[] = [];

        for (const m of members) {
            const isOffline = liveStatus(m) === 'offline';
            if (isOffline) { allOffline.push(m); continue; }
            const top = getTopHoistedRole(m.role_ids ?? [], serverRoles);
            if (top) {
                let bucket = onlineByRole.get(top.role_id);
                if (!bucket) { bucket = []; onlineByRole.set(top.role_id, bucket); }
                bucket.push(m);
            } else {
                onlineNoRole.push(m);
            }
        }

        const byName = (a: ServerMember, b: ServerMember) =>
            (a.nickname ?? a.username ?? '').localeCompare(b.nickname ?? b.username ?? '');
        onlineByRole.forEach(arr => arr.sort(byName));
        onlineNoRole.sort(byName);
        allOffline.sort(byName);

        // Order online groups by role position desc (only hoisted roles appear).
        const sortedRoles = serverRoles
            .filter(r => !r.is_everyone && r.hoisted)
            .sort((a, b) => b.position - a.position);
        const roleGroups = sortedRoles
            .filter(r => onlineByRole.has(r.role_id))
            .map(role => ({ role, members: onlineByRole.get(role.role_id)! }));

        return { roleGroups, onlineNoRole, allOffline };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [members, serverRoles, friendStatuses, myStatus, presenceAuthoritative]);

    const { roleGroups, onlineNoRole, allOffline } = memberGroups;

    // ── Member tile ─────────────────────────────────────────────────────────
    // Build the per-member context menu items. Called fresh each open so the
    // friend / pending state is always current.
    const buildMemberMenu = (m: ServerMember, displayName: string, roleIdsOverride?: string[]) => {
        const isSelf = m.user_id === userId;
        const isFriend = !!globalFriends?.accepted.some(f => f.user_id === m.user_id);
        const isIgnored = ignoredUsers.has(m.user_id);
        const isOwner = m.user_id === server.owner_user_id;

        // Effective role ids: prefer the override passed in (optimistic state),
        // then any pending optimistic value in the ref, then the real member data.
        const effectiveRoleIds: string[] =
            roleIdsOverride ??
            optimisticRoleIdsRef.current[m.user_id] ??
            m.role_ids ?? [];

        // Role submenu — one item per non-everyone role, ticked if already assigned.
        const assignableRoles = serverRoles.filter(r => !r.is_everyone);
        const roleSubmenu = assignableRoles.map(r => {
            const assigned = effectiveRoleIds.includes(r.role_id);
            return {
                label: r.name,
                checked: assigned,
                onSelect: async () => {
                    // P12: re-check MANAGE_ROLES at click-time. The submenu only
                    // builds when canManageRoles was true; this guard catches the
                    // edge case where the user lost the permission between menu
                    // open and item click (rare, but eliminates the silent 403).
                    if (!canManageRoles) return;
                    // Optimistic flip — compute new ids and immediately rebuild the menu.
                    const newIds = assigned
                        ? effectiveRoleIds.filter(id => id !== r.role_id)
                        : [...effectiveRoleIds, r.role_id];
                    optimisticRoleIdsRef.current[m.user_id] = newIds;
                    if (buildMemberMenuRef.current) {
                        memberMenu.updateItems(buildMemberMenuRef.current(m, displayName, newIds));
                    }
                    // API call; on completion clear the optimistic state.
                    try {
                        if (assigned) {
                            await axios.delete(`${API_BASE}/servers/${server.server_id}/members/${m.user_id}/roles/${r.role_id}`, { headers: { Authorization: `Bearer ${token}` } });
                        } else {
                            await axios.put(`${API_BASE}/servers/${server.server_id}/members/${m.user_id}/roles/${r.role_id}`, {}, { headers: { Authorization: `Bearer ${token}` } });
                        }
                        delete optimisticRoleIdsRef.current[m.user_id];
                        loadMembers();
                    } catch {
                        // Revert on failure.
                        delete optimisticRoleIdsRef.current[m.user_id];
                        if (buildMemberMenuRef.current) {
                            memberMenu.updateItems(buildMemberMenuRef.current(m, displayName));
                        }
                    }
                },
            };
        });

        const assignedRoles = serverRoles.filter(r => !r.is_everyone && effectiveRoleIds.includes(r.role_id));
        const roleCtx = { roleIds: effectiveRoleIds, roles: serverRoles.filter(r => !r.is_everyone) };

        // Message / Start a Call both work by DMing this member — same
        // createDm gate as "Invite to Server" below, and being in the same
        // server does NOT satisfy it (mutual friendship is required
        // regardless of shared server membership). canFriendGatedDm mirrors
        // the isFriend/pending/blocked branch a few lines down, which
        // already got this right for Add Friend / Remove Friend; Message,
        // Start a Call and Invite to Server previously did not.
        const canFriendGatedDm = canOfferFriendGatedAction(isSelf ? 'self' : isFriend ? 'friend' : 'stranger');
        const inviteSubItems = canFriendGatedDm && onBuildInviteToServerItems
            ? onBuildInviteToServerItems(m.user_id)
            : null;

        const items: ContextMenuItem[] = [
            { icon: <User />, label: 'View Profile', onSelect: () => onOpenProfile(m.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, { ...roleCtx, serverId: server.server_id, currentNickname: m.nickname ?? null, canSetNickname: m.user_id === userId ? canChangeOwnNick : canManageNick }) },
            ...(!isSelf && canFriendGatedDm ? [
                {
                    icon: <MessageSquare />, label: 'Message',
                    onSelect: () => { onOpenDMWithUser(m.user_id, displayName, m.avatar_url ?? undefined); },
                },
                { icon: <PhoneCall />, label: 'Start a Call', onSelect: () => onStartCall(m.user_id) },
                ...(inviteSubItems?.length ? [{ icon: <UserPlus />, label: 'Invite to Server', onSelect: () => {}, submenu: inviteSubItems }] : []),
            ] : []),
            { divider: true as const },
            ...(isFriend ? [
                {
                    icon: <UserMinus />, label: 'Remove Friend', danger: true,
                    onSelect: async () => {
                        try { await axios.delete(`${API_BASE}/friends/${m.user_id}`, { headers: { Authorization: `Bearer ${token}` } }); }
                        catch { /* non-fatal */ }
                    },
                },
            ] : sentFriendRequests.has(m.user_id) ? [
                { icon: <UserPlus />, label: 'Friend Request Sent', disabled: true, onSelect: () => {} },
            ] : !isSelf ? [
                {
                    icon: <UserPlus />, label: 'Add Friend',
                    onSelect: async () => {
                        try {
                            await axios.post(`${API_BASE}/friends/request`, { target_username: m.username, target_discriminator: m.discriminator }, { headers: { Authorization: `Bearer ${token}` } });
                            setSentFriendRequests(prev => new Set(prev).add(m.user_id));
                            nudges.notify({ kind: 'friend_request_sent' });
                        } catch (err: any) {
                            const msg = err?.response?.data?.message || 'Could not send friend request.';
                            toast.push({ kind: 'error', title: 'Friend request failed', message: msg });
                        }
                    },
                },
            ] : []),
            ...(!isSelf ? [
                {
                    icon: isIgnored ? <VolumeX className="text-yellow-400" /> : <VolumeX />,
                    label: isIgnored ? 'Unignore' : 'Ignore',
                    onSelect: () => toggleIgnore(m.user_id),
                },
                { icon: <Ban />, label: 'Block', danger: true, onSelect: () => onBlock(m.user_id, displayName) },
                // Sits beside Block because they're the same decision for the
                // user ("this person is a problem") with different outcomes:
                // Block is local and private, Report goes to moderation.
                ...(onReport ? [{
                    icon: <Flag />, label: 'Report User', danger: true,
                    onSelect: () => onReport(m.user_id, displayName),
                }] : []),
            ] : []),
            // ── Roles section ───────────────────────────────────────────
            // Managers see the full interactive submenu (assign / unassign).
            // Everyone else sees a read-only list of the member's assigned roles.
            ...(canManageRoles && assignableRoles.length > 0 ? [
                { divider: true as const },
                {
                    icon: <Shield />,
                    label: 'Roles',
                    onSelect: () => {},
                    submenu: roleSubmenu,
                },
            ] : !canManageRoles && assignedRoles.length > 0 ? [
                { divider: true as const },
                {
                    icon: <Shield />,
                    label: 'Roles',
                    onSelect: () => {},
                    submenu: assignedRoles.map(r => ({
                        label: r.name,
                        checked: true as const,
                        disabled: true,
                        onSelect: () => {},
                    })),
                },
            ] : []),
            // ── Nickname ───────────────────────────────────────────────
            ...((isSelf ? canChangeOwnNick : canManageNick) ? [
                { divider: true as const },
                {
                    icon: <Pencil />,
                    label: 'Change Nickname',
                    onSelect: () => {
                        setNicknameInput(m.nickname ?? '');
                        setNicknameError(null);
                        setNicknameDialog({ userId: m.user_id, currentNickname: m.nickname ?? null, displayName });
                    },
                },
            ] : []),
            ...((canKick || canBan) && !isSelf && !isOwner ? [
                { divider: true as const },
                ...(canKick ? [{
                    icon: <Gavel />,
                    label: `Kick ${displayName}`,
                    danger: true,
                    onSelect: () => setPendingConfirm({
                        title: `Kick ${displayName}?`,
                        message: `${displayName} will be removed from the server but can rejoin with an invite.`,
                        confirmLabel: 'Kick',
                        onConfirm: async () => {
                            try { await axios.post(`${API_BASE}/servers/${server.server_id}/members/${m.user_id}/kick`, {}, { headers: { Authorization: `Bearer ${token}` } }); loadMembers(); }
                            catch { /* non-fatal */ }
                        },
                    }),
                }] : []),
                ...(canBan ? [{
                    icon: <Ban />,
                    label: `Ban ${displayName}`,
                    danger: true,
                    onSelect: () => setPendingConfirm({
                        title: `Ban ${displayName}?`,
                        message: `${displayName} will be permanently banned and cannot rejoin unless unbanned.`,
                        confirmLabel: 'Ban',
                        onConfirm: async () => {
                            try { await axios.post(`${API_BASE}/servers/${server.server_id}/members/${m.user_id}/ban`, {}, { headers: { Authorization: `Bearer ${token}` } }); loadMembers(); }
                            catch { /* non-fatal */ }
                        },
                    }),
                }] : []),
            ] : []),
        ];
        // "Move to ▸" — only materialises when they're actually in a call and
        // we hold MOVE_MEMBERS, so it stays absent from the ordinary member
        // list where it would mean nothing.
        items.push(...buildMoveToSubmenu(m.user_id));
        return items;
    };
    // Keep the ref always pointing at the latest closure so onSelect can
    // call buildMemberMenu after the component has re-rendered.
    buildMemberMenuRef.current = buildMemberMenu;

    // PERF: a render FUNCTION, not a component. It used to be declared as a
    // component (`const MemberTile = (...) => ...`, rendered as JSX) inside
    // this panel's body, which made it a brand-new component TYPE on every
    // panel render — so React unmounted and re-created every member row (DOM,
    // EncryptedAvatar and all) each time Dashboard re-rendered: every
    // presence/typing/unread event and every channel switch, x60 members in a
    // busy server. Called as a function, its output reconciles in place. It
    // uses no hooks, so this is behaviour-identical.
    const renderMemberTile = (m: ServerMember, groupPos: GroupRowPosition | null = null) => {
        const isMe = m.user_id === userId;
        const isOwner = m.user_id === server.owner_user_id;
        const status = liveStatus(m);
        const onMobile = liveOnMobile(m);
        const game = liveGame(m);
        const showController = !!game && status !== 'offline';
        // Always show a real name — never the raw user_id. The members fetch
        // populates username for every active member; the "Unknown User"
        // fallback only kicks in for the brief gap between channel-load and
        // member-fetch completion, or for genuinely-stale data.
        const displayName = m.nickname ?? m.username ?? 'Unknown User';
        // Ring punches out the tile's background colour. The hoisted-group
        // wash (bg-black/[0.12], see below) is close enough in value to the
        // panel's own bg-cl-abyss that a single ring colour reads cleanly
        // against both — no separate "in a group" token needed.
        const dotRing = 'border-cl-abyss';
        // Hoisted-role groups ("Display members separately") render as one
        // merged slab: every row gets the same subtle darker wash, and only
        // the group's outer top/bottom corners round — interior seams are
        // square so consecutive rows butt flush. See utils/hoistedGroupRow.ts.
        // Hover still reads clearly on top: hover:bg-white/[0.04] sets the
        // same CSS property, so it simply replaces the wash for that one row.
        const groupClasses = groupPos
            ? `bg-black/[0.12] ${getGroupRowRoundingClass(groupPos)}`
            : 'rounded-lg';

        return (
            <div
                key={m.user_id}
                className={`flex items-center gap-2.5 px-2 py-1.5 hover:bg-white/[0.04] transition-colors relative group cursor-pointer ${groupClasses}`}
                onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button')) return;
                    onOpenProfile(m.user_id, { x: e.clientX, y: e.clientY }, {
                        roleIds: m.role_ids ?? [],
                        roles: serverRoles.filter(r => !r.is_everyone),
                        serverId: server.server_id,
                        currentNickname: m.nickname ?? null,
                        canSetNickname: isMe ? canChangeOwnNick : canManageNick,
                    });
                }}
                onContextMenu={(e) => {
                    // Clear any stale optimistic role state from a previous open.
                    delete optimisticRoleIdsRef.current[m.user_id];
                    memberMenu.open(e, buildMemberMenu(m, displayName), displayName);
                }}
            >
                {/* Avatar + status dot — dim entire block when offline */}
                <div className={`relative w-8 h-8 shrink-0 transition-opacity ${status === 'offline' ? 'opacity-35' : ''}`}>
                    <div className="w-full h-full rounded-full overflow-hidden">
                        <EncryptedAvatar
                            attachmentId={m.avatar_url}
                            userId={m.user_id}
                            token={token}
                            className="w-full h-full"
                            fallbackSize={14}
                            bypassFriendGate
                        />
                    </div>
                    {showController ? (
                        /* Controller badge — no ring needed, icon reads on its own */
                        <span className="absolute -bottom-1 -right-1 flex items-center justify-center">
                            <GameControllerIcon
                                size={13}
                                color={STATUS_CONFIG[status]?.color ?? '#22c55e'}
                            />
                        </span>
                    ) : (
                        /* Plain status dot — ring punches out the tile's background */
                        <span className={`absolute -bottom-0.5 -right-0.5 border-[2px] ${dotRing} rounded-full flex items-center justify-center`}>
                            <StatusIcon status={status} currentGame={null} onMobile={onMobile} size={8} />
                        </span>
                    )}
                </div>

                {/* Name + activity */}
                <div className="flex-1 min-w-0">
                    {/* div (not p) so overflow:hidden doesn't clip the Crown tooltip */}
                    <div className={`flex items-center gap-1.5 font-semibold leading-tight min-w-0 ${showController ? 'text-[13px]' : 'text-[14px]'}`} style={{ color: status === 'offline' ? 'rgba(255,255,255,0.30)' : (memberRoleColors[m.user_id] ?? 'rgba(255,255,255,0.88)') }}>
                        <span className="truncate">{displayName}</span>
                        {isOwner && (
                            <span className="relative group/crown shrink-0 inline-flex items-center">
                                <Crown size={11} className="text-amber-400" />
                                <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 rounded-md bg-cl-raise border border-cl-border/50 text-[10px] text-white/75 whitespace-nowrap shadow-lg opacity-0 group-hover/crown:opacity-100 transition-opacity z-50">
                                    Server Owner
                                </span>
                            </span>
                        )}
                        {isMe && <span className="text-[10px] text-cl-faint font-normal shrink-0">(you)</span>}
                    </div>
                    {game && status !== 'offline' && (
                        <p className="text-[12px] text-white/45 truncate leading-tight mt-0.5">{game}</p>
                    )}
                </div>

                {/* More-options button — opens the same menu the right-click does. */}
                {!isMe && (
                    <FlatIconBtn
                        title="Member options"
                        aria-label="Member options"
                        onClick={(e) => {
                            e.stopPropagation();
                            delete optimisticRoleIdsRef.current[m.user_id];
                            memberMenu.open(e, buildMemberMenu(m, displayName), displayName);
                        }}
                        className="opacity-0 group-hover:opacity-100"
                    >
                        <MoreVertical />
                    </FlatIconBtn>
                )}
            </div>
        );
    };

    // ── Huddle channel delete ───────────────────────────────────────────────
    const deleteHuddleApi = async (h: ChannelInfo) => {
        if (!token) return;
        await axios.delete(`${API_BASE}/servers/${server.server_id}/channels/${h.channel_id}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        onChannelsChanged?.();
    };

    // ── Per-huddle category delete ──────────────────────────────────────────
    const deleteCategoryApi = async (cat: CategoryInfo) => {
        if (!token) return;
        await axios.delete(`${API_BASE}/servers/${server.server_id}/categories/${cat.category_id}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        onChannelsChanged?.();
    };

    // Build category header context-menu items (only for canManage users).
    const buildCatMenu = (cat: CategoryInfo) => [
        ...(canManage ? [
            {
                icon: <Plus />, label: 'Create Calls channel here',
                onSelect: () => {
                    setCreateHuddleSettings({ defaultCategoryId: cat.category_id });
                },
            },
            { divider: true as const },
            {
                icon: <Pencil />, label: 'Edit Category',
                onSelect: () => setCategoryDialog({ mode: 'edit', category: cat }),
            },
            {
                icon: <Trash2 />, label: 'Delete Category', danger: true as const,
                onSelect: () => setPendingConfirm({
                    title: `Delete "${cat.name}"?`,
                    message: 'All Calls channels inside will also be deleted. This cannot be undone.',
                    confirmLabel: 'Delete',
                    onConfirm: async () => {
                        try { await deleteCategoryApi(cat); }
                        catch (e) { console.error('[ServerContextPanel] delete huddle category:', e); }
                    },
                }),
            },
        ] : []),
    ];

    // ── Dynamic call display name ────────────────────────────────────────────
    // The game being played can take over a call's TITLE (never its stored
    // name — nothing is sent to the server for it): when at least half the
    // participants play the same game, the most-played one (ties: first
    // found). Whether that happens, and how, is the Calls channel's "Call
    // names" setting — replace the name (default), show it after the name,
    // or never (incl. "Never change call names"). Rule + setting live in
    // @cipherline/shared/call-naming.ts; see utils/callNaming.ts.
    //
    // Reactively recalculates whenever friendStatuses / myCurrentGame change
    // so the card title updates live as people start/stop games or join/leave.
    const computeCallDisplayName = React.useCallback(
        (participantIds: string[], defaultName: string, setting: CallNamingSettings): string =>
            liveCallTitle(defaultName, participantIds, setting, uid => (uid === userId
                ? myCurrentGame
                : (friendStatuses[uid]?.current_game ?? null))),
        [userId, myCurrentGame, friendStatuses],
    );

    // Helper: render a HuddleButton + its call cards.
    const renderHuddle = (h: ChannelInfo) => {
        const calls = huddleCalls[h.channel_id] ?? [];
        // Preserve spawn order — oldest first (stable arrival order from server).
        const sortedCalls = [...calls].sort(
            (a, b) => new Date(a.spawned_at).getTime() - new Date(b.spawned_at).getTime()
        );
        const aggregateParticipants = calls.reduce((sum, c) => sum + c.participants.length, 0);
        const expanded = huddleExpanded[h.channel_id] ?? (calls.length > 0);
        const isActiveForMe = calls.some(c => c.call_id === activeHuddleCallId);
        // Gate on both cooldown (rate-limit) AND channel CONNECT permission.
        const hCanJoin = canConnect(h.channel_id);
        // Mirrors HuddlesService.spawnCall's server-enforced cap ("This Calls
        // channel has reached its call limit of N") — `calls` is the same
        // live, event-driven `huddleCalls` state the row already renders
        // "X/Y calls" from, so this needs no extra fetch or poll. UX mirror
        // only: the server remains the authority and still refuses the spawn
        // independently.
        const hAtCallLimit = isHuddleAtCallLimit(calls.length, h.max_calls);
        // Same gate the "+" button applies via `canConnect` (passed to
        // HuddleButton below) — the right-click "Start a new call" item used
        // to skip the cooldown check, so it stayed clickable while the "+"
        // button was disabled for it.
        const canStartNewCall = callCooldownSecs === 0 && hCanJoin && !hAtCallLimit;
        // This channel's "Call names" setting — game titles + who may rename.
        const hNaming = callNamingOf(h);
        return (
            // Dropping onto a Calls channel that has no live call spawns one
            // and puts them in it. Only eligible while empty — once there are
            // calls, the per-call drop zones own the gesture, and a second
            // overlapping target would make the hit-testing ambiguous.
            <MoveDropZone
                id={`${HUDDLE_DROP_PREFIX}${h.channel_id}`}
                eligible={!!movingParticipant && calls.length === 0}
            >
            <HuddleButton
                key={h.channel_id}
                name={h.name}
                iconName={h.icon_name ?? null}
                iconEmoji={h.icon_emoji ?? null}
                activeParticipantCount={aggregateParticipants}
                activeCallCount={calls.length}
                maxCalls={h.max_calls}
                canConnect={callCooldownSecs === 0 && hCanJoin}
                atCallLimit={hAtCallLimit}
                cooldownSecs={callCooldownSecs > 0 ? callCooldownSecs : undefined}
                isActiveForMe={isActiveForMe}
                // Only my own active call's row may show a padlock/spinner —
                // this device has no way to know another live call's key
                // state (see the Props comment on myCallEncryptionState).
                encryptionState={isActiveForMe ? myCallEncryptionState : null}
                expanded={expanded}
                onToggleExpanded={() => setHuddleExpanded(prev => ({ ...prev, [h.channel_id]: !expanded }))}
                onSpawn={() => { if (canStartNewCall) onSpawnHuddleCall?.(h); }}
                onContextMenu={(e) => huddleMenu.open(e, [
                    ...(canStartNewCall ? [{
                        icon: <Radio />, label: 'Start a new call',
                        onSelect: () => onSpawnHuddleCall?.(h),
                    }] : []),
                    ...(canStartNewCall && canManage ? [{ divider: true as const }] : []),
                    ...(canManage ? [
                        {
                            icon: <Pencil />, label: 'Edit Calls channel',
                            onSelect: () => setHuddleSettings(h),
                        },
                        {
                            icon: <Trash2 />, label: 'Delete Calls channel', danger: true as const,
                            onSelect: () => setPendingConfirm({
                                title: `Delete "${h.name}"?`,
                                message: 'This channel will be permanently removed.',
                                confirmLabel: 'Delete',
                                onConfirm: async () => {
                                    try { await deleteHuddleApi(h); }
                                    catch (err) { console.error('[ServerContextPanel] delete huddle:', err); }
                                },
                            }),
                        },
                        { divider: true as const },
                    ] : []),
                    {
                        icon: <LinkIcon />, label: 'Copy Channel ID',
                        onSelect: () => writeToClipboard(h.channel_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
                    },
                ], h.name)}
            >
                <AnimatePresence initial={false} mode="popLayout">
                {sortedCalls.map(c => {
                    const isMine = activeHuddleCallId === c.call_id;
                    // Match the API contract (`huddles.service.ts → renameCall`):
                    // the spawner may rename their own call and MANAGE_CHANNELS
                    // (or ADMINISTRATOR via canManage) any — narrowed by the
                    // channel's "Call names" setting (locked: nobody; starters
                    // off: managers only). UX mirror; the server decides.
                    const startedByMe = c.spawner_user_id === userId;
                    const canRename = canRenameHuddleCall(hNaming, { isStarter: startedByMe, canManageChannels: canManage });
                    const participantsLite = c.participants.map(uid => {
                        const m = memberMap.get(uid);
                        return {
                            user_id: uid,
                            nickname: m?.nickname ?? null,
                            username: m?.username,
                            avatar_url: m?.avatar_url ?? null,
                        };
                    });
                    return (
                        <motion.div
                            key={c.call_id}
                            className={landedCallId === c.call_id ? 'cl-move-landed rounded-xl' : undefined}
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } }}
                            exit={{ opacity: 0, y: -6, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
                        >
                        <MoveDropZone
                            id={`${CALL_DROP_PREFIX}${c.call_id}`}
                            eligible={!!movingParticipant && movingParticipant.callId !== c.call_id}
                        >
                            {/* When participants exist, pull HuddleCallCard *inside* the
                                shared gray container so the call card's rounded-lg bottom
                                corners show the container's bg instead of leaving transparent
                                corner gaps between the call card and participant rows.
                                When isMine, #call-sidebar-root in pane4El is CSS-hidden so
                                participants don't appear at the top of the panel; the live
                                audio/video engine keeps running inside the hidden
                                SidebarConference — only the visual list moves here. */}
                            {c.participants.length > 0 ? (
                                <div className={isMine ? '' : 'rounded-t-lg rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]'}>
                                    <HuddleCallCard
                                        callId={c.call_id}
                                        name={computeCallDisplayName(c.participants, c.name, hNaming)}
                                        participants={participantsLite}
                                        isMine={isMine}
                                        canRename={canRename}
                                        startedByMe={startedByMe}
                                        canConnect={callCooldownSecs === 0 && hCanJoin}
                                        token={token}
                                        spawnedAt={c.spawned_at}
                                        memberLimit={h.member_limit}
                                        onJoin={() => onJoinExistingHuddleCall?.(c.call_id, c.name)}
                                        onLeave={() => onLeaveHuddleCall?.()}
                                        onContextMenu={(e) => huddleMenu.open(e, [
                                            isMine
                                                ? { icon: <LogOut />, label: 'Leave call', onSelect: () => onLeaveHuddleCall?.() }
                                                : { icon: <PhoneCall />, label: 'Join call', onSelect: () => onJoinExistingHuddleCall?.(c.call_id, c.name) },
                                            ...(canRename ? [{
                                                icon: <Edit3 />, label: 'Rename',
                                                onSelect: () => { setRenameDraft(c.name); setRenameCall({ callId: c.call_id, name: c.name }); },
                                            }] : []),
                                            { icon: <LinkIcon />, label: 'Copy Call ID', onSelect: () => writeToClipboard(c.call_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })) },
                                        ], c.name)}
                                    />
                                    <div className="flex flex-col w-full">
                                        {c.participants.map(uid => {
                                            const m = memberMap.get(uid);
                                            const displayName = m?.nickname || m?.username || 'Unknown User';
                                            const isMe = uid === userId;
                                            const roleColor = memberRoleColors[uid] ?? null;
                                            return (
                                                <DraggableParticipant
                                                    key={uid}
                                                    callId={c.call_id}
                                                    userId={uid}
                                                    // You can always drag yourself (it's just a quick
                                                    // way to switch calls); dragging anyone else needs
                                                    // MOVE_MEMBERS.
                                                    disabled={!canMoveMembers && !isMe}
                                                >
                                                <div
                                                    className="flex items-center gap-2.5 px-2 py-1.5 hover:bg-white/[0.04] transition-colors w-full cursor-pointer"
                                                    onClick={(e) => onOpenProfile(uid, { x: e.clientX, y: e.clientY }, { roleIds: [], roles: [], serverId: server.server_id })}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        // MUST stop propagation here — the participant row is a
                                                        // descendant of HuddleButton's DOM, which has its own
                                                        // onContextMenu that calls huddleMenu.open() and dispatches
                                                        // 'close-all-popovers'. Without stopPropagation the
                                                        // contextmenu event bubbles up to HuddleButton, which
                                                        // immediately closes the participant popover we just opened.
                                                        e.stopPropagation();
                                                        // In the same huddle call → open the rich PopoverMenu
                                                        // (volume, mute, NS, hide video/SS, view profile, server
                                                        // moderation block). Outside the call → fall back to the
                                                        // compact ContextMenu (no local controls would do anything).
                                                        if (activeHuddleCallId === c.call_id && uid !== userId) {
                                                            window.dispatchEvent(new Event('close-all-popovers'));
                                                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                            setParticipantPopover({
                                                                uid,
                                                                displayName,
                                                                roomName: c.call_id,
                                                                pos: calcPopoverPos(rect),
                                                            });
                                                        } else {
                                                            // Not in the call — show the full member menu (same as
                                                            // right-clicking their row in the members list) so all
                                                            // moderation, friend, and role actions are accessible.
                                                            // Fall back to the compact call menu only if the member
                                                            // record hasn't loaded yet.
                                                            if (m) {
                                                                memberMenu.open(e, buildMemberMenu(m, displayName), displayName);
                                                            } else {
                                                                callParticipantMenu.open(
                                                                    e,
                                                                    buildCallParticipantMenu(uid, c.call_id, displayName),
                                                                    displayName,
                                                                );
                                                            }
                                                        }
                                                    }}
                                                >
                                                    {/* Speaking ring subscribes per identity (SpeakingRing) so a
                                                        speaking flip doesn't re-render this whole panel. */}
                                                    <SpeakingRing
                                                        uid={uid}
                                                        className="w-8 h-8 rounded-full overflow-hidden bg-cl-surface flex items-center justify-center shrink-0 transition-[box-shadow] duration-150"
                                                        speakingClassName="ring-2 ring-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
                                                        idleClassName="ring-1 ring-white/10"
                                                    >
                                                        <EncryptedAvatar
                                                            attachmentId={m?.avatar_url ?? null}
                                                            userId={uid}
                                                            token={token}
                                                            fallbackSize={13}
                                                            bypassFriendGate
                                                            className="w-full h-full object-cover"
                                                        />
                                                    </SpeakingRing>
                                                    <span
                                                        className="flex-1 text-[13px] truncate"
                                                        style={{ color: roleColor ?? 'rgba(255,255,255,0.8)' }}
                                                    >
                                                        {displayName}{isMe ? ' (you)' : ''}
                                                    </span>
                                                    <AnnotationGrantBadge identity={uid} size={12} />
                                                    {/* Ping + signal bars — local user only */}
                                                    {isMe && (() => {
                                                        const { pingMs, packetLossPercent } = callTelemetry?.callStats ?? { pingMs: null, packetLossPercent: null };
                                                        const { bars, color } = signalQuality(pingMs, packetLossPercent);
                                                        return (
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <SignalBars bars={bars} color={color} />
                                                                <span className={`text-[10px] font-mono tabular-nums ${pingColor(pingMs)}`}>
                                                                    {pingMs !== null ? `${pingMs}ms` : '—'}
                                                                </span>
                                                            </div>
                                                        );
                                                    })()}
                                                    {(() => {
                                                        const ts    = participantTrackStates[uid];
                                                        const pmeta = participantMetadata[uid];
                                                        const isLocalMutedByMe   = callCtx?.localMutedIds.has(uid)         ?? false;
                                                        const isVideoHiddenByMe  = callCtx?.hiddenVideoIds.has(uid)         ?? false;
                                                        const isScreenHiddenByMe = callCtx?.hiddenScreenShareIds.has(uid)   ?? false;
                                                        if (!ts && !pmeta && !isLocalMutedByMe && !isVideoHiddenByMe && !isScreenHiddenByMe) return null;
                                                        return (
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                {/* Server-moderation badges — red, highest visual priority. */}
                                                                {pmeta?.serverMutedAudio       && <MicOff       className="w-3.5 h-3.5 text-red-500" />}
                                                                {pmeta?.serverDeafened         && <HeadphoneOff className="w-3.5 h-3.5 text-red-500" />}
                                                                {pmeta?.serverMutedVideo       && <VideoOff     className="w-3.5 h-3.5 text-red-500" />}
                                                                {pmeta?.serverMutedScreenShare && <MonitorOff   className="w-3.5 h-3.5 text-red-500" />}
                                                                {/* Self-deafen — participant toggled deafen themselves. */}
                                                                {pmeta?.deafened && !pmeta?.serverDeafened && (
                                                                    <Headphones className="w-3.5 h-3.5 text-red-400" />
                                                                )}
                                                                {/* Self-mute — participant muted their own mic. */}
                                                                {ts?.isMuted && !pmeta?.serverMutedAudio && !pmeta?.serverDeafened && !pmeta?.deafened && (
                                                                    <MicOff className="w-3.5 h-3.5 text-red-400" />
                                                                )}
                                                                {/* Client-side local mute — only visible to the viewer; gray. */}
                                                                {!ts?.isMuted && !pmeta?.serverDeafened && !pmeta?.deafened && isLocalMutedByMe && (
                                                                    <MicOff className="w-3.5 h-3.5 text-cl-faint" />
                                                                )}
                                                                {/* Screenshare indicator — gray MonitorOff when viewer has hidden it. */}
                                                                {ts?.hasScreenShare && !pmeta?.serverMutedScreenShare && (
                                                                    isScreenHiddenByMe
                                                                        ? <MonitorOff className="w-3.5 h-3.5 text-cl-faint" />
                                                                        : <Monitor    className="w-3.5 h-3.5 text-cl-muted" />
                                                                )}
                                                                {/* Camera indicator — gray VideoOff when viewer has hidden it. */}
                                                                {ts?.hasCamera && !pmeta?.serverMutedVideo && (
                                                                    isVideoHiddenByMe
                                                                        ? <VideoOff className="w-3.5 h-3.5 text-cl-faint" />
                                                                        : <Video    className="w-3.5 h-3.5 text-cl-muted" />
                                                                )}
                                                            </div>
                                                        );
                                                    })()}
                                                </div>
                                                </DraggableParticipant>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : (
                                <HuddleCallCard
                                    callId={c.call_id}
                                    name={computeCallDisplayName(c.participants, c.name, hNaming)}
                                    participants={participantsLite}
                                    isMine={isMine}
                                    canRename={canRename}
                                    startedByMe={startedByMe}
                                    canConnect={callCooldownSecs === 0 && hCanJoin}
                                    token={token}
                                    spawnedAt={c.spawned_at}
                                    memberLimit={h.member_limit}
                                    onJoin={() => onJoinExistingHuddleCall?.(c.call_id, c.name)}
                                    onLeave={() => onLeaveHuddleCall?.()}
                                    onContextMenu={(e) => huddleMenu.open(e, [
                                        isMine
                                            ? { icon: <LogOut />, label: 'Leave call', onSelect: () => onLeaveHuddleCall?.() }
                                            : { icon: <PhoneCall />, label: 'Join call', onSelect: () => onJoinExistingHuddleCall?.(c.call_id, c.name) },
                                        ...(canRename ? [{
                                            icon: <Edit3 />, label: 'Rename',
                                            onSelect: () => { setRenameDraft(c.name); setRenameCall({ callId: c.call_id, name: c.name }); },
                                        }] : []),
                                        { icon: <LinkIcon />, label: 'Copy Call ID', onSelect: () => writeToClipboard(c.call_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })) },
                                    ], c.name)}
                                />
                            )}
                        </MoveDropZone>
                        </motion.div>
                    );
                })}
                </AnimatePresence>
            </HuddleButton>
            </MoveDropZone>
        );
    };

    // ── Render ───────────────────────────────────────────────────────────────
    //
    // The panel shows the channel header, voice-channel rows (with participants),
    // huddle sections, and the member list.
    //
    // #call-sidebar-root, #call-video-root, and #call-controlbar-root are all owned
    // by Dashboard's pane4El so they survive navigation away from this panel without
    // remounting the LiveKit component tree. The isMine branch above renders nothing
    // in place of the old inline portal target — SidebarConference's participant rows
    // always appear in pane4El now.
    return (
        <div className="flex flex-col">

            {/* Search bar — always first so it stays above the pinned panel
                regardless of call state or panel visibility. Text-channel mode
                only; voice/huddle channels have no message history to search. */}
            {showSearch && (
                /* 8px gutter on ALL FOUR sides — same rhythm as the DM panel, whose
                   search row is `px-2 py-2`, so the field lands in the same place in
                   both panels. This was `pt-3 pb-2`: 12px above against 8px below,
                   which sat the field 4px low and read as "the server search isn't
                   centred like the DM one". The horizontal half already matched; only
                   the vertical had drifted. Keep both axes symmetric. */
                <div className="px-2 py-2">
                    {showPinnedPanel ? (
                        <div className="relative">
                            {/* Kit search field — `.srch` owns icon slot + input padding
                                (a Tailwind pl-9 on raw ClInput loses to the kit `.inp` rule). */}
                            <ClSearch
                                icon={<Search size={15} />}
                                type="text"
                                placeholder="Search pinned messages"
                                value={pinnedSearchQuery}
                                onChange={(e) => onPinnedSearchChange?.(e.target.value)}
                                className="text-[13px]"
                                style={{ paddingTop: 8, paddingBottom: 8, borderRadius: 11, paddingRight: 32 }}
                            />
                            {pinnedSearchQuery.length > 0 && (
                                <button
                                    title="Clear"
                                    onClick={() => onPinnedSearchChange?.('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 w-[22px] h-[22px] flex items-center justify-center rounded-md text-cl-faint hover:text-cl-text hover:bg-white/[0.06] transition-colors"
                                >
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    ) : (
                        <ChannelMessageSearch
                            channelId={channel.channel_id}
                            messages={searchableMessages.map(m => {
                                if (m.sender_display_name) return m;
                                // Channel messages don't carry a sender name — resolve it
                                // from the member list this panel already fetched.
                                const mm = memberMap.get(m.sender_user_id);
                                return mm
                                    ? { ...m, sender_display_name: mm.nickname ?? mm.username ?? undefined }
                                    : m;
                            })}
                            onJumpToMessage={(id) => onJumpToMessage?.(id)}
                        />
                    )}
                </div>
            )}

            {/* Pinned messages panel — slides in below the search bar.
                AnimatePresence drives the open/close height animation so the
                content below smoothly makes room rather than snapping. */}
            <AnimatePresence>
            {showPinnedPanel && (
                <motion.div
                    key="pinned-panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="shrink-0 border-b border-cl-border/50 bg-cl-deep overflow-hidden"
                >
                    <div className="flex flex-col" style={{ maxHeight: '40vh' }}>
                        <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-cl-border/40">
                            <Pin className="w-3.5 h-3.5 text-cl-lume shrink-0" />
                            <span className="text-[12px] font-semibold text-cl-text flex-1 leading-tight">Pinned Messages</span>
                            <FlatIconBtn
                                title="Close pinned messages"
                                aria-label="Close pinned messages"
                                onClick={onClosePinnedPanel}
                                className="ml-0.5"
                            >
                                <X />
                            </FlatIconBtn>
                        </div>
                        {/* Portal target — ChatPane portals PinnedMessagesPanel here. */}
                        <div id="pinned-panel-root" className="flex-1 flex flex-col overflow-hidden min-h-0" />
                    </div>
                </motion.div>
            )}
            </AnimatePresence>

            {/* Scrollable content — right-click blank area → create huddle / category.
                Always rendered so call video, voice/huddle rows, and the member list
                remain visible regardless of pinned panel state. */}
            <div
                className={`px-2 pb-3 space-y-4 ${showSearch ? 'pt-1' : 'pt-3'}`}
                onContextMenu={(e) => {
                    if (!canManage) return;
                    // Huddles must always live under a category — create from the
                    // category's + button or right-click menu. Blank-space only
                    // offers creating a new Huddle Category.
                    createMenu.open(e, [
                        {
                            icon: <Folder />, label: 'Create Calls Category',
                            onSelect: () => setCategoryDialog({ mode: 'create' }),
                        },
                    ]);
                }}
            >

                {/* ── Huddles (Phase M) — DnD-sortable categories + huddles ─ */}
                <DndContext
                    sensors={huddleSensors}
                    onDragStart={onHuddleDragStart}
                    onDragOver={onHuddleDragOver}
                    onDragEnd={onHuddleDragEnd}
                >
                    <SortableContext
                        items={huddleCategories.map(c => `hcat:${c.category_id}`)}
                        strategy={verticalListSortingStrategy}
                    >
                        {huddleCategories.map(cat => {
                            const catHuddles = huddleGroups.byCat[cat.category_id] ?? [];
                            const collapsed = !!collapsedCats[cat.category_id];
                            const catMenuItems = buildCatMenu(cat);
                            const catKey  = `hcat:${cat.category_id}`;
                            const catKeys = huddleCategories.map(c => `hcat:${c.category_id}`);
                            return (
                                <SortableHuddleCatSection
                                    key={cat.category_id}
                                    catId={cat.category_id}
                                    disabled={!canManage}
                                    isDragging={huddleActiveId === catKey}
                                    dropLine={getHuddleDropLine(catKey, catKeys)}
                                >
                                    {(setHeaderRef, headerDragProps) => (
                                        <div>
                                            {/* Entire header row is the drag activator */}
                                            <div
                                                ref={canManage ? setHeaderRef : undefined}
                                                {...(canManage ? headerDragProps : {})}
                                                className={`group flex items-center gap-1.5 mb-1.5 px-1 w-full hover:bg-transparent transition-colors ${canManage ? 'cursor-grab active:cursor-grabbing select-none touch-none' : 'cursor-pointer'}`}
                                                onClick={() => setCollapsedCats(prev => ({ ...prev, [cat.category_id]: !prev[cat.category_id] }))}
                                                onContextMenu={(e) => {
                                                    e.stopPropagation();
                                                    if (catMenuItems.length > 0) catMenu.open(e, catMenuItems, cat.name);
                                                }}
                                            >
                                                {collapsed
                                                    ? <ChevronRight size={11} className="text-cl-faint group-hover:text-cl-muted transition-colors shrink-0" />
                                                    : <ChevronDown  size={11} className="text-cl-faint group-hover:text-cl-muted transition-colors shrink-0" />
                                                }
                                                {cat.icon_name
                                                    ? <ChannelIconRenderer name={cat.icon_name} size={15} className="text-white/45 group-hover:text-cl-muted transition-colors shrink-0" />
                                                    : <Radio size={15} className="text-white/45 group-hover:text-cl-muted transition-colors shrink-0" />
                                                }
                                                <span
                                                    className="truncate flex-1 text-[10px] font-mono font-semibold uppercase text-cl-faint group-hover:text-cl-muted transition-colors"
                                                    style={{ letterSpacing: '1.1px' }}
                                                >
                                                    {cat.name}
                                                </span>
                                                {canManage && (
                                                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-all shrink-0">
                                                        <FlatIconBtn
                                                            title="Create Calls channel here"
                                                            aria-label="Create Calls channel here"
                                                            onClick={(e) => { e.stopPropagation(); setCreateHuddleSettings({ defaultCategoryId: cat.category_id }); }}
                                                        >
                                                            <Plus />
                                                        </FlatIconBtn>
                                                        <FlatIconBtn
                                                            title="Category options"
                                                            aria-label="Category options"
                                                            onClick={(e) => { e.stopPropagation(); if (catMenuItems.length > 0) catMenu.open(e, catMenuItems, cat.name); }}
                                                        >
                                                            <MoreVertical />
                                                        </FlatIconBtn>
                                                    </div>
                                                )}
                                            </div>
                                            {(() => {
                                                // When collapsed, still show the active-call huddle if the
                                                // local user is in a call inside this category.
                                                const activeHuddleInCat = collapsed
                                                    ? catHuddles.find(h =>
                                                        (huddleCalls[h.channel_id] ?? []).some(c => c.call_id === activeHuddleCallId)
                                                      )
                                                    : undefined;

                                                if (collapsed && !activeHuddleInCat) return null;

                                                if (collapsed && activeHuddleInCat) {
                                                    // Only render the one active huddle; suppress DnD wrapper
                                                    // (dragging while collapsed would be confusing anyway).
                                                    return (
                                                        <div className="space-y-1.5">
                                                            {renderHuddle(activeHuddleInCat)}
                                                        </div>
                                                    );
                                                }

                                                // Normal expanded state — render all huddles with DnD.
                                                return (
                                                    <div className="space-y-1.5">
                                                        <SortableContext
                                                            items={catHuddles.map(h => `hd:${h.channel_id}`)}
                                                            strategy={verticalListSortingStrategy}
                                                        >
                                                            {catHuddles.map(h => {
                                                                const hKey  = `hd:${h.channel_id}`;
                                                                const hKeys = catHuddles.map(x => `hd:${x.channel_id}`);
                                                                return (
                                                                    <SortableHuddleItem
                                                                        key={h.channel_id}
                                                                        huddle={h}
                                                                        disabled={!canManage}
                                                                        isDragging={huddleActiveId === hKey}
                                                                        dropLine={getHuddleDropLine(hKey, hKeys)}
                                                                    >
                                                                        {renderHuddle(h)}
                                                                    </SortableHuddleItem>
                                                                );
                                                            })}
                                                        </SortableContext>
                                                        {catHuddles.length === 0 && (
                                                            <p className="text-[11px] text-cl-faint px-1 py-1">No huddles yet — click + to add one</p>
                                                        )}
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    )}
                                </SortableHuddleCatSection>
                            );
                        })}
                    </SortableContext>

                    {/* Uncategorized huddles */}
                    {huddleGroups.uncategorized.length > 0 && (
                        <div className="space-y-1.5">
                            <SortableContext
                                items={huddleGroups.uncategorized.map(h => `hd:${h.channel_id}`)}
                                strategy={verticalListSortingStrategy}
                            >
                                {huddleGroups.uncategorized.map(h => {
                                    const hKey  = `hd:${h.channel_id}`;
                                    const hKeys = huddleGroups.uncategorized.map(x => `hd:${x.channel_id}`);
                                    return (
                                        <SortableHuddleItem
                                            key={h.channel_id}
                                            huddle={h}
                                            disabled={!canManage}
                                            isDragging={huddleActiveId === hKey}
                                            dropLine={getHuddleDropLine(hKey, hKeys)}
                                        >
                                            {renderHuddle(h)}
                                        </SortableHuddleItem>
                                    );
                                })}
                            </SortableContext>
                        </div>
                    )}

                    <DragOverlay dropAnimation={null}>
                        {huddleActiveId?.startsWith('hd:') && (() => {
                            const h = localHuddles.find(x => x.channel_id === huddleActiveId.slice(3));
                            return h ? (
                                <div className="opacity-75 pointer-events-none shadow-2xl text-[13px] font-semibold text-cl-muted bg-cl-deep rounded-xl border border-white/[0.1] px-3 py-2">
                                    {h.name}
                                </div>
                            ) : null;
                        })()}
                        {huddleActiveId?.startsWith('hcat:') && (() => {
                            const cat = localHuddleCats.find(x => x.category_id === huddleActiveId.slice(5));
                            return cat ? (
                                <div className="opacity-75 pointer-events-none shadow-2xl text-[13px] font-semibold text-cl-muted bg-cl-deep rounded px-2 py-1">
                                    {cat.name}
                                </div>
                            ) : null;
                        })()}
                        {movingParticipant && (() => {
                            const m = memberMap.get(movingParticipant.userId);
                            const name = m?.nickname || m?.username || 'Unknown User';
                            return (
                                <div className="cl-move-chip">
                                    <div className="cl-move-chip-av">
                                        <EncryptedAvatar
                                            attachmentId={m?.avatar_url ?? null}
                                            userId={movingParticipant.userId}
                                            token={token}
                                            fallbackSize={13}
                                            bypassFriendGate
                                            disableClickProfile
                                            className="w-full h-full object-cover"
                                        />
                                    </div>
                                    <span
                                        className="cl-move-chip-name"
                                        style={{ color: memberRoleColors[movingParticipant.userId] ?? 'var(--cl-text)' }}
                                    >
                                        {name}
                                    </span>
                                </div>
                            );
                        })()}
                    </DragOverlay>
                </DndContext>

                {/* ── Voice Channels ─────────────────────────────────────── */}
                {voiceChannels.length > 0 && (
                    <div>
                        <ClButton
                            variant="ghost"
                            fullWidth
                            row
                            onClick={() => setVoiceCollapsed(v => !v)}
                            className="mb-1.5 group"
                        >
                            {voiceCollapsed
                                ? <ChevronRight size={11} className="text-cl-faint group-hover:text-cl-muted transition-colors shrink-0" />
                                : <ChevronDown size={11} className="text-cl-faint group-hover:text-cl-muted transition-colors shrink-0" />
                            }
                            <Volume2 size={11} className="text-cl-faint group-hover:text-cl-muted transition-colors shrink-0" />
                            <h4 className="text-[11px] font-mono font-semibold uppercase tracking-widest text-cl-faint group-hover:text-cl-muted transition-colors">
                                Voice Channels
                            </h4>
                        </ClButton>
                        {!voiceCollapsed && <div className="space-y-1">
                            {voiceChannels.map(vc => {
                                const participants = voiceParticipants[vc.channel_id] ?? [];
                                const isActive = participants.length > 0;
                                const isMine = activeVoiceChannelId === vc.channel_id;
                                // Gate join actions by CONNECT permission resolved per-channel.
                                const vcCanJoin = canConnect(vc.channel_id);
                                return (
                                    /* Outer card — rounded-xl overflow-hidden is the ONLY
                                       source of corner rounding. Every row inside is straight;
                                       the clip handles the top-left/top-right/bottom-left/
                                       bottom-right curves automatically regardless of how many
                                       participants are in the channel. */
                                    <div key={vc.channel_id} className="rounded-xl overflow-hidden">
                                        {/* Channel name row */}
                                        <div
                                            className={`flex items-center gap-2 px-2 py-1.5 transition-colors group
                                                ${vcCanJoin
                                                    ? 'cursor-pointer hover:bg-white/[0.04]'
                                                    : 'cursor-not-allowed opacity-40 select-none'
                                                }
                                                ${isMine ? 'bg-green-500/[0.08]' : isActive ? 'bg-green-500/[0.04]' : ''}
                                            `}
                                            onClick={() => { if (vcCanJoin) onJoinVoiceChannel?.(vc); }}
                                            onContextMenu={(e) => voiceMenu.open(e, [
                                                ...(vcCanJoin ? [{
                                                    icon: isMine ? <LogOut /> : <Volume2 />,
                                                    label: isMine ? 'Disconnect' : 'Join Voice',
                                                    onSelect: () => onJoinVoiceChannel?.(vc),
                                                }] : []),
                                                {
                                                    icon: <LinkIcon />, label: 'Copy Channel ID',
                                                    onSelect: () => writeToClipboard(vc.channel_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
                                                },
                                            ], `🔊 ${vc.name}`)}
                                            title={
                                                !vcCanJoin ? "You don't have permission to connect to this channel"
                                                : isMine ? 'You are connected'
                                                : 'Click to join'
                                            }
                                        >
                                            {vc.icon_name ? (
                                                <ChannelIconRenderer name={vc.icon_name} size={12}
                                                    className={isMine ? 'text-green-400 shrink-0' : isActive ? 'text-green-400/70 shrink-0' : 'text-cl-faint group-hover:text-cl-faint shrink-0'} />
                                            ) : vc.icon_emoji ? (
                                                <span className="text-[14px] leading-none shrink-0 w-3 text-center">{vc.icon_emoji}</span>
                                            ) : (
                                                <Volume2 size={12} className={isMine ? 'text-green-400' : isActive ? 'text-green-400/70' : 'text-cl-faint group-hover:text-cl-faint'} />
                                            )}
                                            <span className={`flex-1 text-[12px] font-medium truncate ${isMine ? 'text-green-300' : isActive ? 'text-green-300/80' : 'text-cl-faint group-hover:text-cl-muted'}`}>
                                                {vc.name}
                                            </span>
                                            {isMine ? (
                                                <span className="text-[10px] text-green-400 shrink-0 font-semibold">● Live</span>
                                            ) : isActive ? (
                                                <span className="text-[10px] text-green-400/60 shrink-0">
                                                    {participants.length}
                                                </span>
                                            ) : vcCanJoin ? (
                                                <span className="text-[10px] text-cl-faint group-hover:text-cl-faint shrink-0 transition-colors">Join</span>
                                            ) : (
                                                <Lock size={10} className="text-cl-faint shrink-0" />
                                            )}
                                        </div>
                                        {/* Participants — simple WS-state row list.
                                            SidebarConference participant rows are portaled
                                            into the persistent #call-sidebar-root in
                                            Dashboard's aside, not here. */}
                                        {!isMine && participants.length > 0 && (
                                            <div>
                                                {participants.map(uid => {
                                                        const pm = memberMap.get(uid);
                                                        const pName = pm?.nickname ?? pm?.username ?? 'Unknown User';
                                                        const pStatus = liveStatus(pm ?? { user_id: uid } as ServerMember);
                                                        const pOnMobile = liveOnMobile(pm ?? { user_id: uid } as ServerMember);
                                                        return (
                                                            <div
                                                                key={uid}
                                                                className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/[0.03] transition-colors cursor-pointer group"
                                                                onClick={(e) => onOpenProfile(uid, { x: e.clientX, y: e.clientY })}
                                                                onContextMenu={(e) => callParticipantMenu.open(
                                                                    e,
                                                                    buildCallParticipantMenu(uid, vc.active_call_session_id, pName),
                                                                    pName,
                                                                )}
                                                            >
                                                                <div className="relative w-8 h-8 shrink-0">
                                                                    <SpeakingRing
                                                                        uid={uid}
                                                                        className="w-full h-full rounded-full overflow-hidden transition-[box-shadow] duration-150"
                                                                        speakingClassName="ring-2 ring-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
                                                                    >
                                                                        <EncryptedAvatar
                                                                            attachmentId={pm?.avatar_url ?? null}
                                                                            userId={uid}
                                                                            token={token}
                                                                            className="w-full h-full"
                                                                            fallbackSize={13}
                                                                            bypassFriendGate
                                                                        />
                                                                    </SpeakingRing>
                                                                    <span className="absolute bottom-[-1px] right-[-2px] border border-cl-abyss rounded-full">
                                                                        <StatusIcon status={pStatus} currentGame={null} onMobile={pOnMobile} size={7} />
                                                                    </span>
                                                                </div>
                                                                <span className="text-[13px] font-medium text-cl-muted truncate flex-1 group-hover:text-white/80 transition-colors">{pName}</span>
                                                                <AnnotationGrantBadge identity={uid} size={12} />
                                                                {/* Status badges — only populated when the viewer is in the
                                                                    same LiveKit room (callCtx has data for this participant). */}
                                                                {(() => {
                                                                    const ts    = participantTrackStates[uid];
                                                                    const pmeta = participantMetadata[uid];
                                                                    const isLocalMutedByMe   = callCtx?.localMutedIds.has(uid)       ?? false;
                                                                    const isVideoHiddenByMe  = callCtx?.hiddenVideoIds.has(uid)       ?? false;
                                                                    const isScreenHiddenByMe = callCtx?.hiddenScreenShareIds.has(uid) ?? false;
                                                                    if (!ts && !pmeta && !isLocalMutedByMe) return null;
                                                                    return (
                                                                        <div className="flex items-center gap-1 shrink-0">
                                                                            {pmeta?.serverMutedAudio       && <MicOff       className="w-3 h-3 text-red-500" />}
                                                                            {pmeta?.serverDeafened         && <HeadphoneOff className="w-3 h-3 text-red-500" />}
                                                                            {pmeta?.serverMutedVideo       && <VideoOff     className="w-3 h-3 text-red-500" />}
                                                                            {pmeta?.serverMutedScreenShare && <MonitorOff   className="w-3 h-3 text-red-500" />}
                                                                            {pmeta?.deafened && !pmeta?.serverDeafened && (
                                                                                <Headphones className="w-3 h-3 text-red-400" />
                                                                            )}
                                                                            {ts?.isMuted && !pmeta?.serverMutedAudio && !pmeta?.serverDeafened && !pmeta?.deafened && (
                                                                                <MicOff className="w-3 h-3 text-red-400" />
                                                                            )}
                                                                            {!ts?.isMuted && !pmeta?.serverDeafened && !pmeta?.deafened && isLocalMutedByMe && (
                                                                                <MicOff className="w-3 h-3 text-cl-faint" />
                                                                            )}
                                                                            {ts?.hasScreenShare && !pmeta?.serverMutedScreenShare && (
                                                                                isScreenHiddenByMe
                                                                                    ? <MonitorOff className="w-3 h-3 text-cl-faint" />
                                                                                    : <Monitor    className="w-3 h-3 text-cl-muted" />
                                                                            )}
                                                                            {ts?.hasCamera && !pmeta?.serverMutedVideo && (
                                                                                isVideoHiddenByMe
                                                                                    ? <VideoOff className="w-3 h-3 text-cl-faint" />
                                                                                    : <Video    className="w-3 h-3 text-cl-muted" />
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })()}
                                                            </div>
                                                        );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>}
                    </div>
                )}

                {/* ── Members ────────────────────────────────────────────── */}
                <div className="space-y-3">
                    {loading ? (
                        <div className="flex justify-center py-6">
                            <div className="w-4 h-4 border-2 border-white/20 border-t-cl-lume rounded-full animate-spin" />
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {/* Sits inside the panel-wide px-2 gutter — member cards line up
                                with the huddle cards and the search bar. */}
                            {/* Online members: only render this entire block if anyone is online */}
                            {(roleGroups.length > 0 || onlineNoRole.length > 0) && (
                                <div className="space-y-3">
                                    {/* Hoisted role groups ("Display members separately") merge into
                                        one slab: every row shares the same subtle wash and only the
                                        group's outer top/bottom corners round (no per-row overflow
                                        wrapper, so the Crown tooltip never gets clipped). Rows sit
                                        flush (no gap) so consecutive rows butt seamlessly. */}
                                    {roleGroups.map(({ role, members: gMembers }) => (
                                        <div key={role.role_id}>
                                            <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint px-1 mb-1.5">
                                                {role.name} — {gMembers.length}
                                            </p>
                                            <div>
                                                {gMembers.map((m, i) => renderMemberTile(m, getGroupRowPosition(i, gMembers.length)))}
                                            </div>
                                        </div>
                                    ))}

                                    {/* Online members with no hoisted role — flat, no card */}
                                    {onlineNoRole.length > 0 && (
                                        <div>
                                            <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint px-1 mb-1.5">
                                                Online — {onlineNoRole.length}
                                            </p>
                                            <div className="space-y-0.5">
                                                {onlineNoRole.map(m => renderMemberTile(m))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Offline — flat list, no card regardless of role */}
                            {allOffline.length > 0 && (
                                <div>
                                    <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint px-1 mb-1.5">
                                        Offline — {allOffline.length}
                                    </p>
                                    <div className="space-y-0.5">
                                        {allOffline.map(m => renderMemberTile(m))}
                                    </div>
                                </div>
                            )}

                            {members.length === 0 && (
                                <p className="text-center text-cl-faint text-xs py-4 px-3">No members found</p>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Rename-call dialog — kit modal, not the old native window.prompt. */}
            <ClModal open={!!renameCall} onClose={() => setRenameCall(null)} width={380} label="Rename call">
                <h3 className="text-[17px]" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, color: 'var(--cl-text)', margin: 0 }}>Rename call</h3>
                <p className="text-[12.5px] mb-4 mt-1" style={{ color: 'var(--cl-muted)' }}>Everyone in the call sees the new name.</p>
                <ClInput
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    maxLength={60}
                    placeholder="Call name"
                    autoFocus
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') commitRenameCall(); }}
                />
                <div className="flex justify-end gap-2 mt-5">
                    <ClButton variant="ghost" size="sm" onClick={() => setRenameCall(null)}>Cancel</ClButton>
                    <ClButton size="sm" onClick={commitRenameCall} disabled={!renameDraft.replace(/[^a-zA-Z0-9 '\-_.]/g, '').trim()}>Rename</ClButton>
                </div>
            </ClModal>

            {/* Huddle create dialog — right-click blank space / category + button. */}
            {createHuddleSettings && (
                <ChannelSettingsDialog
                    serverId={server.server_id}
                    token={token}
                    defaultKind="huddle"
                    defaultCategoryId={createHuddleSettings.defaultCategoryId}
                    categories={categories}
                    canManage={canManage}
                    ownerUserId={server.owner_user_id}
                    currentUserId={userId}
                    myPermissions={myPermissions}
                    channels={allChannels}
                    onClose={() => setCreateHuddleSettings(null)}
                    onSaved={() => { setCreateHuddleSettings(null); onChannelsChanged?.(); }}
                    onCreatedKeepOpen={() => onChannelsChanged?.()}
                />
            )}

            {/* Edit huddle dialog (unified: overview + permissions tabs). */}
            {huddleSettings && (
                <ChannelSettingsDialog
                    serverId={server.server_id}
                    token={token}
                    channel={huddleSettings}
                    categories={categories}
                    canManage={canManage}
                    ownerUserId={server.owner_user_id}
                    currentUserId={userId}
                    myPermissions={myPermissions}
                    channels={allChannels}
                    onClose={() => setHuddleSettings(null)}
                    onSaved={() => { setHuddleSettings(null); onChannelsChanged?.(); }}
                    onDelete={canManage ? async (ch) => {
                        try { await deleteHuddleApi(ch); setHuddleSettings(null); }
                        catch (e) { console.error('[ServerContextPanel] delete huddle:', e); }
                    } : undefined}
                />
            )}

            {/* Category form — right panel creates huddle categories only. */}
            {categoryDialog && (
                <CategoryFormDialog
                    serverId={server.server_id}
                    token={token}
                    category={categoryDialog.mode === 'edit' ? categoryDialog.category : null}
                    kind="huddle"
                    ownerUserId={server.owner_user_id}
                    currentUserId={userId}
                    myPermissions={myPermissions}
                    categories={categories}
                    channels={allChannels}
                    onClose={() => setCategoryDialog(null)}
                    onSaved={() => { setCategoryDialog(null); onChannelsChanged?.(); }}
                    onDelete={canManage ? async (cat) => {
                        try { await deleteCategoryApi(cat); }
                        catch (e) { console.error('[ServerContextPanel] delete category:', e); }
                    } : undefined}
                />
            )}

            {/* Nickname change dialog — kit modal; raised above the profile modal it opens from. */}
            <ClModal
                open={!!nicknameDialog}
                onClose={() => setNicknameDialog(null)}
                width={320}
                overlayStyle={{ zIndex: 10020 }}
                label="Change Nickname"
                cardStyle={{ padding: 20 }}
                cardClassName="flex flex-col gap-4"
            >
                {nicknameDialog && (
                    <>
                        <div>
                            <h3 className="text-[15px] font-bold text-cl-text m-0">Change Nickname</h3>
                            <p className="text-[12px] text-cl-faint mt-0.5">
                                {nicknameDialog.userId === userId ? 'Your nickname in this server' : `Nickname for ${nicknameDialog.displayName}`}
                            </p>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-semibold text-cl-faint uppercase tracking-widest">Nickname</label>
                            <ClInput
                                autoFocus
                                value={nicknameInput}
                                onChange={e => setNicknameInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') { e.preventDefault(); saveNickname(nicknameDialog.userId, nicknameInput); }
                                }}
                                maxLength={32}
                                placeholder="Leave blank to reset to username"
                            />
                            {nicknameError && <p className="text-[11px] text-red-400">{nicknameError}</p>}
                            <p className="text-[11px] text-cl-faint">Leave blank to reset to account username</p>
                        </div>
                        <div className="flex gap-2 justify-end">
                            <ClButton size="sm" variant="ghost" onClick={() => setNicknameDialog(null)}>Cancel</ClButton>
                            <ClButton size="sm" disabled={nicknameSaving} loading={nicknameSaving} onClick={() => saveNickname(nicknameDialog.userId, nicknameInput)}>Save</ClButton>
                        </div>
                    </>
                )}
            </ClModal>

            {/* Styled confirmation dialog — replaces window.confirm() for
                destructive actions (delete huddle, delete category). */}
            {pendingConfirm && (
                <ConfirmDialog
                    {...pendingConfirm}
                    onConfirm={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }}
                    onCancel={() => setPendingConfirm(null)}
                />
            )}

            {/* Context menus — all portal to document.body, never clipped by
                panel overflow or stacking contexts. */}
            {memberMenu.menu}
            {voiceMenu.menu}
            {huddleMenu.menu}
            {catMenu.menu}
            {createMenu.menu}
            {callParticipantMenu.menu}
            {/* Rich call-participant popover — opened from the right-click handler
                on huddle/voice rows when the local user is in the same call as
                the target. Wraps PopoverMenu with the local-control state pulled
                from CallContext + per-uid persistent hooks. */}
            {participantPopover && (
                <HuddleParticipantPopover
                    uid={participantPopover.uid}
                    displayName={participantPopover.displayName}
                    roomName={participantPopover.roomName}
                    pos={participantPopover.pos}
                    canServerMute={canServerMute}
                    selfUserId={userId ?? ''}
                    onClose={() => setParticipantPopover(null)}
                    onOpenProfile={onOpenProfile}
                    serverId={server.server_id}
                    onServerMuteAction={serverMuteCallParticipant}
                />
            )}
        </div>
    );
};

export default ServerContextPanel;

// ── HuddleParticipantPopover ─────────────────────────────────────────────────
// Renders PopoverMenu (the same component used by in-call ParticipantCard /
// VideoTile) wired to CallContext state. Used for the huddle right-click case
// where the local user is in the same call as the target — the user wants the
// full set of local controls (volume, mute, NS, hide video, hide screenshare)
// plus the server-moderation block, identical to what they get in DM/group
// calls. We need a sub-component (not an inline render in ServerContextPanel)
// because usePersistentVolume / usePersistentNsEnabled are hooks that have to
// be called at component top-level for a specific user_id.

interface HuddleParticipantPopoverProps {
    uid: string;
    displayName: string;
    roomName: string;
    pos: { top: number; left: number };
    canServerMute: boolean;
    selfUserId: string;
    onClose: () => void;
    onOpenProfile: (uid: string, pos: { x: number; y: number }, roleCtx?: { roleIds: string[]; roles: RoleInfo[]; serverId?: string; currentNickname?: string | null; canSetNickname?: boolean }) => void;
    serverId: string;
    onServerMuteAction: (roomName: string, targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
}

const HuddleParticipantPopover: React.FC<HuddleParticipantPopoverProps> = ({
    uid, displayName, roomName, pos, canServerMute, selfUserId,
    onClose, onOpenProfile, serverId, onServerMuteAction,
}) => {
    const callCtx = useCallContextSafe();
    const callTelemetry = useCallTelemetrySafe();
    const popoverRef = useRef<HTMLDivElement>(null);
    const [volume, setVolume] = usePersistentVolume(uid, 'mic');
    const [nsEnabled, setNsEnabled] = usePersistentNsEnabled(uid);

    // Swallow the outside click so it doesn't pass through to the chat view.
    useDismissOnOutsideClick(popoverRef, true, onClose);

    const isLocalMuted = callCtx?.localMutedIds.has(uid) ?? false;
    const isVideoHidden = callCtx?.hiddenVideoIds.has(uid) ?? false;
    const isScreenShareHidden = callCtx?.hiddenScreenShareIds.has(uid) ?? false;
    const tracks = callTelemetry?.participantTrackStates[uid];
    const meta = callTelemetry?.participantMetadata[uid];
    const isSelf = uid === selfUserId;

    return ReactDOM.createPortal(
        <PopoverMenu
            displayName={displayName}
            volume={volume}
            isLocalMuted={isLocalMuted}
            hasVideo={tracks?.hasCamera ?? false}
            isVideoHidden={isVideoHidden}
            hasScreenShare={tracks?.hasScreenShare ?? false}
            isScreenShareHidden={isScreenShareHidden}
            onVolumeChange={setVolume}
            onMuteChange={(v) => callCtx?.toggleLocalMute(uid, v)}
            nsEnabled={nsEnabled}
            onNsEnabledChange={setNsEnabled}
            onHideVideoChange={(v) => callCtx?.toggleHideVideo(uid, v)}
            onHideScreenShareChange={(v) => callCtx?.toggleHideScreenShare(uid, v)}
            popoverRef={popoverRef}
            onClose={onClose}
            style={pos}
            userId={uid}
            // Without these the annotation rows could never appear on THIS
            // popover — the one you get right-clicking a huddle participant
            // while you are in that huddle, i.e. exactly when you are most
            // likely to be sharing something. `selectCanRevoke('', uid)` is
            // always false, so the row was silently missing here alone.
            localIdentity={selfUserId}
            onRevokeAnnotation={onClose}
            onViewProfile={() => { onClose(); onOpenProfile(uid, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, { roleIds: [], roles: [], serverId }); }}
            canServerMute={canServerMute && !isSelf}
            serverMutedAudio={meta?.serverMutedAudio ?? false}
            serverMutedVideo={meta?.serverMutedVideo ?? false}
            serverMutedScreenShare={meta?.serverMutedScreenShare ?? false}
            serverDeafened={meta?.serverDeafened ?? false}
            onServerMuteAudio={!isSelf ? (m) => { onServerMuteAction(roomName, uid, 'audio', m); onClose(); } : undefined}
            onServerMuteVideo={!isSelf ? (m) => { onServerMuteAction(roomName, uid, 'video', m); onClose(); } : undefined}
            onServerMuteScreenShare={!isSelf ? (m) => { onServerMuteAction(roomName, uid, 'screenshare', m); onClose(); } : undefined}
            onServerDeafen={!isSelf ? (d) => { onServerMuteAction(roomName, uid, 'deafen', d); onClose(); } : undefined}
        />,
        document.body
    );
};
