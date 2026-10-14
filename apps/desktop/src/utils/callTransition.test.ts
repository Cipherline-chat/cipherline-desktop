import { describe, it, expect, vi } from 'vitest';
import { DisconnectReason } from 'livekit-client';
import {
    CALL_TRANSITION_TTL_MS,
    buildHuddleSelection,
    createCallTransitionTracker,
    decideDisconnectHandling,
    disconnectedToast,
    failureTitleFor,
    moveFailureTitle,
    parseForceDisconnect,
    parseFromCallId,
    runForceDisconnect,
    runForceMove,
    shouldActOnPaneDisconnect,
    type ForceMoveEventData,
    type HuddleSelection,
} from './callTransition';

/**
 * The client half of the call-moderation overhaul. Owner report: "When moving
 * members around in calls it often completely disconnects them: it almost
 * always looks like they're disconnected, the call controls are gone, etc.,
 * yet they can talk and hear me. It also says they were kicked even though
 * they were moved."
 *
 * The cause was a race between `huddle:force_move` (join the next call) and the
 * LiveKit PARTICIPANT_REMOVED the server used to send for the OLD room. These
 * tests drive both orders through the same pure pieces the Dashboard and
 * CallPane call, and include the pre-fix behaviour as a negative control.
 */

const SRC = 'call-source';
const DST = 'call-dest';
const DST_HUDDLE = 'huddle-dest';

const MOVE: ForceMoveEventData = {
    huddle_id: DST_HUDDLE,
    call_id: DST,
    call_name: 'Raid night',
    livekit_url: 'wss://lk.example',
    livekit_token: 'tok-dest',
    moved_by: 'mod-1',
    moved_by_name: 'Modly',
    from_call_id: SRC,
    nonce: 1,
};

function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ── The marker ───────────────────────────────────────────────────────────────

describe('call transition marker', () => {
    it('a move marks the SOURCE room as expected-to-disconnect, never the destination', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(tr.isExpectedDisconnect(SRC)).toBe(true);
        expect(tr.isExpectedDisconnect(DST)).toBe(false); // a real failure of the new call must still surface
        expect(tr.isExpectedDisconnect('some-other-call')).toBe(false);
        expect(tr.isExpectedDisconnect(null)).toBe(false);
    });

    it('with no marker nothing is expected (negative control)', () => {
        const tr = createCallTransitionTracker();
        expect(tr.isExpectedDisconnect(SRC)).toBe(false);
        expect(tr.isMovePendingFor(DST)).toBe(false);
    });

    it('an older server that omits from_call_id: any call except the destination is the one being left', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: null, toCallId: DST });
        expect(tr.isExpectedDisconnect(SRC)).toBe(true);
        expect(tr.isExpectedDisconnect('anything')).toBe(true);
        expect(tr.isExpectedDisconnect(DST)).toBe(false);
    });

    it('expires, so a marker nothing cleared cannot swallow genuine disconnects forever', () => {
        const c = clock();
        const tr = createCallTransitionTracker(c.now);
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        c.advance(CALL_TRANSITION_TTL_MS - 1);
        expect(tr.isExpectedDisconnect(SRC)).toBe(true);
        c.advance(2);
        expect(tr.isExpectedDisconnect(SRC)).toBe(false);
        expect(tr.current()).toBeNull();
    });

    it('a move is complete when its destination connects', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(tr.isMovePendingFor(DST)).toBe(true);
        tr.markConnected('unrelated-call');
        expect(tr.isMovePendingFor(DST)).toBe(true); // some other room connecting is not our move
        tr.markConnected(DST);
        expect(tr.isMovePendingFor(DST)).toBe(false);
        expect(tr.isExpectedDisconnect(SRC)).toBe(false);
    });

    it('a disconnect marker ends when ANY room next connects (the user has moved on)', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        expect(tr.isExpectedDisconnect(SRC)).toBe(true);
        tr.markConnected('a-new-call');
        expect(tr.isExpectedDisconnect(SRC)).toBe(false);
    });

    it('clearMove drops a move marker but keeps a disconnect marker', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        tr.clearMove();
        expect(tr.current()).toBeNull();
        tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        tr.clearMove();
        expect(tr.isExpectedDisconnect(SRC)).toBe(true);
    });
});

