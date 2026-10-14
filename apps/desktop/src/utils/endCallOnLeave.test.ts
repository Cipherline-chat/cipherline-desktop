import { describe, it, expect, vi } from 'vitest';
import { DisconnectReason } from 'livekit-client';
import {
    END_WHEN_STARTER_LEAVES_HINT,
    END_WHEN_STARTER_LEAVES_LABEL,
    endsWhenNotice,
    endsWhenStarterLeaves,
    isCallStarter,
    leaveEndsCallForOthers,
    leaveRequestBody,
    LEAVE_ACK_CAP_MS,
    shouldHoldTeardownForLeaveAck,
    waitForLeaveAck,
    type EndOnLeaveCall,
} from './endCallOnLeave';
import { addSpawnedCall } from './joinView';
import {
    CALL_ENDED_BY_CREATOR,
    callEndedByCreatorToast,
    createCallTransitionTracker,
    decideDisconnectHandling,
    parseForceDisconnect,
    runForceDisconnect,
} from './callTransition';

/**
 * "End call when the starter leaves" - the client half. It is a CHANNEL setting
 * (`channel.end_call_when_starter_leaves`). Every rule here is a UX mirror of a
 * server decision; these tests pin the user-visible contract:
 *   - the setting is read strictly from the channel the client already holds;
 *   - there is NO prompt: leaving is a plain deliberate leave and the server ends
 *     the call when the call's channel has the setting on;
 *   - a participant whose call was ended by its starter leaves cleanly, with an
 *     information notice that never says kicked / removed;
 *   - everyone sees the "ends when X leaves" line, driven by the channel setting.
 */

const ME = 'user-me';
const STARTER = 'user-starter';
const OTHER = 'user-other';

const call = (over: Partial<EndOnLeaveCall> = {}): EndOnLeaveCall => ({
    call_id: 'call-1',
    spawner_user_id: STARTER,
    participants: [STARTER, OTHER],
    ...over,
});
const ON = { end_call_when_starter_leaves: true };
const OFF = { end_call_when_starter_leaves: false };

describe('the channel setting', () => {
    it('the label and hint are the ones the owner asked for', () => {
        expect(END_WHEN_STARTER_LEAVES_LABEL).toBe('End call when the starter leaves');
        expect(END_WHEN_STARTER_LEAVES_HINT).toBe('Everyone is disconnected when whoever started the call leaves.');
    });

    it('is on only for a strict true; absent / false / null / a non-boolean are all off', () => {
        expect(endsWhenStarterLeaves(ON)).toBe(true);
        expect(endsWhenStarterLeaves(OFF)).toBe(false);
        expect(endsWhenStarterLeaves({})).toBe(false);
        expect(endsWhenStarterLeaves(null)).toBe(false);
        expect(endsWhenStarterLeaves(undefined)).toBe(false);
        expect(endsWhenStarterLeaves({ end_call_when_starter_leaves: 'true' as unknown as boolean })).toBe(false);
        expect(endsWhenStarterLeaves({ end_call_when_starter_leaves: 1 as unknown as boolean })).toBe(false);
    });

    it("the starter is the call's spawner, never anyone else", () => {
        expect(isCallStarter(call(), STARTER)).toBe(true);
        expect(isCallStarter(call(), OTHER)).toBe(false);
        expect(isCallStarter(call(), null)).toBe(false);
        expect(isCallStarter(null, STARTER)).toBe(false);
    });
});

