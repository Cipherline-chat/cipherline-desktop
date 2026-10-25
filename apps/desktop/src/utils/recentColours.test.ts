import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
    map: new Map<string, string>(),
    failWrite: false,
    failRead: false,
}));
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => { if (store.failRead) throw new Error('locked'); return store.map.get(k) ?? null; },
        setItem: (k: string, v: string) => { if (store.failWrite) throw new Error('locked'); store.map.set(k, v); },
    },
}));

import { pushRecentColour, getRecentColours, subscribeRecentColours, parseRecent, MAX_RECENT, __resetRecentColoursForTests } from './recentColours';

beforeEach(() => {
    store.map.clear();
    store.failWrite = false;
    store.failRead = false;
    __resetRecentColoursForTests();
});

describe('recentColours', () => {
    it('starts empty', () => {
        expect(getRecentColours()).toEqual([]);
    });

    it('puts the newest first, lowercases, and expands shorthand', () => {
        pushRecentColour('#25E0C8');
        pushRecentColour('fff');
        expect(getRecentColours()).toEqual(['#ffffff', '#25e0c8']);
        expect(JSON.parse(store.map.get('cipherline_recent_colours')!)).toEqual(['#ffffff', '#25e0c8']);
    });

    it('deduplicates by moving an existing colour to the front', () => {
        pushRecentColour('#111111');
        pushRecentColour('#222222');
        pushRecentColour('#111111');
        expect(getRecentColours()).toEqual(['#111111', '#222222']);
    });

    it('caps at MAX_RECENT (8), dropping the oldest', () => {
        for (let i = 0; i < 12; i++) pushRecentColour(`#${String(i).padStart(2, '0')}0000`);
        const list = getRecentColours();
        expect(MAX_RECENT).toBe(8);
        expect(list).toHaveLength(8);
        expect(list[0]).toBe('#110000');
        expect(list[7]).toBe('#040000');
    });

    it('ignores invalid input', () => {
        pushRecentColour('not a colour');
        pushRecentColour('');
        expect(getRecentColours()).toEqual([]);
        expect(store.map.has('cipherline_recent_colours')).toBe(false);
    });

    it('hands out a stable snapshot reference until something changes', () => {
        pushRecentColour('#123456');
        const a = getRecentColours();
        expect(getRecentColours()).toBe(a);
        pushRecentColour('#654321');
        expect(getRecentColours()).not.toBe(a);
    });

    it('notifies subscribers (two open pickers stay in sync) and unsubscribes', () => {
        const fn = vi.fn();
        const off = subscribeRecentColours(fn);
        pushRecentColour('#abcdef');
        expect(fn).toHaveBeenCalledTimes(1);
        off();
        pushRecentColour('#fedcba');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('reads what is already in the store, tolerating a corrupt blob', () => {
        store.map.set('cipherline_recent_colours', JSON.stringify(['#AABBCC', 'zzz', '#aabbcc', 42, '#123']));
        expect(getRecentColours()).toEqual(['#aabbcc', '#112233']);
        expect(parseRecent('{not json')).toEqual([]);
        expect(parseRecent('{"a":1}')).toEqual([]);
        expect(parseRecent(null)).toEqual([]);
    });

    it('a locked store never throws; the list lives in memory for the session', () => {
        store.failWrite = true;
        expect(() => pushRecentColour('#010203')).not.toThrow();
        expect(getRecentColours()).toEqual(['#010203']);
        store.failRead = true;
        expect(() => getRecentColours()).not.toThrow();
        expect(() => pushRecentColour('#040506')).not.toThrow();
        expect(getRecentColours()).toEqual(['#040506', '#010203']);
    });

    it('a failing read alone degrades to empty', () => {
        store.failRead = true;
        expect(getRecentColours()).toEqual([]);
    });
});