// ── What CallPane does with a LiveKit disconnect ─────────────────────────────

describe('decideDisconnectHandling', () => {
    it('PARTICIPANT_REMOVED on the source room DURING a move: no message, no teardown', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, SRC, tr)).toEqual({ toast: null, teardown: false });
    });

    it('negative control: the SAME disconnect with no move in progress is still "removed" + teardown', () => {
        const tr = createCallTransitionTracker();
        const h = decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, SRC, tr);
        expect(h.teardown).toBe(true);
        expect(h.toast).toMatchObject({ title: 'Removed from call', kind: 'warning' });
    });

    it('a PARTICIPANT_REMOVED on the DESTINATION during a move is a genuine kick and is still reported', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        const h = decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, DST, tr);
        expect(h.teardown).toBe(true);
        expect(h.toast?.title).toBe('Removed from call');
    });

    it('a dropped connection on the source during a move is also part of the move (any non-client reason)', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        for (const r of [DisconnectReason.SIGNAL_CLOSE, DisconnectReason.ROOM_DELETED, DisconnectReason.UNKNOWN_REASON]) {
            expect(decideDisconnectHandling(r, SRC, tr)).toEqual({ toast: null, teardown: false });
        }
    });

    it('CLIENT_INITIATED keeps its normal silent teardown, move or not', () => {
        const tr = createCallTransitionTracker();
        expect(decideDisconnectHandling(DisconnectReason.CLIENT_INITIATED, SRC, tr)).toEqual({ toast: null, teardown: true });
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(decideDisconnectHandling(DisconnectReason.CLIENT_INITIATED, SRC, tr)).toEqual({ toast: null, teardown: true });
    });

    it('an unknown reason with no transition keeps the existing silent teardown', () => {
        expect(decideDisconnectHandling(undefined, SRC, createCallTransitionTracker())).toEqual({ toast: null, teardown: true });
    });

    it('a disconnect marker silences the server\'s fallback removal of the room we just left', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        expect(decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, SRC, tr)).toEqual({ toast: null, teardown: false });
    });
});

describe('shouldActOnPaneDisconnect — a replaced pane cannot end the call that replaced it', () => {
    it('only the pane of the CURRENT call may end it', () => {
        expect(shouldActOnPaneDisconnect(DST, DST)).toBe(true);
        expect(shouldActOnPaneDisconnect(SRC, DST)).toBe(false); // the old pane, after the move
        expect(shouldActOnPaneDisconnect(SRC, null)).toBe(false);
        expect(shouldActOnPaneDisconnect(SRC, undefined)).toBe(false);
    });
});

// ── The move, end to end through the same pieces the app uses ────────────────

/** A stand-in for Dashboard's call state + CallPane's disconnect handler. */
function makeApp(opts: { initialCallId?: string | null } = {}) {
    const tr = createCallTransitionTracker();
    const state: {
        activeCall: HuddleSelection['activeCall'] | null;
        activeHuddleCallId: string | null;
        activeHuddleChannelId: string | null;
        activeVoiceChannelId: string | null;
    } = {
        activeCall: opts.initialCallId
            ? buildHuddleSelection({ callId: opts.initialCallId, huddleId: 'huddle-src', name: 'Old', livekitUrl: 'u', livekitToken: 't', isInitiator: false }).activeCall
            : null,
        activeHuddleCallId: opts.initialCallId ?? null,
        activeHuddleChannelId: opts.initialCallId ? 'huddle-src' : null,
        activeVoiceChannelId: null,
    };
    const toasts: Array<{ kind: string; title: string; message: string }> = [];
    const log: string[] = [];
    const announce = vi.fn();

    let joinPending = false;
    const ports = {
        activeCallId: () => state.activeCall?.id ?? null,
        // Dashboard's rule: the device in the source call (or mid-join) acts.
        isInSourceCall: (ev: ForceMoveEventData) => joinPending
            || (ev.from_call_id ? (state.activeCall?.id ?? null) === ev.from_call_id : state.activeHuddleCallId !== null),
        beginJoin: (ev: ForceMoveEventData) => { log.push(`beginJoin:${ev.call_id}`); return { id: 1 }; },
        settleJoin: () => { log.push('settleJoin'); return true; },
        enter: (sel: HuddleSelection) => {
            log.push('enter');
            state.activeVoiceChannelId = sel.activeVoiceChannelId;
            state.activeHuddleCallId = sel.activeHuddleCallId;
            state.activeHuddleChannelId = sel.activeHuddleChannelId;
            state.activeCall = sel.activeCall;
        },
        announce: (ev: ForceMoveEventData) => { log.push('announce'); announce(ev); },
    };

    /** CallPane.onDisconnected + Dashboard's guard + handleDisconnectCall. */
    function oldPaneDisconnected(reason: DisconnectReason, paneCallId: string, { guard = true, transitions = tr } = {}) {
        const h = decideDisconnectHandling(reason, paneCallId, transitions);
        if (h.toast) toasts.push(h.toast);
        if (!h.teardown) return;
        if (guard && !shouldActOnPaneDisconnect(paneCallId, state.activeCall?.id)) return;
        // handleDisconnectCall → handleLeaveHuddleCall: clears everything.
        state.activeHuddleCallId = null;
        state.activeHuddleChannelId = null;
        state.activeCall = null;
    }

    return { tr, state, toasts, log, ports, announce, oldPaneDisconnected, setJoinPending: (v: boolean) => { joinPending = v; } };
}

