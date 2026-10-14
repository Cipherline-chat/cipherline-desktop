import { describe, it, expect, vi } from 'vitest';
import {
    announceForceMove, wasMovedByOther, moverLabel, movedToastMessage, UNKNOWN_MOVER_LABEL,
    type ForceMoveEvent,
} from './callMove';
import { addSpawnedCall, spawnedCallParticipants, displayHuddleCalls } from './joinView';
import type { HuddleCallInfo } from '../hooks/useServers';

const ME = 'user-b';
const MOD = 'user-a';

const ev = (over: Partial<ForceMoveEvent> = {}): ForceMoveEvent => ({
    huddle_id: 'h2', call_id: 'c2', call_name: "Modly's Call", moved_by: MOD, moved_by_name: 'Modly', nonce: 1, ...over,
});

function harness(selfUserId: string | null = ME) {
    const playMovedCue = vi.fn();
    const pushToast = vi.fn();
    const lastNonce = { current: null as number | null };
    return {
        playMovedCue, pushToast, lastNonce,
        deps: { selfUserId, playMovedCue, pushToast, lastNonce },
    };
}

describe('announceForceMove — the moved user hears and sees it, once', () => {
    it('plays the cue once and toasts "moved to <call> by <name>"', () => {
        const h = harness();
        expect(announceForceMove(ev(), h.deps)).toBe(true);
        expect(h.playMovedCue).toHaveBeenCalledTimes(1);
        expect(h.pushToast).toHaveBeenCalledTimes(1);
        expect(h.pushToast).toHaveBeenCalledWith({
            kind: 'info', title: 'You were moved', message: "You were moved to Modly's Call by Modly.",
        });
    });

    it('does not play twice when the same event is announced again (effect re-run)', () => {
        const h = harness();
        const e = ev();
        announceForceMove(e, h.deps);
        announceForceMove(e, h.deps);
        expect(h.playMovedCue).toHaveBeenCalledTimes(1);
        expect(h.pushToast).toHaveBeenCalledTimes(1);
    });

    it('plays again for a second, distinct move (new nonce)', () => {
        const h = harness();
        announceForceMove(ev({ nonce: 1 }), h.deps);
        announceForceMove(ev({ nonce: 2 }), h.deps);
        expect(h.playMovedCue).toHaveBeenCalledTimes(2);
    });

    it('is silent (no cue, no toast) when we moved ourselves', () => {
        const h = harness();
        expect(announceForceMove(ev({ moved_by: ME }), h.deps)).toBe(false);
        expect(h.playMovedCue).not.toHaveBeenCalled();
        expect(h.pushToast).not.toHaveBeenCalled();
    });

    it('is silent when we do not know who we are yet', () => {
        const h = harness(null);
        announceForceMove(ev(), h.deps);
        expect(h.playMovedCue).not.toHaveBeenCalled();
    });

    it('falls back to the local roster name, then to "a moderator"', () => {
        const h1 = harness();
        announceForceMove(ev({ moved_by_name: undefined }), { ...h1.deps, lookupName: uid => (uid === MOD ? 'Nick' : undefined) });
        expect(h1.pushToast.mock.calls[0][0].message).toBe("You were moved to Modly's Call by Nick.");

        const h2 = harness();
        announceForceMove(ev({ moved_by_name: '  ' }), h2.deps);
        expect(h2.pushToast.mock.calls[0][0].message).toBe(`You were moved to Modly's Call by ${UNKNOWN_MOVER_LABEL}.`);
    });

    it('pure helpers', () => {
        expect(wasMovedByOther({ moved_by: MOD }, ME)).toBe(true);
        expect(wasMovedByOther({ moved_by: ME }, ME)).toBe(false);
        expect(moverLabel({ moved_by: MOD })).toBe(UNKNOWN_MOVER_LABEL);
        expect(movedToastMessage('', 'X')).toBe('You were moved to another call by X.');
    });
});

describe('the actor is never drawn inside a call they only spawned by moving someone', () => {
    const base: Omit<HuddleCallInfo, 'participants' | 'huddle_id'> = {
        call_id: 'c2', name: "Modly's Call", spawner_user_id: MOD, spawned_at: '2026-10-13T10:00:00Z',
    };

    it('server roster [] seeds an empty call, not [spawner]', () => {
        expect(spawnedCallParticipants({ ...base, participants: [] })).toEqual([]);
    });

    it('after spawn + the moved user\'s join, the roster is exactly [moved user]', () => {
        const afterSpawn = addSpawnedCall({}, 'h2', { ...base, participants: [] });
        expect(afterSpawn.h2[0].participants).toEqual([]);
        // The follow-up `huddle:participant` join (applyHuddleParticipant semantics).
        const afterJoin = {
            h2: afterSpawn.h2.map(c => ({ ...c, participants: [...new Set([...c.participants, ME])] })),
        };
        expect(afterJoin.h2[0].participants).toEqual([ME]);
        expect(afterJoin.h2[0].participants).not.toContain(MOD);
    });

    it('the actor\'s own display (not in this call) does not list them in it', () => {
        const spawned = addSpawnedCall({}, 'h2', { ...base, participants: [] });
        // Before the moved user's join lands the call is empty, so it is not
        // drawn at all (rather than drawn with the moderator in it).
        expect(displayHuddleCalls(spawned, null, MOD, 'their-own-call').calls.h2).toEqual([]);
        const joined = { h2: spawned.h2.map(c => ({ ...c, participants: [ME] })) };
        const asMod = displayHuddleCalls(joined, null, MOD, 'their-own-call');
        expect(asMod.calls.h2[0].participants).toEqual([ME]);
        expect(asMod.mineCallId).toBe('their-own-call');
    });

    it('an ordinary spawn (server sends [spawner]) still shows the spawner inside', () => {
        const s = addSpawnedCall({}, 'h2', { ...base, participants: [MOD] });
        expect(s.h2[0].participants).toEqual([MOD]);
    });

    it('legacy server (no roster field) keeps the old [spawner] seed', () => {
        expect(spawnedCallParticipants({ ...base })).toEqual([MOD]);
    });

    it('negative control: the legacy seed is exactly the phantom-self bug', () => {
        // What the client did before: seed [spawner] regardless. For a move
        // spawn that puts the moderator in a call they never joined.
        const legacy = addSpawnedCall({}, 'h2', { ...base });
        expect(legacy.h2[0].participants).toContain(MOD);
    });

    it('is idempotent: a repeated spawn event returns the same object', () => {
        const once = addSpawnedCall({}, 'h2', { ...base, participants: [] });
        expect(addSpawnedCall(once, 'h2', { ...base, participants: [] })).toBe(once);
    });
});
