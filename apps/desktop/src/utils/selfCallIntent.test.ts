import { describe, it, expect, beforeEach } from 'vitest';
import {
    NO_SELF_INTENT,
    deriveSelfIntent,
    resolveCarriedIntent,
    selfCallIntent,
    shouldPublishMicAtConnect,
    shouldWarmMic,
    type SelfCallIntent,
} from './selfCallIntent';
import {
    createCallTransitionTracker,
    runForceMove,
    type ForceMoveEventData,
} from './callTransition';

/**
 * Self-mute / self-deafen are the person's, not the call's.
 *
 * Bug: beginCallJoin reset the join intent to "not muted, not deafened" for
 * EVERY join, including the one a moderator's move performs, so someone muted
 * in call A and dragged into call B was connected with the mic requested on -
 * a hot mic. These tests drive the same pure pieces the Dashboard (beginCallJoin)
 * and CallPane (the room's `audio` option) use, and assert the ORDER of what
 * happens so "unmuted publish, then re-mute" can never pass.
 */

beforeEach(() => selfCallIntent.clear());

const MUTED: SelfCallIntent = { muted: true, deafened: false };
const DEAF_NOT_MUTED: SelfCallIntent = { muted: false, deafened: true };
const DEAF_AND_MUTED: SelfCallIntent = { muted: true, deafened: true };

// ── Deriving the intent in the call ──────────────────────────────────────────

describe('deriveSelfIntent', () => {
    const base = { micOff: false, selfDeafened: false, wasMutedBeforeDeafen: false, pushToTalk: false, serverForcedMute: false, canSpeak: true };

    it('mic on → not muted', () => {
        expect(deriveSelfIntent(base)).toEqual({ muted: false, deafened: false });
    });

    it('mic off by the user\'s choice → muted', () => {
        expect(deriveSelfIntent({ ...base, micOff: true })).toEqual(MUTED);
    });

    it('push-to-talk holding the mic closed is NOT a mute', () => {
        expect(deriveSelfIntent({ ...base, micOff: true, pushToTalk: true }).muted).toBe(false);
    });

    it('a moderator\'s server-mute / server-deafen is NOT the user\'s mute (it must not become one)', () => {
        expect(deriveSelfIntent({ ...base, micOff: true, serverForcedMute: true }).muted).toBe(false);
    });

    it('a listen-only member (no SPEAK) has the mic off by permission, not choice', () => {
        expect(deriveSelfIntent({ ...base, micOff: true, canSpeak: false }).muted).toBe(false);
    });

    it('deafened remembers whether they were muted before (deafen force-mutes the mic)', () => {
        expect(deriveSelfIntent({ ...base, micOff: true, selfDeafened: true, wasMutedBeforeDeafen: false })).toEqual(DEAF_NOT_MUTED);
        expect(deriveSelfIntent({ ...base, micOff: true, selfDeafened: true, wasMutedBeforeDeafen: true })).toEqual(DEAF_AND_MUTED);
    });
});

// ── What the next join starts with ───────────────────────────────────────────

describe('resolveCarriedIntent', () => {
    const idle = { inCall: false, starting: false, connected: false, joinIntent: NO_SELF_INTENT, stored: null };

    it('joining from NOTHING starts clean, even if a stale value is lying around', () => {
        expect(resolveCarriedIntent({ ...idle, stored: DEAF_AND_MUTED })).toEqual(NO_SELF_INTENT);
    });

    it('in a connected call: the in-call state is carried', () => {
        expect(resolveCarriedIntent({ ...idle, inCall: true, connected: true, stored: MUTED })).toEqual(MUTED);
        expect(resolveCarriedIntent({ ...idle, inCall: true, connected: true, stored: DEAF_NOT_MUTED })).toEqual(DEAF_NOT_MUTED);
    });

    it('still joining: the joining controls are the truth (the in-call UI is not up yet)', () => {
        expect(resolveCarriedIntent({ ...idle, inCall: true, connected: false, joinIntent: MUTED, stored: NO_SELF_INTENT })).toEqual(MUTED);
        expect(resolveCarriedIntent({ ...idle, starting: true, joinIntent: DEAF_NOT_MUTED })).toEqual(DEAF_NOT_MUTED);
    });

    it('connected but nothing published yet: falls back to the join intent rather than dropping it', () => {
        expect(resolveCarriedIntent({ ...idle, inCall: true, connected: true, joinIntent: MUTED, stored: null })).toEqual(MUTED);
    });

    it('does not alias the stored object', () => {
        selfCallIntent.set(MUTED);
        const a = resolveCarriedIntent({ ...idle, inCall: true, connected: true, stored: selfCallIntent.get() });
        a.muted = false;
        expect(selfCallIntent.get()).toEqual(MUTED);
    });
});

