import { describe, it, expect } from 'vitest';
import { claimFirstSendOfDay, claimOnTheHour, FIRST_TODAY_LEDGER_ID, ON_THE_HOUR_LEDGER_ID } from './composerFunLedger';
import { EGG_LEDGER_KEY, parseLedger, type EggStore } from './easterEggs';

const mem = (): EggStore & { kv: Map<string, string> } => {
    const kv = new Map<string, string>();
    return { kv, getItem: k => kv.get(k) ?? null, setItem: (k, v) => { kv.set(k, v); } };
};

describe('claimFirstSendOfDay', () => {
    it('fires once per local day, again the next day', () => {
        const st = mem();
        expect(claimFirstSendOfDay(new Date(2026, 9, 20, 8, 0), st)).toBe(true);
        expect(claimFirstSendOfDay(new Date(2026, 9, 20, 8, 5), st)).toBe(false);
        expect(claimFirstSendOfDay(new Date(2026, 9, 20, 23, 59), st)).toBe(false);
        expect(claimFirstSendOfDay(new Date(2026, 9, 21, 0, 0), st)).toBe(true);
    });

    it('writes only an id, a count and a time into the existing ledger key', () => {
        const st = mem();
        claimFirstSendOfDay(new Date(2026, 9, 20, 8, 0), st);
        expect([...st.kv.keys()]).toEqual([EGG_LEDGER_KEY]);
        const entry = parseLedger(st.kv.get(EGG_LEDGER_KEY)!)[FIRST_TODAY_LEDGER_ID];
        expect(Object.keys(entry).sort()).toEqual(['count', 'last']);
    });

    it('a broken store never throws into the send path', () => {
        const st: EggStore = { getItem: () => { throw new Error('locked'); }, setItem: () => { throw new Error('locked'); } };
        expect(() => claimFirstSendOfDay(new Date(), st)).not.toThrow();
    });
});

describe('claimOnTheHour', () => {
    it('only in the :00 minute, at most once per hour', () => {
        const st = mem();
        expect(claimOnTheHour(new Date(2026, 9, 20, 14, 1), st)).toBe(false);
        expect(claimOnTheHour(new Date(2026, 9, 20, 14, 0, 5), st)).toBe(true);
        expect(claimOnTheHour(new Date(2026, 9, 20, 14, 0, 40), st)).toBe(false);
        expect(claimOnTheHour(new Date(2026, 9, 20, 15, 0, 2), st)).toBe(true);
        expect(parseLedger(st.kv.get(EGG_LEDGER_KEY)!)[ON_THE_HOUR_LEDGER_ID].count).toBe(2);
    });
});
