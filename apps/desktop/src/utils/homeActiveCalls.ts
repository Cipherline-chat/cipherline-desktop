/**
 * homeActiveCalls — deciding which "Happening now" row on the Home deck is the
 * call the local user is ALREADY in.
 *
 * Why this is a module and not an inline `.includes()` in HomePanel:
 *
 * The Home deck builds its active-call rows purely out of SERVER-side call
 * membership (`voiceParticipants` / `huddleCalls`, both WS-driven). That map
 * says who is in a call; it says nothing about whether *this* client has a live
 * LiveKit session for it. So every row rendered a "Join" button, including the
 * row for the call you were sitting in — and clicking it did nothing at all,
 * because both join handlers in Dashboard early-return when the target is
 * already the active session. A button that says Join, on a call you're in,
 * that does nothing when pressed.
 *
 * The fix is to compare against Dashboard's own session state instead. That
 * comparison has one genuine trap, which is why it lives here with tests:
 *
 *   • An always-on VOICE CHANNEL is identified by its CHANNEL id
 *     (`activeVoiceChannelId`).
 *   • A HUDDLE row is one *call* under a huddle channel, and a huddle channel
 *     can host several simultaneous calls. It is identified by its CALL id
 *     (`activeHuddleCallId`) — matching on the huddle's channel id
 *     (`activeHuddleChannelId`) would mark every sibling call in that huddle as
 *     "you're in this one", hiding the Join button on calls you could actually
 *     join.
 *
 * Keeping the two id spaces apart is the whole job, so the row type carries its
 * `kind` and the matcher never compares across kinds.
 */

/** Identity of one active-call row on the Home deck. */
export type HomeCallRow =
    | { kind: 'voice'; channelId: string }
    /** `channelId` is the huddle channel; `callId` is the individual call in it. */
    | { kind: 'huddle'; callId: string; channelId: string };

/**
 * What this client is actually connected to — mirrors Dashboard's
 * `activeVoiceChannelId` / `activeHuddleCallId`, which are both set
 * optimistically at click time, so a row flips out of "Join" the instant the
 * user commits rather than after the API round-trip.
 */
export interface LocalCallSession {
    /** Channel id of the always-on voice channel this client is in. */
    voiceChannelId: string | null;
    /** CALL id of the huddle call this client is in — NOT the huddle channel id. */
    huddleCallId: string | null;
}

/**
 * True when `row` is the call this client is already connected to.
 *
 * Deliberately conservative: with no session (or an all-null one) every row is
 * joinable, which is the safe default — the worst case is offering Join on a
 * call you're in, which the join handlers no-op anyway, rather than hiding Join
 * on a call you are not in and can't otherwise reach from Home.
 */
export function isLocalCallRow(
    row: HomeCallRow,
    session: LocalCallSession | null | undefined,
): boolean {
    if (!session) return false;
    if (row.kind === 'voice') {
        return !!session.voiceChannelId && session.voiceChannelId === row.channelId;
    }
    return !!session.huddleCallId && session.huddleCallId === row.callId;
}

/**
 * What clicking a pinned CHANNEL card on Home should actually do, given the
 * channel's own kind and what this client is already connected to.
 *
 * Lives here (not inlined in HomePanel's onOpen) for the same reason
 * isLocalCallRow does — it reuses it, and it is the second control on this
 * panel to have shipped with the "assume every id is a voice channel" bug:
 * the pinned-card click handler called `onJoinVoiceChannel` unconditionally
 * for every pinned channel, regardless of `channel.kind`. The pin picker
 * (AddPinCard) only ever lets a user pin a `'text'` channel, so in practice
 * EVERY pinned-channel click tried to `join_voice` a text channel — the API
 * rejects that with `BadRequestException('Not a voice channel')`
 * (voice-channel.service.ts), and the failure surfaced as "Call connection
 * failed — check your network and try again", which has nothing to do with
 * the actual problem and never once opens the channel the user clicked.
 *
 * A pinned `'voice'` channel has the exact shape of bug `isLocalCallRow` was
 * written for: if it's the channel this client is already in,
 * `onJoinVoiceChannel` early-returns (`if (activeVoiceChannelId ===
 * channel.channel_id) return`) and the card does nothing at all when
 * clicked. Nothing in the current UI can pin a voice channel yet — but
 * PinCard's own render already anticipates one (it picks a speaker icon over
 * the text-channel hash for non-text kinds, added in 6e2c3d2d for exactly
 * this case) — so it's handled here now rather than left as a live trap for
 * whenever pinning a voice channel becomes possible.
 *
 * A pinned `'huddle'` channel names the CATEGORY that hosts calls, not one
 * call — there is no call id to join at the channel level (a call exists
 * only once someone spawns one under the huddle), so the only honest action
 * is to land on the server and let the existing Huddle UI take it from
 * there.
 */
export type PinnedChannelAction =
    /** Navigate straight to this (text) channel. */
    | 'open'
    /** Join this voice channel — it is not the one we're already in. */
    | 'join'
    /** Don't (re)join anything — just get the user to the server. Used both
     *  for a voice channel we're already in (an honest "Return", not a
     *  silent no-op re-join) and for a huddle channel (no single call to join). */
    | 'navigate';

export function resolvePinnedChannelAction(
    channelKind: 'text' | 'voice' | 'huddle',
    channelId: string,
    session: LocalCallSession | null | undefined,
): PinnedChannelAction {
    if (channelKind === 'text') return 'open';
    if (channelKind === 'huddle') return 'navigate';
    return isLocalCallRow({ kind: 'voice', channelId }, session) ? 'navigate' : 'join';
}
