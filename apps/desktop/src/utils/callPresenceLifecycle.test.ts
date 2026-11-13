import { describe, it, expect, beforeEach } from 'vitest';
import {
    createPresenceTracker,
    callPresenceTracker,
    currentCallPresenceTracker,
    __resetCallPresenceForTests,
    PRESENCE_ENTER_MS,
    PRESENCE_LEAVE_MS,
    PRESENCE_LIVEKIT_SETTLE_MS,
} from './callPresenceLifecycle';

const ids = (t: ReturnType<typeof createPresenceTracker>, now: number) => t.list(now).map(i => `${i.id}:${i.phase}`);

describe('baseline vs join', () => {
    it('the first roster is the baseline: nobody is "entering", nothing claims a join', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b'], 0);
        expect(ids(t, 0)).toEqual(['a:present', 'b:present']);
        expect(t.claimEnter('row', 'a', 0)).toBe(false);
    });

    it('a later arrival is entering for PRESENCE_ENTER_MS, then present', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        t.observe(['a', 'b'], 1000);
        expect(t.phase('b', 1000)).toBe('entering');
        expect(t.phase('b', 1000 + PRESENCE_ENTER_MS - 1)).toBe('entering');
        expect(t.phase('b', 1000 + PRESENCE_ENTER_MS)).toBe('present');
    });

    it('LiveKit settle: arrivals inside settleMs of the first observe are baseline (existing members discovered one by one)', () => {
        const t = createPresenceTracker({ settleMs: PRESENCE_LIVEKIT_SETTLE_MS });
        t.observe(['me'], 0);
        t.observe(['me', 'x'], 300);
        t.observe(['me', 'x', 'y'], PRESENCE_LIVEKIT_SETTLE_MS - 1);
        expect(t.phase('x', 300)).toBe('present');
        expect(t.phase('y', PRESENCE_LIVEKIT_SETTLE_MS)).toBe('present');
        t.observe(['me', 'x', 'y', 'z'], PRESENCE_LIVEKIT_SETTLE_MS + 10);
        expect(t.phase('z', PRESENCE_LIVEKIT_SETTLE_MS + 10)).toBe('entering');
    });

    it('selfJoinIds: your own arrival animates even on the first observe; others there do not', () => {
        const t = createPresenceTracker({ selfJoinIds: ['me'] });
        t.observe(['me', 'other'], 0);
        expect(t.phase('me', 0)).toBe('entering');
        expect(t.phase('other', 0)).toBe('present');
    });

    it('re-observing the same roster is idempotent (StrictMode double render, unrelated re-renders)', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        expect(t.observe(['a', 'b'], 10)).toBe(true);
        expect(t.observe(['a', 'b'], 20)).toBe(false);
        expect(t.phase('b', 20)).toBe('entering');
    });
});

