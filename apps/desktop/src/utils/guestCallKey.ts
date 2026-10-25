/**
 * Guests in a Calls-channel call — a member a moderator MOVED into a call whose
 * channel they cannot see / connect to (HuddlesService "Moved-in guests").
 *
 * The problem this solves: a Calls channel's LiveKit room key is derived on
 * each client from the channel's Sender Key (utils/voiceChannelKey.ts), and
 * only members with VIEW_CHANNEL | CONNECT are ever given that Sender Key. A
 * guest has neither, so without help their call never gets past "Securing
 * call…" — the key gate (utils/callKeyGate.ts) correctly refuses to connect
 * without a key.
 *
 * The protocol, end to end:
 *  1. The moderator's client, told by the move response that the target
 *     `target_lacks_access`, records the move (noteGuestMove). The Dashboard
 *     listener then — as a key holder — derives the CURRENT epoch's ROOM key
 *     (never the Sender Key itself: the room key is a one-way, per-(channel,
 *     epoch) HKDF output) and wraps it end-to-end to the guest's devices with
 *     the ordinary per-device envelope crypto. The server only relays it
 *     (POST /huddles/calls/:cid/guest-key → `huddle:guest_key`).
 *  2. If no key arrives, the guest asks (POST …/guest-key-request); the server
 *     forwards that to the call's other participants who can see the channel
 *     (`huddle:guest_key_request`), and one of them answers the same way.
 *  3. The guest's client opens the envelope, checks the distributor's identity
 *     like any key material, checks the content names THIS call and channel,
 *     and feeds the room key into the same gate a member's derived key uses
 *     (pickCallsRoomKey).
 *
 * What a guest therefore holds: the room key for that channel's current epoch
 * — call media, nothing else (Calls channels carry no messages, and the room
 * key cannot be turned back into the Sender Key). Getting media still needs a
 * LiveKit token, which the server only gives them for that call while they are
 * in it.
 *
 * Known limit: a channel key ROTATION during the call (someone lost access)
 * moves the members to a new epoch the guest does not follow; their media
 * stops until they are moved again.
 */

import { resolveCallsChannelKey, type CallsChannelKeySource, type CallsChannelKeyState } from '../hooks/useCallsChannelKey';

export const GUEST_CALL_KEY_TYPE = 'call_guest_key' as const;

/** A room key a guest received for one call. */
export interface GuestRoomKey {
    callId: string;
    channelId: string;
    epoch: number;
    keyB64: string;
}

/** The JSON wrapped inside the envelope. Not a chat message — never rendered. */
export interface GuestCallKeyContent {
    type: typeof GUEST_CALL_KEY_TYPE;
    call_id: string;
    channel_id: string;
    epoch: number;
    key_b64: string;
}

export function buildGuestCallKeyContent(k: GuestRoomKey): GuestCallKeyContent {
    return { type: GUEST_CALL_KEY_TYPE, call_id: k.callId, channel_id: k.channelId, epoch: k.epoch, key_b64: k.keyB64 };
}

const MAX_EPOCH = 1_000_000;
const KEY32_B64_RE = /^[A-Za-z0-9+/]{43}=?$/;

/**
 * Parse a decrypted envelope. Returns the key only when it is well-formed AND
 * names exactly the call and channel this client is a guest in — a key wrapped
 * for another call (or relabelled by the relay) is refused, never installed.
 */
export function parseGuestCallKeyContent(
    contentJson: string,
    expected: { callId: string; channelId: string },
): GuestRoomKey | null {
    let c: Partial<GuestCallKeyContent> | null;
    try { c = JSON.parse(contentJson); } catch { return null; }
    if (!c || c.type !== GUEST_CALL_KEY_TYPE) return null;
    if (c.call_id !== expected.callId || c.channel_id !== expected.channelId) return null;
    const e = c.epoch;
    if (typeof e !== 'number' || !Number.isSafeInteger(e) || e < 1 || e > MAX_EPOCH) return null;
    if (typeof c.key_b64 !== 'string' || !KEY32_B64_RE.test(c.key_b64)) return null;
    return { callId: c.call_id, channelId: c.channel_id, epoch: e, keyB64: c.key_b64 };
}

