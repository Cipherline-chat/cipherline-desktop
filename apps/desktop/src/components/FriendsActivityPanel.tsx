import React, { useMemo, useState } from 'react';
import { Cake, Hand, Image as ImageIcon, PenLine, Power, Sparkles, UserPlus, Volume2 } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { GameControllerIcon } from './GameControllerIcon';
import { MusicNoteIcon } from './integrations/MusicNoteIcon';
import { WatchingIcon } from './integrations/WatchingIcon';
import { ActivitySourceIcon } from './integrations/PlatformLogo';
import { StatusEmoji } from './StatusLine';
import { personalStatusEmoji } from './personalStatusEmoji';
import { MascotEmpty } from './MascotEmpty';
import { resolveActiveStatus } from '../utils/activeNow';
import { anniversaryYears } from '../utils/profileExtras';
import { listeningStore, SOURCE_LABEL, type ActivitySource } from '../utils/integrations/listening';
import {
    deriveFriendCalls, entryVerb, groupActiveNow, longAgo, selectActiveNow, selectFeed, shortAgo, todaysAnniversaries,
    type ActiveNowCard, type ActiveNowMedia, type FriendActivityEntry, type FriendCall,
} from '../utils/friendActivity';
import type { FriendStatusEntry } from '../utils/userStatusModel';
import '../styles/friends-activity.css';

/**
 * The right-hand panel while the Friends page is open: what friends are
 * doing NOW (calls you can see, games, music / video) and a short RECENT
 * timeline this device observed while the app was running.
 *
 * Replaces the old "Active Now" online list — the Friends page itself already
 * groups people by presence. Every input is data this client already holds;
 * the rules (privacy filters, bounds) live in utils/friendActivity.ts.
 */

export interface ActivityFriend {
    user_id: string;
    username: string;
    avatar_url?: string | null;
    friends_since?: string | null;
}

interface ChannelLike { channel_id: string; server_id: string; name: string }
interface ServerLike { server_id: string; name: string }
interface HuddleLike { call_id: string; name?: string | null; participants: readonly string[] }

export interface FriendsActivityPanelProps {
    token: string | null;
    friends: readonly ActivityFriend[];
    blockedIds: ReadonlySet<string>;
    /** The friends list has not loaded yet. */
    loading: boolean;
    friendStatuses: Record<string, FriendStatusEntry | undefined>;
    presence: Record<string, boolean | undefined>;
    entries: readonly FriendActivityEntry[];
    voiceParticipants: Record<string, readonly string[]>;
    huddleCalls: Record<string, readonly HuddleLike[]>;
    channels: readonly ChannelLike[];
    servers: readonly ServerLike[];
    localCallSession: { voiceChannelId: string | null; huddleCallId: string | null } | null;
    onOpenProfile: (userId: string, anchor: { x: number; y: number }) => void;
    onJoinCall?: (call: FriendCall) => void;
    now: number;
}

const RECENT_COLLAPSED = 10;

/** Anchor the profile popover next to the clicked row (keyboard: its rect). */
const anchorOf = (e: React.MouseEvent<HTMLElement>): { x: number; y: number } => {
    if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2 };
};

const Avatar: React.FC<{ friend: ActivityFriend; token: string | null; size: number; children?: React.ReactNode }> = ({ friend, token, size, children }) => (
    <span className="fa-av" style={{ width: size, height: size }}>
        <span className="fa-avimg" style={{ width: size, height: size }}>
            <EncryptedAvatar attachmentId={friend.avatar_url ?? null} userId={friend.user_id} token={token} className="w-full h-full" fallbackSize={Math.round(size * 0.4)} disableClickProfile />
        </span>
        {children}
    </span>
);

/** Equalizer bars: live information (something is playing), not decoration. */
const Eq: React.FC = () => <span className="fa-eq" aria-hidden="true"><i /><i /><i /></span>;

/**
 * The platform's logo (Spotify, YouTube, ...; else the note / the TV). Never the
 * album cover: covers are for profile views only, so this list fetches none.
 */
const MediaArt: React.FC<{ media: ActiveNowMedia }> = ({ media }) => (
    <span className="fa-art" data-kind={media.kind} data-source={media.source}>
        <ActivitySourceIcon kind={media.kind} source={media.source} size={20} />
    </span>
);

const sourceName = (s: string): string | null => SOURCE_LABEL[s as ActivitySource] ?? null;

/** Someone playing / listening / watching: the art (cover, or the kind's glyph) with
 *  their avatar tucked on its corner, then name · kind, the title and a detail line. */
