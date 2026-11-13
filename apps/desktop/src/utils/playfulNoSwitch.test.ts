import { describe, it, expect } from 'vitest';
import { claimEgg, type EggStore } from './easterEggs';
import { claimMoment, MOMENTS, type MomentId } from './moments';
import { EGG_IDS } from './eggProgress';

/**
 * There is NO off switch for the playful touches (owner 2026-10-20, "I don't want any of it
 * togglable"; the Appearance card was removed in 4b82fa2a). The old key can still be sitting in a
 * store as '0'. This sweeps EVERY registered egg and moment: none may read it, so a stale '0' must
 * change nothing. (easterEggs.wiring.test.ts separately fails if any source file names the key.)
 */
const RETIRED_SWITCH_KEY = 'cipherline_easter_eggs';
const stale = (): EggStore => {
    const m = new Map<string, string>([[RETIRED_SWITCH_KEY, '0']]);
    return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
};

describe('a stale "0" under the retired switch key changes nothing, for every registered egg and moment', () => {
    it.each([...EGG_IDS].filter(id => !(id in MOMENTS)))('egg %s still fires', (id) => {
        expect(claimEgg(stale(), id, 1_000)).toBe(true);
    });
    it.each(Object.keys(MOMENTS) as MomentId[])('moment %s still fires', (id) => {
        expect(claimMoment(stale(), id, 1_000)).toBe(true);
    });
});