describe('selfCallIntent store', () => {
    it('set / get / clear', () => {
        expect(selfCallIntent.get()).toBeNull();
        selfCallIntent.set(DEAF_AND_MUTED);
        expect(selfCallIntent.get()).toEqual(DEAF_AND_MUTED);
        selfCallIntent.clear();
        expect(selfCallIntent.get()).toBeNull();
    });
});

// ── The mic at connect ───────────────────────────────────────────────────────

describe('shouldPublishMicAtConnect / shouldWarmMic', () => {
    it('only an unmuted, undeafened user whose token allows it opens the mic', () => {
        expect(shouldPublishMicAtConnect(NO_SELF_INTENT, true)).toBe(true);   // negative control: the happy path still works
        expect(shouldPublishMicAtConnect(MUTED, true)).toBe(false);
        expect(shouldPublishMicAtConnect(DEAF_NOT_MUTED, true)).toBe(false);
        expect(shouldPublishMicAtConnect(DEAF_AND_MUTED, true)).toBe(false);
        expect(shouldPublishMicAtConnect(NO_SELF_INTENT, false)).toBe(false); // listen-only token
    });

    it('does not warm (open) the mic device for a join that will not use it', () => {
        expect(shouldWarmMic(NO_SELF_INTENT)).toBe(true);
        expect(shouldWarmMic(MUTED)).toBe(false);
        expect(shouldWarmMic(DEAF_NOT_MUTED)).toBe(false);
    });
});

// ── End to end: the ORDER of what happens to the mic ─────────────────────────

/** Dashboard.beginCallJoin → CallPane's LiveKitRoom, as a recorded sequence. */
function joinSequence(prior: { inCall: boolean; connected: boolean; stored: SelfCallIntent | null; joinIntent?: SelfCallIntent }, tokenAllowsMic = true) {
    const log: string[] = [];
    if (prior.stored) selfCallIntent.set(prior.stored);
    // beginCallJoin
    const carried = resolveCarriedIntent({
        inCall: prior.inCall, starting: false, connected: prior.connected,
        joinIntent: prior.joinIntent ?? NO_SELF_INTENT, stored: selfCallIntent.get(),
    });
    log.push(`joinIntent=${carried.muted ? 'muted' : 'live'}/${carried.deafened ? 'deafened' : 'hearing'}`);
    if (shouldWarmMic(carried)) log.push('prewarmMic');
    // CallPane mounts LiveKitRoom with audio={joinWithMic}; LiveKit publishes only if true.
    const audio = shouldPublishMicAtConnect(carried, tokenAllowsMic);
    log.push(`connect(audio=${audio})`);
    if (audio) log.push('publish:microphone');
    // SidebarConference mounts seeded from the same intent: silenced from its first render.
    log.push(`sidebarSeed(deafened=${carried.deafened})`);
    return { log, carried };
}