describe('force_move — both arrival orders end in the SAME correct state with no kicked message', () => {
    const expectedAfterMove = () => buildHuddleSelection({
        callId: DST, huddleId: DST_HUDDLE, name: 'Raid night', livekitUrl: 'wss://lk.example', livekitToken: 'tok-dest', isInitiator: false,
    });

    it('LiveKit removal arrives BEFORE the move has been applied (the race that used to tear the UI down)', () => {
        const app = makeApp({ initialCallId: SRC });
        // WS handler arms the marker synchronously, then sets React state...
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        // ...but the old room's removal beats the Dashboard effect:
        app.oldPaneDisconnected(DisconnectReason.PARTICIPANT_REMOVED, SRC);
        // The effect now runs the move.
        expect(runForceMove(MOVE, app.ports, app.tr)).toBe('entered');

        expect(app.toasts).toEqual([]); // nothing says "kicked" / "removed"
        const exp = expectedAfterMove();
        expect(app.state.activeCall).toEqual(exp.activeCall);
        expect(app.state.activeHuddleCallId).toBe(DST);
        expect(app.state.activeHuddleChannelId).toBe(DST_HUDDLE);
        expect(app.state.activeVoiceChannelId).toBeNull();
    });

    it('LiveKit removal arrives AFTER the move (a stale pane reporting the end of ITS room)', () => {
        const app = makeApp({ initialCallId: SRC });
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        runForceMove(MOVE, app.ports, app.tr);
        app.oldPaneDisconnected(DisconnectReason.PARTICIPANT_REMOVED, SRC);

        expect(app.toasts).toEqual([]);
        expect(app.state.activeCall?.id).toBe(DST);
        expect(app.state.activeHuddleCallId).toBe(DST);
    });

    it('even a STALE pane\'s ordinary teardown (marker already cleared) cannot end the new call', () => {
        const app = makeApp({ initialCallId: SRC });
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        runForceMove(MOVE, app.ports, app.tr);
        app.tr.clear(); // marker expired / cleared — only the pane-id guard is left
        app.oldPaneDisconnected(DisconnectReason.CLIENT_INITIATED, SRC);
        expect(app.state.activeCall?.id).toBe(DST);
        expect(app.state.activeHuddleCallId).toBe(DST);
    });

    it('NEGATIVE CONTROL — the pre-fix behaviour (no marker, no pane guard) reproduces the owner report', () => {
        const app = makeApp({ initialCallId: SRC });
        runForceMove(MOVE, app.ports, app.tr);                       // moved into DST...
        const noTransition = createCallTransitionTracker();           // ...no marker armed
        app.oldPaneDisconnected(DisconnectReason.PARTICIPANT_REMOVED, SRC, { guard: false, transitions: noTransition });

        expect(app.toasts.map(t => t.title)).toContain('Removed from call'); // "says they were kicked"
        expect(app.state.activeCall).toBeNull();                             // "call controls are gone"
        expect(app.state.activeHuddleCallId).toBeNull();                     // ...while the new room's audio still flows
    });

    it('rebuilds the call exactly as a user-initiated switch would: the same selection from the same builder', () => {
        const app = makeApp({ initialCallId: SRC });
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        runForceMove(MOVE, app.ports, app.tr);
        // What handleJoinExistingHuddleCall builds for the same destination.
        const viaJoin = buildHuddleSelection({
            callId: DST, huddleId: DST_HUDDLE, name: 'Raid night', livekitUrl: 'wss://lk.example', livekitToken: 'tok-dest', isInitiator: false,
        });
        expect(app.state.activeCall).toEqual(viaJoin.activeCall);
        expect(app.state.activeCall).toMatchObject({
            id: DST, callsChannelId: DST_HUDDLE, isVoiceChannel: true, voiceChannelName: 'Raid night',
            mode: 'sfu', isInitiator: false, e2ee_key_b64: '',
        });
    });

    it('goes through the normal join steps in order: begin → settle → enter → announce (cue + toast last)', () => {
        const app = makeApp({ initialCallId: SRC });
        runForceMove(MOVE, app.ports, app.tr);
        expect(app.log).toEqual([`beginJoin:${DST}`, 'settleJoin', 'enter', 'announce']);
        expect(app.announce).toHaveBeenCalledWith(MOVE);
    });

    it('does NOT issue a REST leave of its own — leaving the old room is the pane unmounting (client-initiated)', () => {
        // The flow has no "leave" port at all: the only way it changes the
        // old call is replacing activeCall, which re-keys CallPane.
        const app = makeApp({ initialCallId: SRC });
        const keys = Object.keys(app.ports);
        expect(keys).not.toContain('leave');
        expect(keys).toEqual(['activeCallId', 'isInSourceCall', 'beginJoin', 'settleJoin', 'enter', 'announce']);
    });

    it('a replayed event for the call we are already in rebuilds nothing', () => {
        const app = makeApp({ initialCallId: DST });
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(runForceMove(MOVE, app.ports, app.tr)).toBe('already-there');
        expect(app.log).toEqual([]);
        expect(app.tr.isMovePendingFor(DST)).toBe(false);
    });

    it('a second, IDLE device of the same account ignores the move (it would otherwise kick the real one)', () => {
        // The server addresses force_move to every device. Connecting a second
        // client with the same LiveKit identity to the destination would make
        // LiveKit drop the device that IS in the call (DUPLICATE_IDENTITY).
        const idle = makeApp({ initialCallId: null });
        idle.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(runForceMove(MOVE, idle.ports, idle.tr)).toBe('not-in-source');
        expect(idle.state.activeCall).toBeNull();
        expect(idle.log).toEqual([]);
        expect(idle.tr.current()).toBeNull(); // and its marker is dropped, silencing nothing

        const elsewhere = makeApp({ initialCallId: 'a-different-call' });
        expect(runForceMove(MOVE, elsewhere.ports, elsewhere.tr)).toBe('not-in-source');
        expect(elsewhere.state.activeCall?.id).toBe('a-different-call');
    });

    it('the device that IS in the source call acts (negative control for the idle-device rule)', () => {
        const app = makeApp({ initialCallId: SRC });
        expect(runForceMove(MOVE, app.ports, app.tr)).toBe('entered');
    });

    it('a device still mid-join into the source call acts too (its join is the call being left)', () => {
        const app = makeApp({ initialCallId: null });
        app.setJoinPending(true);
        expect(runForceMove(MOVE, app.ports, app.tr)).toBe('entered');
        expect(app.state.activeCall?.id).toBe(DST);
    });

    it('an older server (no from_call_id): the device in a Calls-channel call acts, an idle one does not', () => {
        const legacy: ForceMoveEventData = { ...MOVE, from_call_id: null };
        expect(runForceMove(legacy, makeApp({ initialCallId: SRC }).ports, createCallTransitionTracker())).toBe('entered');
        expect(runForceMove(legacy, makeApp({ initialCallId: null }).ports, createCallTransitionTracker())).toBe('not-in-source');
    });

    it('a join superseded between begin and settle is not entered', () => {
        const app = makeApp({ initialCallId: SRC });
        app.ports.settleJoin = () => false;
        expect(runForceMove(MOVE, app.ports, app.tr)).toBe('superseded');
        expect(app.state.activeCall?.id).toBe(SRC);
    });

    it('two moves in a row: the second replaces the first; each marks only its own source', () => {
        const app = makeApp({ initialCallId: SRC });
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        runForceMove(MOVE, app.ports, app.tr);
        const second: ForceMoveEventData = { ...MOVE, call_id: 'call-third', huddle_id: 'huddle-third', call_name: 'Third', from_call_id: DST, nonce: 2 };
        app.tr.begin({ kind: 'move', fromCallId: DST, toCallId: 'call-third' });
        runForceMove(second, app.ports, app.tr);
        expect(app.state.activeCall?.id).toBe('call-third');
        // The removal of the intermediate room is part of the second move...
        expect(decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, DST, app.tr).teardown).toBe(false);
        // ...and a stale one from the very first room no longer is (nothing to silence there).
        expect(decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, SRC, app.tr).teardown).toBe(true);
    });

    it('a move while a different join is still in flight: the move takes over via the same begin/settle', () => {
        const app = makeApp({ initialCallId: null });
        app.setJoinPending(true); // a join into the source call is in flight
        const begin = vi.fn(() => ({ id: 2 }));
        app.ports.beginJoin = begin;
        runForceMove(MOVE, app.ports, app.tr);
        expect(begin).toHaveBeenCalledTimes(1); // beginCallJoin supersedes the open attempt itself
        expect(app.state.activeCall?.id).toBe(DST);
    });
});

