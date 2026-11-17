import React, { useEffect, useId, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { CallMediaSummary } from './CallMediaSummary';
import type { ChannelInfo, ServerInfo } from '../hooks/useServers';
import { isLocalCallRow, type HomeCallRow, type LocalCallSession } from '../utils/homeActiveCalls';
import { huddleCallMediaKey, voiceChannelMediaKey } from '../utils/callMediaPresence';
import { canJoinVoice } from '../utils/voiceJoinGate';
import {
    HOME_CALLS_COLLAPSED_LIMIT, HOME_CALLS_COLLAPSED_LIMIT_TWO_COL, HOME_CALLS_TWO_COL_MIN_WIDTH,
    applyCallOrder, callColumns, foldCalls, getHomeCallsExpanded, needsFold, nextCallOrder, setHomeCallsExpanded,
    soloStack, stackParticipants, stackSlotWidth, type CallOrder,
} from '../utils/homeCallsList';

/** One live call on the Home deck (a voice channel, or one huddle call). */
export interface HomeCallEntry {
    key: string;
    /** What the row is called: the huddle CALL's own name (several calls can
     *  share one Calls channel), or the voice channel's name. */
    name: string;
    channel: ChannelInfo;
    server: ServerInfo;
    participantIds: string[];
    /** ms epoch the call started, when known (huddle calls only). */
    startedAt: number | null;
    row: HomeCallRow;
    onJoin: () => void;
}

interface HomeCallsTileProps {
    calls: HomeCallEntry[];
    localCallSession?: LocalCallSession | null;
    friendIds: ReadonlySet<string>;
    token: string | null;
    serverMemberAvatarMaps?: Record<string, Record<string, string | null>>;
    voiceUserAvatarIds?: Record<string, string>;
    voiceUserNames?: Record<string, string>;
    /** Row click: show the call's server (never joins — Join is the button). */
    onSelectServer?: (serverId: string) => void;
}

/**
 * The Home deck's ONE "Happening now" tile: every live call you can see, one
 * compact line each, the first few shown and the rest behind "+N more".
 * Renders nothing when there is no live call (the deck's empty state is the
 * tile's absence, as before). Ordering/folding rules: utils/homeCallsList.
 * A SINGLE live call gets its own two-line row instead (bigger avatar stack,
 * the call name over "server · N in call", Join / "In call" centred) — one
 * 34px line in an otherwise empty tile looked unfinished (owner 2026-11-16).
 * No row is ever filled to mark your own call; the quiet "In call" tag does.
 *
 * The row for the call you are ALREADY in never offers Join — pressing it was
 * a no-op anyway (both join handlers early-return on the active session), and
 * the rest of the app never offers Join on your own call either:
 * HuddleCallCard drops the button under `isMine`, and FloatingHuddleCard
 * reuses that treatment. A "Return" here read as "rejoin" to someone already
 * in the call (owner 2026-10-31), so it shows an "In call" tag instead.
 * Leaving stays in the ControlBar of the right-hand call panel. Join is also
 * withheld on a call you can see but may not CONNECT to (utils/voiceJoinGate).
 */
export const HomeCallsTile: React.FC<HomeCallsTileProps> = (props) => {
    if (props.calls.length === 0) return null;
    return <HomeCallsTileBody {...props} />;
};

const HomeCallsTileBody: React.FC<HomeCallsTileProps> = ({
    calls, localCallSession, friendIds, token,
    serverMemberAvatarMaps, voiceUserAvatarIds, voiceUserNames, onSelectServer,
}) => {
    const listId = useId();
    const listRef = useRef<HTMLUListElement>(null);

    // Two-across only when the LIST itself is wide (it is half the deck when a
    // backup nudge pairs with it) and there are more calls than one column
    // shows folded (utils/homeCallsList callColumns). Measured rather than
    // container-queried so the fold limit and the CSS columns can't disagree;
    // only the threshold crossing is stored, so a resize drag doesn't re-render.
    const [wide, setWide] = useState(false);
    useEffect(() => {
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width ?? 0;
            setWide(w >= HOME_CALLS_TWO_COL_MIN_WIDTH);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const [expanded, setExpanded] = useState(getHomeCallsExpanded);
    const toggle = () => {
        const next = !expanded;
        setHomeCallsExpanded(next);
        setExpanded(next);
    };

    // Rank only on a membership change (utils/homeCallsList) — the "store
    // information from previous renders" pattern, so presence churn inside a
    // call updates its count without moving its row.
    const mineKey = calls.find(c => isLocalCallRow(c.row, localCallSession))?.key ?? null;
    const ctx = { mineKey, friendIds };
    const [kept, setKept] = useState<CallOrder>(() => nextCallOrder(null, calls, ctx));
    const order = nextCallOrder(kept, calls, ctx);
    if (order !== kept) setKept(order);
    const ordered = applyCallOrder(calls, order);

    const twoCol = callColumns(wide ? HOME_CALLS_TWO_COL_MIN_WIDTH : 0, ordered.length) === 2;
    const limit = twoCol ? HOME_CALLS_COLLAPSED_LIMIT_TWO_COL : HOME_CALLS_COLLAPSED_LIMIT;
    const { shown, hidden } = foldCalls(ordered, expanded, limit);
    const foldable = needsFold(ordered.length, limit);

    // One call gets its own two-line layout (bigger stack, name over "server ·
    // N in call"); 2+ keep the one-line rows. Multi rows share an avatar slot
    // as wide as the widest stack SHOWN, so names align without the dead gap
    // a fixed three-avatar slot left beside a lone avatar.
    const solo = ordered.length === 1;
    const slotStyle = solo ? undefined : ({
        '--hd-stack-w': `${stackSlotWidth(shown.map(c => Math.min(c.participantIds.length, 3)))}px`,
    } as React.CSSProperties);

    return (
        <section
            className={`hd-tile hd-a--lume hd-t--call hd-t--wide${solo ? ' hd-t--solo' : ''}`}
            data-ob-anchor="home-tile"
            data-testid="home-calls-tile"
        >
            <div className="hd-head">
                <span className="hd-ic">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.2" strokeLinecap="round">
                        <path d="M4 6a2 2 0 0 1 2-2h2l2 5-2 1a12 12 0 0 0 6 6l1-2 5 2v2a2 2 0 0 1-2 2A16 16 0 0 1 4 6z" />
                    </svg>
                </span>
                <h2>Happening now</h2>
                {calls.length > 1 && (
                    <span className="hd-count" aria-label={`${calls.length} live calls`}>{calls.length}</span>
                )}
                <span className="hd-wave" aria-hidden="true"><i /><i /><i /></span>
            </div>
            <ul
                ref={listRef}
                id={listId}
                className={`hd-calls${solo ? ' hd-calls--solo' : ''}`}
                data-cols={twoCol ? '2' : '1'}
                aria-label="Live calls"
                style={slotStyle}
            >
                {shown.map((call, i) => {
                    const mine = call.key === mineKey;
                    const n = call.participantIds.length;
                    const where = `${call.name} · ${call.server.name} · ${n} in call`;
                    const openProps = onSelectServer
                        ? { onClick: () => onSelectServer(call.server.server_id) }
                        : { disabled: true };
                    const avatar = (uid: string, fallbackSize: number) => (
                        <EncryptedAvatar
                            key={uid} userId={uid} token={token}
                            attachmentId={serverMemberAvatarMaps?.[call.server.server_id]?.[uid] ?? voiceUserAvatarIds?.[uid] ?? null}
                            className="w-full h-full" fallbackSize={fallbackSize}
                            disableClickProfile bypassFriendGate
                        />
                    );
                    // Who's sharing / on camera — server presence, so it
                    // shows whether or not you're in this call.
                    const media = (
                        <span className="hd-call-media">
                            <CallMediaSummary
                                mediaKey={call.row.kind === 'voice'
                                    ? voiceChannelMediaKey(call.row.channelId)
                                    : huddleCallMediaKey(call.row.callId)}
                                participantIds={call.participantIds}
                                names={voiceUserNames}
                            />
                        </span>
                    );
                    const act = mine
                        // Your own call: a quiet lume "In call" (dot + text, no
                        // fill), never a highlighted band (owner 2026-11-16).
                        ? <span className="hd-call-here hd-call-act"><i aria-hidden="true" />In call</span>
                        : canJoinVoice(call.channel) && (
                            <button type="button"
                                    className={`hd-btn${solo ? '' : ' hd-btn--sm'} hd-call-act`}
                                    onClick={call.onJoin} aria-label={`Join ${call.name}`}>
                                Join
                            </button>
                        );

                    if (solo) {
                        const { ids, extra } = soloStack(call.participantIds, friendIds);
                        return (
                            <li
                                key={call.key}
                                className="hd-call hd-call--solo"
                                data-mine={mine ? 'true' : undefined}
                                data-testid="home-call-row"
                            >
                                <button type="button" className="hd-call-open" title={where} {...openProps}>
                                    <span className="hd-call-stack" aria-hidden="true">
                                        {ids.map(uid => avatar(uid, 12))}
                                        {extra > 0 && <span className="hd-call-stackmore">+{extra}</span>}
                                    </span>
                                    <span className="hd-call-body">
                                        <span className="hd-call-name">{call.name}</span>
                                        <span className="hd-call-meta">
                                            <span className="hd-call-srv">
                                                <span className="sr-only">in </span>{call.server.name}
                                            </span>
                                            <span className="hd-call-sep" aria-hidden="true">·</span>
                                            <span className="hd-call-n">
                                                <span className="sr-only">, </span>{n} in call
                                            </span>
                                            {media}
                                        </span>
                                    </span>
                                </button>
                                {act}
                            </li>
                        );
                    }

                    const stack = stackParticipants(call.participantIds, friendIds);
                    return (
                        <li
                            key={call.key}
                            className={`hd-call${i >= limit ? ' hd-call--extra' : ''}`}
                            data-mine={mine ? 'true' : undefined}
                            data-testid="home-call-row"
                        >
                            <button type="button" className="hd-call-open" title={where} {...openProps}>
                                <span className="hd-call-stack" aria-hidden="true">
                                    {stack.map(uid => avatar(uid, 9))}
                                </span>
                                <span className="hd-call-name">{call.name}</span>
                                <span className="hd-call-srv">
                                    <span className="sr-only">in </span>{call.server.name}
                                </span>
                                <span className="hd-call-n">
                                    <Users width={11} height={11} aria-hidden="true" />
                                    <span aria-hidden="true">{n}</span>
                                    <span className="sr-only">, {n} in call</span>
                                </span>
                                {media}
                            </button>
                            {act}
                        </li>
                    );
                })}
            </ul>
            {foldable && (
                <button
                    type="button"
                    className="hd-calls-more"
                    aria-expanded={expanded}
                    aria-controls={listId}
                    onClick={toggle}
                    data-testid="home-calls-more"
                >
                    {expanded ? 'Show less' : `+${hidden} more`}
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                         className={expanded ? 'is-up' : undefined}>
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </button>
            )}
        </section>
    );
};

export default HomeCallsTile;