const SoloCard: React.FC<{
    card: ActiveNowCard;
    friend: ActivityFriend;
    token: string | null;
    onOpenProfile: FriendsActivityPanelProps['onOpenProfile'];
    index: number;
}> = ({ card, friend, token, onOpenProfile, index }) => {
    const { game, media } = card;
    const kind: 'game' | 'listening' | 'watching' = game ? 'game' : media!.kind;
    const kindLabel = kind === 'game' ? 'Playing' : kind === 'watching' ? 'Watching' : 'Listening to';
    const title = game ?? media!.track;
    const detail = kind === 'game' ? null : [media!.artist, kind === 'listening' ? sourceName(media!.source) : null].filter(Boolean).join(' · ');
    // Playing AND listening: the music as a small second line.
    const also = game && media
        ? { icon: <ActivitySourceIcon kind={media.kind} source={media.source} size={11} />, text: `${media.kind === 'watching' ? 'Watching' : 'Listening to'} ${media.track}` }
        : null;
    const label = `${friend.username}, ${kindLabel.toLowerCase()} ${title}${detail ? `, ${detail}` : ''}. Open profile`;
    return (
        <li className="fa-card" data-kind={kind} style={{ '--fa-i': Math.min(index, 8) } as React.CSSProperties}>
            <button type="button" className="fa-card-btn" aria-label={label} onClick={e => onOpenProfile(friend.user_id, anchorOf(e))}>
                <span className="fa-artwrap">
                    {kind === 'game'
                        ? <span className="fa-art" data-kind="game"><GameControllerIcon size={22} /></span>
                        : <MediaArt media={media!} />}
                    <span className="fa-art-av"><Avatar friend={friend} token={token} size={22} /></span>
                </span>
                <span className="fa-card-text">
                    <span className="fa-card-top">
                        <span className="fa-card-name">{friend.username}</span>
                        <span className="fa-card-kind">{kind !== 'game' && <Eq />}{kindLabel}</span>
                    </span>
                    <span className="fa-card-title" title={title}>{title}</span>
                    {detail && <span className="fa-card-detail" title={detail}>{detail}</span>}
                    {also && <span className="fa-card-also">{also.icon}<span>{also.text}</span></span>}
                </span>
            </button>
        </li>
    );
};

/** One call (voice channel or Calls-channel call) with every friend in it:
 *  their faces (each opens that profile), who else is there, and Join. */
