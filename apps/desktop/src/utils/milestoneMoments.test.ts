import { describe, it, expect } from 'vitest';
import { MOMENTS, claimMoment, type MomentId } from './moments';
import { clockMoments } from './moments';
import { isPiDay, PI_WINDOW } from './moments';
import { isLeapDay } from './moments';
import { nyeCallDue, msUntilNewYear, MOMENT_YIELDS, yieldMoments, momentCount, ledgerId } from './moments';
import { isNewcomer, NEWCOMER_MS } from './moments';
import { messageDeliveredMoment } from './moments';
import { parseCallCount, callConnectedMoment } from './moments';
import { CALL_MILESTONE } from './moments';
import { serverCreatedMoment } from './moments';
import { EGG_LEDGER_KEY, parseLedger } from './easterEggs';
import type { EggStore } from './easterEggs';

/**
 * The seven milestone / calendar moments: first-message, first-call,
 * first-server, call-100, pi-day, leap-day, nye-call. Their triggers are pure
 * functions of structural facts (a count, the clock, an account's age, what the
 * account already found) — nothing here sees a message, a participant or a name.
 */
const memStore = (init: Record<string, string> = {}): EggStore & { map: Map<string, string> } => {
    const map = new Map(Object.entries(init));
    return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
};
const DAY = 86_400_000;
const T0 = new Date('2026-10-20T12:00:00').getTime();
const at = (iso: string) => new Date(iso);
const hoursAgo = (h: number) => new Date(T0 - h * 3_600_000).toISOString();
/** Whichever of the seven exist yet. */
const NEW = (['first-message', 'first-call', 'first-server', 'call-100', 'pi-day', 'leap-day', 'nye-call'] as string[]).filter(id => id in MOMENTS) as MomentId[];
const AMBIENT = ['pi-day', 'leap-day'] as const;

describe('the registry entries', () => {
    it('all exist, passive, with the pacing the doctrine asks for', () => {
        for (const id of NEW) {
            const d = MOMENTS[id];
            expect(d.mode, id).toBe('passive');
            expect(d.durationMs, id).toBeLessThanOrEqual(9000);
        }
    });
    it('the calendar ones are ambient (they wait for a quiet moment); the rest answer something that just happened', () => {
        for (const id of NEW) expect(MOMENTS[id].waitForIdle, id).toBe((AMBIENT as readonly string[]).includes(id));
    });
    it('copy is dry and short: no ocean tack-ons', () => {
        for (const id of NEW) {
            const d = MOMENTS[id];
            expect(`${d.headline} ${d.line} ${d.shown}`, id).not.toMatch(/\b(bubble|blub|ocean|deep|sea|tide|reef|fish)\w*/i);
        }
    });
});

describe('Pi Day (clockMoments)', () => {
    it('March 14th, a few minutes either side of 1:59 p.m. local, and nowhere else', () => {
        expect(PI_WINDOW).toEqual({ from: 13 * 60 + 54, to: 14 * 60 + 4 });
        expect(isPiDay(at('2027-03-14T13:59:00'))).toBe(true);
        expect(isPiDay(at('2027-03-14T13:54:00'))).toBe(true);
        expect(isPiDay(at('2027-03-14T14:04:59'))).toBe(true);
        expect(isPiDay(at('2027-03-14T13:53:59'))).toBe(false);
        expect(isPiDay(at('2027-03-14T14:05:00'))).toBe(false);
        expect(isPiDay(at('2027-03-14T01:59:00'))).toBe(false);       // 1:59 a.m. is not it
        expect(isPiDay(at('2027-03-13T13:59:00'))).toBe(false);
        expect(isPiDay(at('2027-04-14T13:59:00'))).toBe(false);
        expect(isPiDay(at('2027-03-15T13:59:00'))).toBe(false);
    });
    it('clockMoments offers it only in its window', () => {
        const fresh = (iso: string) => clockMoments(at(iso), at(iso).getTime(), null);   // just opened: no coffee
        expect(fresh('2027-03-14T14:00:00')).toEqual(['pi-day']);
        expect(fresh('2027-03-14T09:00:00')).toEqual([]);
    });
    it('once a year: a second tick the same day is refused, the next year is due', () => {
        const s = memStore();
        expect(claimMoment(s, 'pi-day', at('2027-03-14T13:59:30').getTime())).toBe(true);
        expect(claimMoment(s, 'pi-day', at('2027-03-14T14:02:30').getTime())).toBe(false);
        expect(claimMoment(s, 'pi-day', at('2028-03-14T13:59:30').getTime())).toBe(true);
    });
});

