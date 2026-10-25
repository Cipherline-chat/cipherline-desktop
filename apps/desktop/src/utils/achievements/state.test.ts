import { describe, it, expect } from 'vitest';
import {
    addCallTime, addGameTime, addMessage, addVerified, computeTotals, emptyState, longestStreak, markDay, mergeState,
    notePeople, parseState, sameState, sanitizeState, setMostPlayedPref, unlockIds, type AchievementsState,
} from './state';

const CTX = { eggCount: 0, accountCreatedMs: null, now: Date.UTC(2026, 9, 23) };
const H = 3_600_000;

function stateA(): AchievementsState {
    let s = emptyState();
    s = addCallTime(s, 'devA', { dtMs: 2 * H, people: 3, isHost: true, sessionMs: 2 * H, hour: 14, day: '2026-10-01' });
    s = addMessage(s, 'devA', 'srv1', '2026-10-01');
    s = addVerified(s, 'u1');
    return unlockIds(s, ['voice-100h'], '2026-09');
}
function stateB(): AchievementsState {
    let s = emptyState();
    s = addCallTime(s, 'devB', { dtMs: 3 * H, people: 9, isHost: false, sessionMs: 3 * H, hour: 3, day: '2026-10-02' });
    s = addMessage(s, 'devB', 'srv2', '2026-10-02');
    s = addVerified(s, 'u2');
    s = addGameTime(s, 'devB', 'Hades', 90 * 60_000);
    return unlockIds(s, ['voice-100h', 'fleet'], '2026-10');
}

describe('mergeState', () => {
    it('is commutative, associative and idempotent', () => {
        const a = stateA(), b = stateB();
        let c = emptyState();
        c = addCallTime(c, 'devC', { dtMs: H, people: 2, isHost: false, sessionMs: H, hour: 10, day: '2026-10-03' });
        expect(sameState(mergeState(a, b), mergeState(b, a))).toBe(true);
        expect(sameState(mergeState(mergeState(a, b), c), mergeState(a, mergeState(b, c)))).toBe(true);
        expect(sameState(mergeState(a, a), a)).toBe(true);
        const ab = mergeState(a, b);
        expect(sameState(mergeState(ab, a), ab)).toBe(true);
        expect(sameState(mergeState(ab, b), ab)).toBe(true);
    });

    it('sums DIFFERENT devices and never double-counts the SAME device', () => {
        const merged = mergeState(stateA(), stateB());
        const t = computeTotals(merged, CTX);
        expect(t.voiceHours).toBeCloseTo(5, 6); // 2h on devA + 3h on devB
        expect(t.messages).toBe(2);
        // the same device seen twice (a stale replica and a newer one): max, not 2 + 4
        const older = addCallTime(emptyState(), 'devA', { dtMs: 2 * H, people: 1, isHost: false, sessionMs: 2 * H, hour: 12, day: '2026-10-01' });
        const newer = addCallTime(older, 'devA', { dtMs: 2 * H, people: 1, isHost: false, sessionMs: 4 * H, hour: 12, day: '2026-10-01' });
        expect(computeTotals(mergeState(older, newer), CTX).voiceHours).toBeCloseTo(4, 6);
        expect(computeTotals(mergeState(newer, older), CTX).voiceHours).toBeCloseTo(4, 6);
    });

    it('single-valued records are the max across devices; sets union; unlock keeps the earliest month', () => {
        const merged = mergeState(stateA(), stateB());
        const t = computeTotals(merged, CTX);
        expect(t.peakCallPeople).toBe(9);
        expect(t.hostedPeak).toBe(3);
        expect(t.lateNightHours).toBeCloseTo(3, 6);
        expect(t.servers).toBe(2);
        expect(t.verified).toBe(2);
        expect(t.activeDevices).toBe(2);
        expect(merged.unlocked['voice-100h']).toBe('2026-09');
        expect(merged.unlocked['fleet']).toBe('2026-10');
    });

    it('a restore under a NEW device id keeps the old entry (history is not overwritten)', () => {
        const old = stateA();
        const reinstalled = addMessage(emptyState(), 'devNew', null, '2026-10-05');
        const t = computeTotals(mergeState(old, reinstalled), CTX);
        expect(t.voiceHours).toBeCloseTo(2, 6);
        expect(t.messages).toBe(2);
    });

    it('most-played preference is last-writer-wins and a tie resolves to OFF', () => {
        const on = setMostPlayedPref(emptyState(), true, 1000);
        const off = setMostPlayedPref(on, false, 2000);
        expect(mergeState(on, off).prefs.mostPlayed).toBe(false);
        expect(mergeState(off, on).prefs.mostPlayed).toBe(false);
        const reOn = setMostPlayedPref(off, true, 3000);
        expect(mergeState(off, reOn).prefs.mostPlayed).toBe(true);
        const tieA: AchievementsState = { ...emptyState(), prefs: { mostPlayed: true, at: 5 } };
        const tieB: AchievementsState = { ...emptyState(), prefs: { mostPlayed: false, at: 5 } };
        expect(mergeState(tieA, tieB).prefs.mostPlayed).toBe(false);
        expect(mergeState(tieB, tieA).prefs.mostPlayed).toBe(false);
    });
});

