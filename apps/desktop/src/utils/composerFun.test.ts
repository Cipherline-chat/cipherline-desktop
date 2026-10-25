import { describe, it, expect, beforeEach } from 'vitest';
import {
    EVERYONE_CONFIRM_THRESHOLD, needsEveryoneConfirm, massMentionOf, isBigRoom, everyoneConfirmCopy, formatCount,
    createSendSpamTracker, SPAM_FIRST_AT, SPAM_WINDOW_MS, SPAM_STEP, SPAM_STREAK_GAP_MS, SPAM_COOLDOWN_MS,
    charCounter, isOnTheHour, isFirstSendOfDay, firstTodayPool, FIRST_TODAY_MORNING_LINES, FIRST_TODAY_LINES,
    claimBigPasteChip, __resetBigPasteChip, BIG_PASTE_CHARS, COMPOSER_FUN_POOLS,
    type EveryoneConfirmInput,
} from './composerFun';

const base: EveryoneConfirmInput = {
    mentions: [{ type: 'everyone' }],
    memberCount: 101,
    isServerChannel: true,
    canMention: true,
    isEdit: false,
    alreadyConfirmed: false,
};

describe('needsEveryoneConfirm — the >100-member threshold', () => {
    it('is strictly greater than 100', () => {
        expect(EVERYONE_CONFIRM_THRESHOLD).toBe(100);
        expect(needsEveryoneConfirm({ ...base, memberCount: 100 })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, memberCount: 101 })).toBe(true);
        expect(needsEveryoneConfirm({ ...base, memberCount: 99 })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, memberCount: 5000 })).toBe(true);
    });

    it('@here asks too; a user/role mention or no mention does not', () => {
        expect(needsEveryoneConfirm({ ...base, mentions: [{ type: 'here' }] })).toBe(true);
        expect(needsEveryoneConfirm({ ...base, mentions: [{ type: 'user' }, { type: 'role' }] })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, mentions: [] })).toBe(false);
    });

    it('never stands in front of the permission refusal (no MENTION_EVERYONE → no dialog)', () => {
        expect(needsEveryoneConfirm({ ...base, canMention: false })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, canMention: false, mentions: [{ type: 'here' }], memberCount: 9999 })).toBe(false);
    });

    it('asks once: the confirmed re-entry goes straight through', () => {
        expect(needsEveryoneConfirm({ ...base, alreadyConfirmed: true })).toBe(false);
    });

    it('edits, DMs/groups and an unloaded roster never ask', () => {
        expect(needsEveryoneConfirm({ ...base, isEdit: true })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, isServerChannel: false })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, memberCount: null })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, memberCount: undefined })).toBe(false);
        expect(needsEveryoneConfirm({ ...base, memberCount: Number.NaN })).toBe(false);
    });

    it('isBigRoom / massMentionOf', () => {
        expect(isBigRoom(100)).toBe(false);
        expect(isBigRoom(101)).toBe(true);
        expect(massMentionOf([{ type: 'here' }, { type: 'everyone' }])).toBe('everyone');
        expect(massMentionOf([{ type: 'user' }, { type: 'here' }])).toBe('here');
        expect(massMentionOf([{ type: 'user' }])).toBeNull();
    });
});

describe('everyoneConfirmCopy', () => {
    it('states the real member count', () => {
        expect(everyoneConfirmCopy('everyone', 1284)).toEqual({
            title: 'Mention everyone?',
            message: 'This will notify 1,284 members.',
            confirmLabel: 'Send to everyone',
        });
    });
    it('@here is honest that it is the online members', () => {
        const c = everyoneConfirmCopy('here', 101);
        expect(c.title).toBe('Mention everyone?');
        expect(c.message).toMatch(/online/);
        expect(c.message).toMatch(/101/);
    });
    it('formats with grouping regardless of locale', () => {
        expect(formatCount(1234567)).toBe('1,234,567');
        expect(formatCount(-3)).toBe('0');
    });
});

