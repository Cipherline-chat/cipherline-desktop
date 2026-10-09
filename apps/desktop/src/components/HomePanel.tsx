import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { KeysSignal } from './mascot/Keys';
import { HomeKeys, type PlayVerdict } from './mascot/HomeKeys';
import { homeGameVerdict } from '../utils/keysBurst';
import { FirewallOverlay } from './FirewallOverlay';
import { canUseWorker } from './loadingWorkerHost';
import { HomeAmbient } from './HomeAmbient';
import { useAmbientMotion } from '../hooks/useAmbientMotion';
import { EncryptedAvatar } from './EncryptedAvatar';
import { HomeStatusDot } from './HomeStatusDot';
import { resolvePresenceWithMobile } from '../utils/activeNow';
import { preloadAvatars } from '../hooks/useEncryptedAvatar';
import type { ChannelInfo, ServerInfo, HuddleCallInfo } from '../hooks/useServers';
import type { FriendStatusEntry } from '../hooks/useUserStatus';
import { ServerIcon } from './server/ServerIcon';
import secureLocalStore from '../utils/secureLocalStore';
import { pinKey, type PinnedHomeItem } from '../utils/homePins';
import { pickRecent } from '../utils/homeRecents';
import {
    isLocalCallRow, resolvePinnedChannelAction,
    type HomeCallRow, type LocalCallSession,
} from '../utils/homeActiveCalls';
import { computeBackupNudge } from '../utils/backupNudge';
import { summarizeCallRoster, labelVoiceUsers } from '../utils/serverCallPresence';
import { CallMediaSummary } from './CallMediaSummary';
import { huddleCallMediaKey, voiceChannelMediaKey } from '../utils/callMediaPresence';
import { getLastBackupMs, BACKUP_STATE_EVENT } from '../services/driveBackup';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { readBackupBlocked } from '../hooks/useBackupAutoSchedule';
import { ClInput } from './cl';
import { useEscape } from '../hooks/useEscape';
import { shouldSpeak, pokeReaction, SLEEPY_AT } from '../utils/keysBrain';
import { pokeLine, sleepyLine, type KeysContext } from '../utils/keysObservations';
import { playSound } from '../utils/notificationSounds';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { APP_VERSION } from '../constants';
import '../styles/home-deck.css';

// ── Types ──────────────────────────────────────────────────────────────────────

export type { PinnedHomeItem } from '../utils/homePins';
// Kept exported from here — it was part of this module's surface before the
// decision logic moved to utils/backupNudge.ts.
export type { BackupNudge } from '../utils/backupNudge';

interface HomePanelProps {
    userId: string;
    displayName: string;
    token: string | null;
    conversations: any[];
    unreadCounts: Record<string, number>;
    mentionCounts: Record<string, number>;
    /** Persisted per-conversation last-activity clock (ms epoch) — survives restarts. */
    lastActivityAt?: Record<string, number>;
    presence: Record<string, boolean>;
    friends?: { accepted: any[] } | null;
    servers: ServerInfo[];
    serverChannels: Record<string, ChannelInfo[]>;
    voiceParticipants: Record<string, string[]>;
    huddleCalls: Record<string, HuddleCallInfo[]>;
    /** server_id → (user_id → avatar attachment id). Same map ServerContextPanel/
     *  SidebarConference use for in-call avatars — populated per-server as its
     *  panel mounts, so it's best-effort here: a server you haven't opened
     *  this session won't have an entry yet and its "Happening now" participants
     *  fall back to the color-avatar placeholder until you do. */
    serverMemberAvatarMaps?: Record<string, Record<string, string | null>>;
    /** user_id → display name, seeded server-side (see Dashboard) so it
     *  covers people in servers this session never opened. Used only for the
     *  Friends section's "who's with them" call tooltip — falls back to
     *  'Someone' per-name, same as the server rail's own hover roster. */
    voiceUserNames?: Record<string, string>;
    /** user_id → avatar attachment id, seeded server-side and kept live by the
     *  presence JOIN events (see Dashboard). The cross-server fallback for the
     *  deck's participant faces: `serverMemberAvatarMaps` only covers a server
     *  whose panel has mounted, which a "Happening now" call in a server you
     *  have not opened this session by definition is not — so without this the
     *  deck rendered the colour placeholder for those people every time. */
    voiceUserAvatarIds?: Record<string, string>;
    /** Per-server unread/mention rollup — the SAME object the server rail
     *  badges render from (Dashboard's serverRailBadges.byServer, computed by
     *  utils/unreadBadges). Passed in rather than recomputed so the deck and
     *  the rail can never disagree about what a server owes you. */
    serverBadges?: Record<string, { unread: number; mentions: number }>;
    /** server_id → ms epoch of the newest message in any of its channels. The
     *  server-side counterpart to lastActivityAt; see Dashboard. */
    serverLastActivityAt?: Record<string, number>;
    pinnedItems: PinnedHomeItem[];
    /** Live friend presence detail (status / custom status / game) keyed by
     *  user id — already flowing over the socket, see useUserStatus. */
    friendStatuses?: Record<string, FriendStatusEntry>;
    /** What THIS client is connected to (Dashboard's activeVoiceChannelId /
     *  activeHuddleCallId). `voiceParticipants` / `huddleCalls` only describe
     *  server-side membership, so without this the deck cannot tell the call
     *  you're sitting in apart from the ones you could join — see
     *  utils/homeActiveCalls. */
    localCallSession?: LocalCallSession | null;
    onSelectConversation: (conv: any) => void;
    onJoinVoiceChannel: (channel: ChannelInfo) => void;
    onJoinHuddleCall: (callId: string, displayName: string) => void;
    onSelectServer?: (serverId: string) => void;
    /** Navigate straight to a (text) channel — server view + this exact
     *  channel selected. Used by a pinned channel card: unlike
     *  onJoinVoiceChannel, this never attempts to join anything, so it's
     *  correct for the only channel kind AddPinCard actually lets a user pin.
     *  See utils/homeActiveCalls' resolvePinnedChannelAction. */
    onOpenChannel?: (channel: ChannelInfo) => void;
    onPin: (item: PinnedHomeItem) => void;
    onUnpin: (item: PinnedHomeItem) => void;
    onOpenStorage: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Keys quips live in utils/eggPools.ts (KEYS_QUIPS) so the personality-
// doctrine tests cover the pool.

function relativeTime(dateStr: string | undefined | null): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 0) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(diff / 3_600_000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(diff / 86_400_000);
    return `${days}d ago`;
}

/**
 * Whether this account's backups are configured at all. Read alongside the
 * timestamp so a configured-but-not-yet-run setup never gets told it has "no
 * backup yet", which is the wrong thing to say and the wrong thing to do
 * about it. Mirrors useBackupAutoSchedule's own config shape; kept
 * deliberately tolerant since this only drives copy.
 */
function backupIsConfigured(userId: string): boolean {
    try {
        const raw = secureLocalStore.getItem(`cipherline_backup_cfg_${userId}`);
        if (!raw) return false;
        const c = JSON.parse(raw);
        const hasLocal = c?.localEnabled === true && typeof c?.localDir === 'string' && c.localDir;
        const hasDrive = c?.driveEnabled === true;
        return !!(hasLocal || hasDrive);
    } catch { return false; }
}

