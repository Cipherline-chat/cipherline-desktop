import { describe, it, expect } from 'vitest';
import { createTracker, MAX_TICK_MS, type TrackerEnv } from './tracker';
import { addMessage, emptyState, setMostPlayedPref } from './state';
import { addPlay, pruneBuckets, topGames, sameTop, parseBuckets } from './mostPlayed';

const H = 3_600_000;

function harness(opts: { eggs?: number; created?: number | null; startMs?: number } = {}) {
    let now = opts.startMs ?? new Date(2026, 9, 23, 12, 0, 0).getTime(); // local noon
    let saved: string | null = null;
    let savedWeekly: string | null = null;
    const env: TrackerEnv = {
        load: () => saved, save: r => { saved = r; },
        loadWeekly: () => savedWeekly, saveWeekly: r => { savedWeekly = r; },
        deviceId: 'dev1', now: () => now,
        eggCount: () => opts.eggs ?? 0, accountCreatedMs: () => opts.created ?? null,
        setTimer: () => 0, clearTimer: () => undefined,
    };
    const t = createTracker(env);
    const unlocks: string[] = [];
    t.onUnlock(e => unlocks.push(e.id));
    return { t, unlocks, advance: (ms: number) => { now += ms; }, setNow: (ms: number) => { now = ms; }, env, get saved() { return saved; }, get weekly() { return savedWeekly; } };
}

describe('tracker: time accrual', () => {
    it('credits call time only while connected, capped per tick so a sleeping laptop banks nothing', () => {
        const h = harness();
        h.t.signalCall({ id: 'c1', connected: true, people: 3, isHost: true });
        h.advance(30_000); h.t.tick();
        expect(h.t.totals().voiceHours * H).toBeCloseTo(30_000, 0);
        h.advance(6 * H); h.t.tick(); // lid closed for six hours
        expect(h.t.totals().voiceHours * H).toBeCloseTo(30_000 + MAX_TICK_MS, 0);
        h.t.signalCall(null);
        h.advance(60_000); h.t.tick();
        expect(h.t.totals().voiceHours * H).toBeCloseTo(30_000 + MAX_TICK_MS, 0);
    });

    it('a ringing (not yet connected) call earns nothing; alone time and peak/host are tracked', () => {
        const h = harness();
        h.t.signalCall({ id: 'c1', connected: false, people: 1, isHost: true });
        h.advance(30_000); h.t.tick();
        expect(h.t.totals().voiceHours).toBe(0);
        h.t.signalCall({ id: 'c1', connected: true, people: 1, isHost: true });
        h.advance(30_000); h.t.tick();
        h.t.signalCall({ id: 'c1', connected: true, people: 9, isHost: true });
        h.advance(30_000); h.t.tick();
        const t = h.t.totals();
        expect(t.aloneHours * H).toBeCloseTo(30_000, 0);
        expect(t.hostedPeak).toBe(9);
        expect(t.peakCallPeople).toBe(9);
        expect(t.longestCallHours * H).toBeCloseTo(60_000, 0);
    });

    it('a new call id restarts "how long this call has lasted"', () => {
        const h = harness();
        h.t.signalCall({ id: 'a', connected: true, people: 2, isHost: false });
        h.advance(30_000); h.t.tick();
        h.t.signalCall({ id: 'b', connected: true, people: 2, isHost: false });
        h.advance(30_000); h.t.tick();
        expect(h.t.totals().longestCallHours * H).toBeCloseTo(30_000, 0);
        expect(h.t.totals().voiceHours * H).toBeCloseTo(60_000, 0);
    });

    it('game time feeds both the lifetime counter and the rolling week, and marks nothing without a game', () => {
        const h = harness();
        h.t.signalGame('Hades');
        h.advance(60_000); h.t.tick();
        h.t.signalGame(null);
        h.advance(60_000); h.t.tick();
        expect(h.t.top()).toEqual([{ game: 'Hades', minutes: 1 }]);
        expect(h.t.getState().devices.dev1.gameMs.Hades).toBe(60_000);
    });
});