describe('leaving would end the call for someone (informational line only - never a prompt)', () => {
    it('starter + channel setting on + someone else in the call: yes', () => {
        expect(leaveEndsCallForOthers(call(), ON, STARTER)).toBe(true);
    });
    it('channel setting off or unknown: no', () => {
        expect(leaveEndsCallForOthers(call(), OFF, STARTER)).toBe(false);
        expect(leaveEndsCallForOthers(call(), {}, STARTER)).toBe(false);
        expect(leaveEndsCallForOthers(call(), null, STARTER)).toBe(false);
    });
    it('not the starter: no (the setting never concerns you)', () => {
        expect(leaveEndsCallForOthers(call(), ON, OTHER)).toBe(false);
        expect(leaveEndsCallForOthers(call(), ON, ME)).toBe(false);
    });
    it('alone in the call: no - nobody else is affected', () => {
        expect(leaveEndsCallForOthers(call({ participants: [STARTER] }), ON, STARTER)).toBe(false);
    });
    it('call unknown to the client: no (the server decides regardless)', () => {
        expect(leaveEndsCallForOthers(null, ON, STARTER)).toBe(false);
        expect(leaveEndsCallForOthers(call(), ON, null)).toBe(false);
    });
});

describe('leaving is a plain deliberate leave - no dialog, the server decides', () => {
    it('a leave the user chose sends {deliberate:true}', () => {
        expect(leaveRequestBody(true)).toEqual({ deliberate: true });
    });
    it('an automatic leave (drop, crash, timeout, undone join) sends no body at all', () => {
        expect(leaveRequestBody(false)).toEqual({});
        expect(leaveRequestBody(undefined)).toEqual({});
    });
    it('only a strict true counts (a stray truthy value or click event is not deliberate)', () => {
        expect(leaveRequestBody(1 as unknown as boolean)).toEqual({});
        expect(leaveRequestBody({} as unknown as boolean)).toEqual({});
    });
});

describe('the starter is recognised for a call started from the UI', () => {
    const ME_ID = 'user-me';
    const spawnResponse = { call_id: 'real-1', name: 'General', spawner_user_id: ME_ID, spawned_at: '2026-10-14T00:00:00.000Z' };

    it('the spawn RESPONSE alone makes the caller the starter, with no WS broadcast needed', () => {
        // Dashboard.handleSpawnHuddleCall applies the response (applyHuddleSpawn) before anything else.
        const calls = addSpawnedCall({}, 'h1', spawnResponse);
        const c = calls.h1[0];
        expect(isCallStarter(c, ME_ID)).toBe(true);
        expect(endsWhenNotice(c, ON, ME_ID, 'Me')).toBe('Ends for everyone when you leave');
        // ...and the (later) broadcast of the same call is a no-op, not a second card.
        expect(addSpawnedCall(calls, 'h1', spawnResponse)).toBe(calls);
    });

    it('a call someone else started never makes me the starter (the mover, not the moved)', () => {
        const moved = addSpawnedCall({}, 'h1', { ...spawnResponse, spawner_user_id: 'moderator' }).h1[0];
        expect(isCallStarter(moved, ME_ID)).toBe(false);
        expect(endsWhenNotice(moved, ON, ME_ID, 'Modly')).toBe('This call ends when Modly leaves');
        expect(isCallStarter(moved, 'moderator')).toBe(true);
    });
});

describe('the line everyone sees on the call card (driven by the CHANNEL setting)', () => {
    it('is absent while the channel setting is off, unknown, or there is no call', () => {
        expect(endsWhenNotice(call(), OFF, OTHER, 'Cora')).toBeNull();
        expect(endsWhenNotice(call(), {}, OTHER, 'Cora')).toBeNull();
        expect(endsWhenNotice(call(), null, OTHER, 'Cora')).toBeNull();
        expect(endsWhenNotice(null, ON, OTHER, 'Cora')).toBeNull();
    });
    it('names the starter for everyone else', () => {
        expect(endsWhenNotice(call(), ON, OTHER, 'Cora')).toBe('This call ends when Cora leaves');
    });
    it('tells the starter it is about them', () => {
        expect(endsWhenNotice(call(), ON, STARTER, 'Cora')).toBe('Ends for everyone when you leave');
    });
    it("falls back gracefully when the starter's name is unknown", () => {
        expect(endsWhenNotice(call(), ON, OTHER, undefined)).toBe('This call ends when the person who started it leaves');
        expect(endsWhenNotice(call(), ON, OTHER, '   ')).toBe('This call ends when the person who started it leaves');
    });
    it('flipping the channel setting flips the line for the same call (it is not per-call state)', () => {
        const c = call();
        expect(endsWhenNotice(c, OFF, OTHER, 'Cora')).toBeNull();
        expect(endsWhenNotice(c, ON, OTHER, 'Cora')).not.toBeNull();
    });
});