describe('streaks and days', () => {
    it('longestStreak counts consecutive local days only', () => {
        expect(longestStreak([])).toBe(0);
        expect(longestStreak(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05'])).toBe(3);
        expect(longestStreak(['2026-12-31', '2027-01-01', '2026-12-30'])).toBe(3); // across a year boundary
        expect(longestStreak(['2026-02-28', '2026-03-01'])).toBe(2); // across a month boundary
        expect(longestStreak(['2026-10-01', '2026-10-01'])).toBe(1);
    });

    it('bestStreak survives trimming the day set, and ignores garbage keys', () => {
        let s = emptyState();
        for (let d = 1; d <= 31; d++) s = markDay(s, `2026-01-${String(d).padStart(2, '0')}`);
        expect(s.bestStreak).toBe(31);
        const long = { ...s, days: [] as string[] };
        expect(computeTotals(long, CTX).bestStreak).toBe(31);
        expect(markDay(s, 'not-a-day')).toBe(s);
    });
});

describe('counters', () => {
    it('alone / late-night / host / longest-call accrue from the tick fields', () => {
        let s = emptyState();
        s = addCallTime(s, 'd', { dtMs: H, people: 1, isHost: true, sessionMs: H, hour: 3, day: '2026-10-01' });
        s = addCallTime(s, 'd', { dtMs: H, people: 5, isHost: true, sessionMs: 2 * H, hour: 5, day: '2026-10-01' });
        const t = computeTotals(s, CTX);
        expect(t.voiceHours).toBeCloseTo(2, 6);
        expect(t.aloneHours).toBeCloseTo(1, 6);
        expect(t.lateNightHours).toBeCloseTo(1, 6); // hour 5 is outside [2,5)
        expect(t.longestCallHours).toBeCloseTo(2, 6);
        expect(t.hostedPeak).toBe(5);
        expect(notePeople(s, 'd', 12, false).devices.d.peakCallPeople).toBe(12);
        expect(notePeople(s, 'd', 12, false).devices.d.hostedPeak).toBe(5);
    });

    it('games: best single game and distinct games >= 1h are summed across devices', () => {
        let a = addGameTime(emptyState(), 'a', 'Hades', 150 * 60_000);
        a = addGameTime(a, 'a', 'Celeste', 30 * 60_000);
        const b = addGameTime(emptyState(), 'b', 'Hades', 60 * 60_000);
        const t = computeTotals(mergeState(a, b), CTX);
        expect(t.bestGameHours).toBeCloseTo(3.5, 6);
        expect(t.gamesPlayed).toBe(1);
    });

    it('account age comes from the creation date', () => {
      const t = computeTotals(emptyState(), { ...CTX, accountCreatedMs: CTX.now - 400 * 86_400_000 });
      expect(t.accountAgeDays).toBeCloseTo(400, 6);
    });

    it('unlockIds only adds and never rewrites a month', () => {
        const s = unlockIds(emptyState(), ['fleet'], '2026-10');
        expect(unlockIds(s, ['fleet'], '2027-01')).toBe(s);
        expect(unlockIds(s, [], '2027-01')).toBe(s);
    });
});

describe('sanitizeState (storage / remote input is untrusted)', () => {
    it('junk becomes an empty state, never a throw', () => {
        expect(sameState(parseState('not json'), emptyState())).toBe(true);
        expect(sameState(parseState(null), emptyState())).toBe(true);
        expect(sameState(sanitizeState([1, 2]), emptyState())).toBe(true);
    });

    it('drops negative / NaN / absurd numbers, bad ids, bad months and bad day keys', () => {
        const s = sanitizeState({
            devices: { 'ok-dev': { voiceMs: -5, messages: 'x', peakCallPeople: 1e12, gameMs: { Hades: 5000, '': 1, big: Infinity } }, 'bad id!': { voiceMs: 1 } },
            days: ['2026-10-01', 'nope'], servers: ['s1', 'has space'], verified: [3],
            unlocked: { fleet: '2026-10', 'bad id': '2026-10', 'voice-100h': '2026-13' },
            prefs: { mostPlayed: 'yes', at: -1 },
        });
        expect(Object.keys(s.devices)).toEqual(['ok-dev']);
        expect(s.devices['ok-dev'].voiceMs).toBe(0);
        expect(s.devices['ok-dev'].messages).toBe(0);
        expect(s.devices['ok-dev'].peakCallPeople).toBe(100_000);
        expect(s.devices['ok-dev'].gameMs).toEqual({ Hades: 5000 });
        expect(s.days).toEqual(['2026-10-01']);
        expect(s.servers).toEqual(['s1']);
        expect(s.verified).toEqual([]);
        expect(s.unlocked).toEqual({ fleet: '2026-10' });
        expect(s.prefs).toEqual({ mostPlayed: false, at: 0 });
    });
});
