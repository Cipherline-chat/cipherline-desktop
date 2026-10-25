// @vitest-environment jsdom
/**
 * The one-time "make sure it's really them" hint: the pure eligibility rule (every
 * condition, both ways), the thread counter, and the per-account "done" record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    return {
        map,
        readyUserId: null as string | null,
        getItem: vi.fn((k: string) => map.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { map.set(k, v); }),
        isAccountReady: vi.fn((uid: string) => !!uid && store.readyUserId === uid),
    };
});
vi.mock('./secureLocalStore', () => ({ secureLocalStore: store, default: store }));

import {
    HINT_MIN_PER_SIDE, HINT_QUIET_START_MS, HINT_SEEN_MS, SAFETY_HINT_DONE_PREFIX, SAFETY_HINT_EVENT,
    SAFETY_HINT_TITLE, SAFETY_HINT_PRIMARY, SAFETY_HINT_SECONDARY, safetyHintBody,
    safetyHintBlocker, safetyHintEligible, quietStartLeftMs, countThreadSides,
    hintStoreReady, isHintDone, markHintDone, subscribeHintDone, type HintFacts,
} from './safetyVerifyHint';
import { classifyKvKey } from '../services/backupRegistry';
import { isTextLikeMessageType } from './messageMenuGating';

const ELIGIBLE: HintFacts = {
    isOneToOneDm: true, isSelfChat: false, trustLevel: 'unverified', warningActive: false, verifiedAnyone: false,
    messagesFromMe: 5, messagesFromThem: 5, callActiveHere: false, sinceAppStartMs: HINT_QUIET_START_MS,
    alreadyDone: false, tipsOff: false,
};

describe('eligibility: all conditions hold -> eligible', () => {
    it('the baseline is eligible, exactly at every threshold', () => {
        expect(safetyHintEligible(ELIGIBLE)).toBe(true);
        expect(safetyHintBlocker(ELIGIBLE)).toBeNull();
        expect(HINT_MIN_PER_SIDE).toBe(5);
        expect(HINT_QUIET_START_MS).toBe(60_000);
    });
    it('plenty of history and a long-running app are fine too', () => {
        expect(safetyHintEligible({ ...ELIGIBLE, messagesFromMe: 400, messagesFromThem: 90, sinceAppStartMs: 9e9 })).toBe(true);
    });
});

describe('eligibility: each condition on its own blocks it', () => {
    const cases: Array<[string, Partial<HintFacts>, string]> = [
        ['already finished with', { alreadyDone: true }, 'done'],
        ['tips are switched off', { tipsOff: true }, 'tips-off'],
        ['your own notes chat', { isSelfChat: true }, 'self-chat'],
        ['a group or a server channel', { isOneToOneDm: false }, 'not-a-dm'],
        ['the contact is already verified', { trustLevel: 'verified' }, 'trust-level'],
        ['the contact is verified on an old (v1) comparison', { trustLevel: 'verified_legacy' }, 'trust-level'],
        ['the contact is partly verified', { trustLevel: 'partially_verified' }, 'trust-level'],
        ['the contact has no keys to compare', { trustLevel: 'unverifiable' }, 'trust-level'],
        ['a key-change / forgery warning owns the topic', { trustLevel: 'compromised' }, 'trust-level'],
        ['a warning banner is up', { warningActive: true }, 'warning'],
        ['the user has verified someone else', { verifiedAnyone: true }, 'verified-someone'],
        ['4 messages from me (one short)', { messagesFromMe: 4 }, 'thin-history'],
        ['4 messages from them (one short)', { messagesFromThem: 4 }, 'thin-history'],
        ['one-sided: a hundred from me, none from them', { messagesFromMe: 100, messagesFromThem: 0 }, 'thin-history'],
        ['an empty thread', { messagesFromMe: 0, messagesFromThem: 0 }, 'thin-history'],
        ['a call is live in this DM', { callActiveHere: true }, 'in-call'],
        ['the first minute after start (59.999 s)', { sinceAppStartMs: HINT_QUIET_START_MS - 1 }, 'just-started'],
        ['the very start', { sinceAppStartMs: 0 }, 'just-started'],
    ];
    it.each(cases)('%s', (_name, patch, why) => {
        const f = { ...ELIGIBLE, ...patch };
        expect(safetyHintEligible(f)).toBe(false);
        expect(safetyHintBlocker(f)).toBe(why);
    });
    it('quietStartLeftMs counts down to the end of the first minute', () => {
        expect(quietStartLeftMs(0)).toBe(60_000);
        expect(quietStartLeftMs(45_000)).toBe(15_000);
        expect(quietStartLeftMs(60_000)).toBe(0);
        expect(quietStartLeftMs(10 ** 9)).toBe(0);
    });
});

describe('the copy is exactly what the owner wrote', () => {
    it('title, body, buttons', () => {
        expect(SAFETY_HINT_TITLE).toBe('Make sure it’s really them');
        expect(safetyHintBody('Mara')).toBe('Compare safety numbers with Mara once, in person or on a call. If they match, nobody is sitting in the middle.');
        expect(SAFETY_HINT_PRIMARY).toBe('Compare now');
        expect(SAFETY_HINT_SECONDARY).toBe('Not now');
    });
    it('plain: no exclamation marks, no puns', () => {
        expect(`${SAFETY_HINT_TITLE} ${safetyHintBody('Mara')}`).not.toMatch(/!/);
    });
});

describe('countThreadSides', () => {
    const msg = (type: string, mine: boolean) => ({ content: { type }, mine });
    const isMine = (m: { mine: boolean }) => m.mine;
    it('counts text-like rows per side, ignoring system rows, calls, reactions and attachments', () => {
        const rows = [
            msg('text', true), msg('text', false), msg('klipy_gif', true), msg('server_invite', false),
            msg('system', true), msg('call_key', false), msg('reaction', true), msg('attachment', false),
            { content: null, mine: true }, { mine: false },
        ];
        expect(countThreadSides(rows, isMine, isTextLikeMessageType)).toEqual({ mine: 2, theirs: 2 });
    });
    it('stops counting once both sides have enough (long threads stay cheap)', () => {
        const rows = Array.from({ length: 1000 }, (_, i) => msg('text', i % 2 === 0));
        const seen = vi.fn(isMine);
        const r = countThreadSides(rows, seen, isTextLikeMessageType);
        expect(r.mine).toBeGreaterThanOrEqual(5);
        expect(r.theirs).toBeGreaterThanOrEqual(5);
        expect(seen.mock.calls.length).toBeLessThan(20);
    });
    it('an empty or missing thread is zero on both sides', () => {
        expect(countThreadSides([] as Array<{ mine: boolean; content?: null }>, isMine, isTextLikeMessageType)).toEqual({ mine: 0, theirs: 0 });
        expect(countThreadSides<{ mine: boolean; content?: null }>(null, isMine, isTextLikeMessageType)).toEqual({ mine: 0, theirs: 0 });
    });
});

describe('persistence: finished once, for the account, for good', () => {
    beforeEach(() => {
        store.map.clear();
        store.readyUserId = 'u1';
        store.getItem.mockClear(); store.setItem.mockClear();
    });
    const KEY = (u: string) => `${SAFETY_HINT_DONE_PREFIX}${u}`;

    it('starts not done; marking is one record "1" in the secure store under the account', () => {
        expect(isHintDone('u1')).toBe(false);
        markHintDone('u1', 'closed');
        expect(store.map.get(KEY('u1'))).toBe('1');
        expect(isHintDone('u1')).toBe(true);
    });
    it('is per account: finishing it for one account leaves the other’s alone', () => {
        markHintDone('u1');
        store.readyUserId = 'u2';
        expect(isHintDone('u2')).toBe(false);
    });
    it('each route marks it done: a button / Escape (closed), being seen, verifying anyone', () => {
        for (const reason of ['closed', 'seen', 'verified'] as const) {
            store.map.clear();
            markHintDone('u1', reason);
            expect(isHintDone('u1')).toBe(true);
        }
    });
    it('is idempotent: one write however many times it is marked', () => {
        markHintDone('u1'); markHintDone('u1', 'verified'); markHintDone('u1', 'seen');
        expect(store.setItem).toHaveBeenCalledTimes(1);
    });
    it('tells subscribers WHY (an open card stays up for "seen", comes down for the others)', () => {
        const heard: string[] = [];
        const off = subscribeHintDone(r => heard.push(r));
        markHintDone('u1', 'seen'); markHintDone('u1', 'closed'); markHintDone('u1', 'verified');
        off();
        markHintDone('u1', 'closed');
        expect(heard).toEqual(['seen', 'closed', 'verified']);
        expect(SAFETY_HINT_EVENT).toBe('cipherline:safety-hint-changed');
    });
    it('before the account’s records are loaded it reads as DONE and writes nothing (a cold namespace would repeat it)', () => {
        store.readyUserId = null;
        expect(hintStoreReady('u1')).toBe(false);
        expect(isHintDone('u1')).toBe(true);
        markHintDone('u1');
        expect(store.setItem).not.toHaveBeenCalled();
        expect(isHintDone(null)).toBe(true);
        expect(isHintDone('')).toBe(true);
    });
    it('an unreadable store reads as done and never throws', () => {
        store.getItem.mockImplementationOnce(() => { throw new Error('locked'); });
        expect(isHintDone('u1')).toBe(true);
        store.setItem.mockImplementationOnce(() => { throw new Error('locked'); });
        expect(() => markHintDone('u1')).not.toThrow();
    });
    it('the seen threshold is a few seconds, not instant', () => {
        expect(HINT_SEEN_MS).toBeGreaterThanOrEqual(3000);
    });
});

describe('backups', () => {
    it('the done record is classified, and excluded from vaults (a one-time UI marker)', () => {
        expect(classifyKvKey(`${SAFETY_HINT_DONE_PREFIX}u1`, 'u1')).toBe('exclude');
        expect(classifyKvKey(`${SAFETY_HINT_DONE_PREFIX}8f3c1e52-aaaa-bbbb-cccc-123456789abc`, '8f3c1e52-aaaa-bbbb-cccc-123456789abc')).toBe('exclude');
    });
});
