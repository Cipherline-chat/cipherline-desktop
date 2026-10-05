import { DisconnectReason } from 'livekit-client';

/**
 * callDisconnectReasons — maps LiveKit's DisconnectReason enum to a message
 * a user can actually act on, and a rough "was this something the app
 * should try to recover from" classification.
 *
 * Before this, `onDisconnected` on <LiveKitRoom> ignored its `reason`
 * argument entirely — every disconnect (kicked by a moderator, room
 * closed, reconnect exhausted after ~38s, a second device answering the
 * same call, a token expiring) fell through to the exact same generic
 * "call ended" teardown, with no way for the user to tell "you left" from
 * "your connection gave up" from "someone kicked you."
 */

export type DisconnectMessageKind = 'info' | 'warning' | 'error';

export interface DisconnectMessage {
    title: string;
    message: string;
    kind: DisconnectMessageKind;
}

/**
 * Table-driven so every enum value maps to something deliberate rather than
 * falling through a catch-all — see callDisconnectReasons.test.ts, which
 * asserts every DisconnectReason value has an entry here.
 */
const REASON_MESSAGES: Record<DisconnectReason, DisconnectMessage> = {
    [DisconnectReason.UNKNOWN_REASON]: {
        title: 'Call ended',
        message: 'The call ended.',
        kind: 'info',
    },
    [DisconnectReason.CLIENT_INITIATED]: {
        // The normal "you clicked leave" path — no banner needed, callers
        // should generally skip showing anything for this one.
        title: 'You left the call',
        message: 'You left the call.',
        kind: 'info',
    },
    [DisconnectReason.DUPLICATE_IDENTITY]: {
        // Fallback path for the multi-device answer race (see Phase H's
        // dedicated call:answered_elsewhere event) — this fires if that
        // event is ever missed, so the user still gets SOME explanation
        // instead of an unexplained disconnect.
        title: 'Answered on another device',
        message: 'This call was answered on one of your other devices.',
        kind: 'info',
    },
    [DisconnectReason.SERVER_SHUTDOWN]: {
        title: 'Server restarted',
        message: 'The call server restarted. Try rejoining in a moment.',
        kind: 'warning',
    },
    [DisconnectReason.PARTICIPANT_REMOVED]: {
        title: 'Removed from call',
        message: 'You were removed from this call by a moderator.',
        kind: 'warning',
    },
    [DisconnectReason.ROOM_DELETED]: {
        title: 'Call ended',
        message: 'This call no longer exists.',
        kind: 'info',
    },
    [DisconnectReason.STATE_MISMATCH]: {
        title: 'Connection lost',
        message: "Your connection got out of sync and couldn't recover. Try rejoining.",
        kind: 'error',
    },
    [DisconnectReason.JOIN_FAILURE]: {
        title: "Couldn't join the call",
        message: "Something went wrong joining this call. Try again.",
        kind: 'error',
    },
    [DisconnectReason.MIGRATION]: {
        title: 'Call migrating',
        message: 'The call is moving to a different server — reconnecting automatically.',
        kind: 'info',
    },
    [DisconnectReason.SIGNAL_CLOSE]: {
        title: 'Connection lost',
        message: "Lost the connection and couldn't reconnect. Check your network and try rejoining.",
        kind: 'error',
    },
    [DisconnectReason.ROOM_CLOSED]: {
        title: 'Call ended',
        message: 'This call has ended.',
        kind: 'info',
    },
    [DisconnectReason.USER_UNAVAILABLE]: {
        title: "Couldn't connect",
        message: "You couldn't be reached for this call.",
        kind: 'warning',
    },
    [DisconnectReason.USER_REJECTED]: {
        title: 'Call declined',
        message: 'The call was declined.',
        kind: 'info',
    },
    [DisconnectReason.SIP_TRUNK_FAILURE]: {
        title: 'Call failed',
        message: 'The call failed to connect. Try again.',
        kind: 'error',
    },
    [DisconnectReason.CONNECTION_TIMEOUT]: {
        title: 'Connection timed out',
        message: "Couldn't reconnect in time. Check your network and try rejoining.",
        kind: 'error',
    },
    [DisconnectReason.MEDIA_FAILURE]: {
        title: 'Media error',
        message: 'A media error interrupted the call. Try rejoining.',
        kind: 'error',
    },
    [DisconnectReason.AGENT_ERROR]: {
        title: 'Call error',
        message: 'Something went wrong with the call.',
        kind: 'error',
    },
};

const FALLBACK: DisconnectMessage = {
    title: 'Call ended',
    message: 'The call ended.',
    kind: 'info',
};

export function mapDisconnectReasonToUserMessage(reason: DisconnectReason | undefined): DisconnectMessage {
    if (reason === undefined) return FALLBACK;
    return REASON_MESSAGES[reason] ?? FALLBACK;
}

/**
 * Whether this disconnect reason represents something the app's own retry
 * logic (as opposed to LiveKit's already-exhausted internal reconnect)
 * could plausibly recover from by offering a "rejoin" action, vs. a
 * definitively terminal state (kicked, declined, room gone) where rejoining
 * would just fail again or isn't appropriate.
 */
export function isRecoverableDisconnect(reason: DisconnectReason | undefined): boolean {
    if (reason === undefined) return false;
    switch (reason) {
        case DisconnectReason.SERVER_SHUTDOWN:
        case DisconnectReason.STATE_MISMATCH:
        case DisconnectReason.JOIN_FAILURE:
        case DisconnectReason.SIGNAL_CLOSE:
        case DisconnectReason.CONNECTION_TIMEOUT:
        case DisconnectReason.MEDIA_FAILURE:
        case DisconnectReason.SIP_TRUNK_FAILURE:
        case DisconnectReason.AGENT_ERROR:
            return true;
        default:
            return false;
    }
}
