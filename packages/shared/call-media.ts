/**
 * Out-of-call media presence: "is this participant's camera on / are they
 * sharing their screen?", visible to members who can SEE the call's channel
 * without having to join it.
 *
 * Inside a call the client reads this straight off LiveKit track state. A
 * member who is NOT in the call only has server voice presence, so the server
 * keeps a tiny per-call record of these two booleans and fans it out with
 * exactly the same VIEW_CHANNEL audience as voice presence itself.
 *
 * What this is NOT: content, keys, or anything about who watches whom. It is
 * two bits per participant, the same thing every participant in the call can
 * already see on their own screen.
 *
 * Wire events (both over the authenticated WS, `{ event, data }`):
 *   client → server  `call:media_report`  {@link CallMediaReport}
 *   server → client  `call:media_state`   {@link CallMediaStateEvent}
 * Seeds: `GET /v1/voice-participants`, `GET /v1/servers/:id/voice-participants`
 * and `GET /v1/huddles/:hid/calls` carry an optional `media` map
 * ({@link CallMediaByUser}) on each call / voice channel. Every field is
 * additive — an older client ignores it, a newer client treats it as absent.
 */

export interface CallMediaState {
    camera: boolean;
    screen_share: boolean;
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
}

export const NO_CALL_MEDIA: Readonly<CallMediaState> = Object.freeze({ camera: false, screen_share: false });

export function hasAnyCallMedia(s: CallMediaState | null | undefined): boolean {
    return !!s && (s.camera || s.screen_share);
}

/** Tolerant reader for one wire value: anything that is not an object with
 *  boolean flags reads as "nothing on" (never throws, never coerces a
 *  truthy string into `true`). */
export function readCallMediaState(raw: unknown): CallMediaState {
    if (typeof raw !== 'object' || raw === null) return { camera: false, screen_share: false };
    const r = raw as Record<string, unknown>;
    return { camera: r.camera === true, screen_share: r.screen_share === true };
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