// ── A participant whose call the creator ended ───────────────────────────────

describe('the call ended because its creator left', () => {
    const SRC = 'call-1';
    function makeParticipant(over: { callId?: string | null } = {}) {
        const tr = createCallTransitionTracker();
        const calls: string[] = [];
        const toasts: Array<{ kind: string; title: string; message: string }> = [];
        const ports = {
            activeCallId: () => (over.callId === undefined ? SRC : over.callId),
            activeVoiceChannelId: () => null,
            leave: () => calls.push('leave'),
            toast: (t: { kind: 'info'; title: string; message: string }) => { calls.push('toast'); toasts.push(t); },
            playLeaveCue: () => calls.push('cue'),
        };
        return { tr, calls, toasts, ports };
    }
    const wire = { call_id: SRC, channel_id: 'huddle-1', by_name: 'Cora', reason: CALL_ENDED_BY_CREATOR } as const;

    it('the wire payload carries the reason; an unknown reason is ignored (a plain disconnect)', () => {
        expect(parseForceDisconnect({ call_id: SRC, channel_id: 'h', by_name: 'Cora', reason: 'creator_left' }))
            .toEqual({ call_id: SRC, channel_id: 'h', by_name: 'Cora', reason: 'creator_left' });
        expect(parseForceDisconnect({ call_id: SRC, channel_id: 'h', by_name: 'Mod', reason: 'something_else' })?.reason).toBeUndefined();
        expect(parseForceDisconnect({ call_id: SRC, channel_id: 'h', by_name: 'Mod' })?.reason).toBeUndefined();
    });

    it('leaves cleanly, plays the neutral leave cue, and says "<creator> ended the call" as information', () => {
        const d = makeParticipant();
        d.tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        expect(runForceDisconnect(wire, d.ports, d.tr)).toBe('left');
        expect(d.calls).toEqual(['leave', 'cue', 'toast']);
        expect(d.toasts).toEqual([{ kind: 'info', title: 'Call ended', message: 'Cora ended the call.' }]);
    });

    it('never says kicked / removed / disconnected-by (that is the moderator notice)', () => {
        const t = callEndedByCreatorToast('Cora');
        expect(t.kind).toBe('info');
        expect(`${t.title} ${t.message}`.toLowerCase()).not.toMatch(/kick|remov|disconnected|error|fail|moderator/);
    });

    it('negative control: the SAME event without the reason is the moderator wording', () => {
        const d = makeParticipant();
        runForceDisconnect({ call_id: SRC, channel_id: 'huddle-1', by_name: 'Modly' }, d.ports, d.tr);
        expect(d.toasts[0].title).toBe('Disconnected from call');
    });

    it('falls back when the server did not name the creator', () => {
        expect(callEndedByCreatorToast(undefined).message).toBe('The person who started it ended the call.');
    });

    it('the server\'s fallback LiveKit removal that follows is silent: no "removed" message, no second teardown', () => {
        const d = makeParticipant();
        d.tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        runForceDisconnect(wire, d.ports, d.tr);
        expect(decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, SRC, d.tr)).toEqual({ toast: null, teardown: false });
    });

    it('the client\'s own clean leave (CLIENT_INITIATED) is a silent teardown', () => {
        const d = makeParticipant();
        expect(decideDisconnectHandling(DisconnectReason.CLIENT_INITIATED, SRC, d.tr)).toEqual({ toast: null, teardown: true });
    });

    it('a second device of the same account that is not in that call ignores it', () => {
        const d = makeParticipant({ callId: null });
        d.tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        expect(runForceDisconnect(wire, d.ports, d.tr)).toBe('not-in-that-call');
        expect(d.calls).toEqual([]);
        expect(d.toasts).toEqual([]);
        expect(d.tr.current()).toBeNull();
    });
});

