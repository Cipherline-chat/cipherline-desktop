import { describe, it, expect } from 'vitest';
import { achievementsFor, cardSections, featuredAchievements, levelFill, splitFold, TIER_RANK } from './profileCardLayout';
import { ACHIEVEMENTS } from './achievements/catalog';
import { ABOUT_BLOCKS_EXPANDED_MAX, type ShowcaseBlock } from './profileExtras';
import {
    anniversariesKey, anniversaryToastText, dueAnniversaries, parseLedger, registerFriendsSince, anniversaryYearsFor,
} from './profileMoments';
import { classifyKvKey } from '../services/backupRegistry';

const none: Record<ShowcaseBlock, boolean> = { steam: false, games: false, links: false, interests: false, achievements: false, most_played: false };
const all: Record<ShowcaseBlock, boolean> = { steam: true, games: true, links: true, interests: true, achievements: true, most_played: true };

describe('cardSections: what the card shows, per viewer', () => {
    it("keeps the owner's order and drops sections with nothing to show", () => {
        expect(cardSections({ blocks: ['links', 'steam', 'games'], has: { ...none, links: true, games: true } })).toEqual(['links', 'games']);
    });
    it('achievements and most played still appear (after the owner\'s) when the owner did not place them', () => {
        expect(cardSections({ blocks: ['games'], has: all })).toEqual(['games', 'achievements', 'most_played']);
        expect(cardSections({ blocks: ['most_played', 'games'], has: all })).toEqual(['most_played', 'games', 'achievements']);
    });
    it('a stranger (the server sends no most played) never gets the section, placed or not', () => {
        expect(cardSections({ blocks: ['most_played'], has: { ...all, most_played: false } })).not.toContain('most_played');
        expect(cardSections({ blocks: [], has: { ...all, most_played: false } })).toEqual(['achievements']);
    });
    it('nothing to show is an empty card body, never empty sections', () => {
        expect(cardSections({ blocks: ['steam', 'games', 'links'], has: none })).toEqual([]);
    });
    it('a duplicated block from the wire renders once', () => {
        expect(cardSections({ blocks: ['games', 'games'], has: all }).filter((b) => b === 'games')).toHaveLength(1);
    });
});

describe('splitFold', () => {
    it(`opens the first ${ABOUT_BLOCKS_EXPANDED_MAX}, folds the rest`, () => {
        expect(splitFold([1, 2, 3, 4, 5, 6])).toEqual({ open: [1, 2, 3, 4], folded: [5, 6] });
        expect(splitFold([1, 2])).toEqual({ open: [1, 2], folded: [] });
    });
});

describe('featuredAchievements: three medallions, never a list', () => {
    const u = (id: string, month: string) => ({ id, month });
    it("uses the owner's picks when there are any", () => {
        expect(featuredAchievements(null, ['streak-30', 'voice-2000h']).map((d) => d.id)).toEqual(['streak-30', 'voice-2000h']);
    });
    it('drops picks that are unknown or no longer unlocked (when the unlocked list is known)', () => {
        const got = featuredAchievements([u('streak-30', '2026-01')], ['nope', 'streak-30', 'voice-2000h']);
        expect(got.map((d) => d.id)).toEqual(['streak-30']);
    });
    it('otherwise the rarest: gold, then silver, then bronze; newest first within a tier; at most three', () => {
        const got = featuredAchievements([
            u('voice-100h', '2026-05'), // bronze
            u('streak-30', '2026-09'), // bronze, newer
            u('voice-500h', '2026-01'), // silver
            u('marathon-call', '2026-03'), // silver, newer
            u('voice-2000h', '2025-01'), // gold
        ], []);
        expect(got.map((d) => d.id)).toEqual(['voice-2000h', 'marathon-call', 'voice-500h']);
        expect(got.length).toBeLessThanOrEqual(3);
        for (let i = 1; i < got.length; i++) expect(TIER_RANK[got[i - 1].tier]).toBeGreaterThanOrEqual(TIER_RANK[got[i].tier]);
    });
    it('nothing unlocked and no picks: nothing', () => {
        expect(featuredAchievements([], [])).toEqual([]);
        expect(featuredAchievements(null, null)).toEqual([]);
    });
});