/** Deterministic hue from a user/entity id string for placeholder avatars. */
function idToHue(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
    return Math.abs(h) % 360;
}

// ── Status vocabulary ──────────────────────────────────────────────────────────
// Mirrors useUserStatus / StatusPicker so the deck can't drift from the rest of
// the app. The dot itself (colour + the phone icon) is HomeStatusDot.
const STATUS_LABEL: Record<string, string> = {
    online: 'Online',
    away: 'Idle',
    dnd: 'Do Not Disturb',
    offline: 'Offline',
};

// ── Pin card ───────────────────────────────────────────────────────────────────

type ResolvedPin =
    | { kind: 'conversation'; item: PinnedHomeItem; conv: any }
    | { kind: 'channel'; item: PinnedHomeItem; channel: ChannelInfo; server: ServerInfo }
    | { kind: 'server'; item: PinnedHomeItem; server: ServerInfo };

/** One "Pick back up" card: a conversation or a server, both carrying the two
 *  values the section ranks on so the sort never has to branch on kind. */
type RecentItem = {
    key: string;
    /** 2 = mentions you, 1 = unread, 0 = quiet. */
    attention: number;
    /** ms epoch of the newest known activity; 0 when nothing is cached. */
    activity: number;
    unread: number;
    mention: number;
} & (
    | { kind: 'conversation'; conv: any }
    | { kind: 'server'; server: ServerInfo }
);

const PinCard: React.FC<{
    entry: ResolvedPin;
    /** Resolved by the parent (see convAvatarId) so a pinned DM uses the same
     *  freshest-source-wins lookup every other row on the deck does. */
    avatarId?: string | null;
    token: string | null;
    unread: number;
    mention: number;
    /** True only for a `channel`-kind pin whose channel is the voice channel
     *  this client is ALREADY connected to (resolvePinnedChannelAction ===
     *  'navigate'). Clicking still does something honest (onOpen navigates
     *  instead of re-joining) — this just makes the card say so, rather than
     *  silently changing what "Join"-shaped click behaviour means. */
    inCall?: boolean;
    onOpen: () => void;
    onUnpin: () => void;
}> = ({ entry, avatarId, token, unread, mention, inCall, onOpen, onUnpin }) => {
    const name = entry.kind === 'conversation' ? (entry.conv.title || 'Chat')
        : entry.kind === 'server' ? entry.server.name
        : entry.channel.name;
    const sub = entry.kind === 'conversation'
        ? (entry.conv.type === 'group' ? 'Group' : 'Direct message')
        : entry.kind === 'server' ? 'Server'
        : inCall ? `In call · ${entry.server.name}`
        : entry.server.name;

    return (
        <div className="hd-card" onClick={onOpen} role="button" tabIndex={0}
             style={{ ['--hd-hue' as string]: String(idToHue(entry.kind === 'conversation' ? entry.conv.conversation_id : entry.server.server_id)) }}
             onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
            {entry.kind === 'conversation' ? (
                <span className="hd-av">
                    <EncryptedAvatar
                        attachmentId={avatarId ?? entry.conv.avatar_url}
                        userId={entry.conv.other_user_id ?? null}
                        token={token}
                        className="w-full h-full"
                        fallbackSize={12}
                        isGroup={entry.conv.type === 'group'}
                        disableClickProfile
                    />
                </span>
            ) : (
                // Server AND channel pins show the server's icon: a pinned
                // channel's card already names the channel, and the icon is
                // what tells you which server it lives in.
                <ServerIcon
                    serverId={entry.server.server_id}
                    name={entry.server.name}
                    attachmentId={entry.server.icon_attachment}
                    keyB64={entry.server.icon_key_b64}
                    nonceB64={entry.server.icon_nonce_b64}
                    token={token}
                    className="hd-chip"
                />
            )}

            <span className="hd-cardbody">
                <span className="hd-cardname">{name}</span>
                <span className="hd-cardsub">{sub}</span>
            </span>

            {(mention > 0 || unread > 0) && (
                <span className={`hd-pill${mention > 0 ? ' hd-pill--named' : ''}`}>
                    {mention > 0 ? mention : unread}
                </span>
            )}

            <button
                className="hd-unpin"
                onClick={e => { e.stopPropagation(); onUnpin(); }}
                aria-label={`Unpin ${name}`}
                title="Unpin"
            >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
        </div>
    );
};


// ── Add-pin card + search popover ──────────────────────────────────────────────