describe('createSendSpamTracker', () => {
    const clicks = (t: ReturnType<typeof createSendSpamTracker>, times: number[]) => times.map(n => t.click(n));

    it('4 quick clicks do nothing; the 5th inside 2 s wobbles', () => {
        const t = createSendSpamTracker();
        const out = clicks(t, [0, 200, 400, 600, 800]);
        expect(out.slice(0, 4)).toEqual([null, null, null, null]);
        expect(out[4]).toBe('wobble');
        expect(SPAM_FIRST_AT).toBe(5);
    });

    it('5 clicks spread over more than 2 s never start it', () => {
        const t = createSendSpamTracker();
        // 600 ms apart: inside the streak gap, but 5 clicks span 2.4 s > window.
        const out = clicks(t, [0, 600, 1200, 1800, 2400, 3000, 3600]);
        expect(out.every(x => x === null)).toBe(true);
        expect(4 * 600).toBeGreaterThan(SPAM_WINDOW_MS);
    });

    it('escalates wobble → sulk → keys, SPAM_STEP clicks apart', () => {
        const t = createSendSpamTracker();
        const times = Array.from({ length: 5 + 2 * SPAM_STEP }, (_, i) => i * 150);
        const out = clicks(t, times);
        expect(out[4]).toBe('wobble');
        expect(out[4 + SPAM_STEP]).toBe('sulk');
        expect(out[4 + 2 * SPAM_STEP]).toBe('keys');
        expect(out.filter(Boolean)).toEqual(['wobble', 'sulk', 'keys']);
    });

    it('is rate-limited: after Keys, clicks are ignored for the cooldown', () => {
        const t = createSendSpamTracker();
        const times = Array.from({ length: 5 + 2 * SPAM_STEP }, (_, i) => i * 150);
        clicks(t, times);
        const end = times[times.length - 1];
        const during = clicks(t, Array.from({ length: 10 }, (_, i) => end + 200 + i * 100));
        expect(during.every(x => x === null)).toBe(true);
        const after = end + SPAM_COOLDOWN_MS + 10;
        expect(clicks(t, [0, 1, 2, 3, 4].map(i => after + i * 100))[4]).toBe('wobble');
    });

    it('a pause longer than the streak gap resets the ladder', () => {
        const t = createSendSpamTracker();
        clicks(t, [0, 100, 200, 300, 400]);                 // wobble
        const resume = 400 + SPAM_STREAK_GAP_MS + 1;
        const out = clicks(t, [resume, resume + 100, resume + 200, resume + 300]);
        expect(out).toEqual([null, null, null, null]);     // would have been sulk at +4 without the reset
        expect(t.click(resume + 400)).toBe('wobble');       // starts over
    });

    it('reset() forgets the streak', () => {
        const t = createSendSpamTracker();
        clicks(t, [0, 100, 200, 300]);
        t.reset();
        expect(t.click(400)).toBeNull();
    });
});

describe('charCounter', () => {
    it('hides until 90% of the cap, then counts down, and is "full" at the cap', () => {
        expect(charCounter(0, 1000)).toBeNull();
        expect(charCounter(899, 1000)).toBeNull();
        expect(charCounter(900, 1000)).toEqual({ remaining: 100, full: false });
        expect(charCounter(999, 1000)).toEqual({ remaining: 1, full: false });
        expect(charCounter(1000, 1000)).toEqual({ remaining: 0, full: true });
        expect(charCounter(1200, 1000)).toEqual({ remaining: 0, full: true });
    });
});

describe('clock-gated touches', () => {
    it('on the hour = the :00 minute, local', () => {
        expect(isOnTheHour(new Date(2026, 9, 20, 14, 0, 0))).toBe(true);
        expect(isOnTheHour(new Date(2026, 9, 20, 14, 0, 59))).toBe(true);
        expect(isOnTheHour(new Date(2026, 9, 20, 14, 1, 0))).toBe(false);
        expect(isOnTheHour(new Date(2026, 9, 20, 13, 59, 59))).toBe(false);
    });

    it('first send of the day compares LOCAL calendar days', () => {
        const morning = new Date(2026, 9, 20, 8, 0);
        expect(isFirstSendOfDay(undefined, morning)).toBe(true);
        expect(isFirstSendOfDay(new Date(2026, 9, 19, 23, 59).getTime(), morning)).toBe(true);
        expect(isFirstSendOfDay(new Date(2026, 9, 20, 0, 1).getTime(), morning)).toBe(false);
        // A clock moved backwards never fires.
        expect(isFirstSendOfDay(new Date(2026, 9, 21, 9, 0).getTime(), morning)).toBe(false);
    });

    it('"Good morning" only before noon', () => {
        expect(firstTodayPool(new Date(2026, 9, 20, 7, 0))).toBe(FIRST_TODAY_MORNING_LINES);
        expect(firstTodayPool(new Date(2026, 9, 20, 12, 0))).toBe(FIRST_TODAY_LINES);
        expect(firstTodayPool(new Date(2026, 9, 20, 2, 0))).toBe(FIRST_TODAY_LINES);
    });
});

describe('big paste chip', () => {
    beforeEach(() => __resetBigPasteChip());
    it('fires once per session, only for a long paste', () => {
        expect(claimBigPasteChip(BIG_PASTE_CHARS - 1)).toBe(false);
        expect(claimBigPasteChip(BIG_PASTE_CHARS)).toBe(true);
        expect(claimBigPasteChip(BIG_PASTE_CHARS * 10)).toBe(false);
    });
});

describe('copy — the doctrine checks eggPools.test.ts applies to ALL_POOLS', () => {
    it.each(Object.entries(COMPOSER_FUN_POOLS))('%s: ≥3 distinct non-empty lines', (_n, pool) => {
        expect(pool.length).toBeGreaterThanOrEqual(3);
        expect(new Set(pool).size).toBe(pool.length);
        for (const l of pool) expect(l.trim()).not.toBe('');
    });
    it.each(Object.entries(COMPOSER_FUN_POOLS))('%s: no "sealed", no tacked-on sea puns (owner, 2026-10-20)', (_n, pool) => {
        for (const l of pool) {
            expect(l).not.toMatch(/\bseal(ed|s|ing)?\b/i);
            expect(l).not.toMatch(/\b(bubbl\w*|ocean|deep|tide|ink|abyss|splash|fish\w*)\b/i);
        }
    });
});