describe('achievementsFor: the View all sheet', () => {
    const unlocked = [{ id: 'voice-100h', month: '2026-05' }, { id: 'voice-2000h', month: '2026-01' }];
    it('Unlocked + Locked partition the catalogue', () => {
        const a = achievementsFor('unlocked', unlocked);
        const b = achievementsFor('locked', unlocked);
        expect(a.length + b.length).toBe(ACHIEVEMENTS.length);
        expect(a.map((d) => d.id)).toEqual(['voice-2000h', 'voice-100h']);
        expect(b.some((d) => d.id === 'voice-100h')).toBe(false);
    });
    it('your own locked ones sort closest-to-done first; secret ones go last and never by progress', () => {
        const progress = { 'streak-30': { current: 29, target: 30 }, 'msgs-5000': { current: 10, target: 5000 }, 'night-shift': { current: 10, target: 10 } };
        const got = achievementsFor('locked', [], progress);
        expect(got[0].id).toBe('streak-30');
        const firstSecret = got.findIndex((d) => d.secret);
        expect(got.slice(firstSecret).every((d) => d.secret)).toBe(true);
        expect(got.slice(firstSecret).map((d) => d.id)).toEqual(ACHIEVEMENTS.filter((d) => d.secret).map((d) => d.id));
    });
    it('without progress (someone else\'s card) the locked ones keep catalogue order', () => {
        expect(achievementsFor('locked', []).map((d) => d.id)).toEqual(ACHIEVEMENTS.map((d) => d.id));
    });
});

describe('levelFill', () => {
    it('is level / max, clamped', () => {
        expect(levelFill(5, 10)).toBe(0.5);
        expect(levelFill(12, 10)).toBe(1);
        expect(levelFill(-1, 10)).toBe(0);
        expect(levelFill(3, 0)).toBe(0);
    });
});


describe('friend anniversaries (open-the-app toast)', () => {
    const today = new Date(2026, 6, 19, 9, 0);
    const friends = [
        { user_id: 'a', username: 'Ada', friends_since: new Date(2024, 6, 19, 20).toISOString() },
        { user_id: 'b', username: 'Bo', friends_since: new Date(2024, 6, 20, 20).toISOString() },
        { user_id: 'c', username: 'Cy', friends_since: new Date(2026, 6, 19, 1).toISOString() },
        { user_id: 'd', username: 'Di' },
    ];
    it('only friends whose anniversary is today (and at least a year old) are due', () => {
        expect(dueAnniversaries(friends, today, {})).toEqual([{ user_id: 'a', username: 'Ada', years: 2 }]);
    });
    it('once per friend per year: the ledger suppresses a repeat, a new year is due again', () => {
        expect(dueAnniversaries(friends, today, { a: 2026 })).toEqual([]);
        expect(dueAnniversaries(friends, new Date(2027, 6, 19), { a: 2026 }).map((d) => d.user_id)).toEqual(['a', 'c']);
    });
    it('toast wording for none / one / several', () => {
        expect(anniversaryToastText([])).toBeNull();
        expect(anniversaryToastText([{ user_id: 'a', username: 'Ada', years: 1 }])).toBe('You and Ada have been friends for one year today.');
        expect(anniversaryToastText([{ user_id: 'a', username: 'Ada', years: 2 }, { user_id: 'b', username: 'Bo', years: 1 }]))
            .toBe('Ada (2 years) and 1 more friend anniversary today.');
    });
    it('the card looks the day up from the friends list it was registered from', () => {
        registerFriendsSince(friends);
        expect(anniversaryYearsFor('a', today)).toBe(2);
        expect(anniversaryYearsFor('b', today)).toBe(0);
        expect(anniversaryYearsFor('stranger', today)).toBe(0);
    });
    it('the ledger parses defensively and is a per-device (excluded) backup key', () => {
        expect(parseLedger('{"a":2026,"b":"x"}')).toEqual({ a: 2026 });
        expect(parseLedger('not json')).toEqual({});
        expect(parseLedger(null)).toEqual({});
        expect(classifyKvKey(anniversariesKey('u1'), 'u1')).toBe('exclude');
    });
});
