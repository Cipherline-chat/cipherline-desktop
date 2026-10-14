/**
 * Out-of-call media presence: "is this participant's camera on / are they
 * sharing their screen / are they muted / are they deafened?", visible to
 * members who can SEE the call's channel without having to join it.
 *
 * Inside a call the client reads this straight off LiveKit track state. A
 * member who is NOT in the call only has server voice presence, so the server
 * keeps a tiny per-call record of these four booleans and fans it out with
 * exactly the same VIEW_CHANNEL audience as voice presence itself.
 *
 * `muted` / `deafened` are the participant's SELF state (their own mic toggle
 * and deafen toggle), reported by their own client. Server-moderation
 * mute/deafen (an admin muting someone) lives only in LiveKit participant
 * metadata and is NOT carried here. Push-to-talk: a client in PTT mode
 * reports `muted: false` — the mic closing between key presses is not a mute,
 * and reporting it would flap the icon on every key press.
 *
 * What this is NOT: content, keys, or anything about who watches whom. It is
 * four bits per participant, the same thing every participant in the call can
 * already see on their own screen.
 *
 * Wire events (both over the authenticated WS, `{ event, data }`):
 *   client → server  `call:media_report`  {@link CallMediaReport}
 *   server → client  `call:media_state`   {@link CallMediaStateEvent}
 * Seeds: `GET /v1/voice-participants`, `GET /v1/servers/:id/voice-participants`
 * and `GET /v1/huddles/:hid/calls` carry an optional `media` map
 * ({@link CallMediaByUser}) on each call / voice channel. Every field is
 * additive — an older client ignores it, a newer client treats it as absent.
 * `muted` / `deafened` were added after `camera` / `screen_share`: an older
 * client never sends them (reads as false) and an older client receiving them
 * ignores them; a reader must treat an absent value as false.
 */

export interface CallMediaState {
    camera: boolean;
    screen_share: boolean;
    /** Self mic-off (never push-to-talk key-up — see the file header). */
    muted: boolean;
    /** Self deafen. */
    deafened: boolean;
}

/** user_id → media state. Only participants with at least one flag set
 *  appear; absent means "nothing on". */
export type CallMediaByUser = Record<string, CallMediaState>;

/** Client → server: "this is MY current media state in the call I'm in".
 *  Exactly one of `call_id` (a Calls-channel call) or `channel_id` (a legacy
 *  always-on voice channel) is set. The server only ever applies it to the
 *  sender's own state, only while the sender is a participant, and clamps it
 *  to what the sender is actually allowed to publish there. */
export interface CallMediaReport {
    call_id?: string;
    channel_id?: string;
    camera: boolean;
    screen_share: boolean;
    /** Optional on the wire: an older client omits it, which reads as false. */
    muted?: boolean;
    /** Optional on the wire: an older client omits it, which reads as false. */
    deafened?: boolean;
}

/** Server → client. `channel_id` is the Calls channel (huddle) or voice
 *  channel — the VIEW_CHANNEL subject. `call_id` is the huddle call, or
 *  null for a legacy voice channel (whose presence is keyed by channel). */
export interface CallMediaStateEvent {
    channel_id: string;
    call_id: string | null;
    user_id: string;
    camera: boolean;
    screen_share: boolean;
    /** Always sent by a server that knows the field; an older server omits it
     *  — readers go through {@link readCallMediaState}, which reads absent as false. */
    muted: boolean;
    deafened: boolean;
}

export const NO_CALL_MEDIA: Readonly<CallMediaState> = Object.freeze({
    camera: false, screen_share: false, muted: false, deafened: false,
});

/** True when ANY of the four flags is set — a muted-only participant still
 *  belongs in a seed's `media` map. (Callers that mean "has video" must read
 *  `camera` / `screen_share` directly, not this.) */
export function hasAnyCallMedia(s: CallMediaState | null | undefined): boolean {
    return !!s && (s.camera || s.screen_share || s.muted || s.deafened);
}

/** Tolerant reader for one wire value: anything that is not an object with
 *  boolean flags reads as "nothing on" (never throws, never coerces a
 *  truthy string into `true`). */
export function readCallMediaState(raw: unknown): CallMediaState {
    if (typeof raw !== 'object' || raw === null) return { ...NO_CALL_MEDIA };
    const r = raw as Record<string, unknown>;
    return {
        camera: r.camera === true,
        screen_share: r.screen_share === true,
        muted: r.muted === true,
        deafened: r.deafened === true,
    };
}

/** Tolerant reader for a seed's optional `media` map. Drops non-string keys'
 *  garbage and all-false entries so the result only names people with
 *  something on. */
export function readCallMediaByUser(raw: unknown): CallMediaByUser {
    const out: CallMediaByUser = {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
    for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) {
        const s = readCallMediaState(v);
        if (hasAnyCallMedia(s)) out[uid] = s;
    }
    return out;
}