describe('muted in call A → into call B: the mic is never opened, in this order', () => {
    it('user-initiated switch', () => {
        const { log } = joinSequence({ inCall: true, connected: true, stored: MUTED });
        expect(log).toEqual(['joinIntent=muted/hearing', 'connect(audio=false)', 'sidebarSeed(deafened=false)']);
        expect(log).not.toContain('publish:microphone');
        expect(log).not.toContain('prewarmMic');
    });

    it('deafened likewise: nothing captured, remote audio silenced from the first sidebar render', () => {
        const { log } = joinSequence({ inCall: true, connected: true, stored: DEAF_NOT_MUTED });
        expect(log).toEqual(['joinIntent=live/deafened', 'connect(audio=false)', 'sidebarSeed(deafened=true)']);
    });

    it('deafened AND muted keeps both', () => {
        const { carried } = joinSequence({ inCall: true, connected: true, stored: DEAF_AND_MUTED });
        expect(carried).toEqual(DEAF_AND_MUTED);
    });

    it('NEGATIVE CONTROL: an unmuted user IS connected with the mic (so the assertions above are not vacuous)', () => {
        const { log } = joinSequence({ inCall: true, connected: true, stored: NO_SELF_INTENT });
        expect(log).toEqual(['joinIntent=live/hearing', 'prewarmMic', 'connect(audio=true)', 'publish:microphone', 'sidebarSeed(deafened=false)']);
    });

    it('NEGATIVE CONTROL: the pre-fix behaviour (reset to clean) would have published the mic', () => {
        // Pre-fix beginCallJoin: setJoinIntent({ muted: false, deafened: false }) unconditionally.
        const preFix = NO_SELF_INTENT;
        expect(shouldPublishMicAtConnect(preFix, true)).toBe(true);
    });

    it('joining from no call starts clean even after a muted call was left', () => {
        selfCallIntent.set(MUTED);
        selfCallIntent.clear(); // handleDisconnectCall on a real leave
        const { log } = joinSequence({ inCall: false, connected: false, stored: null });
        expect(log).toContain('connect(audio=true)');
    });

    it('a listen-only token never publishes regardless', () => {
        const { log } = joinSequence({ inCall: true, connected: true, stored: NO_SELF_INTENT }, false);
        expect(log).toContain('connect(audio=false)');
    });
});

describe('a MODERATOR\'S move carries the mute through the real move flow', () => {
    const MOVE: ForceMoveEventData = {
        huddle_id: 'h2', call_id: 'B', call_name: 'B', livekit_url: 'wss://x', livekit_token: 't',
        moved_by: 'mod', from_call_id: 'A', nonce: 1,
    };

    function moveFrom(stored: SelfCallIntent) {
        const log: string[] = [];
        selfCallIntent.set(stored);
        const ports = {
            activeCallId: () => 'A',
            isInSourceCall: () => true,
            // Dashboard's beginCallJoin: carry first, then (if not muted) warm the mic.
            beginJoin: () => {
                const carried = resolveCarriedIntent({ inCall: true, starting: false, connected: true, joinIntent: NO_SELF_INTENT, stored: selfCallIntent.get() });
                log.push(`beginJoin(intent=${carried.muted ? 'muted' : 'live'}/${carried.deafened ? 'deaf' : 'hear'})`);
                if (shouldWarmMic(carried)) log.push('prewarmMic');
                return carried;
            },
            settleJoin: () => { log.push('settleJoin'); return true; },
            enter: () => { log.push('enter'); },
            announce: () => { log.push('announce'); },
        };
        const outcome = runForceMove(MOVE, ports, createCallTransitionTracker());
        // The new CallPane mounts only after `enter`: its connect options come from the carried intent.
        const carried = resolveCarriedIntent({ inCall: true, starting: false, connected: true, joinIntent: NO_SELF_INTENT, stored: selfCallIntent.get() });
        log.push(`connect(audio=${shouldPublishMicAtConnect(carried, true)})`);
        return { outcome, log };
    }

    it('muted in A → moved to B: carried before the room is built, mic requested never', () => {
        const { outcome, log } = moveFrom(MUTED);
        expect(outcome).toBe('entered');
        expect(log).toEqual(['beginJoin(intent=muted/hear)', 'settleJoin', 'enter', 'announce', 'connect(audio=false)']);
        expect(log.indexOf('beginJoin(intent=muted/hear)')).toBeLessThan(log.indexOf('enter'));
        expect(log.some(l => l.includes('audio=true'))).toBe(false);
    });

    it('deafened in A → moved to B', () => {
        const { log } = moveFrom(DEAF_NOT_MUTED);
        expect(log[0]).toBe('beginJoin(intent=live/deaf)');
        expect(log[log.length - 1]).toBe('connect(audio=false)');
        expect(log).not.toContain('prewarmMic');
    });

    it('negative control: an unmuted member is moved with the mic on', () => {
        const { log } = moveFrom(NO_SELF_INTENT);
        expect(log).toContain('prewarmMic');
        expect(log[log.length - 1]).toBe('connect(audio=true)');
    });
});
