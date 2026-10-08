import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { ClButton, ClSearch, ClConfirm, ClSegment } from './cl';
import { useOpenProfile } from '../contexts/ProfileOpenContext';
import {
    UserPlus, MessageSquare, Users, Clock, CheckCircle, XCircle,
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
import { EncryptedAvatar } from './EncryptedAvatar';
import { formatRailBadgeCount } from '../utils/unreadBadges';
import { MascotEmpty } from './MascotEmpty';

interface FriendsPaneProps {
    onStartChat: (chat: { id: string, title?: string, type?: string, other_user_id?: string }) => void;
    onStartGroupChat?: () => void;
    onAddToGroup?: (friend: { user_id: string; username: string; avatar_url?: string }) => void;
    onFriendsLoaded?: (friends: { accepted: any[] }) => void;
    onStartCall?: (targetUserId: string) => void;
    friendStatuses?: Record<string, FriendStatusEntry>;
    onViewProfile?: (userId: string) => void;
    friendAcceptedEvent?: { requester_id: string, recipient_id: string } | null;
    friendRequestEvent?: { recipient_id: string } | null;
    friendRemovedEvent?: { removed_by: string, other_user_id: string } | null;
    /** Bumps on every WS reconnect (sleep-resync). Previously this pane had
     *  no reconnect resync at all — a friend request that arrived, was
     *  accepted, or was withdrawn while the socket was down (asleep laptop,
     *  dropped network) fired no event on wake, so the pending tab sat
     *  stale until some LATER, unrelated friend event happened to trigger
     *  a refetch. */
    wsConnectCount?: number;
}

type SubTab = 'all' | 'pending' | 'blocked';

/** Mono uppercase section label — same vocabulary as settings/profile. */
const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p
        className="text-[10px] font-semibold uppercase text-cl-faint m-0 mb-3"
        style={{ fontFamily: 'var(--cl-font-mono)', letterSpacing: '1.2px' }}
    >
        {children}
    </p>
);

/** Staggered row entrance — rows drift up as a list arrives (motion doctrine:
 *  translateY only, capped stagger so long lists don't feel slow). */
const rowEntrance = (i: number) => ({
    className: 'fade-rise-enter',
    style: { animationDelay: `${Math.min(i, 10) * 30}ms` } as React.CSSProperties,
});