/**
 * The room key the call gate should use: the member's own derived key when it
 * is ready for THIS channel, else a guest key received for THIS call in THIS
 * channel, else the derivation state unchanged (waiting → the gate blocks).
 * A guest key can never leak into another call: it is bound to both ids.
 */
export function pickCallsRoomKey(
    channelKey: CallsChannelKeyState,
    guestKey: GuestRoomKey | null | undefined,
    activeCallId: string | null | undefined,
    channelId: string | null | undefined,
): CallsChannelKeyState {
    if (channelKey.status === 'ready' && channelKey.channelId === channelId) return channelKey;
    if (guestKey && activeCallId && channelId
        && guestKey.callId === activeCallId && guestKey.channelId === channelId) {
        return { status: 'ready', keyB64: guestKey.keyB64, epoch: guestKey.epoch, channelId };
    }
    return channelKey;
}

// ── Moves this client made (the moderator side) ────────────────────────────

export interface GuestMove {
    callId: string;
    huddleId: string;
    serverId: string;
    guestUserId: string;
}

/** How long after a move this client still answers that guest's key requests. */
export const GUEST_MOVE_SERVE_WINDOW_MS = 2 * 60_000;

const recentMoves = new Map<string, number>(); // `${callId}|${guestUserId}` → at
const moveListeners = new Set<(m: GuestMove) => void>();

/** Record a move this client made into a call the target cannot join, and tell
 *  the listener (Dashboard) to hand them the room key. */
export function noteGuestMove(m: GuestMove, now: number = Date.now()): void {
    recentMoves.set(`${m.callId}|${m.guestUserId}`, now);
    for (const [k, at] of recentMoves) if (now - at > GUEST_MOVE_SERVE_WINDOW_MS) recentMoves.delete(k);
    for (const l of moveListeners) l(m);
}

export function onGuestMove(listener: (m: GuestMove) => void): () => void {
    moveListeners.add(listener);
    return () => { moveListeners.delete(listener); };
}

export function movedRecently(callId: string, guestUserId: string, now: number = Date.now()): boolean {
    const at = recentMoves.get(`${callId}|${guestUserId}`);
    return at !== undefined && now - at <= GUEST_MOVE_SERVE_WINDOW_MS;
}

/** Test seam. */
export function _resetGuestMoves(): void { recentMoves.clear(); moveListeners.clear(); }

/**
 * Should this client answer a `huddle:guest_key_request`? Defence in depth on
 * top of the server's routing: only when it is IN that call itself (so it is in
 * the room with the guest), or it is the moderator who just moved that guest
 * there. Never for itself.
 */
export function shouldServeGuestKeyRequest(input: {
    callId: string;
    guestUserId: string;
    selfUserId: string | null | undefined;
    activeCallId: string | null | undefined;
    now?: number;
}): boolean {
    if (!input.selfUserId || input.guestUserId === input.selfUserId) return false;
    if (input.activeCallId && input.activeCallId === input.callId) return true;
    return movedRecently(input.callId, input.guestUserId, input.now);
}

// ── Delivering (holder side) ───────────────────────────────────────────────

export interface DeliverGuestKeyPorts {
    keySource: CallsChannelKeySource;
    /** The guest's approved devices with key bundles (GET servers/:sid/members/:uid/devices). */
    getMemberDevices(serverId: string, userId: string): Promise<unknown[]>;
    /** Wrap `contentJson` to `devices` → one multi-device envelope. */
    encrypt(contentJson: string, devices: unknown[]): Promise<string>;
    /** POST /huddles/calls/:cid/guest-key */
    post(callId: string, body: { user_id: string; envelope_b64: string }): Promise<unknown>;
}

export type DeliverGuestKeyOutcome = 'sent' | 'no-key' | 'no-devices';

/** Derive the current room key and hand it to the guest. Throws on transport errors. */
export async function deliverGuestCallKey(m: GuestMove, ports: DeliverGuestKeyPorts): Promise<DeliverGuestKeyOutcome> {
    const key = await resolveCallsChannelKey(ports.keySource, m.huddleId, null);
    if (!key || key.status !== 'ready') return 'no-key';
    const devices = await ports.getMemberDevices(m.serverId, m.guestUserId);
    if (!Array.isArray(devices) || devices.length === 0) return 'no-devices';
    const content = buildGuestCallKeyContent({ callId: m.callId, channelId: m.huddleId, epoch: key.epoch, keyB64: key.keyB64 });
    const envelope = await ports.encrypt(JSON.stringify(content), devices);
    await ports.post(m.callId, { user_id: m.guestUserId, envelope_b64: envelope });
    return 'sent';
}