const CallCard: React.FC<{
    call: FriendCall;
    members: ActivityFriend[];
    token: string | null;
    onOpenProfile: FriendsActivityPanelProps['onOpenProfile'];
    onJoinCall?: (call: FriendCall) => void;
    index: number;
}> = ({ call, members, token, onOpenProfile, onJoinCall, index }) => {
    const others = call.participantIds.length - members.length - (call.mine ? 1 : 0);
    const names = members.map(m => m.username);
    const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} & ${names[1]}` : `${names[0]}, ${names[1]} +${names.length - 2}`;
    const extra = others > 0 ? ` and ${others} other${others === 1 ? '' : 's'}` : '';
    return (
        <li className="fa-card fa-card--call" data-kind="call" style={{ '--fa-i': Math.min(index, 8) } as React.CSSProperties}>
            <div className="fa-card-row">
                <span className="fa-artwrap">
                    <span className="fa-art" data-kind="call"><Volume2 size={20} aria-hidden="true" /><span className="fa-live" aria-hidden="true" /></span>
                </span>
                <span className="fa-card-text">
                    <span className="fa-card-top">
                        <span className="fa-card-name fa-card-name--title" title={call.channelName}>{call.channelName}</span>
                        <span className="fa-card-kind">In a call</span>
                    </span>
                    <span className="fa-card-detail" title={call.serverName}>{call.serverName}</span>
                </span>
            </div>
            <div className="fa-card-foot">
                <span className="fa-faces">
                    {members.slice(0, 4).map(m => (
                        <button key={m.user_id} type="button" className="fa-face" aria-label={`${m.username}, in ${call.channelName}. Open profile`}
                            title={m.username} onClick={e => onOpenProfile(m.user_id, anchorOf(e))}>
                            <Avatar friend={m} token={token} size={22} />
                        </button>
                    ))}
                </span>
                <span className="fa-card-with" title={`${names.join(', ')}${extra}`}>{who}{extra && <span className="fa-faint">{extra}</span>}</span>
                {call.mine
                    ? <span className="fa-here">You&apos;re here</span>
                    : onJoinCall && (
                        <button type="button" className="fa-join" onClick={() => onJoinCall(call)} aria-label={`Join ${call.channelName} in ${call.serverName}`}>
                            Join
                        </button>
                    )}
            </div>
        </li>
    );
};

const KIND_ICON: Record<FriendActivityEntry['kind'], React.ReactNode> = {
    online: <Power size={10} strokeWidth={3} aria-hidden="true" />,
    playing: <GameControllerIcon size={10} />,
    listening: <MusicNoteIcon size={10} />,
    watching: <WatchingIcon size={10} />,
    status: <PenLine size={10} strokeWidth={2.6} aria-hidden="true" />,
    avatar: <ImageIcon size={10} strokeWidth={2.6} aria-hidden="true" />,
    renamed: <PenLine size={10} strokeWidth={2.6} aria-hidden="true" />,
    high_five: <Hand size={10} strokeWidth={2.6} aria-hidden="true" />,
    new_friend: <UserPlus size={10} strokeWidth={2.6} aria-hidden="true" />,
};

const RecentRow: React.FC<{
    e: FriendActivityEntry;
    friend: ActivityFriend;
    token: string | null;
    now: number;
    onOpenProfile: FriendsActivityPanelProps['onOpenProfile'];
}> = ({ e, friend, token, now, onOpenProfile }) => {
    const name = <b className="fa-who">{friend.username}</b>;
    const sentence = e.kind === 'new_friend'
        ? <>You and {name} are now friends</>
        : (
            <>
                {name} {entryVerb(e)}
                {(e.kind === 'playing' || e.kind === 'listening' || e.kind === 'watching') && e.title && <> <b className="fa-what">{e.title}</b></>}
            </>
        );
    const sub = e.kind === 'status'
        ? (
            <span className="fa-rsub fa-rsub--status">
                <StatusEmoji value={e.emoji} className="shrink-0" renderCustom={personalStatusEmoji(friend.user_id)} />
                {e.title && <span className="fa-trunc">{e.title}</span>}
            </span>
        )
        : (e.kind === 'listening' || e.kind === 'watching') && e.detail ? <span className="fa-rsub fa-trunc">{e.detail}</span> : null;
    const text = `${e.kind === 'new_friend' ? `You and ${friend.username} are now friends` : `${friend.username} ${entryVerb(e)}${e.title && e.kind !== 'renamed' ? ` ${e.title}` : ''}`}, ${longAgo(e.at, now)}. Open profile`;
    return (
        <li>
            <button type="button" className="fa-rrow" data-kind={e.kind} aria-label={text} onClick={ev => onOpenProfile(friend.user_id, anchorOf(ev))}>
                <Avatar friend={friend} token={token} size={30}>
                    <span className="fa-badge" data-kind={e.kind}>{KIND_ICON[e.kind]}</span>
                </Avatar>
                <span className="fa-rtext">
                    <span className="fa-rline">{sentence}</span>
                    {sub}
                </span>
                <time className="fa-time" dateTime={new Date(e.at).toISOString()}>{shortAgo(e.at, now)}</time>
            </button>
        </li>
    );
};

const Skeleton: React.FC = () => (
    <div className="fa-skel" aria-hidden="true">
        {[0, 1, 2].map(i => <span key={i} className="fa-skel-row"><i className="fa-skel-av" /><i className="fa-skel-line" /></span>)}
    </div>
);

export const FriendsActivityPanel: React.FC<FriendsActivityPanelProps> = ({
    token, friends, blockedIds, loading, friendStatuses, presence, entries,
    voiceParticipants, huddleCalls, channels, servers, localCallSession, onOpenProfile, onJoinCall, now,
}) => {
    const [expanded, setExpanded] = useState(false);
    const byId = useMemo(() => new Map(friends.map(f => [f.user_id, f])), [friends]);
    const friendIds = useMemo(() => new Set(friends.map(f => f.user_id)), [friends]);
    // Re-read the listening store whenever it changes (any friend's track).
    const listeningVersion = React.useSyncExternalStore(listeningStore.subscribe, listeningStore.all, listeningStore.all);

    const calls = useMemo(
        () => deriveFriendCalls(friendIds, voiceParticipants, huddleCalls, channels, servers, localCallSession),
        [friendIds, voiceParticipants, huddleCalls, channels, servers, localCallSession],
    );
    const active = useMemo(() => selectActiveNow(friends, {
        isPresent: id => resolveActiveStatus(id, friendStatuses, presence) !== 'offline',
        gameOf: id => (friendStatuses[id]?.on_mobile ? null : friendStatuses[id]?.current_game ?? null),
        mediaOf: id => {
            const l = listeningVersion.get(id);
            if (!l || l.endsAt <= now) return null;
            return { kind: l.kind, track: l.track, artist: l.artist, source: l.source, artRef: l.artRef ?? null, startedAt: l.startedAt, durationMs: l.durationMs };
        },
        calls,
        blockedIds,
    }), [friends, friendStatuses, presence, listeningVersion, calls, blockedIds, now]);
    const groups = useMemo(() => groupActiveNow(active), [active]);

    const feed = useMemo(() => selectFeed(entries, { friendIds, blockedIds, now }), [entries, friendIds, blockedIds, now]);
    const today = useMemo(() => todaysAnniversaries(friends, blockedIds, since => anniversaryYears(since, new Date(now))), [friends, blockedIds, now]);
    const shown = expanded ? feed : feed.slice(0, RECENT_COLLAPSED);

    if (loading && friends.length === 0) {
        return (
            <div className="fa-root" aria-busy="true">
                <h4 className="fa-h">Active now</h4>
                <Skeleton />
            </div>
        );
    }

    if (friends.length === 0) {
        return (
            <div className="fa-root fa-root--empty">
                <MascotEmpty title="No friends to follow yet" sub="Add a few friends and you'll see their games, music and calls here." size={72} />
            </div>
        );
    }

    if (active.length === 0 && feed.length === 0 && today.length === 0) {
        return (
            <div className="fa-root fa-root--empty" data-testid="friends-activity-empty">
                <MascotEmpty title="All quiet in the deep" sub="When friends start a game, put on some music or hop into a call, it'll surface here." size={72} />
                <p className="fa-privacy">Seen only on this device. Nothing here is stored on a server.</p>
            </div>
        );
    }

    return (
        <div className="fa-root" data-testid="friends-activity">
            <section aria-labelledby="fa-now-h">
                <div className="fa-hrow">
                    <h4 id="fa-now-h" className="fa-h">Active now</h4>
                    {active.length > 0 && <span className="fa-n" aria-label={`${active.length} friends`}>{active.length}</span>}
                </div>
                {active.length === 0 ? (
                    <p className="fa-quiet">Nobody&apos;s in a game, a call or a song right now.</p>
                ) : (
                    <ul className="fa-cards">
                        {groups.calls.map((g, i) => (
                            <CallCard
                                key={`${g.call.kind}:${g.call.id}`} call={g.call}
                                members={g.userIds.map(id => byId.get(id)).filter((f): f is ActivityFriend => !!f)}
                                token={token} onOpenProfile={onOpenProfile} onJoinCall={onJoinCall} index={i}
                            />
                        ))}
                        {groups.solo.map((c, i) => {
                            const f = byId.get(c.userId);
                            return f ? <SoloCard key={c.userId} card={c} friend={f} token={token} onOpenProfile={onOpenProfile} index={groups.calls.length + i} /> : null;
                        })}
                    </ul>
                )}
            </section>

            <section aria-labelledby="fa-recent-h" className="fa-recent">
                <div className="fa-hrow">
                    <h4 id="fa-recent-h" className="fa-h">Recent</h4>
                    <span className="fa-hint" title="Seen on this device while Cipherline was open. Nothing here is stored on a server.">last 24h · this device</span>
                </div>
                {today.length > 0 && (
                    <ul className="fa-list">
                        {today.map(t => {
                            const f = byId.get(t.userId);
                            if (!f) return null;
                            return (
                                <li key={`anniv-${t.userId}`}>
                                    <button type="button" className="fa-rrow fa-rrow--today" onClick={ev => onOpenProfile(f.user_id, anchorOf(ev))}
                                        aria-label={`${t.years === 1 ? 'One year' : `${t.years} years`} of friendship with ${f.username} today. Open profile`}>
                                        <Avatar friend={f} token={token} size={30}>
                                            <span className="fa-badge" data-kind="anniversary"><Cake size={10} strokeWidth={2.6} aria-hidden="true" /></span>
                                        </Avatar>
                                        <span className="fa-rtext">
                                            <span className="fa-rline"><b className="fa-what">{t.years === 1 ? 'One year' : `${t.years} years`}</b> of friendship with <b className="fa-who">{f.username}</b></span>
                                            <span className="fa-rsub">Today <Sparkles size={11} aria-hidden="true" /></span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {feed.length === 0 ? (
                    <p className="fa-quiet">What friends get up to while you&apos;re here will show up here.</p>
                ) : (
                    <ul className="fa-list">
                        {shown.map(e => {
                            const f = byId.get(e.userId);
                            return f ? <RecentRow key={e.id} e={e} friend={f} token={token} now={now} onOpenProfile={onOpenProfile} /> : null;
                        })}
                    </ul>
                )}
                {feed.length > RECENT_COLLAPSED && (
                    <button type="button" className="fa-more" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
                        {expanded ? 'Show less' : `Show ${feed.length - RECENT_COLLAPSED} more`}
                    </button>
                )}
            </section>
        </div>
    );
};

export default FriendsActivityPanel;
