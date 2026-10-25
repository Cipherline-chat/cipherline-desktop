import { describe, it, expect } from 'vitest';
import {
    EGG_LEDGER_KEY, parseLedger, eggDue, recordEgg, claimEgg, eggCount, noteEgg,
    costumeFor, birthdayYears, isHalloween, isLateNight, konamiStep, KONAMI, pushWithin, isTypingTarget,
    type EggStore,
} from './easterEggs';

function fakeStore(initial: Record<string, string> = {}): EggStore & { map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

describe('ledger', () => {
    it('parses garbage as empty and keeps only well-formed entries', () => {
        expect(parseLedger(null)).toEqual({});
        expect(parseLedger('not json')).toEqual({});
        expect(parseLedger('[1,2]')).toEqual({});
        expect(parseLedger(JSON.stringify({ a: { count: 2, last: 5 }, b: { count: 'x' }, c: null }))).toEqual({ a: { count: 2, last: 5 } });
    });

    it('maxTimes stops an egg for good; cooldown spaces it out', () => {
        let l = recordEgg({}, 'e', 1000);
        expect(eggDue(l, 'e', 1500, { maxTimes: 2 })).toBe(true);
        l = recordEgg(l, 'e', 2000);
        expect(eggDue(l, 'e', 9e9, { maxTimes: 2 })).toBe(false);
        expect(eggDue(l, 'e', 2500, { cooldownMs: 1000 })).toBe(false);
        expect(eggDue(l, 'e', 3000, { cooldownMs: 1000 })).toBe(true);
        expect(eggDue(l, 'other', 0, { maxTimes: 1 })).toBe(true);
    });

    it('a clock that moved backwards does not re-arm a cooldown', () => {
        const l = recordEgg({}, 'e', 10_000);
        expect(eggDue(l, 'e', 5_000, { cooldownMs: 60_000 })).toBe(false);
    });
});

describe('claimEgg', () => {
    it('claims once for a one-shot, then refuses', () => {
        const s = fakeStore();
        expect(claimEgg(s, 'konami', 1, { maxTimes: 1 })).toBe(true);
        expect(claimEgg(s, 'konami', 2, { maxTimes: 1 })).toBe(false);
        expect(eggCount(s, 'konami')).toBe(1);
    });

    it('there is no switch: a stale "0" under the retired key changes nothing', () => {
        const s = fakeStore({ cipherline_easter_eggs: '0' });
        expect(claimEgg(s, 'konami', 1)).toBe(true);
        expect(s.map.has(EGG_LEDGER_KEY)).toBe(true);
    });

    it('a failing ledger write still lets the egg fire (it only costs rate-limiting)', () => {
        const s: EggStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
        expect(claimEgg(s, 'x', 1)).toBe(true);
    });

    it('noteEgg records without a policy check', () => {
        const s = fakeStore();
        noteEgg(s, 'dev-mode', 5);
        noteEgg(s, 'dev-mode', 6);
        expect(eggCount(s, 'dev-mode')).toBe(2);
    });
});

describe('the calendar (local time)', () => {
    const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h);

    it('Halloween is Oct 31 only', () => {
        expect(costumeFor(d(2026, 10, 31))).toBe('witch');
        expect(isHalloween(d(2026, 10, 31))).toBe(true);
        expect(costumeFor(d(2026, 10, 30))).toBeNull();
        expect(costumeFor(d(2026, 11, 1))).toBeNull();
        expect(isHalloween(d(2026, 10, 30))).toBe(false);
    });

    it('New Year covers Dec 31 and Jan 1, not Dec 30 or Jan 2', () => {
        expect(costumeFor(d(2026, 12, 31))).toBe('party');
        expect(costumeFor(d(2027, 1, 1))).toBe('party');
        expect(costumeFor(d(2026, 12, 30))).toBeNull();
        expect(costumeFor(d(2027, 1, 2))).toBeNull();
    });

    it('the birthday only counts from the first anniversary', () => {
        expect(birthdayYears(d(2026, 4, 30))).toBe(0);
        expect(costumeFor(d(2026, 4, 30))).toBeNull();
        expect(birthdayYears(d(2027, 4, 30))).toBe(1);
        expect(costumeFor(d(2027, 4, 30))).toBe('party');
        expect(birthdayYears(d(2028, 4, 30))).toBe(2);
        expect(birthdayYears(d(2027, 4, 29))).toBe(0);
    });

    it('late night is 03:00–04:59 and nothing else', () => {
        expect(isLateNight(d(2026, 1, 1, 2))).toBe(false);
        expect(isLateNight(new Date(2026, 0, 1, 2, 59))).toBe(false);
        expect(isLateNight(new Date(2026, 0, 1, 3, 0))).toBe(true);
        expect(isLateNight(new Date(2026, 0, 1, 4, 59))).toBe(true);
        expect(isLateNight(new Date(2026, 0, 1, 5, 0))).toBe(false);
        expect(isLateNight(d(2026, 1, 1, 15))).toBe(false);
    });
});

describe('konami', () => {
    const run = (keys: string[]) => keys.reduce((p, k) => (p === KONAMI.length ? p : konamiStep(p, k)), 0);

    it('completes on the classic sequence (case-insensitive b/a)', () => {
        expect(run([...KONAMI])).toBe(KONAMI.length);
        expect(run(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'B', 'A'])).toBe(KONAMI.length);
    });
    it('a wrong key restarts it', () => {
        expect(run(['ArrowUp', 'ArrowUp', 'ArrowDown', 'x'])).toBe(0);
        expect(run(['ArrowUp', 'ArrowDown'])).toBe(0);
    });
    it('a fumbled extra Up still counts as the start of a new attempt', () => {
        expect(run(['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'])).toBe(0);
        // …but a fresh attempt after the fumble works.
        expect(run(['ArrowUp', 'ArrowUp', 'ArrowUp', ...KONAMI.slice(1)])).toBe(KONAMI.length);
    });
});

describe('pushWithin', () => {
    it('keeps only the trailing window', () => {
        let t: number[] = [];
        for (const at of [0, 10_000, 20_000]) t = pushWithin(t, at, 60_000);
        expect(t).toHaveLength(3);
        t = pushWithin(t, 69_000, 60_000);
        expect(t).toEqual([10_000, 20_000, 69_000]);
    });
});

describe('isTypingTarget', () => {
    it('is true for text fields and contenteditable, false for everything else', () => {
        expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
        expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
        expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
        expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
        expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
        expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});
