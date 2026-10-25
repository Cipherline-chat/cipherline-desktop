import { describe, it, expect } from 'vitest';
import {
    DEMOTE_AFTER_MS,
    PROMOTE_AFTER_TICKS,
    advanceSpeakerTicks,
    applyPromotion,
    prioritizeForOverflow,
    stripTier,
    type TierInput,
} from './overflowPriority';

interface Entry extends TierInput { label?: string }
const describeEntry = (e: Entry): TierInput => e;
const ids = (xs: readonly Entry[]) => xs.map(x => x.identity);

const share: Entry = { identity: 'share', hasVideo: true };
const cam1: Entry = { identity: 'cam1', hasVideo: true };
const cam2: Entry = { identity: 'cam2', hasVideo: true };
const gate: Entry = { identity: 'gate', hasVideo: false, gated: true };
const a1: Entry = { identity: 'a1', hasVideo: false };
const a2: Entry = { identity: 'a2', hasVideo: false };
const a3: Entry = { identity: 'a3', hasVideo: false };

describe('applyPromotion (shared with the sidebar)', () => {
    const list = [{ identity: 'a' }, { identity: 'b' }, { identity: 'c' }, { identity: 'd' }];

    it('moves promoted ids to the front, most recently promoted first', () => {
        expect(applyPromotion(list, ['c', 'a']).map(x => x.identity)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('keeps everyone else in their original order', () => {
        expect(applyPromotion(list, ['d']).map(x => x.identity)).toEqual(['d', 'a', 'b', 'c']);
    });

    it('ignores promoted ids that are not in the list, and an empty promotion list', () => {
        expect(applyPromotion(list, ['zzz']).map(x => x.identity)).toEqual(['a', 'b', 'c', 'd']);
        expect(applyPromotion(list, []).map(x => x.identity)).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('stripTier', () => {
    it('ranks pictures, then gates, then promoted speakers, then the rest', () => {
        const promoted = new Set(['a2']);
        expect(stripTier(cam1, promoted)).toBe(0);
        expect(stripTier(share, promoted)).toBe(0);
        expect(stripTier(gate, promoted)).toBe(1);
        expect(stripTier(a2, promoted)).toBe(2);
        expect(stripTier(a1, promoted)).toBe(3);
    });
});

describe('prioritizeForOverflow (strip mode)', () => {
    const roster = [a1, a2, gate, cam1, a3, share, cam2];

    it('does not reorder anything while everything fits', () => {
        const out = prioritizeForOverflow(roster, { overflowing: false, promotedIds: ['a3'], describe: describeEntry });
        expect(ids(out)).toEqual(ids(roster));
    });

    it('puts shares and cameras first, then gates, then the rest, in original order', () => {
        const out = prioritizeForOverflow(roster, { overflowing: true, promotedIds: [], describe: describeEntry });
        expect(ids(out)).toEqual(['cam1', 'share', 'cam2', 'gate', 'a1', 'a2', 'a3']);
    });

    it('then recent/active speakers (nothing to show) ahead of the silent rest', () => {
        const out = prioritizeForOverflow(roster, { overflowing: true, promotedIds: ['a3', 'a2'], describe: describeEntry });
        expect(ids(out)).toEqual(['cam1', 'share', 'cam2', 'gate', 'a3', 'a2', 'a1']);
    });

    it('promotes an active speaker within the picture tier too', () => {
        const out = prioritizeForOverflow(roster, { overflowing: true, promotedIds: ['cam2'], describe: describeEntry });
        expect(ids(out).slice(0, 3)).toEqual(['cam2', 'cam1', 'share']);
    });

    it('is stable and does not mutate its input', () => {
        const input = [...roster];
        const once = prioritizeForOverflow(input, { overflowing: true, promotedIds: ['a2'], describe: describeEntry });
        const twice = prioritizeForOverflow(once, { overflowing: true, promotedIds: ['a2'], describe: describeEntry });
        expect(ids(twice)).toEqual(ids(once));
        expect(input).toEqual(roster);
    });

    it('handles empty and single-item strips', () => {
        expect(prioritizeForOverflow([], { overflowing: true, promotedIds: [], describe: describeEntry })).toEqual([]);
        expect(ids(prioritizeForOverflow([a1], { overflowing: true, promotedIds: ['a1'], describe: describeEntry }))).toEqual(['a1']);
    });

    it('a participant promoted in the sidebar order is promoted in the strip order (one rule set)', () => {
        const promotedIds = ['a2'];
        const sidebar = applyPromotion([a1, a2, a3], promotedIds);
        const strip = prioritizeForOverflow([a1, a2, a3], { overflowing: true, promotedIds, describe: describeEntry });
        expect(ids(strip)).toEqual(ids(sidebar));
    });
});

describe('advanceSpeakerTicks (the anti-jitter hysteresis)', () => {
    const speak = (isSpeaking: boolean) => [{ identity: 'x', isSpeaking }];

    it('does not promote on a blip shorter than the threshold', () => {
        const ticks: Record<string, number> = {};
        expect(advanceSpeakerTicks(ticks, speak(true)).promote).toEqual([]);
        expect(advanceSpeakerTicks(ticks, speak(false)).promote).toEqual([]);
        expect(ticks.x).toBe(0);
    });

    it(`promotes exactly once, on the ${PROMOTE_AFTER_TICKS}nd consecutive speaking tick`, () => {
        const ticks: Record<string, number> = {};
        const seen: string[][] = [];
        for (let i = 0; i < 6; i++) seen.push(advanceSpeakerTicks(ticks, speak(true)).promote);
        expect(seen.map(s => s.length)).toEqual([0, 1, 0, 0, 0, 0]);
    });

    it('reports a demotion edge once when speech stops, never while still above the threshold', () => {
        const ticks: Record<string, number> = { x: 4 };
        expect(advanceSpeakerTicks(ticks, speak(false)).demote).toEqual([]); // 4 -> 3
        expect(advanceSpeakerTicks(ticks, speak(false)).demote).toEqual([]); // 3 -> 2
        expect(advanceSpeakerTicks(ticks, speak(false)).demote).toEqual(['x']); // 2 -> 1: crossed
        expect(advanceSpeakerTicks(ticks, speak(false)).demote).toEqual([]); // 1 -> 0
        expect(advanceSpeakerTicks(ticks, speak(false)).demote).toEqual([]); // stays idle
    });

    it('keeps the demotion delay long enough to ride out a normal pause', () => {
        expect(DEMOTE_AFTER_MS).toBeGreaterThanOrEqual(3000);
    });
});