// ── Failure path ─────────────────────────────────────────────────────────────

describe('a move whose destination fails to connect', () => {
    it('is reported as "Couldn\'t move you to X", not a generic connection error', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(failureTitleFor(DST, 'Raid night', tr)).toBe("Couldn't move you to Raid night");
        expect(moveFailureTitle('  Raid night ')).toBe("Couldn't move you to Raid night");
        expect(moveFailureTitle(undefined)).toBe("Couldn't move you to the call");
    });

    it('an ordinary join failure keeps the generic title (negative control)', () => {
        const tr = createCallTransitionTracker();
        expect(failureTitleFor(DST, 'Raid night', tr)).toBeUndefined();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        expect(failureTitleFor('some-other-call', 'X', tr)).toBeUndefined();
    });

    it('once connected the move is over, so a later failure is not mislabelled', () => {
        const tr = createCallTransitionTracker();
        tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        tr.markConnected(DST);
        expect(failureTitleFor(DST, 'Raid night', tr)).toBeUndefined();
    });

    it('leaving clears the pending move, so the user is left out of calls with no stale label', () => {
        const app = makeApp({ initialCallId: SRC });
        app.tr.begin({ kind: 'move', fromCallId: SRC, toCallId: DST });
        runForceMove(MOVE, app.ports, app.tr);
        // CallPane: connection failed → toast titled for the move → stableOnLeave → handleDisconnectCall
        const title = failureTitleFor(DST, MOVE.call_name, app.tr);
        expect(title).toBe("Couldn't move you to Raid night");
        app.tr.clearMove();               // handleDisconnectCall
        app.state.activeHuddleCallId = null; app.state.activeHuddleChannelId = null; app.state.activeCall = null;
        // Clean: out of every call, no pending marker, nothing half-built.
        expect(app.state).toEqual({ activeCall: null, activeHuddleCallId: null, activeHuddleChannelId: null, activeVoiceChannelId: null });
        expect(app.tr.current()).toBeNull();
        expect(failureTitleFor(DST, MOVE.call_name, app.tr)).toBeUndefined();
    });
});