const AddPinCard: React.FC<{
    conversations: any[];
    serverChannels: Record<string, ChannelInfo[]>;
    servers: ServerInfo[];
    pinnedItems: PinnedHomeItem[];
    token: string | null;
    onPin: (item: PinnedHomeItem) => void;
}> = ({ conversations, serverChannels, servers, pinnedItems, token, onPin }) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const wrapRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50);
    }, [open]);

    useEscape(() => setOpen(false), open);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const pinnedConvIds = new Set(pinnedItems.filter(p => p.type === 'conversation').map(p => (p as any).id));
    const pinnedChannelIds = new Set(pinnedItems.filter(p => p.type === 'channel').map(p => (p as any).channelId));
    const pinnedServerIds = new Set(pinnedItems.filter(p => p.type === 'server').map(p => (p as any).serverId));

    const q = search.toLowerCase();
    const matchingConvs = conversations.filter(c =>
        !pinnedConvIds.has(c.conversation_id) &&
        (c.title || '').toLowerCase().includes(q)
    ).slice(0, 5);

    const allChannels = Object.values(serverChannels).flat().filter(ch => ch.kind === 'text');
    const matchingChannels = allChannels.filter(ch =>
        !pinnedChannelIds.has(ch.channel_id) &&
        ch.name.toLowerCase().includes(q)
    ).slice(0, 5);

    const matchingServers = servers.filter(sv =>
        !pinnedServerIds.has(sv.server_id) &&
        sv.name.toLowerCase().includes(q)
    ).slice(0, 5);

    const hasResults = matchingConvs.length > 0 || matchingChannels.length > 0 || matchingServers.length > 0;

    return (
        <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
                className="hd-addcard"
                onClick={() => setOpen(v => !v)}
                style={{ width: '100%', height: '100%', minHeight: 48 }}
                aria-label="Pin something to home"
            >
                <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
                <span>Pin something</span>
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.97 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className="hd-pinpop"
                        style={{
                            position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 200,
                            width: 240, background: 'var(--cl-raise)',
                            border: '1.5px solid var(--cl-border)',
                            borderRadius: 'var(--cl-r-md)',
                            boxShadow: 'var(--cl-shadow-menu)', overflow: 'hidden',
                        }}
                    >
                        <div style={{ padding: '10px 10px 6px' }}>
                            {/* ClInput (the kit's .inp) instead of a bare <input> — it was
                                only using cl-* tokens for color, but outline:'none' with no
                                focus replacement left keyboard users with zero focus
                                indicator. .inp:focus already has the correct lume glow; the
                                style overrides below just fit it into this tight 240px
                                popover (kit default padding/radius is sized for full forms). */}
                            <ClInput
                                ref={inputRef}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder="Search servers, chats & channels…"
                                style={{
                                    width: '100%', borderRadius: 'var(--cl-r-sm)', padding: '8px 10px',
                                    fontSize: 13, boxSizing: 'border-box',
                                }}
                            />
                        </div>

                        <div style={{ maxHeight: 240, overflowY: 'auto', padding: '0 6px 8px' }}>
                            {!hasResults && (
                                <div style={{ padding: '10px 6px', color: 'var(--cl-faint)', fontSize: 12.5, textAlign: 'center' }}>
                                    {search ? 'No matches' : 'Start typing to search'}
                                </div>
                            )}
                            {matchingServers.length > 0 && (
                                <>
                                    <div style={{ padding: '6px 6px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cl-faint)' }}>Servers</div>
                                    {matchingServers.map(sv => (
                                        <button
                                            key={sv.server_id}
                                            onClick={() => { onPin({ type: 'server', serverId: sv.server_id }); setOpen(false); setSearch(''); }}
                                            style={{
                                                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                                                padding: '7px 8px', borderRadius: 'var(--cl-r-sm)',
                                                border: 'none', background: 'none', cursor: 'pointer',
                                                color: 'var(--cl-text)', fontSize: 13, textAlign: 'left',
                                                fontFamily: 'var(--cl-font-body)',
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--cl-surface)')}
                                            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                        >
                                            <span style={{ width: 22, height: 22, flexShrink: 0 }}>
                                                <ServerIcon
                                                    serverId={sv.server_id}
                                                    name={sv.name}
                                                    attachmentId={sv.icon_attachment}
                                                    keyB64={sv.icon_key_b64}
                                                    nonceB64={sv.icon_nonce_b64}
                                                    token={token}
                                                    className="w-full h-full rounded-md text-[9px]"
                                                />
                                            </span>
                                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {sv.name}
                                            </span>
                                        </button>
                                    ))}
                                </>
                            )}
                            {matchingConvs.length > 0 && (
                                <>
                                    <div style={{ padding: '6px 6px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cl-faint)' }}>Chats</div>
                                    {matchingConvs.map(conv => (
                                        <button
                                            key={conv.conversation_id}
                                            onClick={() => { onPin({ type: 'conversation', id: conv.conversation_id }); setOpen(false); setSearch(''); }}
                                            style={{
                                                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                                                padding: '7px 8px', borderRadius: 'var(--cl-r-sm)',
                                                border: 'none', background: 'none', cursor: 'pointer',
                                                textAlign: 'left',
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--cl-surface)')}
                                            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                        >
                                            <div style={{ width: 28, height: 28, borderRadius: 99, overflow: 'hidden', flexShrink: 0 }}>
                                                <EncryptedAvatar
                                                    attachmentId={conv.avatar_url ?? null}
                                                    userId={conv.other_user_id ?? conv.conversation_id}
                                                    isGroup={conv.type === 'group'}
                                                    token={token}
                                                    className="w-full h-full"
                                                    fallbackSize={12}
                                                    disableClickProfile
                                                />
                                            </div>
                                            <span style={{ fontSize: 13, color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {conv.title || 'Chat'}
                                            </span>
                                        </button>
                                    ))}
                                </>
                            )}
                            {matchingChannels.length > 0 && (
                                <>
                                    <div style={{ padding: '8px 6px 2px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cl-faint)' }}>Channels</div>
                                    {matchingChannels.map(ch => {
                                        const srv = servers.find(s => s.server_id === ch.server_id);
                                        return (
                                            <button
                                                key={ch.channel_id}
                                                onClick={() => { onPin({ type: 'channel', channelId: ch.channel_id, serverId: ch.server_id }); setOpen(false); setSearch(''); }}
                                                style={{
                                                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                                                    padding: '7px 8px', borderRadius: 'var(--cl-r-sm)',
                                                    border: 'none', background: 'none', cursor: 'pointer',
                                                    textAlign: 'left',
                                                }}
                                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--cl-surface)')}
                                                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                                            >
                                                <div style={{
                                                    width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                                                    background: `hsl(${idToHue(ch.channel_id)}, 40%, 28%)`,
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: 12, color: 'var(--cl-text)',
                                                }}>
                                                    {ch.icon_emoji || '#'}
                                                </div>
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ fontSize: 13, color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        #{ch.name}
                                                    </div>
                                                    {srv && <div style={{ fontSize: 10.5, color: 'var(--cl-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{srv.name}</div>}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ── Main component ─────────────────────────────────────────────────────────────

export const HomePanel: React.FC<HomePanelProps> = ({
    userId, displayName, token,
    conversations, unreadCounts, mentionCounts, lastActivityAt, presence,
    friends,
    servers, serverChannels, voiceParticipants, huddleCalls, serverMemberAvatarMaps, voiceUserNames, voiceUserAvatarIds,
    serverBadges, serverLastActivityAt, pinnedItems, friendStatuses, localCallSession,
    onSelectConversation, onJoinVoiceChannel, onJoinHuddleCall, onSelectServer, onOpenChannel,
    onPin, onUnpin, onOpenStorage,
}) => {
    // Ambient motion (rising motes + decorative micro-loops) — device pref.
    const [ambientOn] = useAmbientMotion();

    // Keys mascot state — the spoken line + a rotation counter (rule 3).
    const [keysSpeech, setKeysSpeech] = useState<string | null>(null);
    const quipSeqRef = useRef(0);
    const quipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const hasMentions = useMemo(() => Object.values(mentionCounts).some(n => n > 0), [mentionCounts]);
    const hasUnreads = useMemo(() => Object.values(unreadCounts).some(n => n > 0), [unreadCounts]);
    const keysSignal: KeysSignal = hasMentions ? 'alert' : hasUnreads ? 'pulse' : 'idle';

    useEffect(() => () => { if (quipTimerRef.current) clearTimeout(quipTimerRef.current); }, []);

    // The easter egg: spam Keys and he opens the loading screen's game over
    // this pane (HomeKeys + utils/keysBurst decide when; FirewallOverlay is
    // the game). Never during a call: it would sit over the call's Home row
    // and take Space; and a call starting mid-game closes it.
    const [gameOpen, setGameOpen] = useState(false);
    const inCall = !!localCallSession;
    // A call starting closes it (state adjusted during render, so the
    // overlay never paints a frame over a live call).
    if (inCall && gameOpen) setGameOpen(false);
    // Not gated on reduced motion: see homeGameVerdict.
    const canPlay = useCallback(
        (): PlayVerdict => homeGameVerdict(inCall, () => canUseWorker(document.createElement('canvas'))),
        [inCall],
    );
    const openGame = useCallback(() => { if (!inCall) setGameOpen(true); }, [inCall]);
    const closeGame = useCallback(() => setGameOpen(false), []);

    const { prefs: notifPrefs } = useNotificationPrefs();
    const notifPrefsRef = useRef(notifPrefs);
    useEffect(() => { notifPrefsRef.current = notifPrefs; }, [notifPrefs]);

    // What Keys can SEE — keysCtxRef, assigned AFTER the memos it reads (see
    // below friendActivity; reading them here would hit the temporal dead
    // zone). The click handler only dereferences at click time.
    const keysCtxRef = useRef<KeysContext | null>(null);

    const handleKeysClick = useCallback((count: number) => {
        // A soft blub accompanies every VISIBLE reaction (rule 12: the sound
        // rides the payoff, it never is one) — silent once he's asleep.
        if (pokeReaction(count) !== 'none') playSound('mascot', notifPrefsRef.current);
        // He doesn't narrate every poke — the animation is the payoff. Words
        // punctuate the ladder (shouldSpeak in keysBrain), and the FIRST line
        // of a streak is context-aware: he comments on what's actually on
        // screen (mentions, a call happening, 2am, no backup, the unread
        // pile...) before falling back to generic quips.
        if (!shouldSpeak(count)) return;
        const seq = quipSeqRef.current++;
        const line = count === SLEEPY_AT
            ? sleepyLine(seq)
            : pokeLine(keysCtxRef.current!, count, seq);
        if (quipTimerRef.current) clearTimeout(quipTimerRef.current);
        setKeysSpeech(line);
        quipTimerRef.current = setTimeout(() => setKeysSpeech(null), 3600);
    }, []);

    // Greeting
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const firstName = displayName.split(' ')[0] || displayName;

    // ── Avatar resolution ─────────────────────────────────────────────────────
    // `conversations[].avatar_url` is the primary source, but it is only ever
    // as fresh as the last GET /conversations: the API nulls a DM partner's
    // avatar unless the friendship is accepted AT QUERY TIME, and the array is
    // restored verbatim from the encrypted local cache on boot. So a peer who
    // set or changed a picture while this client was closed — or who became a
    // friend after the row was cached — reads as "no avatar" until something
    // forces a refetch, and the deck paints a placeholder it has no business
    // painting. The friends payload is refetched on mount and again on every
    // friend event, making it the fresher of the two; fall back to it.
    const friendAvatarById = useMemo(() => {
        const map: Record<string, string> = {};
        for (const f of friends?.accepted ?? []) {
            if (f?.user_id && f.avatar_url) map[f.user_id] = f.avatar_url;
        }
        return map;
    }, [friends]);

    /** Attachment id to paint for a conversation row — freshest source first. */
    const convAvatarId = useCallback((conv: any): string | null => {
        if (conv?.avatar_url) return conv.avatar_url;
        if (conv?.other_user_id) return friendAvatarById[conv.other_user_id] ?? null;
        return null;
    }, [friendAvatarById]);

    // Resolved pinned items
    const resolvedPins = useMemo(() => {
        const allChannels = Object.values(serverChannels).flat();
        return pinnedItems.map(item => {
            if (item.type === 'conversation') {
                const conv = conversations.find(c => c.conversation_id === item.id);
                return conv ? { kind: 'conversation' as const, item, conv } : null;
            }
            if (item.type === 'server') {
                const server = servers.find(s => s.server_id === item.serverId);
                return server ? { kind: 'server' as const, item, server } : null;
            }
            const channel = allChannels.find(c => c.channel_id === item.channelId);
            const server = servers.find(s => s.server_id === item.serverId);
            return channel && server ? { kind: 'channel' as const, item, channel, server } : null;
        }).filter((x): x is NonNullable<typeof x> => x !== null);
    }, [pinnedItems, conversations, serverChannels, servers]);

    // Active calls (voice channels + huddle calls with participants).
    //
    // Every row carries a `row: HomeCallRow` identity so the "am I already in
    // this one?" question is answered by one tested matcher rather than an
    // ad-hoc id comparison at the render site — the two id spaces (voice
    // CHANNEL id vs. huddle CALL id) are easy to mix up, and mixing them up
    // silently mislabels sibling calls. See utils/homeActiveCalls.
    const activeCalls = useMemo(() => {
        const allChannels = Object.values(serverChannels).flat();

        const voiceCalls = Object.entries(voiceParticipants)
            .filter(([, uids]) => uids.length > 0)
            .map(([channelId, participantIds]) => {
                const channel = allChannels.find(c => c.channel_id === channelId);
                const server = servers.find(s => s.server_id === channel?.server_id);
                if (!channel || !server) return null;
                return {
                    key: `voice-${channelId}`, channel, server, participantIds,
                    row: { kind: 'voice', channelId } as HomeCallRow,
                    onJoin: () => onJoinVoiceChannel(channel),
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);

        const huddles = Object.entries(huddleCalls)
            .flatMap(([huddleId, calls]) =>
                calls
                    .filter(c => c.participants.length > 0)
                    .map(c => {
                        const channel = allChannels.find(ch => ch.channel_id === huddleId);
                        const server = servers.find(s => s.server_id === channel?.server_id);
                        if (!channel || !server) return null;
                        return {
                            key: `huddle-${c.call_id}`, channel, server, participantIds: c.participants,
                            row: { kind: 'huddle', callId: c.call_id, channelId: huddleId } as HomeCallRow,
                            onJoin: () => onJoinHuddleCall(c.call_id, c.name || channel.name),
                        };
                    })
                    .filter((x): x is NonNullable<typeof x> => x !== null)
            );

        return [...voiceCalls, ...huddles];
    }, [voiceParticipants, huddleCalls, serverChannels, servers, onJoinVoiceChannel, onJoinHuddleCall]);

    // ── Pick back up ──────────────────────────────────────────────────────────
    // Conversations AND servers, ranked together: what needs you first, then
    // what moved last. Mentions outrank unreads outrank everything; within a
    // tier the persisted last-activity clock orders (it survives restarts; the
    // server-side updated_at is only a fallback for never-seen convs).
    //
    // Servers used to be missing from this section entirely — the deck's only
    // way back into one was the rail or a pin. They rank on the same two axes:
    // their unread/mention rollup is the rail's own badge object, and their
    // clock is the newest activity across their channels (serverLastActivityAt,
    // derived in Dashboard from the same cached channel messages).
    const recentItems = useMemo<RecentItem[]>(() => {
        const convItems: RecentItem[] = conversations.map(c => {
            const mention = mentionCounts[c.conversation_id] || 0;
            const unread = unreadCounts[c.conversation_id] || 0;
            return {
                key: `conv-${c.conversation_id}`, kind: 'conversation', conv: c, unread, mention,
                attention: (mention > 0 ? 2 : 0) + (unread > 0 ? 1 : 0),
                activity: lastActivityAt?.[c.conversation_id]
                    ?? new Date(c.updated_at || c.created_at || 0).getTime(),
            };
        });

        const serverItems: RecentItem[] = servers.map(srv => {
            const mention = serverBadges?.[srv.server_id]?.mentions ?? 0;
            const unread = serverBadges?.[srv.server_id]?.unread ?? 0;
            return {
                key: `srv-${srv.server_id}`, kind: 'server', server: srv, unread, mention,
                attention: (mention > 0 ? 2 : 0) + (unread > 0 ? 1 : 0),
                activity: serverLastActivityAt?.[srv.server_id] ?? 0,
            };
        });

        // Reserved-slot merge — see utils/homeRecents for why a straight top-N
        // of the union quietly drops every server.
        return pickRecent(convItems, serverItems);
    }, [conversations, servers, serverBadges, serverLastActivityAt, unreadCounts, mentionCounts, lastActivityAt]);

    // ── What you missed ───────────────────────────────────────────────────────
    // Only conversations that actually need you, mentions first. This is the
    // one section that should empty out as you deal with it.
    const missedConvs = useMemo(() => {
        return conversations
            .filter(c => (unreadCounts[c.conversation_id] || 0) > 0 || (mentionCounts[c.conversation_id] || 0) > 0)
            .sort((a, b) => {
                const m = (mentionCounts[b.conversation_id] || 0 ? 1 : 0) - (mentionCounts[a.conversation_id] || 0 ? 1 : 0);
                if (m !== 0) return m;
                const at = lastActivityAt?.[a.conversation_id] ?? new Date(a.updated_at || 0).getTime();
                const bt = lastActivityAt?.[b.conversation_id] ?? new Date(b.updated_at || 0).getTime();
                return bt - at;
            })
            .slice(0, 6);
    }, [conversations, unreadCounts, mentionCounts, lastActivityAt]);

    const totalMissed = useMemo(
        () => conversations.reduce((n, c) => n + (unreadCounts[c.conversation_id] || 0), 0),
        [conversations, unreadCounts],
    );

    // ── Friend activity ───────────────────────────────────────────────────────
    // Ordered by how much of an invitation the signal is: people in a call
    // first, then playing something, then anyone else who's around. Offline
    // friends collapse to a count rather than a long grey list.
    const inCallUserIds = useMemo(
        () => new Set(activeCalls.flatMap(c => c.participantIds)),
        [activeCalls],
    );

    /** user_id → the specific call (voice channel or huddle) they're in right
     *  now. Lets the Friends list show WHO a friend is on a call with instead
     *  of a bare "in call" label — that gap ("I don't know who they are")
     *  is exactly what live testing reported. A user can only be in one call
     *  at a time, so first-match is unambiguous; built from `activeCalls`
     *  (already the per-call-scoped grouping, unlike the per-SERVER grouping
     *  utils/serverCallPresence's deriveServerCallPresence produces, which
     *  would merge sibling calls in the same server together and misreport
     *  who a friend is actually with). */
    const callByUserId = useMemo(() => {
        const out = new Map<string, (typeof activeCalls)[number]>();
        for (const call of activeCalls) {
            for (const uid of call.participantIds) {
                if (!out.has(uid)) out.set(uid, call);
            }
        }
        return out;
    }, [activeCalls]);

    // Seabed footer: how fresh the newest backup is, in words.
    const lastBackupLabel = useMemo(() => {
        const ms = getLastBackupMs(userId);
        if (!ms) return 'no backup yet';
        const mins = Math.floor((Date.now() - ms) / 60_000);
        if (mins < 60) return `backed up ${Math.max(1, mins)}m ago`;
        if (mins < 60 * 24) return `backed up ${Math.floor(mins / 60)}h ago`;
        return `backed up ${Math.floor(mins / 1440)}d ago`;
    }, [userId]);

    const friendActivity = useMemo(() => {
        const all = friends?.accepted ?? [];
        const rank = (uid: string) => {
            if (inCallUserIds.has(uid)) return 0;
            if (friendStatuses?.[uid]?.current_game) return 1;
            return 2;
        };
        const online = all
            .filter(f => presence[f.user_id] === true || (friendStatuses?.[f.user_id]?.status ?? 'offline') !== 'offline')
            .sort((a, b) => rank(a.user_id) - rank(b.user_id));
        return { online, offlineCount: Math.max(0, all.length - online.length), total: all.length };
    }, [friends, presence, friendStatuses, inCallUserIds]);

    // The snapshot of local UI state Keys observes before speaking
    // (keysObservations.ts): counts, the clock, presence — never content
    // (doctrine rule 8), and none of it leaves this component.
    keysCtxRef.current = {
        hour: new Date().getHours(),
        dayOfWeek: new Date().getDay(),
        month: new Date().getMonth(),
        mentions: Object.values(mentionCounts).reduce((a, b) => a + b, 0),
        unreads: Object.values(unreadCounts).reduce((a, b) => a + b, 0),
        friendsOnline: friendActivity.online.length,
        friendsTotal: friendActivity.total,
        callParticipants: activeCalls.reduce((a, c) => a + c.participantIds.length, 0),
        backupConfigured: backupIsConfigured(userId),
    };

    // Warm the avatar cache for everything the deck is about to paint. Home is
    // the first screen after boot, so without this every row races its own cold
    // two-request fetch (key + download) and the deck spends its opening
    // seconds as a wall of placeholders. Server icons are deliberately excluded
    // — their keys ride inline on the server row (see ServerIcon), so they never
    // touch this key-fetch path.
    //
    // This is the FOREGROUND lane: these rows are on screen right now. It is
    // bounded by what the deck renders — at most 6 "missed" rows and the
    // "pick back up" shortlist.
    //
    // `friends.accepted` used to be spread in here too, uncapped. That is a
    // request storm hiding in a warm: an account with 150 friends is 300 REST
    // calls, and the API's `default` bucket is 300/60s in a FIXED window with a
    // 60 s block — so a well-connected user could 429 themselves off the entire
    // API at boot, for a minute, warming avatars they may never look at.
    // Friends now go through useAvatarWarming, which caps them, orders them
    // online-first and paces the cold ones.
    useEffect(() => {
        if (!token) return;
        const ids = [
            ...missedConvs.map(convAvatarId),
            ...recentItems.map(item => item.kind === 'conversation' ? convAvatarId(item.conv) : null),
        ].filter((id): id is string => !!id);
        if (ids.length) void preloadAvatars(ids, token);
    }, [token, missedConvs, recentItems, convAvatarId]);

    // ── Backup nudge ──────────────────────────────────────────────────────────
    // Only surfaces when there's something to do about it. Muting is written on
    // the click itself (never from an effect) so it can't clobber on mount —
    // see the home-persist comment in Dashboard for what that cost us before.
    const muteKey = `cipherline_home_backup_muted_${userId}`;
    const [backupMuted, setBackupMuted] = useState<boolean>(() => {
        try { return secureLocalStore.getItem(muteKey) === '1'; } catch { return false; }
    });
    const muteBackupNudge = useCallback(() => {
        setBackupMuted(true);
        try { secureLocalStore.setItem(muteKey, '1'); } catch { /* non-fatal */ }
    }, [muteKey]);

    // The nudge is read from secureLocalStore on render, and nothing about a
    // backup finishing (or being set up in Settings) re-renders Home — so the
    // "You have no backup yet" tile used to stay up after the user did exactly
    // what it asked. Re-render whenever backup state changes.
    const [, setBackupStateTick] = useState(0);
    useEffect(() => {
        const bump = () => setBackupStateTick(t => t + 1);
        window.addEventListener(BACKUP_STATE_EVENT, bump);
        window.addEventListener(BACKUP_RESTORED_EVENT, bump);
        return () => {
            window.removeEventListener(BACKUP_STATE_EVENT, bump);
            window.removeEventListener(BACKUP_RESTORED_EVENT, bump);
        };
    }, []);

    const backupNudge = backupMuted
        ? null
        : computeBackupNudge(getLastBackupMs(userId), {
            configured: backupIsConfigured(userId),
            blocked: readBackupBlocked(userId),
        });

    const alertCount = (backupNudge ? 1 : 0) + (activeCalls.length > 0 ? 1 : 0);

    return (
        <div className="hd-frame">
        <div className="hd-host custom-scrollbar" data-ambient={ambientOn ? 'on' : 'off'}>
            <HomeAmbient enabled={ambientOn} />
            <div className="hd-inner">

                {/* ── Greeting + mascot ─────────────────────────────────── */}
                <div className="hd-greet">
                    <div>
                        <motion.span
                            className="hd-eyebrow"
                            data-ob-anchor="home-eyebrow"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.4 }}
                        >
                            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                        </motion.span>
                        <motion.h1
                            data-ob-anchor="home-greeting"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.4, delay: 0.06, ease: 'easeOut' }}
                        >
                            {greeting}{firstName ? `, ${firstName}` : ''}.
                        </motion.h1>
                        <motion.p
                            data-ob-anchor="home-subline"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.4, delay: 0.14 }}
                        >
                            {activeCalls.length > 0
                                ? `${activeCalls.length} active call${activeCalls.length > 1 ? 's' : ''} right now`
                                : hasMentions ? 'You were mentioned while you were gone.'
                                : hasUnreads ? 'Some threads moved while you were gone.'
                                : 'Quiet since you left.'}
                        </motion.p>
                    </div>

                    {/* Keys — the articulated mascot (components/mascot/Keys.tsx),
                        in his Home frame (mascot/HomeKeys.tsx: the swim, the
                        glances, looking at the pointer, and the spam-click
                        egg). He owns his moods (pokes → happy → sleepy →
                        asleep, hover wakes), the wave-on-mount hello and
                        blink; this host owns WHICH line he says (the
                        KEYS_QUIPS pool), the app-state signal, and the game. */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.5, delay: 0.18, ease: [0.34, 1.56, 0.64, 1] }}
                        className="hd-mascotbtn hd-mascotslot"
                        data-ob-anchor="home-keys"
                    >
                        <HomeKeys
                            key={userId}
                            userId={userId}
                            lively={ambientOn}
                            signal={keysSignal}
                            speech={keysSpeech}
                            onPoke={handleKeysClick}
                            canPlay={canPlay}
                            onPlay={openGame}
                        />
                    </motion.div>
                </div>

                {/* ── Deck ──────────────────────────────────────────────── */}
                <div className="hd-deck" data-alerts={alertCount}>

                    {/* Backup — mounts only when there's something to act on. */}
                    {backupNudge && (
                        <section className={`hd-tile hd-a--glow hd-t--attn hd-t--wide${backupNudge.critical ? ' is-critical' : ''}`} data-ob-anchor="home-tile">
                            <span className="hd-attnchip">{backupNudge.chip}</span>
                            <h2 className="hd-attntitle">{backupNudge.title}</h2>
                            <p className="hd-attnbody">{backupNudge.body}</p>
                            <div className="hd-acts">
                                <button className="hd-btn" onClick={onOpenStorage}>Back up now</button>
                                <button className="hd-btn hd-btn--link" onClick={muteBackupNudge}>
                                    Don&apos;t show again
                                </button>
                            </div>
                        </section>
                    )}

                    {/* Live calls.
                        The row for the call you are ALREADY in never offers
                        Join — pressing it was a no-op anyway (both join
                        handlers early-return on the active session), and the
                        rest of the app never offers Join on your own call
                        either: HuddleCallCard drops the button entirely under
                        `isMine`, and FloatingHuddleCard (the card you get after
                        navigating away from your call's server) reuses that
                        exact treatment. Home follows the same rule, with the
                        one thing a launcher surface should add: a way BACK.
                        Leaving stays where it lives everywhere else — the
                        ControlBar in the right-hand call panel, which is
                        mounted on Home too whenever a call is live. */}
                    {activeCalls.map(call => {
                        const mine = isLocalCallRow(call.row, localCallSession);
                        return (
                        <section
                            key={call.key}
                            className="hd-tile hd-a--lume hd-t--call hd-t--wide"
                            data-ob-anchor="home-tile"
                            data-mine={mine ? 'true' : undefined}
                        >
                            <div className="hd-head">
                                <span className="hd-ic">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         strokeWidth="2.2" strokeLinecap="round">
                                        <path d="M4 6a2 2 0 0 1 2-2h2l2 5-2 1a12 12 0 0 0 6 6l1-2 5 2v2a2 2 0 0 1-2 2A16 16 0 0 1 4 6z" />
                                    </svg>
                                </span>
                                <h2>Happening now</h2>
                                {mine && <span className="hd-live">In call</span>}
                                <span className="hd-wave" aria-hidden="true"><i /><i /><i /></span>
                            </div>
                            <div className="hd-callrow">
                                <div className="hd-stack">
                                    {call.participantIds.slice(0, 3).map(uid => (
                                        <EncryptedAvatar
                                            key={uid} userId={uid} token={token}
                                            attachmentId={serverMemberAvatarMaps?.[call.server.server_id]?.[uid] ?? voiceUserAvatarIds?.[uid] ?? null}
                                            className="w-full h-full" fallbackSize={12}
                                            disableClickProfile bypassFriendGate
                                        />
                                    ))}
                                </div>
                                <div className="hd-callinfo">
                                    <p className="hd-callname">{call.channel.name}</p>
                                    <p className="hd-callwhere">
                                        {call.server.name} · {call.participantIds.length} in call
                                        {mine ? ' · you’re in this one' : ''}
                                        {/* Who's sharing / on camera — server presence, so it
                                            shows whether or not you're in this call. */}
                                        <CallMediaSummary
                                            mediaKey={call.row.kind === 'voice'
                                                ? voiceChannelMediaKey(call.row.channelId)
                                                : huddleCallMediaKey(call.row.callId)}
                                            participantIds={call.participantIds}
                                            names={voiceUserNames}
                                        />
                                    </p>
                                </div>
                                {!mine ? (
                                    <button className="hd-btn" onClick={call.onJoin}>Join</button>
                                ) : onSelectServer ? (
                                    // Navigation, not a re-join: drops you back on the
                                    // call's own server view, which is also where the
                                    // focused-video pane lives (see CallFocusSuppressor
                                    // in Dashboard — leaving Home restores the focus
                                    // that was suspended on the way in).
                                    // Rendered only when there IS somewhere to go —
                                    // a button that does nothing is the bug we're
                                    // fixing, so we don't introduce a second one.
                                    <button
                                        className="hd-btn"
                                        onClick={() => onSelectServer(call.server.server_id)}
                                        aria-label={`Return to ${call.channel.name} in ${call.server.name}`}
                                    >
                                        Return
                                    </button>
                                ) : null}
                            </div>
                        </section>
                        );
                    })}

                    {/* Pinned — servers, DMs, group chats and channels. */}
                    <section className="hd-tile hd-a--lavender hd-t--full" data-ob-anchor="home-tile">
                        <div className="hd-head">
                            <span className="hd-ic">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6zM12 15v5" />
                                </svg>
                            </span>
                            <h2>Pinned</h2>
                        </div>
                        <div className="hd-cards">
                            {resolvedPins.map(p => {
                                // A pinned CHANNEL card used to call onJoinVoiceChannel
                                // for every channel kind, no matter what. AddPinCard
                                // only ever lets a user pin a 'text' channel, so that
                                // click always tried to join_voice a text channel — the
                                // API 400s ("Not a voice channel") and the card never
                                // once opened what it was pinned for. A 'voice' channel
                                // has the OTHER shape of bug: if it's the one this
                                // client is already in, onJoinVoiceChannel early-returns
                                // and the card does nothing at all — the same mechanism
                                // cd9a573b fixed for "Happening now". See
                                // utils/homeActiveCalls' resolvePinnedChannelAction.
                                const channelAction = p.kind === 'channel'
                                    ? resolvePinnedChannelAction(p.channel.kind, p.channel.channel_id, localCallSession)
                                    : null;
                                return (
                                <PinCard
                                    key={pinKey(p.item)}
                                    entry={p}
                                    avatarId={p.kind === 'conversation' ? convAvatarId(p.conv) : null}
                                    token={token}
                                    unread={p.kind === 'conversation' ? (unreadCounts[p.conv.conversation_id] || 0) : 0}
                                    mention={p.kind === 'conversation' ? (mentionCounts[p.conv.conversation_id] || 0) : 0}
                                    inCall={p.kind === 'channel' && p.channel.kind === 'voice' && channelAction === 'navigate'}
                                    onOpen={() => {
                                        if (p.kind === 'conversation') {
                                            onSelectConversation({
                                                id: p.conv.conversation_id, title: p.conv.title, type: p.conv.type,
                                                other_user_id: p.conv.other_user_id, avatar_url: p.conv.avatar_url,
                                            });
                                        } else if (p.kind === 'server') {
                                            onSelectServer?.(p.server.server_id);
                                        } else if (channelAction === 'open') {
                                            onOpenChannel?.(p.channel);
                                        } else if (channelAction === 'join') {
                                            onJoinVoiceChannel(p.channel);
                                        } else {
                                            // 'navigate': either the voice channel we're
                                            // already in (Return, not a silent re-join
                                            // no-op) or a huddle channel (no single call
                                            // id to join at the channel level).
                                            onSelectServer?.(p.server.server_id);
                                        }
                                    }}
                                    onUnpin={() => onUnpin(p.item)}
                                />
                                );
                            })}
                            <AddPinCard
                                conversations={conversations}
                                serverChannels={serverChannels}
                                servers={servers}
                                pinnedItems={pinnedItems}
                                token={token}
                                onPin={onPin}
                            />
                        </div>
                    </section>

                    {/* While you were away. */}
                    <section className="hd-tile hd-a--cyan hd-t--primary" data-ob-anchor="home-tile">
                        <div className="hd-head">
                            <span className="hd-ic">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2.2" strokeLinecap="round">
                                    <path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" />
                                </svg>
                            </span>
                            <h2>While you were away</h2>
                            {missedConvs.length > 0 && (
                                <span className="hd-count">{totalMissed} new</span>
                            )}
                        </div>

                        {missedConvs.length === 0 ? (
                            <div className="hd-clear">
                                <strong>Nothing missed</strong>
                                <span>You&apos;re square with everyone.</span>
                            </div>
                        ) : (
                            <div className="hd-rows">
                                {missedConvs.map(conv => {
                                    const mention = mentionCounts[conv.conversation_id] || 0;
                                    const unread = unreadCounts[conv.conversation_id] || 0;
                                    return (
                                        <button
                                            key={conv.conversation_id}
                                            className="hd-row"
                                            onClick={() => onSelectConversation({
                                                id: conv.conversation_id, title: conv.title, type: conv.type,
                                                other_user_id: conv.other_user_id, avatar_url: conv.avatar_url,
                                            })}
                                        >
                                            <span className="hd-av">
                                                <EncryptedAvatar
                                                    attachmentId={convAvatarId(conv)}
                                                    userId={conv.other_user_id ?? null}
                                                    token={token}
                                                    className="w-full h-full"
                                                    fallbackSize={14}
                                                    isGroup={conv.type === 'group'}
                                                    disableClickProfile
                                                />
                                                {conv.other_user_id && !conv.is_self && (() => {
                                                    const p = resolvePresenceWithMobile(conv.other_user_id, friendStatuses, presence);
                                                    return p.status !== 'offline' && <HomeStatusDot status={p.status} onMobile={p.onMobile} />;
                                                })()}
                                            </span>
                                            <span className="hd-body">
                                                <span className="hd-top">
                                                    <span className="hd-name">{conv.title}</span>
                                                    {mention > 0 && <span className="hd-tag">named you</span>}
                                                    <span className="hd-time">{relativeTime(conv.updated_at)}</span>
                                                </span>
                                                <span className="hd-sub hd-sub--quiet">
                                                    <span>{unread} new message{unread === 1 ? '' : 's'}</span>
                                                </span>
                                            </span>
                                            <span className={`hd-pill${mention > 0 ? ' hd-pill--named' : ''}`}>
                                                {mention > 0 ? mention : unread}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </section>

                    {/* Friends — status, custom status, and what they're playing. */}
                    <section className="hd-tile hd-a--ok hd-t--primary" data-ob-anchor="home-tile">
                        <div className="hd-head">
                            <span className="hd-ic">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
                                    <circle cx="10" cy="8" r="3.5" />
                                    <path d="M19 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15 4.6a3.5 3.5 0 0 1 0 6.8" />
                                </svg>
                            </span>
                            <h2>Friends</h2>
                            {friendActivity.total > 0 && (
                                <span className="hd-count">
                                    {friendActivity.online.length} of {friendActivity.total} on
                                </span>
                            )}
                        </div>

                        {friendActivity.online.length === 0 ? (
                            <div className="hd-clear">
                                <strong>Nobody around</strong>
                                <span>
                                    {friendActivity.total === 0
                                        ? 'Add a friend to see them here.'
                                        : 'They’ll show up when they come online.'}
                                </span>
                            </div>
                        ) : (
                            <>
                                <div className="hd-rows">
                                    {friendActivity.online.slice(0, 6).map(f => {
                                        const fs = friendStatuses?.[f.user_id];
                                        const status = fs?.status ?? 'online';
                                        const game = fs?.current_game ?? null;
                                        const say = fs?.custom_status_text ?? null;
                                        const conv = conversations.find(c => c.type === 'dm' && c.other_user_id === f.user_id);
                                        // Who ELSE is on the call with this friend, not the friend
                                        // themselves (already shown at the left of the row) — that's
                                        // the "who is with them" gap this replaces a bare "in call"
                                        // label for. Capped the same way the server rail's own hover
                                        // roster caps (summarizeCallRoster, shared logic — see
                                        // utils/serverCallPresence.ts), just to 3 instead of 5: this
                                        // is an inline row, not a popover, so there's far less width.
                                        const friendCall = callByUserId.get(f.user_id);
                                        const withOthers = friendCall
                                            ? friendCall.participantIds.filter(uid => uid !== f.user_id)
                                            : [];
                                        const callRoster = withOthers.length > 0
                                            ? summarizeCallRoster(withOthers, 3)
                                            : null;
                                        return (
                                            <button
                                                key={f.user_id}
                                                className="hd-row"
                                                disabled={!conv}
                                                onClick={() => conv && onSelectConversation({
                                                    id: conv.conversation_id, title: conv.title, type: 'dm',
                                                    other_user_id: f.user_id, avatar_url: conv.avatar_url,
                                                })}
                                            >
                                                <span className="hd-av">
                                                    <EncryptedAvatar
                                                        attachmentId={f.avatar_url ?? null}
                                                        userId={f.user_id}
                                                        token={token}
                                                        className="w-full h-full"
                                                        fallbackSize={14}
                                                        disableClickProfile
                                                        bypassFriendGate
                                                    />
                                                    <HomeStatusDot status={status} onMobile={status !== 'offline' && !!fs?.on_mobile} />
                                                </span>
                                                <span className="hd-body">
                                                    <span className="hd-top">
                                                        <span className="hd-name">{f.display_name || f.username}</span>
                                                    </span>
                                                    {game ? (
                                                        <span className="hd-sub hd-sub--game">
                                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                                                                 stroke="currentColor" strokeWidth="2.2"
                                                                 strokeLinecap="round" strokeLinejoin="round">
                                                                <path d="M7 11h4M9 9v4M15.5 12h.01M18 10h.01" />
                                                                <rect x="2" y="6" width="20" height="12" rx="5" />
                                                            </svg>
                                                            <span>{game}</span>
                                                        </span>
                                                    ) : say ? (
                                                        <span className="hd-sub">
                                                            {fs?.custom_status_emoji && <span>{fs.custom_status_emoji}</span>}
                                                            <span>{say}</span>
                                                        </span>
                                                    ) : (
                                                        <span className="hd-sub hd-sub--quiet">
                                                            <span>{STATUS_LABEL[status]}</span>
                                                        </span>
                                                    )}
                                                </span>
                                                {friendCall && (
                                                    <span
                                                        className="hd-live"
                                                        title={
                                                            withOthers.length > 0
                                                                ? `In ${friendCall.channel.name} · ${friendCall.server.name} with ${labelVoiceUsers(withOthers, voiceUserNames).join(', ')}`
                                                                : `In ${friendCall.channel.name} · ${friendCall.server.name}`
                                                        }
                                                    >
                                                        {callRoster && (
                                                            <span className="hd-live-stack">
                                                                {callRoster.shown.map(uid => (
                                                                    <EncryptedAvatar
                                                                        key={uid}
                                                                        userId={uid}
                                                                        token={token}
                                                                        attachmentId={serverMemberAvatarMaps?.[friendCall.server.server_id]?.[uid] ?? null}
                                                                        className="w-full h-full"
                                                                        fallbackSize={9}
                                                                        disableClickProfile
                                                                        bypassFriendGate
                                                                    />
                                                                ))}
                                                                {callRoster.overflow > 0 && (
                                                                    <span className="hd-live-more">+{callRoster.overflow}</span>
                                                                )}
                                                            </span>
                                                        )}
                                                        in call
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                                {(friendActivity.offlineCount > 0 || friendActivity.online.length > 6) && (
                                    <p className="hd-more">
                                        {friendActivity.online.length > 6 && `${friendActivity.online.length - 6} more online`}
                                        {friendActivity.online.length > 6 && friendActivity.offlineCount > 0 && ' · '}
                                        {friendActivity.offlineCount > 0 && `${friendActivity.offlineCount} offline`}
                                    </p>
                                )}
                            </>
                        )}
                    </section>

                    {/* Pick back up — conversations and servers alike. */}
                    {recentItems.length > 0 && (
                        <section className="hd-tile hd-a--orange hd-t--full" data-ob-anchor="home-tile">
                            <div className="hd-head">
                                <span className="hd-ic">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         strokeWidth="2.2" strokeLinecap="round">
                                        <path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" />
                                    </svg>
                                </span>
                                <h2>Pick back up</h2>
                            </div>
                            <div className="hd-cards">
                                {recentItems.map(item => item.kind === 'server' ? (
                                    <button
                                        key={item.key}
                                        className="hd-card"
                                        style={{ ['--hd-hue' as string]: String(idToHue(item.server.server_id)) }}
                                        onClick={() => onSelectServer?.(item.server.server_id)}
                                    >
                                        {/* Server icons carry their own inline key, so they render
                                            through ServerIcon rather than EncryptedAvatar — and fall
                                            back to the same 2-letter colored card the rail uses,
                                            never a blank tile. */}
                                        <ServerIcon
                                            serverId={item.server.server_id}
                                            name={item.server.name}
                                            attachmentId={item.server.icon_attachment}
                                            keyB64={item.server.icon_key_b64}
                                            nonceB64={item.server.icon_nonce_b64}
                                            token={token}
                                            className="hd-chip"
                                        />
                                        <span className="hd-cardbody">
                                            <span className="hd-cardname">{item.server.name}</span>
                                            <span className="hd-cardsub">
                                                {item.activity
                                                    ? relativeTime(new Date(item.activity).toISOString())
                                                    : 'Server'}
                                            </span>
                                        </span>
                                        {(item.mention > 0 || item.unread > 0) && (
                                            <span className={`hd-pill${item.mention > 0 ? ' hd-pill--named' : ''}`}>
                                                {item.mention > 0 ? item.mention : item.unread}
                                            </span>
                                        )}
                                    </button>
                                ) : (
                                    <button
                                        key={item.key}
                                        className="hd-card"
                                        style={{ ['--hd-hue' as string]: String(idToHue(item.conv.conversation_id)) }}
                                        onClick={() => onSelectConversation({
                                            id: item.conv.conversation_id, title: item.conv.title, type: item.conv.type,
                                            other_user_id: item.conv.other_user_id, avatar_url: convAvatarId(item.conv),
                                        })}
                                    >
                                        <span className="hd-av">
                                            <EncryptedAvatar
                                                attachmentId={convAvatarId(item.conv)}
                                                userId={item.conv.other_user_id ?? null}
                                                token={token}
                                                className="w-full h-full"
                                                fallbackSize={12}
                                                isGroup={item.conv.type === 'group'}
                                                disableClickProfile
                                            />
                                            {item.conv.other_user_id && !item.conv.is_self && (() => {
                                                const p = resolvePresenceWithMobile(item.conv.other_user_id, friendStatuses, presence);
                                                return p.status !== 'offline' && <HomeStatusDot status={p.status} onMobile={p.onMobile} />;
                                            })()}
                                        </span>
                                        <span className="hd-cardbody">
                                            <span className="hd-cardname">{item.conv.title}</span>
                                            <span className="hd-cardsub">
                                                {relativeTime(
                                                    item.activity ? new Date(item.activity).toISOString() : null,
                                                ) || 'no activity yet'}
                                            </span>
                                        </span>
                                        {(item.mention > 0 || item.unread > 0) && (
                                            <span className={`hd-pill${item.mention > 0 ? ' hd-pill--named' : ''}`}>
                                                {item.mention > 0 ? item.mention : item.unread}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                </div>

                {/* ── The seabed — a glanceable closing strip ───────────── */}
                <footer className="hd-floor" data-ob-anchor="home-floor">
                    <span className="hd-floor-sec">
                        <i className="hd-floor-dot" aria-hidden />
                        End-to-end encrypted — every message, every call
                    </span>
                    <span className="hd-floor-stats">
                        <span>{friendActivity.online.length} of {friendActivity.total} friends on</span>
                        <i aria-hidden>·</i>
                        <span>{totalMissed > 0 ? `${totalMissed} waiting for you` : 'inbox clear'}</span>
                        <i aria-hidden>·</i>
                        <span className={lastBackupLabel === 'no backup yet' ? 'hd-floor-warn' : ''}>{lastBackupLabel}</span>
                    </span>
                    <span className="hd-floor-ver">v{APP_VERSION}</span>
                </footer>
            </div>
        </div>
        {gameOpen && <FirewallOverlay key={userId} userId={userId} onClose={closeGame} />}
        </div>
    );
};

export default HomePanel;