const FriendsPane: React.FC<FriendsPaneProps> = ({
    onStartChat, onStartGroupChat, onAddToGroup, onFriendsLoaded,
    onStartCall, friendStatuses, onViewProfile,
    friendAcceptedEvent, friendRequestEvent, friendRemovedEvent,
    wsConnectCount
}) => {
    const { token, deviceId } = useAuth();
    const openProfileCtx = useOpenProfile();
    const toast = useToast();
    const [friends, setFriends] = useState<{ pending_incoming: any[], pending_outgoing: any[], accepted: any[], blocked: any[] }>({
        pending_incoming: [],
        pending_outgoing: [],
        accepted: [],
        blocked: []
    });
    const [subTab, setSubTab] = useState<SubTab>('all');
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState('');
    const [showAddFriendModal, setShowAddFriendModal] = useState(false);
    const friendMenu = useContextMenu();
    const [confirmDialog, setConfirmDialog] = useState<{
        title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void;
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
            const res = await axios.get(`${API_BASE}/friends`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setFriends(res.data);
            onFriendsLoaded?.(res.data);
        } catch (err) {
            console.error('Failed to fetch friends:', err);
        } finally {
            setRefreshing(false);
        }
    };

    useEffect(() => {
        if (token) fetchFriends();
    }, [token]);

    useEffect(() => {
        if (!token) return;
        if (!friendAcceptedEvent && !friendRequestEvent && !friendRemovedEvent) return;
        fetchFriends(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [friendAcceptedEvent, friendRequestEvent, friendRemovedEvent]);

    // Reconnect resync — see the wsConnectCount prop doc comment. Skips the
    // initial connect (count goes 0→1) the same way Dashboard's own
    // reconnect effect does, since the mount effect above already covers it.
    const prevWsConnectCount = useRef(0);
    useEffect(() => {
        if (!token || wsConnectCount === undefined) return;
        if (prevWsConnectCount.current === 0 && wsConnectCount <= 1) {
            prevWsConnectCount.current = wsConnectCount;
            return;
        }
        prevWsConnectCount.current = wsConnectCount;
        fetchFriends(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wsConnectCount, token]);

    const handleReject = async (friendId: string, rowId: string) => {
        setRejectingRequestIds(prev => new Set(prev).add(rowId));
        try {
            await axios.delete(`${API_BASE}/friends/${friendId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            fetchFriends(true);
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Request Failed', message: err?.response?.data?.message || 'Failed to reject request' });
        } finally {
            setRejectingRequestIds(prev => { const next = new Set(prev); next.delete(rowId); return next; });
        }
    };

    const handleBlock = (userId: string, username: string) => {
        setConfirmDialog({
            title: `Block ${username}?`,
            message: `${username} won't be able to send you friend requests or messages. They won't be notified that you blocked them.`,
            confirmLabel: 'Block',
            danger: true,
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    await axios.post(`${API_BASE}/friends/block`, { target_id: userId }, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    fetchFriends(true);
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
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Accept Failed', message: err?.response?.data?.message || 'Failed to accept' });
        } finally {
            setAcceptingRequestIds(prev => { const next = new Set(prev); next.delete(friendId); return next; });
        }
    };

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
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'DM Failed', message: err?.response?.data?.message || 'Failed to start DM' });
        }
    };

    const handleRemoveFriend = (friend: any) => {
        setConfirmDialog({
            title: 'Remove Friend',
            message: `Remove ${formatUserTag(friend.username, friend.discriminator)} as a friend? You'll no longer be able to send messages, but your chat history will remain visible.`,
            confirmLabel: 'Remove',
            danger: true,
            onConfirm: async () => {
                setConfirmDialog(null);
                try {
                    await axios.delete(`${API_BASE}/friends/${friend.user_id}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    fetchFriends(true);
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

    // Requests that have come IN are what needs attention, so they get the red
    // unread pill (the same look as the rail's badges). Requests you sent are
    // only waiting on someone else: a plain count, shown when nothing is incoming.
    const incomingCount = friends.pending_incoming.length;
    const tabs: { id: SubTab; label: string; icon: React.ReactNode; badge?: number; unread?: number }[] = [
        { id: 'all', label: 'All Friends', icon: <UserCheck size={16} />, badge: friends.accepted.length },
        {
            id: 'pending', label: 'Pending', icon: <Clock size={16} />,
            unread: incomingCount || undefined,
            badge: incomingCount ? undefined : (pendingCount || undefined),
        },
        { id: 'blocked', label: 'Blocked', icon: <Ban size={16} />, badge: friends.blocked?.length ? friends.blocked.length : undefined },
    ];

    return (
        <div className="flex flex-col h-full bg-cl-abyss overflow-hidden">

            {/* Header */}
            <div className="shrink-0 px-10 pt-8 pb-0 border-b border-cl-border/40">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center text-cl-lume">
                            <Users size={20} />
                        </div>
                        <div>
                            <h1
                                className="text-xl font-semibold text-cl-text tracking-tight leading-none m-0"
                                style={{ fontFamily: 'var(--cl-font-display)' }}
                            >
                                Friends
                            </h1>
                            <p className="text-xs text-cl-faint mt-0.5">
                                {friends.accepted.length} friend{friends.accepted.length !== 1 ? 's' : ''}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
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

                {/* Sub-tabs — kit segmented control (sliding lume indicator) */}
                <div className="pb-4">
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
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">

                {/* ── All Friends ── */}
                {subTab === 'all' && (
                    <div className="px-10 py-8">
                        {friends.accepted.length > 0 && (
                            <div className="mb-6 max-w-sm">
                                <ClSearch
                                    icon={<Search size={14} />}
                                    type="text"
                                    placeholder="Search friends"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                />
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
                            <p className="text-cl-faint text-sm text-center py-12">
                                No friends match &ldquo;{search}&rdquo;
                            </p>
                        ) : (
                            <div className="grid grid-cols-1 gap-2 max-w-3xl">
                                {filteredFriends.map((f: any, i: number) => (
                                    <div
                                        key={f.friend_table_id}
                                        style={rowEntrance(i).style}
                                        className={`flex items-center gap-4 px-5 py-3.5 bg-cl-surface border border-cl-border/40 rounded-xl hover:bg-cl-raise hover:border-cl-lume/25 transition-all group cursor-pointer ${rowEntrance(i).className}`}
                                        onClick={(e) => {
                                            if ((e.target as HTMLElement).closest('button, a, input')) return;
                                            if (openProfileCtx) openProfileCtx(f.user_id, { x: e.clientX, y: e.clientY });
                                            else onViewProfile?.(f.user_id);
                                        }}
                                    >
                                        <div className="w-10 h-10 rounded-full shrink-0 relative">
                                            <div className="w-full h-full rounded-full overflow-hidden border border-cl-lume/20">
                                                <EncryptedAvatar attachmentId={f.avatar_url} userId={f.user_id} token={token} className="w-full h-full" fallbackSize={16} />
                                            </div>
                                            {(() => {
                                                const fs = friendStatuses?.[f.user_id];
                                                const status = fs?.status ?? 'offline';
                                                // The phone glyph replaces the dot while this friend is
                                                // present on phones only (the server's on_mobile — one bit,
                                                // same audience as the dot itself, hidden by "appear
                                                // offline"). Games are a desktop signal, so on_mobile wins.
                                                const onMobile = status !== 'offline' && !!fs?.on_mobile;
                                                const game = onMobile ? null : (fs?.current_game ?? null);
                                                const showController = !!game && status !== 'offline';
                                                return showController ? (
                                                    <span className="absolute bottom-0 right-0 z-10 flex items-center justify-center">
                                                        <StatusIcon status={status} currentGame={game} size={12} />
                                                    </span>
                                                ) : (
                                                    <span className="absolute bottom-0 right-0 border-[2px] border-cl-surface rounded-full z-10 flex items-center justify-center">
                                                        <StatusIcon status={status} currentGame={null} onMobile={onMobile} size={10} />
                                                    </span>
                                                );
                                            })()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-semibold text-[14px] text-cl-text truncate m-0">
                                                {f.username}
                                                {f.discriminator !== null && f.discriminator !== undefined && (
                                                    <span
                                                        className="ml-1.5 text-[11px] font-medium text-cl-faint"
                                                        style={{ fontFamily: 'var(--cl-font-mono)' }}
                                                    >
                                                        #{padDiscriminator(f.discriminator)}
                                                    </span>
                                                )}
                                                <ProfileBadgeRow badges={f.badges} size="sm" className="ml-1.5 align-middle" />
                                            </p>
                                            {(() => {
                                                const fs = friendStatuses?.[f.user_id];
                                                if (!fs || fs.status === 'offline') return null;
                                                const line = fs.current_game
                                                    ? `Playing ${fs.current_game}`
                                                    : fs.custom_status_text
                                                        ? `${fs.custom_status_emoji ? fs.custom_status_emoji + ' ' : ''}${fs.custom_status_text}`
                                                        : null;
                                                return line
                                                    ? <p className="text-[11px] text-cl-muted truncate mt-0.5 m-0">{line}</p>
                                                    : null;
                                            })()}
                                        </div>
                                        <div data-friend-dropdown={f.user_id} className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <ClButton
                                                variant="primary"
                                                size="sm"
                                                onClick={() => handleMessageFriend(f)}
                                            >
                                                <MessageSquare size={14} />
                                                Message
                                            </ClButton>
                                            <ClButton
                                                variant="ghost"
                                                size="sm"
                                                icon
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    friendMenu.open(e, [
                                                        {
                                                            icon: <User />, label: 'Profile',
                                                            onSelect: () => {
                                                                if (openProfileCtx) openProfileCtx(f.user_id, { x: e.clientX, y: e.clientY });
                                                                else onViewProfile?.(f.user_id);
                                                            },
                                                        },
                                                        { icon: <PhoneCall />, label: 'Call', onSelect: () => onStartCall?.(f.user_id) },
                                                        { icon: <MessagesSquare />, label: 'Add to Group Chat', onSelect: () => onAddToGroup?.(f) },
                                                        { divider: true },
                                                        { icon: <UserMinus />, label: 'Remove Friend', danger: true, onSelect: () => handleRemoveFriend(f) },
                                                        { icon: <Ban />, label: 'Block', danger: true,
                                                          onSelect: () => handleBlock(f.user_id, formatUserTag(f.username, f.discriminator)) },
                                                    ], formatUserTag(f.username, f.discriminator));
                                                }}
                                            >
                                                <MoreVertical size={16} />
                                            </ClButton>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ── Blocked ── */}
                {subTab === 'blocked' && (
                    <div className="px-10 py-8 max-w-lg">
                        <div className="mb-8">
                            <h2 className="text-lg font-semibold text-cl-text mb-1 m-0" style={{ fontFamily: 'var(--cl-font-display)' }}>Blocked Users</h2>
                            <p className="text-sm text-cl-faint m-0 mt-1">You will not receive messages or calls from these users.</p>
                        </div>

                        {friends.blocked && friends.blocked.length > 0 ? (
                            <div className="flex flex-col gap-2">
                                {friends.blocked.map((f: any, i: number) => (
                                    <div key={f.friend_table_id} style={rowEntrance(i).style} className={`flex items-center gap-4 px-5 py-3.5 bg-cl-surface border border-cl-flash/10 rounded-xl ${rowEntrance(i).className}`}>
                                        <div className="relative w-10 h-10 shrink-0">
                                            <div className="w-10 h-10 rounded-full overflow-hidden">
                                                <EncryptedAvatar
                                                    attachmentId={f.avatar_url}
                                                    userId={f.user_id}
                                                    token={token}
                                                    className="w-full h-full opacity-60"
                                                    fallbackSize={18}
                                                    bypassFriendGate
                                                />
                                            </div>
                                            <div className="absolute -bottom-0.5 -right-0.5 w-4.5 h-4.5 rounded-full bg-cl-surface flex items-center justify-center">
                                                <div className="w-4 h-4 rounded-full bg-cl-flash/90 flex items-center justify-center">
                                                    <Ban size={10} className="text-cl-text" strokeWidth={2.5} />
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-semibold text-[14px] text-cl-text truncate">
                                                {formatUserTag(f.username, f.discriminator)}
                                            </p>
                                        </div>
                                        {/* shrink-0: this button sits as a direct flex child alongside
                                            the name's flex-1 min-w-0 in a narrow list — without it,
                                            flexbox can squeeze the button and wrap "Unblock" onto two
                                            uneven lines, which reads as the text not being centered.
                                            The label itself gets a small relative nudge down — the
                                            button box is centered (verified), but bold Nunito's glyph
                                            metrics read visually high inside a line-height:1 box. */}
                                        <ClButton variant="ghost" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => handleUnblock(f.user_id)}>
                                            <span style={{ position: 'relative', top: 2 }}>Unblock</span>
                                        </ClButton>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-16 text-center opacity-50">
                                <Ban size={32} className="text-cl-faint mb-4" />
                                <h3 className="text-cl-text font-semibold mb-1">No blocked users</h3>
                                <p className="text-cl-faint text-sm">When you block someone, they will appear here.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* ── Pending ── */}
                {subTab === 'pending' && (
                    <div className="px-10 py-8 max-w-lg">
                        {/* Incoming */}
                        {friends.pending_incoming.length > 0 && (
                            <div className="mb-8">
                                <Eyebrow>Incoming Requests — {friends.pending_incoming.length}</Eyebrow>
                                <div className="flex flex-col gap-2">
                                    {friends.pending_incoming.map((f: any, i: number) => (
                                        <div key={f.friend_table_id} style={rowEntrance(i).style} className={`flex items-center gap-4 px-5 py-3.5 bg-cl-surface border border-cl-lume/20 rounded-xl ${rowEntrance(i).className}`}>
                                            <div className="w-10 h-10 rounded-full shrink-0 relative overflow-hidden">
                                                {/* Not a friend yet: the friends-only gate would hide the picture the server
                                                    now serves for an incoming request (see AttachmentsService.hasRequestOrBlockRelation). */}
                                                <EncryptedAvatar attachmentId={f.avatar_url} userId={f.requester_id} token={token} className="w-full h-full" fallbackSize={18} bypassFriendGate />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="font-semibold text-[14px] text-cl-text truncate">
                                                    {formatUserTag(f.username, f.discriminator)}
                                                </p>
                                                <p className="text-[11px] text-cl-faint">Sent you a friend request</p>
                                            </div>
                                            {/* Both siblings are text pills on the same variant/size
                                                so they read as one deliberate pair — Accept was
                                                previously a labeled pill next to an icon-only circular
                                                Reject, which put them at two different heights (a
                                                40px circle vs a ~32px pill) even though each button on
                                                its own was a correct ClButton usage. */}
                                            <div className="flex items-center gap-2">
                                                <ClButton
                                                    variant="ok"
                                                    size="sm"
                                                    loading={acceptingRequestIds.has(f.friend_table_id)}
                                                    disabled={rejectingRequestIds.has(f.friend_table_id)}
                                                    onClick={() => handleAccept(f.friend_table_id)}
                                                >
                                                    <CheckCircle size={13} />
                                                    Accept
                                                </ClButton>
                                                <ClButton
                                                    variant="danger"
                                                    size="sm"
                                                    loading={rejectingRequestIds.has(f.friend_table_id)}
                                                    disabled={acceptingRequestIds.has(f.friend_table_id)}
                                                    onClick={() => handleReject(f.requester_id, f.friend_table_id)}
                                                >
                                                    <XCircle size={13} />
                                                    Reject
                                                </ClButton>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Outgoing */}
                        {friends.pending_outgoing.length > 0 && (
                            <div className="mb-8">
                                <Eyebrow>Sent Requests — {friends.pending_outgoing.length}</Eyebrow>
                                <div className="flex flex-col gap-2">
                                    {friends.pending_outgoing.map((f: any, i: number) => (
                                        <div key={f.friend_table_id} style={rowEntrance(i).style} className={`flex items-center gap-4 px-5 py-3.5 bg-cl-surface border border-cl-border/40 rounded-xl ${rowEntrance(i).className}`}>
                                            <div className="w-10 h-10 rounded-full shrink-0 relative overflow-hidden">
                                                <EncryptedAvatar attachmentId={f.avatar_url} userId={f.recipient_id} token={token} className="w-full h-full" fallbackSize={18} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="font-semibold text-[14px] text-cl-text truncate">
                                                    {formatUserTag(f.username, f.discriminator)}
                                                </p>
                                                <p className="text-[11px] text-cl-faint">Waiting for response…</p>
                                            </div>
                                            <div className="flex items-center gap-1.5 px-3 py-1 text-cl-faint text-[11px] font-semibold rounded-full border border-cl-border bg-white/[0.03]">
                                                <Clock size={11} />
                                                Pending
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {pendingCount === 0 && (
                            <div className="flex flex-col items-center justify-center py-24 text-center">
                                <div className="w-14 h-14 rounded-full bg-cl-ok/[0.08] border border-cl-ok/15 flex items-center justify-center mb-4">
                                    <CheckCircle size={24} className="text-cl-ok/70" />
                                </div>
                                <h3 className="text-cl-text font-semibold mb-1">All caught up</h3>
                                <p className="text-cl-faint text-sm">No pending requests right now.</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Confirm dialog via kit */}
            <ClConfirm
                open={!!confirmDialog}
                onClose={() => setConfirmDialog(null)}
                onConfirm={confirmDialog?.onConfirm ?? (() => {})}
                title={confirmDialog?.title ?? ''}
                message={confirmDialog?.message}
                confirmLabel={confirmDialog?.confirmLabel ?? 'Confirm'}
                danger={confirmDialog?.danger}
            />

            {showAddFriendModal && (
                <AddFriendModal onClose={() => { setShowAddFriendModal(false); fetchFriends(true); }} />
            )}

            {friendMenu.menu}
        </div>
    );
};

export default FriendsPane;
