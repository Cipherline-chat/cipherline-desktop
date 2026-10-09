import { describe, it, expect } from 'vitest';
import {
    deriveCallJoinPhase, isJoinPending, joinPhaseLabel,
    createJoinAttemptTracker, describeCallJoinFailure, isSameJoinInFlight, huddleJoinHeaders,
    startJoinTimeline, markJoinStage, formatJoinTimeline,
    type CallJoinPhaseInput,
} from './callJoinFlow';

const base: CallJoinPhaseInput = { isStartingCall: false, activeCallId: null, keyGateKind: 'blocked', roomConnectedCallId: null };

describe('deriveCallJoinPhase', () => {
    it('idle with nothing going on', () => {
        expect(deriveCallJoinPhase(base)).toBe('idle');
    });
    it('requesting from the click until a call object exists', () => {
        expect(deriveCallJoinPhase({ ...base, isStartingCall: true })).toBe('requesting');
    });
    it('securing while the call exists but the key gate is still blocked (CallPane not mounted)', () => {
        expect(deriveCallJoinPhase({ ...base, activeCallId: 'c1', keyGateKind: 'blocked' })).toBe('securing');
        // isStartingCall is irrelevant once the call exists
        expect(deriveCallJoinPhase({ ...base, isStartingCall: true, activeCallId: 'c1', keyGateKind: 'blocked' })).toBe('securing');
    });
    it('connecting once the key is held and until THIS call reports connected', () => {
        expect(deriveCallJoinPhase({ ...base, activeCallId: 'c1', keyGateKind: 'connect' })).toBe('connecting');
    });
    it('connected only when the connected id is the active call id', () => {
        expect(deriveCallJoinPhase({ ...base, activeCallId: 'c1', keyGateKind: 'connect', roomConnectedCallId: 'c1' })).toBe('connected');
    });
    it('a stale connected id from another call never skips connecting', () => {
        expect(deriveCallJoinPhase({ ...base, activeCallId: 'c2', keyGateKind: 'connect', roomConnectedCallId: 'c1' })).toBe('connecting');
    });
    it('a key gate that drops back to blocked is securing again even if the room had connected', () => {
        // (in practice the gate holds a latched key for a live call; this
        // pins that "blocked" always wins, so nothing is shown as connected
        // without a key)
        expect(deriveCallJoinPhase({ ...base, activeCallId: 'c1', keyGateKind: 'blocked', roomConnectedCallId: 'c1' })).toBe('securing');
    });
});

describe('isJoinPending / joinPhaseLabel', () => {
    it('pending exactly in the three in-flight phases', () => {
        expect(isJoinPending('idle')).toBe(false);
        expect(isJoinPending('requesting')).toBe(true);
        expect(isJoinPending('securing')).toBe(true);
        expect(isJoinPending('connecting')).toBe(true);
        expect(isJoinPending('connected')).toBe(false);
    });
    it('labels name the phase and nothing else', () => {
        expect(joinPhaseLabel('requesting')).toBe('Joining…');
        expect(joinPhaseLabel('securing')).toBe('Securing…');
        expect(joinPhaseLabel('connecting')).toBe('Connecting…');
        expect(joinPhaseLabel('connected')).toBe('');
        expect(joinPhaseLabel('idle')).toBe('');
    });
});

describe('createJoinAttemptTracker', () => {
    it('a plain join settles live exactly once', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        expect(t.pending()).toBe(a);
        expect(t.settle(a)).toBe(true);
        expect(t.pending()).toBeNull();
        expect(t.settle(a)).toBe(false); // never commits twice
    });
    it('Leave mid-join: the late result is not committed', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        expect(t.cancel()).toBe(a);
        expect(t.pending()).toBeNull();
        expect(t.settle(a)).toBe(false);
    });
    it('cancel with nothing open is a no-op', () => {
        const t = createJoinAttemptTracker();
        expect(t.cancel()).toBeNull();
        const a = t.begin('x');
        t.settle(a);
        expect(t.cancel()).toBeNull();
    });
    it('a newer join supersedes an older one still in flight', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        const b = t.begin('voice:2');
        expect(t.settle(a)).toBe(false);
        expect(t.settle(b)).toBe(true);
    });
    it('the older result landing AFTER the newer one committed still does not commit', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        const b = t.begin('voice:2');
        expect(t.settle(b)).toBe(true);
        expect(t.settle(a)).toBe(false);
    });
    it('fail closes the attempt without committing', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('x');
        t.fail(a);
        expect(t.pending()).toBeNull();
        expect(t.settle(a)).toBe(false);
    });
    it('mayUndo: an abandoned join is undone… unless a newer open join targets the same thing', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        t.cancel();
        expect(t.mayUndo(a)).toBe(true); // nothing newer → undo
        const b = t.begin('voice:1'); // clicked straight back in
        expect(t.mayUndo(a)).toBe(false); // undoing a would kick them out of b
        const c = t.begin('voice:2'); // b superseded by a different channel
        expect(t.mayUndo(b)).toBe(true); // newest voice:1 attempt is b itself
        expect(t.mayUndo(a)).toBe(true); // b (newer, same target) was cancelled → protects nothing
        expect(t.settle(c)).toBe(true);
    });
    it('mayUndo: a newer same-target join that already COMMITTED still protects (slow old response)', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        t.cancel();
        const b = t.begin('voice:1');
        expect(t.settle(b)).toBe(true); // the new join landed first and is the live call
        expect(t.settle(a)).toBe(false); // the old one lands late…
        expect(t.mayUndo(a)).toBe(false); // …and must not leave the channel they are in
    });
    it('mayUndo: a newer same-target join that FAILED protects nothing', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('voice:1');
        t.cancel();
        const b = t.begin('voice:1');
        t.fail(b);
        expect(t.mayUndo(a)).toBe(true);
    });
});