describe('the leap day (clockMoments)', () => {
    it('February 29th, any time, any year that has one', () => {
        expect(isLeapDay(at('2028-02-29T00:00:00'))).toBe(true);
        expect(isLeapDay(at('2028-02-29T23:59:00'))).toBe(true);
        expect(isLeapDay(at('2028-02-28T12:00:00'))).toBe(false);
        expect(isLeapDay(at('2028-03-01T12:00:00'))).toBe(false);
        expect(isLeapDay(at('2027-02-28T12:00:00'))).toBe(false);
    });
    it('clockMoments offers it on the 29th only', () => {
        expect(clockMoments(at('2028-02-29T09:00:00'), at('2028-02-29T09:00:00').getTime(), null)).toEqual(['leap-day']);
    });
    it('once per leap day', () => {
        const s = memStore();
        expect(claimMoment(s, 'leap-day', at('2028-02-29T08:00:00').getTime())).toBe(true);
        expect(claimMoment(s, 'leap-day', at('2028-02-29T21:00:00').getTime())).toBe(false);
        expect(claimMoment(s, 'leap-day', at('2032-02-29T08:00:00').getTime())).toBe(true);
    });
});

describe("New Year's midnight in a call (nye-call)", () => {
    it('due only in the first minute of January 1st (local), and only while in a call', () => {
        expect(nyeCallDue(at('2027-01-01T00:00:00'), true)).toBe(true);
        expect(nyeCallDue(at('2027-01-01T00:00:59'), true)).toBe(true);
        expect(nyeCallDue(at('2027-01-01T00:01:00'), true)).toBe(false);
        expect(nyeCallDue(at('2026-12-31T23:59:59'), true)).toBe(false);
        expect(nyeCallDue(at('2027-01-01T00:00:10'), false)).toBe(false);   // no call, no moment
        expect(nyeCallDue(at('2027-02-01T00:00:10'), true)).toBe(false);
    });
    it('msUntilNewYear counts to the next local Jan 1 00:00:00', () => {
        expect(msUntilNewYear(at('2026-12-31T23:58:00'))).toBe(120_000);
        expect(msUntilNewYear(at('2026-12-31T23:59:59'))).toBe(1000);
    });
    it('once a year', () => {
        const s = memStore();
        expect(claimMoment(s, 'nye-call', at('2027-01-01T00:00:05').getTime())).toBe(true);
        expect(claimMoment(s, 'nye-call', at('2027-01-01T00:00:50').getTime())).toBe(false);
        expect(claimMoment(s, 'nye-call', at('2028-01-01T00:00:05').getTime())).toBe(true);
    });
    it('it stands in for new-year: playing it spends new-year for that day, without crediting it', () => {
        expect(MOMENT_YIELDS['nye-call']).toEqual(['new-year']);
        const s = memStore();
        const t = at('2027-01-01T00:00:05').getTime();
        yieldMoments(s, 'nye-call', t);
        expect(parseLedger(s.getItem(EGG_LEDGER_KEY))[ledgerId('new-year')]).toEqual({ count: 0, last: t });
        // later that day the underwater fireworks are refused...
        expect(claimMoment(s, 'new-year', at('2027-01-01T09:00:00').getTime())).toBe(false);
        // ...a count of 0 is not a find (creditLedgerFinds only credits count > 0)...
        expect(momentCount(s, 'new-year')).toBe(0);
        // ...and next year it is a fresh day for them.
        expect(claimMoment(s, 'new-year', at('2028-01-01T09:00:00').getTime())).toBe(true);
    });
    it('a moment with nothing to yield writes nothing; an existing count is kept', () => {
        const s = memStore();
        yieldMoments(s, 'first-ban', T0);
        expect(s.map.size).toBe(0);
        const s2 = memStore({ [EGG_LEDGER_KEY]: JSON.stringify({ [ledgerId('new-year')]: { count: 2, last: 5 } }) });
        yieldMoments(s2, 'nye-call', T0);
        expect(parseLedger(s2.getItem(EGG_LEDGER_KEY))[ledgerId('new-year')]).toEqual({ count: 2, last: T0 });
    });
    it('an unreadable or unwritable ledger never throws', () => {
        const bad: EggStore = { getItem: () => { throw new Error('locked'); }, setItem: () => { throw new Error('locked'); } };
        expect(() => yieldMoments(bad, 'nye-call', T0)).not.toThrow();
        const ro: EggStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
        expect(() => yieldMoments(ro, 'nye-call', T0)).not.toThrow();
    });
});

