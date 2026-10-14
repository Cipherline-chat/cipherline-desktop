/**
 * endCallOnLeave - the client half of "End call when the starter leaves"
 * (server: HuddlesService.tryEndCallForEveryone).
 *
 * It is a CHANNEL setting (`channel.end_call_when_starter_leaves`), edited in
 * the Calls channel's settings modal by whoever may edit the channel - there is
 * no per-call switch and no prompt. When the person who STARTED a call leaves it
 * on purpose in a channel that has the setting on, the call simply ends for
 * everyone. Everyone looking at the call sees a quiet line so it is never a
 * surprise.
 *
 * Every rule here is a UX MIRROR. The server decides when a leave ends a call,
 * from its own state: nothing in this file can end a call by itself. Pure and
 * framework-free so the rules are unit-testable without the 14k-line Dashboard.
 */

/** The slice of a Calls-channel call these rules read. */
export interface EndOnLeaveCall {
    call_id: string;
    /** "The starter" - the one whose leave can end the call. */
    spawner_user_id: string;
    participants: string[];
}

/** The slice of a Calls channel these rules read. */
export interface EndOnLeaveChannel {
    /** Server-owned. Absent = off (an older API, or the setting is off). */
    end_call_when_starter_leaves?: boolean;
}

/** The switch in the channel settings modal. */
export const END_WHEN_STARTER_LEAVES_LABEL = 'End call when the starter leaves';
export const END_WHEN_STARTER_LEAVES_HINT = 'Everyone is disconnected when whoever started the call leaves.';

export const isCallStarter = (
    call: Pick<EndOnLeaveCall, 'spawner_user_id'> | null | undefined,
    userId: string | null | undefined,
): boolean => !!call && !!userId && call.spawner_user_id === userId;

/** Is the setting on for this Calls channel? Strictly `true`: anything else is off. */
export const endsWhenStarterLeaves = (channel: EndOnLeaveChannel | null | undefined): boolean =>
    channel?.end_call_when_starter_leaves === true;

/**
 * Would the starter's leave end the call for somebody? Only when it actually
 * would: the channel setting is on, they are the starter, and at least one OTHER
 * person is in the call. Used ONLY for an informational sentence in the "Leave
 * Current Call?" switch confirm that already existed - never to ask anything new.
 */
export function leaveEndsCallForOthers(
    call: EndOnLeaveCall | null | undefined,
    channel: EndOnLeaveChannel | null | undefined,
    userId: string | null | undefined,
): boolean {
    if (!call || !userId) return false;
    if (!isCallStarter(call, userId) || !endsWhenStarterLeaves(channel)) return false;
    return call.participants.some(p => p !== userId);
}

/**
 * The line shown on the call card to everyone who can see the call while the
 * channel's setting is on. null when it is off. The subject is "the starter".
 */
export function endsWhenNotice(
    call: Pick<EndOnLeaveCall, 'spawner_user_id'> | null | undefined,
    channel: EndOnLeaveChannel | null | undefined,
    userId: string | null | undefined,
    starterName: string | null | undefined,
): string | null {
    if (!call || !endsWhenStarterLeaves(channel)) return null;
    if (isCallStarter(call, userId)) return 'Ends for everyone when you leave';
    const who = typeof starterName === 'string' && starterName.trim() ? starterName.trim() : 'the person who started it';
    return `This call ends when ${who} leaves`;
}

// ── The leave request ────────────────────────────────────────────────────────

/**
 * Body of `POST /v1/huddles/calls/:cid/leave`. A leave the user chose carries
 * `{deliberate:true}`: the server ends the call for everyone only when that
 * comes from the call's starter in a channel with the setting on. Every
 * automatic leave (drop, crash, timeout, undone join) sends no body at all, so
 * it can never end a call.
 */
export const leaveRequestBody = (deliberate: boolean | undefined): { deliberate?: true } =>
    deliberate === true ? { deliberate: true } : {};

// ── Ordering: the leave must reach the server BEFORE the room is torn down ──

/**
 * How long a starter's Leave may keep the call UI (and so the LiveKit room) up
 * while the deliberate leave request is in flight. A normal round trip is well
 * under this; a dead network must not hold the user in a call they asked to
 * leave, so the teardown happens at the cap whatever the request is doing.
 */
export const LEAVE_ACK_CAP_MS = 1500;

/**
 * Must the room teardown wait for the server to answer this leave?
 *
 * Tearing the room down disconnects the starter from LiveKit, and LiveKit's
 * `participant_left` webhook reaches the API (server to server) long before
 * the starter's own HTTPS request does. That webhook is an ORDINARY leave: it
 * removes the starter from the call, so when the deliberate leave then lands the
 * server finds nobody left to act on ("the creator is no longer a participant")
 * and the call carries on without its starter. Switching calls never lost that
 * race only because the old room stays up through the whole join round trip.
 *
 * So when this leave is the one that would end the call for somebody (deliberate,
 * the starter, the channel's setting on, at least one other person in it), the
 * teardown waits for the answer. Any other leave tears down at once, exactly as
 * before - the wait costs a round trip and is only worth paying here.
 */
export const shouldHoldTeardownForLeaveAck = (
    deliberate: boolean,
    call: EndOnLeaveCall | null | undefined,
    channel: EndOnLeaveChannel | null | undefined,
    userId: string | null | undefined,
): boolean => deliberate === true && leaveEndsCallForOthers(call, channel, userId);

/**
 * Resolve when the leave request has settled (answered OR failed) or the cap
 * elapses, whichever is first. Never rejects. Timers are injectable for tests.
 */
export function waitForLeaveAck(
    sent: Promise<unknown>,
    capMs: number = LEAVE_ACK_CAP_MS,
    timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
): Promise<'acked' | 'timeout'> {
    return new Promise(resolve => {
        const handle = timers.set(() => resolve('timeout'), capMs);
        const done = () => { timers.clear(handle); resolve('acked'); };
        sent.then(done, done);
    });
}