describe('describeCallJoinFailure', () => {
    const http = (status: number, headers: Record<string, unknown> = {}) => ({ response: { status, headers } });

    it('426 → no toast (the upgrade overlay owns it)', () => {
        expect(describeCallJoinFailure(http(426), 'voice')).toEqual({ toast: null });
    });
    it('429 → a cooldown from Retry-After, and a warning that says how long', () => {
        const f = describeCallJoinFailure(http(429, { 'retry-after': '7' }), 'huddle-join');
        expect(f.cooldownMs).toBe(7000);
        expect(f.toast?.kind).toBe('warning');
        expect(f.toast?.message).toContain('7s');
    });
    it('429 without a usable Retry-After falls back to 10s', () => {
        expect(describeCallJoinFailure(http(429), 'voice').cooldownMs).toBe(10_000);
        expect(describeCallJoinFailure(http(429, { 'retry-after': 'soon' }), 'voice').cooldownMs).toBe(10_000);
    });
    it('409 → answered elsewhere (info, not an error)', () => {
        expect(describeCallJoinFailure(http(409), 'dm-join').toast?.kind).toBe('info');
    });
    it('403 → permission wording, channel-specific for voice', () => {
        expect(describeCallJoinFailure(http(403), 'voice').toast?.message).toMatch(/permission to join this voice channel/);
        expect(describeCallJoinFailure(http(403), 'huddle-join').toast?.message).toMatch(/permission to join this call/);
    });
    it('404 → the call has ended', () => {
        expect(describeCallJoinFailure(http(404), 'dm-join').toast?.message).toBe('That call has ended.');
    });
    it('network / unknown → the per-kind default, as an error', () => {
        const f = describeCallJoinFailure(new Error('timeout of 15000ms exceeded'), 'voice');
        expect(f.toast).toEqual({ kind: 'error', title: 'Call connection failed', message: "Couldn't join the voice channel — check your network and try again." });
        expect(describeCallJoinFailure(null, 'huddle-spawn').toast?.message).toMatch(/start the call/);
        expect(f.cooldownMs).toBeUndefined();
    });
});

describe('join timeline', () => {
    it('records each stage once, relative to the click', () => {
        const t = startJoinTimeline('voice', 1000);
        expect(markJoinStage(t, 'ui', 1012)).toBe(true);
        expect(markJoinStage(t, 'ui', 1500)).toBe(false); // first one counts
        expect(t.marks.ui).toBe(12);
        expect(markJoinStage(null, 'ui', 5)).toBe(false);
    });
    it('formats per-stage deltas and the total, with no ids', () => {
        const t = startJoinTimeline('voice', 0);
        markJoinStage(t, 'ui', 12);
        markJoinStage(t, 'request', 310);
        markJoinStage(t, 'key', 313);
        markJoinStage(t, 'connected', 925);
        markJoinStage(t, 'mic', 1068);
        expect(formatJoinTimeline(t)).toBe('voice · ui 12ms · request +298ms · key +3ms · connected +612ms · mic +143ms · total 1068ms');
    });
    it('skips stages that never happened and never prints a negative delta', () => {
        const t = startJoinTimeline('dm-join', 0);
        markJoinStage(t, 'request', 200);
        markJoinStage(t, 'ui', 250); // a late first-frame mark
        markJoinStage(t, 'connected', 600);
        const line = formatJoinTimeline(t);
        expect(line).toBe('dm-join · ui 250ms · request +0ms · connected +350ms · total 600ms');
        expect(line).not.toMatch(/\+-/);
    });
});

// Ghost-call fix (2026-10-08): a second click on "start a call" while the
// first spawn was in flight created a second call room.
describe('isSameJoinInFlight — re-entrancy guard', () => {
    it('a repeat of the in-flight join is recognised', () => {
        const t = createJoinAttemptTracker();
        t.begin('spawn:h1');
        expect(isSameJoinInFlight(t, 'spawn:h1')).toBe(true);
    });

    it('control: a different target is not a repeat (it supersedes, as before)', () => {
        const t = createJoinAttemptTracker();
        t.begin('spawn:h1');
        expect(isSameJoinInFlight(t, 'spawn:h2')).toBe(false);
        expect(isSameJoinInFlight(t, 'huddle-call:c1')).toBe(false);
    });

    it('control: once the join settled, failed or was cancelled, the same target may start again', () => {
        const t = createJoinAttemptTracker();
        const a = t.begin('spawn:h1');
        t.settle(a);
        expect(isSameJoinInFlight(t, 'spawn:h1')).toBe(false);
        const b = t.begin('spawn:h1');
        t.fail(b);
        expect(isSameJoinInFlight(t, 'spawn:h1')).toBe(false);
        t.begin('spawn:h1');
        t.cancel();
        expect(isSameJoinInFlight(t, 'spawn:h1')).toBe(false);
    });

    it('control: nothing in flight → not a repeat', () => {
        expect(isSameJoinInFlight(createJoinAttemptTracker(), 'spawn:h1')).toBe(false);
    });
});

describe('huddleJoinHeaders', () => {
    it('carries the device id so the server can retire this device\'s other calls', () => {
        expect(huddleJoinHeaders('tok', 'dev-1')).toEqual({ Authorization: 'Bearer tok', 'x-device-id': 'dev-1' });
    });
    it('control: omits it when unknown', () => {
        expect(huddleJoinHeaders('tok', null)).toEqual({ Authorization: 'Bearer tok' });
    });
});