// ── force_disconnect ─────────────────────────────────────────────────────────

describe('force_disconnect — a clean leave with the right notice', () => {
    function makeDisc(over: { callId?: string | null; voiceId?: string | null } = {}) {
        const tr = createCallTransitionTracker();
        const calls: string[] = [];
        const toasts: Array<{ kind: string; title: string; message: string }> = [];
        const ports = {
            activeCallId: () => (over.callId === undefined ? SRC : over.callId),
            activeVoiceChannelId: () => over.voiceId ?? null,
            leave: () => calls.push('leave'),
            toast: (t: { kind: 'info'; title: string; message: string }) => { calls.push('toast'); toasts.push(t); },
            playLeaveCue: () => calls.push('cue'),
        };
        return { tr, calls, toasts, ports };
    }

    it('leaves the call and says who did it, as information (not a warning or error)', () => {
        const d = makeDisc();
        d.tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        expect(runForceDisconnect({ call_id: SRC, channel_id: 'huddle-src', by_name: 'Modly' }, d.ports, d.tr)).toBe('left');
        expect(d.calls).toEqual(['leave', 'cue', 'toast']);
        expect(d.toasts).toEqual([{
            kind: 'info', title: 'Disconnected from call', message: 'You were disconnected from the call by Modly.',
        }]);
    });

    it('never calls it "kicked" or "removed" — and plays the neutral leave cue, not an error tone', () => {
        const t = disconnectedToast('Modly');
        expect(t.kind).toBe('info');
        expect(`${t.title} ${t.message}`.toLowerCase()).not.toMatch(/kick|remov|error|fail/);
        const d = makeDisc();
        runForceDisconnect({ call_id: SRC, channel_id: 'h', by_name: 'M' }, d.ports, d.tr);
        expect(d.calls).toContain('cue');
    });

    it('falls back to "a moderator" when the server did not name them', () => {
        expect(disconnectedToast(undefined).message).toBe('You were disconnected from the call by a moderator.');
        expect(disconnectedToast('   ').message).toBe('You were disconnected from the call by a moderator.');
    });

    it('the server\'s fallback removal that follows reads as part of the disconnect (no "Removed from call")', () => {
        const d = makeDisc();
        d.tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        runForceDisconnect({ call_id: SRC, channel_id: 'h', by_name: 'M' }, d.ports, d.tr);
        expect(decideDisconnectHandling(DisconnectReason.PARTICIPANT_REMOVED, SRC, d.tr)).toEqual({ toast: null, teardown: false });
    });

    it('a legacy voice channel is matched by channel id', () => {
        const d = makeDisc({ callId: 'voice-session', voiceId: 'voice-ch' });
        expect(runForceDisconnect({ call_id: 'other', channel_id: 'voice-ch', by_name: 'M' }, d.ports, d.tr)).toBe('left');
    });

    it('is ignored when this client is in a different call (another device, or already left) and disarms the marker', () => {
        const d = makeDisc({ callId: 'some-other-call' });
        d.tr.begin({ kind: 'disconnect', fromCallId: SRC, toCallId: null });
        expect(runForceDisconnect({ call_id: SRC, channel_id: 'huddle-src', by_name: 'M' }, d.ports, d.tr)).toBe('not-in-that-call');
        expect(d.calls).toEqual([]);
        expect(d.tr.current()).toBeNull();
    });

    it('is ignored when this client is in no call at all', () => {
        const d = makeDisc({ callId: null });
        expect(runForceDisconnect({ call_id: SRC, channel_id: 'huddle-src', by_name: 'M' }, d.ports, d.tr)).toBe('not-in-that-call');
        expect(d.toasts).toEqual([]);
    });
});

