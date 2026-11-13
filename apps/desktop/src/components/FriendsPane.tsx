import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { ClButton, ClSearch, ClSegment, useClTooltip } from './cl';
import { FriendActionDialog, type FriendActionKind } from './FriendActionDialog';
import { useOpenProfile } from '../contexts/ProfileOpenContext';
import {
    UserPlus, MessageSquare, Clock, Check, X, Inbox,
    Search, MessagesSquare, UserCheck, UserMinus, RefreshCw, MoreVertical, PhoneCall, Ban, User
} from 'lucide-react';
import { StatusIcon } from './StatusPicker';
import { ProfileBadgeRow } from './ProfileBadgeRow';
import { formatUserTag, padDiscriminator } from '@cipherline/shared';
import type { FriendStatusEntry } from '../hooks/useUserStatus';
import { useContextMenu } from '../hooks/useContextMenu';
import { AddFriendModal } from './AddFriendModal';
import { useToast } from '../contexts/ToastContext';
import { API_BASE } from '../constants';
import { apiUrl } from '../utils/apiPath';
import { EncryptedAvatar } from './EncryptedAvatar';
import { AvatarDecoration } from './ProfileCosmetics';
import { decorationLook } from '../utils/decorationLook';
import { peekProfile } from '../utils/profileCache';
import { formatRailBadgeCount } from '../utils/unreadBadges';
import { MascotEmpty } from './MascotEmpty';
import { usePlayfulLine } from '../hooks/useEasterEggs';
import { FRIENDS_NO_MATCH_POOL } from '../utils/eggPools';
import { hashSeed } from '../utils/easterEggs';
import { StatusLine } from './StatusLine';
import { EMPTY_FRIENDS, type FriendsPayload, type FriendsLoadStatus } from '../utils/friendsSync';
import { HoverPlayRow } from './server/HoverPlayRow';
import { STATUS_CONFIG } from '../utils/userStatusModel';
import { friendRequestTiming, expiryLabel, daysAgoLabel } from '../utils/friendRequestTiming';
import '../styles/friends-pane.css';

interface FriendsPaneProps {
    onStartChat: (chat: { id: string, title?: string, type?: string, other_user_id?: string }) => void;
    onStartGroupChat?: () => void;
    onAddToGroup?: (friend: { user_id: string; username: string; avatar_url?: string }) => void;
    /** The ONE copy of GET /friends, owned by Dashboard (also feeds the
     *  right-hand Active Now panel). `null` = never loaded successfully — which
     *  is NOT the same as "loaded and you have no friends". */
    friends: FriendsPayload | null;
    friendsStatus: FriendsLoadStatus;
    /** Re-fetch GET /friends. Never rejects; on failure the last good list stays. */
    onRefresh: () => Promise<unknown>;
    onStartCall?: (targetUserId: string) => void;
    friendStatuses?: Record<string, FriendStatusEntry>;
    onViewProfile?: (userId: string) => void;
}

type SubTab = 'all' | 'pending' | 'blocked';

/** Staggered row entrance — rows drift up as a list arrives (motion doctrine:
 *  translateY only, capped stagger so long lists don't feel slow). */
const rowEntrance = (i: number) => ({
    className: 'fade-rise-enter',
    style: { animationDelay: `${Math.min(i, 10) * 30}ms` } as React.CSSProperties,
});

/* ── Presentational pieces (module level so rows never remount) ─────────── */

/** A group of people: sentence-case heading + count, then one sheet of rows. */
const Group: React.FC<{ title: string; count: number; hint?: React.ReactNode; children: React.ReactNode }> = ({ title, count, hint, children }) => {
    const id = `fp-g-${title.toLowerCase().replace(/\s+/g, '-')}`;
    return (
        <section className="fp-group" aria-labelledby={id}>
            <div className="fp-grouphead">
                <h2 id={id}>{title}</h2>
                <span className="fp-n" aria-label={`${count}`}>{count}</span>
                {hint && <span className="fp-hint">{hint}</span>}
            </div>
            <div className="fp-sheet" role="list">{children}</div>
        </section>
    );
};

/** True while the pane is at or below the width where its request buttons drop their
 *  labels (keep in step with the `@container fp (max-width: 600px)` block in friends-pane.css). */
const COMPACT_PANE_PX = 600;
function useCompactPane(ref: React.RefObject<HTMLElement | null>): boolean {
    const [compact, setCompact] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width <= COMPACT_PANE_PX));
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return compact;
}