describe('tracker: events, unlocks, persistence', () => {
    it('counts messages and distinct servers; unlocks fire once, with the month, and never un-unlock', () => {
        const h = harness();
        for (let i = 0; i < 10; i++) h.t.noteMessage(`srv${i}`);
        h.t.noteMessage('srv0');
        expect(h.t.totals().servers).toBe(10);
        expect(h.unlocks).toEqual(['servers-10']);
        expect(h.t.getState().unlocked['servers-10']).toBe('2026-10');
        h.t.noteMessage('srv99');
        expect(h.unlocks).toEqual(['servers-10']); // not announced twice
    });

    it('counts a verified friend once', () => {
        const h = harness();
        for (let i = 0; i < 5; i++) { h.t.noteVerified(`u${i}`); h.t.noteVerified(`u${i}`); }
        expect(h.t.totals().verified).toBe(5);
        expect(h.unlocks).toEqual(['verify-5']);
    });

    it('eggs and account age unlock through reevaluate()', () => {
        let eggs = 29;
        const h = harness({ created: new Date(2025, 0, 1).getTime() });
        h.env.eggCount = () => eggs;
        h.t.reevaluate();
        expect(h.unlocks).toEqual(['year-1']);
        eggs = 30;
        h.t.reevaluate();
        expect(h.unlocks).toEqual(['year-1', 'eggs-30']);
    });

    it('merging another device in can unlock (fleet: three active devices)', () => {
        const h = harness();
        h.t.noteMessage(null);
        let remote = addMessage(emptyState(), 'devB', null, '2026-10-01');
        remote = addMessage(remote, 'devC', null, '2026-10-01');
        expect(h.t.mergeRemote(remote)).toBe(true);
        expect(h.unlocks).toEqual(['fleet']);
        expect(h.t.mergeRemote(remote)).toBe(false); // idempotent: nothing changed
    });

    it('persists on flush and a fresh tracker resumes from it', () => {
        const h = harness();
        h.t.noteMessage('s');
        h.t.setMostPlayed(true);
        h.t.flush();
        const resumed = createTracker({ ...h.env, load: () => h.saved });
        expect(resumed.totals().messages).toBe(1);
        expect(resumed.getState().prefs.mostPlayed).toBe(true);
    });

    it('survives corrupt storage', () => {
        const h = harness();
        const t = createTracker({ ...h.env, load: () => '{{{', loadWeekly: () => 'nope' });
        expect(t.totals().messages).toBe(0);
        expect(t.top()).toEqual([]);
    });

    it('the opt-in preference defaults OFF', () => {
        expect(harness().t.getState().prefs.mostPlayed).toBe(false);
        expect(setMostPlayedPref(emptyState(), false, 5).prefs.mostPlayed).toBe(false);
    });
});

describe('mostPlayed buckets', () => {
    it('top 3 over a rolling 7 days, merging names case-insensitively, dropping sub-minute noise', () => {
        let b = {};
        b = addPlay(b, '2026-10-20', 'Hades', 30 * 60_000);
        b = addPlay(b, '2026-10-22', 'hades', 30 * 60_000);
        b = addPlay(b, '2026-10-22', 'Celeste', 45 * 60_000);
        b = addPlay(b, '2026-10-22', 'Tetris', 20_000);
        b = addPlay(b, '2026-10-23', 'Doom', 10 * 60_000);
        b = addPlay(b, '2026-10-23', 'Quake', 5 * 60_000);
        expect(topGames(b, '2026-10-23')).toEqual([
            { game: 'Hades', minutes: 60 }, { game: 'Celeste', minutes: 45 }, { game: 'Doom', minutes: 10 },
        ]);
    });

    it('the window is exactly 7 days: day 6 back counts, day 7 back does not', () => {
        const b = { '2026-10-17': { Old: 60 * 60_000 }, '2026-10-16': { TooOld: 60 * 60_000 } }; // 6 and 7 days before the 23rd
        expect(topGames(b, '2026-10-23').map(g => g.game)).toEqual(['Old']);
        expect(topGames(b, '2026-10-24').map(g => g.game)).toEqual([]);
    });

    it('buckets older than 8 days are dropped on write, and future/garbage days are ignored', () => {
        const b = { '2026-10-10': { A: 1000 }, '2026-10-15': { B: 1000 }, '2026-10-23': { C: 1000 }, '2027-01-01': { D: 1000 } };
        expect(Object.keys(pruneBuckets(b, '2026-10-23')).sort()).toEqual(['2026-10-23']);
        expect(Object.keys(addPlay(b, '2026-10-23', 'E', 1000)).sort()).toEqual(['2026-10-23']);
        expect(Object.keys(pruneBuckets({ '2026-10-16': { X: 1 }, '2026-10-15': { Y: 1 } }, '2026-10-23'))).toEqual(['2026-10-16']);
    });

    it('rejects over-long names and non-positive durations; parse tolerates junk', () => {
        expect(addPlay({}, '2026-10-23', 'x'.repeat(65), 1000)).toEqual({});
        expect(addPlay({}, '2026-10-23', 'G', 0)).toEqual({});
        expect(parseBuckets('[1]')).toEqual({});
        expect(parseBuckets('{"2026-10-23":{"G":5000,"bad":-1}}')).toEqual({ '2026-10-23': { G: 5000 } });
        expect(sameTop([{ game: 'a', minutes: 1 }], [{ game: 'a', minutes: 1 }])).toBe(true);
        expect(sameTop([{ game: 'a', minutes: 1 }], [{ game: 'a', minutes: 2 }])).toBe(false);
    });
});