describe('leaving ghost', () => {
    it('a leaver stays in the list as `leaving`, at the index it had, for PRESENCE_LEAVE_MS', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b', 'c'], 0);
        t.observe(['a', 'c'], 1000);
        expect(ids(t, 1000)).toEqual(['a:present', 'b:leaving', 'c:present']);
        expect(t.isLeaving('b', 1000 + PRESENCE_LEAVE_MS - 1)).toBe(true);
        expect(t.nextExpiryIn(1000)).toBe(PRESENCE_LEAVE_MS);
    });

    it('the ghost is removed once the leave window is over', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b'], 0);
        t.observe(['a'], 1000);
        expect(t.prune(1000 + PRESENCE_LEAVE_MS - 1)).toBe(false);
        expect(t.prune(1000 + PRESENCE_LEAVE_MS)).toBe(true);
        expect(ids(t, 1000 + PRESENCE_LEAVE_MS)).toEqual(['a:present']);
        expect(t.nextExpiryIn(1000 + PRESENCE_LEAVE_MS)).toBeNull();
    });

    it('the last person leaving is still a ghost (the row animates out, it does not vanish)', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        t.observe([], 500);
        expect(ids(t, 500)).toEqual(['a:leaving']);
    });

    it('rejoining DURING the leave animation cancels the ghost and re-enters the same entry (new join)', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b'], 0);
        t.observe(['a'], 1000);
        expect(t.isLeaving('b', 1100)).toBe(true);
        t.observe(['a', 'b'], 1100);
        expect(t.phase('b', 1100)).toBe('entering');
        expect(ids(t, 1100)).toEqual(['a:present', 'b:entering']);
        // The cancelled ghost is not pruned later as if it had left.
        t.prune(1000 + PRESENCE_LEAVE_MS + 5);
        expect(t.phase('b', 1000 + PRESENCE_LEAVE_MS + 5)).toBe('entering');
        // …and it is a NEW join: a surface that animated the first join may animate this one.
        expect(t.claimEnter('row', 'b', 1100)).toBe(true);
    });

    it('rejoining after the ghost expired is a plain fresh join', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b'], 0);
        t.observe(['a'], 1000);
        t.observe(['a', 'b'], 1000 + PRESENCE_LEAVE_MS + 50);
        expect(t.phase('b', 1000 + PRESENCE_LEAVE_MS + 50)).toBe('entering');
        expect(ids(t, 1000 + PRESENCE_LEAVE_MS + 50)).toEqual(['a:present', 'b:entering']);
    });

    it('several ghosts keep their relative positions while new people arrive', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b', 'c', 'd'], 0);
        t.observe(['a', 'd', 'e'], 1000);
        expect(t.list(1000).map(i => i.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
});

describe('no replay — joins are claimed per surface, not per mount', () => {
    it('a surface claims a join exactly once; a remount on the same surface (layout switch / reparent) does not replay it', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        t.observe(['a', 'b'], 1000);
        expect(t.claimEnter('cam', 'b', 1000)).toBe(true);      // tile mounts → animates
        expect(t.claimEnter('cam', 'b', 1200)).toBe(false);     // remount 200 ms later → inert
        expect(t.claimEnter('cam', 'b', 1600)).toBe(false);
    });

    it('a StrictMode double render of the same mount agrees (second claim within the twin window)', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        t.observe(['a', 'b'], 1000);
        expect(t.claimEnter('row', 'b', 1000)).toBe(true);
        expect(t.claimEnter('row', 'b', 1001)).toBe(true);
    });

    it('different surfaces each get their own join (the row in the sidebar AND the tile in the grid)', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        t.observe(['a', 'b'], 1000);
        expect(t.claimEnter('audio', 'b', 1000)).toBe(true);
        expect(t.claimEnter('fs', 'b', 1100)).toBe(true);
    });

    it('opening a surface after the join window (entering fullscreen later) plays nothing', () => {
        const t = createPresenceTracker();
        t.observe(['a'], 0);
        t.observe(['a', 'b'], 1000);
        expect(t.claimEnter('fs', 'b', 1000 + PRESENCE_ENTER_MS)).toBe(false);
    });

    it('leavers and unknown ids never claim', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b'], 0);
        t.observe(['a'], 1000);
        expect(t.claimEnter('row', 'b', 1000)).toBe(false);
        expect(t.claimEnter('row', 'zzz', 1000)).toBe(false);
    });
});

describe('reduced motion', () => {
    it('no ghosts: a leaver is gone at once', () => {
        const t = createPresenceTracker({ reducedMotion: true });
        t.observe(['a', 'b'], 0);
        t.observe(['a'], 1000);
        expect(ids(t, 1000)).toEqual(['a:present']);
        expect(t.nextExpiryIn(1000)).toBeNull();
    });

    it('no join claims', () => {
        const t = createPresenceTracker({ reducedMotion: true });
        t.observe(['a'], 0);
        t.observe(['a', 'b'], 1000);
        expect(t.claimEnter('row', 'b', 1000)).toBe(false);
    });

    it('switching reduced motion on mid-animation drops pending ghosts', () => {
        const t = createPresenceTracker();
        t.observe(['a', 'b'], 0);
        t.observe(['a'], 1000);
        t.setReducedMotion(true);
        expect(ids(t, 1000)).toEqual(['a:present']);
    });
});

describe('the live call tracker survives remounts, one call at a time', () => {
    beforeEach(() => __resetCallPresenceForTests());

    it('same session key → same tracker (a SidebarConference remount keeps who was animated)', () => {
        const a = callPresenceTracker('s1');
        expect(callPresenceTracker('s1')).toBe(a);
        expect(currentCallPresenceTracker()).toBe(a);
    });

    it('a new session gets a fresh tracker with the LiveKit settle window', () => {
        const a = callPresenceTracker('s1');
        const b = callPresenceTracker('s2');
        expect(b).not.toBe(a);
        b.observe(['me'], 0);
        b.observe(['me', 'early'], 500);
        expect(b.phase('early', 500)).toBe('present');
    });
});