/** Round icon action on a row: a real button with an accessible name and the kit tooltip. */
const RowAction: React.FC<{
    label: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    className?: string;
    children: React.ReactNode;
}> = ({ label, onClick, className, children }) => {
    const { anchorProps, tooltip, describedBy } = useClTooltip(label);
    return (
        <>
            <button
                type="button"
                {...anchorProps}
                aria-label={label}
                aria-describedby={describedBy}
                className={['fp-act', className ?? ''].filter(Boolean).join(' ')}
                onClick={(e) => { e.stopPropagation(); onClick(e); }}
            >
                {children}
            </button>
            {tooltip}
        </>
    );
};

/** Empty state for a tab or a search: a lit porthole glyph, a title, one line. */
const PaneEmpty: React.FC<{
    icon: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; extra?: React.ReactNode;
    accent?: string; children?: React.ReactNode;
}> = ({ icon, title, sub, extra, accent, children }) => (
    <div className="fp-empty" style={accent ? ({ '--fp-accent': accent } as React.CSSProperties) : undefined}>
        <span className="fp-empty-ic" aria-hidden="true">{icon}</span>
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
        {extra && <p>{extra}</p>}
        {children && <div className="fp-empty-acts">{children}</div>}
    </div>
);

/** What a friend's status line says when there is no custom status or game. */
function quietStatusLabel(status: string, onMobile: boolean): string | null {
    if (status === 'offline') return null;
    if (onMobile) return 'On mobile';
    return STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.label ?? null;
}

/** Roving focus between rows: Up/Down/Home/End move, Enter/Space opens,
 *  Shift+F10 / the context-menu key opens the row's menu. Rows are found by
 *  `data-friend-row` across every group in the pane, so focus flows from the
 *  Online sheet into the Offline one. */
function rowKeyDown(
    e: React.KeyboardEvent<HTMLDivElement>,
    onActivate: (at: { x: number; y: number }) => void,
    onMenu?: (at: { clientX: number; clientY: number }) => void,
) {
    if (e.target !== e.currentTarget) return;
    const row = e.currentTarget;
    const rect = row.getBoundingClientRect();
    const all = (): HTMLElement[] => Array.from(row.closest('.fp-body')?.querySelectorAll<HTMLElement>('[data-friend-row]') ?? []);
    const move = (to: (list: HTMLElement[], i: number) => HTMLElement | undefined) => {
        e.preventDefault();
        const list = all();
        to(list, list.indexOf(row))?.focus();
    };
    switch (e.key) {
        case 'ArrowDown': return move((l, i) => l[i + 1]);
        case 'ArrowUp': return move((l, i) => l[i - 1]);
        case 'Home': return move((l) => l[0]);
        case 'End': return move((l) => l[l.length - 1]);
        case 'Enter':
        case ' ':
            e.preventDefault();
            onActivate({ x: rect.left + 56, y: rect.top + rect.height / 2 });
            return;
        case 'ContextMenu':
            if (!onMenu) return;
            e.preventDefault();
            onMenu({ clientX: rect.right - 48, clientY: rect.bottom - 6 });
            return;
        case 'F10':
            if (!onMenu || !e.shiftKey) return;
            e.preventDefault();
            onMenu({ clientX: rect.right - 48, clientY: rect.bottom - 6 });
            return;
    }
}