// ── Receiving (guest side) ─────────────────────────────────────────────────

export interface GuestKeyEvent {
    call_id: string;
    huddle_id: string;
    sender_user_id: string;
    envelope_b64: string;
}

export function parseGuestKeyEvent(d: unknown): GuestKeyEvent | null {
    const x = d as Record<string, unknown> | null;
    if (!x || typeof x !== 'object') return null;
    const { call_id, huddle_id, sender_user_id, envelope_b64 } = x;
    if (typeof call_id !== 'string' || typeof huddle_id !== 'string'
        || typeof sender_user_id !== 'string' || typeof envelope_b64 !== 'string') return null;
    return { call_id, huddle_id, sender_user_id, envelope_b64 };
}

export interface GuestKeyRequestEvent {
    call_id: string;
    huddle_id: string;
    server_id: string;
    guest_user_id: string;
}

export function parseGuestKeyRequestEvent(d: unknown): GuestKeyRequestEvent | null {
    const x = d as Record<string, unknown> | null;
    if (!x || typeof x !== 'object') return null;
    const { call_id, huddle_id, server_id, guest_user_id } = x;
    if (typeof call_id !== 'string' || typeof huddle_id !== 'string'
        || typeof server_id !== 'string' || typeof guest_user_id !== 'string') return null;
    return { call_id, huddle_id, server_id, guest_user_id };
}

export interface AcceptGuestKeyPorts {
    decrypt(envelopeB64: string): Promise<{ contentJson: string; senderUserId?: string }>;
    /** The distributor's identity check every piece of key material passes
     *  (TOFU pin per device). false = refuse. */
    trustSender(decrypted: { contentJson: string; senderUserId?: string }): Promise<boolean>;
}

/**
 * Open a `huddle:guest_key` for the call this client is a guest in. Null when
 * it is for another call, does not decrypt, comes from someone other than the
 * relay says, fails the distributor check, or does not name this call.
 */
export async function acceptGuestCallKey(
    ev: GuestKeyEvent,
    guestOf: { callId: string; channelId: string } | null,
    ports: AcceptGuestKeyPorts,
): Promise<GuestRoomKey | null> {
    if (!guestOf || ev.call_id !== guestOf.callId || ev.huddle_id !== guestOf.channelId) return null;
    let dec: { contentJson: string; senderUserId?: string };
    try { dec = await ports.decrypt(ev.envelope_b64); } catch { return null; }
    if (!dec.senderUserId || dec.senderUserId !== ev.sender_user_id) return null;
    if (!(await ports.trustSender(dec))) return null;
    return parseGuestCallKeyContent(dec.contentJson, guestOf);
}

/** When the guest asks the call's key holders, if no key has arrived yet. */
export const GUEST_KEY_REQUEST_DELAYS_MS = [3_000, 8_000, 20_000] as const;

// ── Header for a call in a channel this client cannot see ─────────────────

export interface GuestCall {
    callId: string;
    huddleId: string;
    serverId: string | null;
    callName: string;
}

/** The floating call header's server/channel line for a guest: the server they
 *  are in, the call's own name, and an explicit "Private channel" — never a
 *  lookup into a channel list that does not contain it. */
export function guestCallServerInfo(
    g: GuestCall,
    servers: { server_id: string; name?: string | null }[],
): { serverId: string; serverName: string | null; channelName: string; iconName: null; iconEmoji: null; maxCalls: null; guest: true } | null {
    if (!g.serverId) return null;
    const srv = servers.find(s => s.server_id === g.serverId);
    return {
        serverId: g.serverId,
        serverName: srv?.name ?? null,
        channelName: g.callName ? `${g.callName} · Private channel` : 'Private channel',
        iconName: null,
        iconEmoji: null,
        maxCalls: null,
        guest: true,
    };
}