// ── Wire parsing ─────────────────────────────────────────────────────────────

describe('wire parsing (WS payloads are untrusted)', () => {
    it('parses a well-formed force_disconnect', () => {
        expect(parseForceDisconnect({ call_id: 'c', channel_id: 'h', by_name: 'Modly' })).toEqual({ call_id: 'c', channel_id: 'h', by_name: 'Modly' });
    });

    it.each([
        ['missing call_id', { channel_id: 'h' }],
        ['missing channel_id', { call_id: 'c' }],
        ['non-string ids', { call_id: 5, channel_id: {} }],
        ['empty ids', { call_id: '', channel_id: '' }],
        ['over-long id', { call_id: 'x'.repeat(65), channel_id: 'h' }],
        ['null', null],
        ['a string', 'huddle:force_disconnect'],
    ])('rejects %s', (_label, data) => {
        expect(parseForceDisconnect(data)).toBeNull();
    });

    it('ignores a non-string by_name rather than trusting it', () => {
        expect(parseForceDisconnect({ call_id: 'c', channel_id: 'h', by_name: { evil: true } })?.by_name).toBeUndefined();
    });

    it('from_call_id: a string id, else null (older servers)', () => {
        expect(parseFromCallId('abc')).toBe('abc');
        expect(parseFromCallId(undefined)).toBeNull();
        expect(parseFromCallId(7)).toBeNull();
        expect(parseFromCallId('')).toBeNull();
    });
});