const FriendsPane: React.FC<FriendsPaneProps> = ({
    onStartChat, onStartGroupChat, onAddToGroup,
    friends: friendsProp, friendsStatus, onRefresh,
    onStartCall, friendStatuses, onViewProfile,
}) => {
    const { token, deviceId } = useAuth();
    const openProfileCtx = useOpenProfile();
    const toast = useToast();
    // No private copy: this used to be a `useState` that started EMPTY on every
    // mount and was filled by a one-shot, error-swallowing GET, so a single failed
    // fetch left "Your circle is quiet" up while Dashboard's copy (the Active Now
    // panel) had the friend. Read the shared payload instead; `loaded` separates
    // "never loaded" from "loaded and empty". See utils/friendsSync.ts.
    const loaded = friendsProp !== null;
    const friends = friendsProp ?? EMPTY_FRIENDS;
    const [subTab, setSubTab] = useState<SubTab>('all');
    // Mirrors the `@container fp (max-width: 600px)` rule in friends-pane.css, where
    // the Accept/Decline labels collapse to icons. CSS does the layout; this only
    // decides whether the (now label-less) buttons need a tooltip to say what they do.
    const rootRef = useRef<HTMLDivElement>(null);
    const compact = useCompactPane(rootRef);
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState('');
    // Egg: a second, playful line under "No friends match" (always shown, rotating per query).
    const noFriendLine = usePlayfulLine('', FRIENDS_NO_MATCH_POOL, hashSeed(search));
    const [showAddFriendModal, setShowAddFriendModal] = useState(false);
    const friendMenu = useContextMenu();
    /** Pending block / remove-friend confirmation (FriendActionDialog). */
    const [friendAction, setFriendAction] = useState<{
        kind: FriendActionKind; userId: string; username: string; onConfirm: () => void;
    } | null>(null);
    // Per-row in-flight tracking for incoming friend-request Accept/Reject —
    // keyed by friend_table_id (the request row), not the acting user id,
    // so the two buttons on the SAME row can see and disable each other
    // without touching any other row's buttons.
    const [acceptingRequestIds, setAcceptingRequestIds] = useState<Set<string>>(new Set());
    const [rejectingRequestIds, setRejectingRequestIds] = useState<Set<string>>(new Set());

    const fetchFriends = async (silent = false) => {
        if (!silent) setRefreshing(true);
        try {
            await onRefresh();
        } finally {
            setRefreshing(false);
        }
    };

    // Revalidate on open. The shared list is already on screen (seeded from
    // Dashboard), so this can only improve it; a failure keeps what is shown.
    // Friend events and WS reconnects refetch in Dashboard, which this reads.
    useEffect(() => {
        if (token) void onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount/token; onRefresh is a per-render closure
    }, [token]);

    const handleReject = async (friendId: string, rowId: string) => {
        setRejectingRequestIds(prev => new Set(prev).add(rowId));
        try {
            await axios.delete(apiUrl`/friends/${friendId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            fetchFriends(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Request Failed', message: err?.response?.data?.message || 'Could not decline the request' });
        } finally {
            setRejectingRequestIds(prev => { const next = new Set(prev); next.delete(rowId); return next; });
        }
    };

    const handleBlock = (userId: string, username: string) => {
        setFriendAction({
            kind: 'block',
            userId,
            username,
            onConfirm: async () => {
                try {
                    await axios.post(`${API_BASE}/friends/block`, { target_id: userId }, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    fetchFriends(true);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
                } catch (err: any) {
                    toast.push({ kind: 'error', title: 'Block Failed', message: err?.response?.data?.message || 'Failed to block user' });
                }
            }
        });
    };

    const handleUnblock = async (userId: string) => {
        try {
            await axios.post(`${API_BASE}/friends/unblock`, { target_id: userId }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            fetchFriends(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Unblock Failed', message: err?.response?.data?.message || 'Failed to unblock user' });
        }
    };

    const handleAccept = async (friendId: string) => {
        setAcceptingRequestIds(prev => new Set(prev).add(friendId));
        try {
            await axios.post(`${API_BASE}/friends/accept`, { friend_id: friendId }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            fetchFriends(true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Accept Failed', message: err?.response?.data?.message || 'Failed to accept' });
        } finally {
            setAcceptingRequestIds(prev => { const next = new Set(prev); next.delete(friendId); return next; });
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const handleMessageFriend = async (friend: any) => {
        try {
            const res = await axios.post(`${API_BASE}/conversations/dm`, {
                other_user_id: friend.user_id
            }, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
            });
            onStartChat({
                id: res.data.conversation_id,
                title: friend.username,
                type: 'dm',
                other_user_id: friend.user_id
            });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'DM Failed', message: err?.response?.data?.message || 'Failed to start DM' });
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const handleRemoveFriend = (friend: any) => {
        setFriendAction({
            kind: 'unfriend',
            userId: friend.user_id,
            username: formatUserTag(friend.username, friend.discriminator),
            onConfirm: async () => {
                try {
                    await axios.delete(apiUrl`/friends/${friend.user_id}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    fetchFriends(true);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
                } catch (err: any) {
                    toast.push({ kind: 'error', title: 'Remove Failed', message: err?.response?.data?.message || 'Failed to remove friend.' });
                }
            }
        });
    };

    const pendingCount = friends.pending_incoming.length + friends.pending_outgoing.length;
    const filteredFriends = friends.accepted.filter(f =>
        f.username.toLowerCase().includes(search.toLowerCase())
    );

    // Presence picks the group (Online / Offline); names sort within it. The
    // same `friendStatuses` read the dot uses, so a row never sits in the
    // Online group with a grey dot.
    const statusOf = (uid: string) => friendStatuses?.[uid]?.status ?? 'offline';
    const byName = (a: { username?: string }, b: { username?: string }) =>
        String(a.username ?? '').localeCompare(String(b.username ?? ''), undefined, { sensitivity: 'base' });
    const onlineFriends = filteredFriends.filter(f => statusOf(f.user_id) !== 'offline').sort(byName);
    const offlineFriends = filteredFriends.filter(f => statusOf(f.user_id) === 'offline').sort(byName);
    const onlineTotal = friends.accepted.filter(f => statusOf(f.user_id) !== 'offline').length;

    // Requests that have come IN are what needs attention, so they get the red
    // unread pill (the same look as the rail's badges). Requests you sent are
    // only waiting on someone else: a plain count, shown when nothing is incoming.
    const incomingCount = friends.pending_incoming.length;
    const tabs: { id: SubTab; label: string; icon: React.ReactNode; badge?: number; unread?: number }[] = [
        { id: 'all', label: 'All friends', icon: <UserCheck size={16} />, badge: friends.accepted.length },
        {
            id: 'pending', label: 'Pending', icon: <Clock size={16} />,
            unread: incomingCount || undefined,
            badge: incomingCount ? undefined : (pendingCount || undefined),
        },
        { id: 'blocked', label: 'Blocked', icon: <Ban size={16} />, badge: friends.blocked?.length ? friends.blocked.length : undefined },
    ];

    const openProfileAt = (userId: string, at: { x: number; y: number }) => {
        if (openProfileCtx) openProfileCtx(userId, at);
        else onViewProfile?.(userId);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const openFriendMenu = (f: any, at: React.MouseEvent | { clientX: number; clientY: number }) => {
        const anchor = { x: at.clientX, y: at.clientY };
        friendMenu.open(at, [
            { icon: <User />, label: 'Profile', onSelect: () => openProfileAt(f.user_id, anchor) },
            { icon: <PhoneCall />, label: 'Call', onSelect: () => onStartCall?.(f.user_id) },
            { icon: <MessagesSquare />, label: 'Add to Group Chat', onSelect: () => onAddToGroup?.(f) },
            { divider: true },
            { icon: <UserMinus />, label: 'Remove Friend', danger: true, onSelect: () => handleRemoveFriend(f) },
            { icon: <Ban />, label: 'Block', danger: true,
              onSelect: () => handleBlock(f.user_id, formatUserTag(f.username, f.discriminator)) },
        ], formatUserTag(f.username, f.discriminator));
    };

    /** The #tag beside a name (shown on hover/focus unless `always`). */
    const tagOf = (discriminator: number | null | undefined, always = false) =>
        discriminator !== null && discriminator !== undefined
            ? <span className={`fp-tag${always ? ' fp-tag--always' : ''}`}>#{padDiscriminator(discriminator)}</span>
            : null;

    const expiryChip = (requestedAt: string | null | undefined) => {
        const { expiresInDays } = friendRequestTiming(requestedAt);
        return expiresInDays === null ? null : (
            <span className="fp-expiry" title="Pending requests are removed after 30 days">
                <Clock size={11} aria-hidden="true" />
                {expiryLabel(expiresInDays)}
            </span>
        );
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const renderFriendRow = (f: any, i: number) => {
        const fs = friendStatuses?.[f.user_id];
        const status = fs?.status ?? 'offline';
        // The phone glyph replaces the dot while this friend is present on
        // phones only (the server's on_mobile — one bit, same audience as the
        // dot itself, hidden by "appear offline"). Games are a desktop signal,
        // so on_mobile wins.
        const onMobile = status !== 'offline' && !!fs?.on_mobile;
        const game = onMobile ? null : (fs?.current_game ?? null);
        const showController = !!game && status !== 'offline';
        const quiet = quietStatusLabel(status, onMobile);
        const entrance = rowEntrance(i);
        return (
            <HoverPlayRow
                key={f.friend_table_id}
                role="listitem"
                tabIndex={0}
                data-friend-row={f.user_id}
                style={entrance.style}
                className={`fp-row${status === 'offline' ? ' fp-row--offline' : ''} ${entrance.className}`}
                onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button, a, input')) return;
                    openProfileAt(f.user_id, { x: e.clientX, y: e.clientY });
                }}
                onContextMenu={(e) => openFriendMenu(f, e)}
                onKeyDown={(e) => rowKeyDown(e, at => openProfileAt(f.user_id, at), at => openFriendMenu(f, at))}
            >
                {(playing) => (
                    <>
                        <div className="fp-av">
                            {/* The look the friend gave it (colour, glow, "Match theme"), as on their card. The
                                payload carries it; an older API that omits the fields is completed from the session profile cache. */}
                            <AvatarDecoration {...decorationLook(f, peekProfile(f.user_id))} block compact className="w-full h-full">
                                <div className="fp-avimg">
                                    <EncryptedAvatar attachmentId={f.avatar_url} userId={f.user_id} token={token} className="w-full h-full" fallbackSize={16} playing={playing} />
                                </div>
                            </AvatarDecoration>
                            <span className={`fp-presence${showController ? ' fp-presence--game' : ''}`}>
                                <StatusIcon status={status} currentGame={showController ? game : null} onMobile={onMobile} size={showController ? 12 : 10} />
                            </span>
                        </div>
                        <div className="fp-text">
                            <div className="fp-nameline">
                                <span className="fp-name">{f.username}</span>
                                <ProfileBadgeRow badges={f.badges} size="sm" />
                                {tagOf(f.discriminator)}
                            </div>
                            <div className="fp-sub">
                                <StatusLine
                                    entry={fs}
                                    userId={f.user_id}
                                    className="block truncate"
                                    renderGame={(g) => <span className="fp-sub--game">Playing {g}</span>}
                                    fallback={quiet ? <span className="fp-sub--quiet">{quiet}</span> : null}
                                />
                            </div>
                        </div>
                        <div data-friend-dropdown={f.user_id} className="fp-acts">
                            <RowAction label="Message" className="fp-act--msg" onClick={() => handleMessageFriend(f)}>
                                <MessageSquare size={16} />
                            </RowAction>
                            {onStartCall && (
                                <RowAction label="Call" className="fp-act--call" onClick={() => onStartCall(f.user_id)}>
                                    <PhoneCall size={16} />
                                </RowAction>
                            )}
                            <RowAction
                                label="More"
                                onClick={(e) => {
                                    // A keyboard press reports (0,0): anchor the menu under the button instead.
                                    const r = e.currentTarget.getBoundingClientRect();
                                    openFriendMenu(f, e.detail === 0 ? { clientX: r.left, clientY: r.bottom + 4 } : e);
                                }}
                            >
                                <MoreVertical size={16} />
                            </RowAction>
                        </div>
                    </>
                )}
            </HoverPlayRow>
        );
    };

    const requesterNames = (() => {
        const names = friends.pending_incoming.map(r => String(r.username ?? 'Someone'));
        if (names.length === 1) return `${names[0]} wants to be friends`;
        if (names.length === 2) return `${names[0]} and ${names[1]} want to be friends`;
        return `${names[0]}, ${names[1]} and ${names.length - 2} more want to be friends`;
    })();

    return (
        <div ref={rootRef} className="friends-pane-root fp-root flex flex-col h-full bg-cl-abyss overflow-hidden">

            {/* Header: title + summary and actions, then the tabs and search on one toolbar row */}
            <div className="fp-head">
                <div className="fp-col">
                    <div className="fp-titlerow">
                        <div className="min-w-0">
                            <h1 className="fp-title">Friends</h1>
                            <p className="fp-summary">
                                {!loaded ? ' '
                                    : friends.accepted.length === 0 ? 'No friends yet'
                                    : onlineTotal === 0 ? `${friends.accepted.length} friend${friends.accepted.length !== 1 ? 's' : ''}, nobody online right now`
                                    : <><b>{onlineTotal}</b> online of {friends.accepted.length} friend{friends.accepted.length !== 1 ? 's' : ''}</>}
                            </p>
                        </div>
                        <div className="fp-headacts">
                            <ClButton
                                variant="ghost"
                                icon
                                size="sm"
                                tooltip="Refresh"
                                disabled={refreshing}
                                onClick={() => fetchFriends()}
                            >
                                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
                            </ClButton>
                            <ClButton
                                variant="ghost"
                                className="fp-hide-narrow"
                                disabled={friends.accepted.length === 0}
                                onClick={() => onStartGroupChat?.()}
                            >
                                <MessagesSquare size={15} />
                                New Group
                            </ClButton>
                            <ClButton onClick={() => setShowAddFriendModal(true)}>
                                <UserPlus size={15} />
                                Add Friend
                            </ClButton>
                        </div>
                    </div>

                    <div className="fp-toolbar">
                        {/* Sub-tabs — kit segmented control (sliding lume indicator) */}
                        <ClSegment<SubTab>
                            value={subTab}
                            onChange={setSubTab}
                            options={tabs.map(tab => ({
                                value: tab.id,
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        {tab.icon}
                                        <span className="leading-none">{tab.label}</span>
                                        {tab.unread !== undefined && tab.unread > 0 && (
                                            <span
                                                role="img"
                                                aria-label={`${tab.unread} new friend request${tab.unread === 1 ? '' : 's'}`}
                                                style={{
                                                    minWidth: 17, height: 17, padding: '0 5px', borderRadius: 99,
                                                    background: 'var(--cl-flash)', color: 'var(--cl-on-flash)',
                                                    fontSize: 10, fontWeight: 800, lineHeight: 1,
                                                    fontFamily: 'var(--cl-font-body)', display: 'inline-flex',
                                                    alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                                                }}
                                            >
                                                {formatRailBadgeCount(tab.unread)}
                                            </span>
                                        )}
                                        {tab.badge !== undefined && tab.badge > 0 && (
                                            <span
                                                className="text-[10px] font-bold leading-none opacity-80"
                                                style={{ fontFamily: 'var(--cl-font-mono)' }}
                                            >
                                                {tab.badge}
                                            </span>
                                        )}
                                    </span>
                                ),
                            }))}
                        />
                        {loaded && subTab === 'all' && friends.accepted.length > 0 && (
                            <div className="fp-search">
                                <ClSearch
                                    icon={<Search size={14} />}
                                    type="text"
                                    aria-label="Search friends"
                                    placeholder="Search friends"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="fp-body custom-scrollbar">

                {/* Never loaded (first fetch pending or failing): say so. Rendering the
                    empty state here told people with friends that they had none. */}
                {!loaded && (
                    <div className="fp-col" role="status" aria-live="polite">
                        {friendsStatus === 'error' ? (
                            <MascotEmpty
                                title="Couldn't load your friends"
                                sub="We can't reach the server right now. Your friends are fine - we'll keep trying."
                            >
                                <ClButton size="sm" onClick={() => { void fetchFriends(); }} disabled={refreshing}>
                                    <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                                    Try again
                                </ClButton>
                            </MascotEmpty>
                        ) : (
                            <>
                                <span className="fp-sr">Loading your friends…</span>
                                <div className="fp-sheet fp-skel" aria-hidden="true">
                                    {[62, 44, 70, 52].map((w, i) => (
                                        <div key={i} className="fp-row">
                                            <span className="fp-skel-av" />
                                            <span className="fp-text">
                                                <span className="fp-skel-line" style={{ width: `${w * 2.2}px`, maxWidth: '60%' }} />
                                                <span className="fp-skel-line" style={{ width: `${w * 3.4}px`, maxWidth: '80%', marginTop: 8, height: 8, opacity: .6 }} />
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* A later refresh failed: keep showing the last good list, say it may be old. */}
                {loaded && friendsStatus === 'error' && (
                    <div className="fp-col" role="status" aria-live="polite">
                        <p className="fp-note">
                            Couldn&rsquo;t refresh your friends - showing the last list we have. Retrying&hellip;
                            <button type="button" className="fp-linkbtn" onClick={() => { void fetchFriends(); }}>Try now</button>
                        </p>
                    </div>
                )}

                {/* ── All Friends ── */}
                {loaded && subTab === 'all' && (
                    <div className="fp-col">
                        {incomingCount > 0 && !search && (
                            <div className="fp-callout">
                                <span className="fp-callout-ic" aria-hidden="true"><UserPlus size={17} /></span>
                                <div className="fp-callout-text">
                                    <p className="fp-callout-title">
                                        {incomingCount === 1 ? '1 friend request' : `${incomingCount} friend requests`}
                                    </p>
                                    <p className="fp-callout-sub">{requesterNames}</p>
                                </div>
                                <ClButton size="sm" variant="ghost" onClick={() => setSubTab('pending')}>Review</ClButton>
                            </div>
                        )}

                        {friends.accepted.length === 0 ? (
                            <MascotEmpty
                                title="Your circle is quiet for now"
                                sub="Add people you trust. Every message is end-to-end encrypted — just you and them."
                            >
                                <ClButton size="sm" onClick={() => setShowAddFriendModal(true)}>
                                    <UserPlus size={14} />
                                    Add a Friend
                                </ClButton>
                            </MascotEmpty>
                        ) : filteredFriends.length === 0 ? (
                            <PaneEmpty
                                icon={<Search size={22} />}
                                title={<>No friends match &ldquo;{search}&rdquo;</>}
                                sub="Search looks at usernames."
                                extra={noFriendLine || undefined}
                            >
                                <ClButton size="sm" variant="ghost" onClick={() => setSearch('')}>Clear search</ClButton>
                            </PaneEmpty>
                        ) : (
                            <>
                                {onlineFriends.length > 0 && (
                                    <Group title="Online" count={onlineFriends.length}>
                                        {onlineFriends.map((f, i) => renderFriendRow(f, i))}
                                    </Group>
                                )}
                                {offlineFriends.length > 0 && (
                                    <Group title="Offline" count={offlineFriends.length}>
                                        {offlineFriends.map((f, i) => renderFriendRow(f, onlineFriends.length + i))}
                                    </Group>
                                )}
                            </>
                        )}
                    </div>
                )}

                {/* ── Blocked ── */}
                {loaded && subTab === 'blocked' && (
                    <div className="fp-col">
                        {friends.blocked && friends.blocked.length > 0 ? (
                            <Group title="Blocked" count={friends.blocked.length} hint="They can't message you or send you requests">
                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt */}
                                {friends.blocked.map((f: any, i: number) => {
                                    const blockedAgo = daysAgoLabel(f.blocked_at);
                                    return (
                                        <HoverPlayRow key={f.friend_table_id} role="listitem" style={rowEntrance(i).style} className={`fp-row fp-row--static ${rowEntrance(i).className}`}>
                                            {(playing) => (
                                                <>
                                                    <div className="fp-av">
                                                        <div className="fp-avimg">
                                                            <EncryptedAvatar
                                                                attachmentId={f.avatar_url}
                                                                userId={f.user_id}
                                                                token={token}
                                                                className="w-full h-full opacity-60"
                                                                fallbackSize={18}
                                                                bypassFriendGate
                                                                playing={playing}
                                                            />
                                                        </div>
                                                        <span className="fp-presence fp-presence--ban" aria-hidden="true">
                                                            <span className="fp-banmark"><Ban size={10} strokeWidth={2.5} /></span>
                                                        </span>
                                                    </div>
                                                    <div className="fp-text">
                                                        <div className="fp-nameline">
                                                            <span className="fp-name">{f.username}</span>
                                                            {tagOf(f.discriminator, true)}
                                                        </div>
                                                        <div className="fp-sub fp-sub--quiet">{blockedAgo ? `Blocked ${blockedAgo}` : 'Blocked'}</div>
                                                    </div>
                                                    {/* shrink-0: never let the name squeeze "Unblock" onto two lines. */}
                                                    <ClButton variant="ghost" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => handleUnblock(f.user_id)}>
                                                        Unblock
                                                    </ClButton>
                                                </>
                                            )}
                                        </HoverPlayRow>
                                    );
                                })}
                            </Group>
                        ) : (
                            <PaneEmpty
                                icon={<Ban size={22} />}
                                accent="var(--cl-muted)"
                                title="You haven't blocked anyone"
                                sub="Blocked people can't message you or send you friend requests, and they aren't told."
                            />
                        )}
                    </div>
                )}

                {/* ── Pending ── */}
                {loaded && subTab === 'pending' && (
                    <div className="fp-col">
                        {/* Incoming */}
                        {friends.pending_incoming.length > 0 && (
                            <Group title="Incoming" count={friends.pending_incoming.length}>
                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt */}
                                {friends.pending_incoming.map((f: any, i: number) => {
                                    const { age } = friendRequestTiming(f.requested_at);
                                    return (
                                        <HoverPlayRow key={f.friend_table_id} role="listitem" style={rowEntrance(i).style} className={`fp-row fp-row--static fp-row--req ${rowEntrance(i).className}`}>
                                            {(playing) => (
                                                <>
                                                    <div className="fp-av">
                                                        <div className="fp-avimg">
                                                            {/* Not a friend yet: the friends-only gate would hide the picture the server
                                                                now serves for an incoming request (see AttachmentsService.hasRequestOrBlockRelation). */}
                                                            <EncryptedAvatar attachmentId={f.avatar_url} userId={f.requester_id} token={token} className="w-full h-full" fallbackSize={18} bypassFriendGate playing={playing} />
                                                        </div>
                                                    </div>
                                                    <div className="fp-text">
                                                        <div className="fp-nameline">
                                                            <span className="fp-name">{f.username}</span>
                                                            {tagOf(f.discriminator, true)}
                                                        </div>
                                                        <div className="fp-sub fp-subrow">
                                                            <span className="fp-subtext">{age ? `Sent you a request ${age}` : 'Sent you a friend request'}</span>
                                                            {expiryChip(f.requested_at)}
                                                        </div>
                                                    </div>
                                                    {/* Both actions are text pills on the same size so they read as one
                                                        deliberate pair at one height. */}
                                                    <div className="fp-acts fp-acts--req">
                                                        <ClButton
                                                            variant="ok"
                                                            size="sm"
                                                            loading={acceptingRequestIds.has(f.friend_table_id)}
                                                            disabled={rejectingRequestIds.has(f.friend_table_id)}
                                                            onClick={() => handleAccept(f.friend_table_id)}
                                                            tooltip={compact ? 'Accept' : undefined}
                                                        >
                                                            <Check size={14} strokeWidth={2.6} aria-hidden="true" />
                                                            <span className="fp-btn-label">Accept</span>
                                                        </ClButton>
                                                        <ClButton
                                                            variant="ghost"
                                                            size="sm"
                                                            loading={rejectingRequestIds.has(f.friend_table_id)}
                                                            disabled={acceptingRequestIds.has(f.friend_table_id)}
                                                            onClick={() => handleReject(f.requester_id, f.friend_table_id)}
                                                            tooltip={compact ? 'Decline' : undefined}
                                                        >
                                                            <X size={14} strokeWidth={2.6} aria-hidden="true" />
                                                            <span className="fp-btn-label">Decline</span>
                                                        </ClButton>
                                                    </div>
                                                </>
                                            )}
                                        </HoverPlayRow>
                                    );
                                })}
                            </Group>
                        )}

                        {/* Outgoing */}
                        {friends.pending_outgoing.length > 0 && (
                            <Group title="Sent" count={friends.pending_outgoing.length} hint="Requests expire after 30 days">
                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt */}
                                {friends.pending_outgoing.map((f: any, i: number) => {
                                    const { age } = friendRequestTiming(f.requested_at);
                                    return (
                                        <HoverPlayRow key={f.friend_table_id} role="listitem" style={rowEntrance(i).style} className={`fp-row fp-row--static fp-row--req ${rowEntrance(i).className}`}>
                                            {(playing) => (
                                                <>
                                                    <div className="fp-av">
                                                        <div className="fp-avimg">
                                                            <EncryptedAvatar attachmentId={f.avatar_url} userId={f.recipient_id} token={token} className="w-full h-full" fallbackSize={18} playing={playing} />
                                                        </div>
                                                    </div>
                                                    <div className="fp-text">
                                                        <div className="fp-nameline">
                                                            <span className="fp-name">{f.username}</span>
                                                            {tagOf(f.discriminator, true)}
                                                        </div>
                                                        <div className="fp-sub fp-sub--quiet fp-subrow">
                                                            <span className="fp-subtext">{age ? `Request sent ${age}` : 'Waiting for a reply'}</span>
                                                            {expiryChip(f.requested_at)}
                                                        </div>
                                                    </div>
                                                    <span className="fp-pending" aria-label="Waiting for a reply">
                                                        <Clock size={13} aria-hidden="true" />
                                                        Waiting
                                                    </span>
                                                </>
                                            )}
                                        </HoverPlayRow>
                                    );
                                })}
                            </Group>
                        )}

                        {pendingCount === 0 && (
                            <PaneEmpty
                                icon={<Inbox size={22} />}
                                accent="var(--cl-ok)"
                                title="No pending requests"
                                sub="Requests you send or receive wait here for up to 30 days."
                            >
                                <ClButton size="sm" variant="ghost" onClick={() => setShowAddFriendModal(true)}>
                                    <UserPlus size={14} />
                                    Add Friend
                                </ClButton>
                            </PaneEmpty>
                        )}
                    </div>
                )}
            </div>

            {/* Block / remove-friend confirmation */}
            {friendAction && (
                <FriendActionDialog
                    kind={friendAction.kind}
                    userId={friendAction.userId}
                    username={friendAction.username}
                    token={token}
                    onConfirm={friendAction.onConfirm}
                    onClose={() => setFriendAction(null)}
                />
            )}

            {showAddFriendModal && (
                <AddFriendModal onClose={() => { setShowAddFriendModal(false); fetchFriends(true); }} />
            )}

            {friendMenu.menu}
        </div>
    );
};

export default FriendsPane;