describe('the starter\'s Leave waits for the server before the room is torn down', () => {
    it('holds only for a deliberate leave by the starter, setting on, somebody else present', () => {
        expect(shouldHoldTeardownForLeaveAck(true, call(), ON, STARTER)).toBe(true);
    });

    it.each([
        ['not deliberate (drop / auto-leave / undone join)', false, call(), ON, STARTER],
        ['not the starter', true, call(), ON, OTHER],
        ['setting off', true, call(), OFF, STARTER],
        ['setting absent (older API)', true, call(), {}, STARTER],
        ['alone in the call (the leave destroys it anyway)', true, call({ participants: [STARTER] }), ON, STARTER],
        ['call unknown locally', true, null, ON, STARTER],
        ['channel unknown locally', true, call(), null, STARTER],
        ['no signed-in user', true, call(), ON, null],
    ])('does NOT hold: %s', (_n, deliberate, c, ch, uid) => {
        expect(shouldHoldTeardownForLeaveAck(deliberate, c, ch, uid)).toBe(false);
    });

    it('a stray truthy non-boolean is never deliberate', () => {
        expect(shouldHoldTeardownForLeaveAck({} as unknown as boolean, call(), ON, STARTER)).toBe(false);
    });

    const timers = () => {
        let fire: (() => void) | null = null;
        const cleared: unknown[] = [];
        return {
            api: { set: (fn: () => void) => { fire = fn; return 'h'; }, clear: (h: unknown) => { cleared.push(h); } },
            fire: () => fire?.(),
            cleared,
        };
    };

    it('resolves "acked" as soon as the request is answered, and stops the cap timer', async () => {
        const t = timers();
        let answer!: () => void;
        const sent = new Promise<void>(r => { answer = r; });
        const waiting = waitForLeaveAck(sent, 1500, t.api);
        answer();
        await expect(waiting).resolves.toBe('acked');
        expect(t.cleared).toEqual(['h']);
    });

    it('a FAILED request also releases the teardown (never trap the user in a call they left)', async () => {
        const t = timers();
        await expect(waitForLeaveAck(Promise.reject(new Error('net')), 1500, t.api)).resolves.toBe('acked');
    });

    it('a request that never answers is released by the cap', async () => {
        const t = timers();
        const waiting = waitForLeaveAck(new Promise(() => {}), 1500, t.api);
        t.fire();
        await expect(waiting).resolves.toBe('timeout');
    });

    it('with the real timers: the cap is LEAVE_ACK_CAP_MS and it is short', async () => {
        expect(LEAVE_ACK_CAP_MS).toBeLessThanOrEqual(2000);
        vi.useFakeTimers();
        try {
            let outcome: string | null = null;
            void waitForLeaveAck(new Promise(() => {})).then(o => { outcome = o; });
            await vi.advanceTimersByTimeAsync(LEAVE_ACK_CAP_MS - 1);
            expect(outcome).toBeNull();
            await vi.advanceTimersByTimeAsync(2);
            expect(outcome).toBe('timeout');
        } finally {
            vi.useRealTimers();
        }
    });

    it('NEGATIVE CONTROL: without the wait the teardown runs before the answer (the bug); with it, after', async () => {
        const log: string[] = [];
        let answer!: () => void;
        const mkSend = () => new Promise<void>(r => { answer = () => { log.push('answered'); r(); }; });

        // old behaviour: teardown in the same tick as the send
        const sent1 = mkSend();
        log.push('sent');
        log.push('teardown');
        answer();
        await sent1;
        expect(log).toEqual(['sent', 'teardown', 'answered']);

        // fixed behaviour: send, wait, teardown
        log.length = 0;
        const sent2 = mkSend();
        log.push('sent');
        const done = waitForLeaveAck(sent2).then(() => { log.push('teardown'); });
        answer();
        await done;
        expect(log).toEqual(['sent', 'answered', 'teardown']);
    });
});