describe('a new account (isNewcomer)', () => {
    it('is under a day old (a little clock skew tolerated), never an older one', () => {
        expect(NEWCOMER_MS).toBe(DAY);
        expect(isNewcomer(hoursAgo(0.1), T0)).toBe(true);
        expect(isNewcomer(hoursAgo(23.9), T0)).toBe(true);
        expect(isNewcomer(hoursAgo(24), T0)).toBe(false);
        expect(isNewcomer(hoursAgo(24 * 400), T0)).toBe(false);
        expect(isNewcomer(new Date(T0 + 60_000).toISOString(), T0)).toBe(true);        // clock skew
        expect(isNewcomer(new Date(T0 + 3_600_000).toISOString(), T0)).toBe(false);    // not from the future
        expect(isNewcomer(null, T0)).toBe(false);
        expect(isNewcomer(undefined, T0)).toBe(false);
        expect(isNewcomer('not a date', T0)).toBe(false);
    });
});

describe('first message (messageDeliveredMoment)', () => {
    it('a delivered send on a new account — not your own notes, not once the account has found it', () => {
        expect(messageDeliveredMoment(hoursAgo(1), [], false, T0)).toBe('first-message');
        expect(messageDeliveredMoment(hoursAgo(1), [], true, T0)).toBeNull();                  // note to self is its own moment
        expect(messageDeliveredMoment(hoursAgo(1), ['first-message'], false, T0)).toBeNull();  // found on another machine
        expect(messageDeliveredMoment(hoursAgo(24 * 90), [], false, T0)).toBeNull();           // a long-time user
        expect(messageDeliveredMoment(null, [], false, T0)).toBeNull();
    });
});

describe('first call (callConnectedMoment)', () => {
    it('parseCallCount: junk is zero', () => {
        expect(parseCallCount('7')).toBe(7);
        expect(parseCallCount(null)).toBe(0);
        expect(parseCallCount('')).toBe(0);
        expect(parseCallCount('abc')).toBe(0);
        expect(parseCallCount('-3')).toBe(0);
        expect(parseCallCount('2.5')).toBe(0);
        expect(parseCallCount('1e12')).toBe(0);
    });
    it('the first to connect on a new account only', () => {
        expect(callConnectedMoment(0, hoursAgo(2), [], T0)).toBe('first-call');
        expect(callConnectedMoment(1, hoursAgo(2), [], T0)).toBeNull();
        expect(callConnectedMoment(0, hoursAgo(24 * 30), [], T0)).toBeNull();                  // a long-time user's first COUNTED call
        expect(callConnectedMoment(0, hoursAgo(2), ['first-call'], T0)).toBeNull();
    });
});

describe('the 100th call (callConnectedMoment)', () => {
    it('exactly the 100th to connect (99 before it), once per account, whatever the account age', () => {
        expect(CALL_MILESTONE).toBe(100);
        expect(callConnectedMoment(98, hoursAgo(24 * 30), [], T0)).toBeNull();
        expect(callConnectedMoment(99, hoursAgo(24 * 30), [], T0)).toBe('call-100');
        expect(callConnectedMoment(100, hoursAgo(24 * 30), [], T0)).toBeNull();
        expect(callConnectedMoment(99, hoursAgo(24 * 30), ['call-100'], T0)).toBeNull();       // restored onto a second machine
        expect(callConnectedMoment(99, null, [], T0)).toBe('call-100');
    });
});

describe('first server (serverCreatedMoment)', () => {
    it('only when the loaded list held none of your own, and not twice per account', () => {
        expect(serverCreatedMoment(0, [])).toBe('first-server');
        expect(serverCreatedMoment(1, [])).toBeNull();
        expect(serverCreatedMoment(null, [])).toBeNull();                                       // list not loaded: say nothing
        expect(serverCreatedMoment(0, ['first-server'])).toBeNull();
    });
});

describe('the once-ever ones really are once ever per device (the ledger)', () => {
    it.each(NEW.filter(id => ['first-message', 'first-call', 'first-server', 'call-100'].includes(id)))('%s', (id) => {
        const s = memStore();
        expect(claimMoment(s, id, T0)).toBe(true);
        expect(claimMoment(s, id, T0 + 800 * DAY)).toBe(false);
    });
});
