import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    },
}));

import { readLoadingGameBest, saveLoadingGameBest, LOADING_GAME_BEST_KEY } from './loadingGameBest';

beforeEach(() => store.clear());

describe('loading game best score', () => {
    it('is 0 when nothing is stored, and ignores junk', () => {
        expect(readLoadingGameBest()).toBe(0);
        store.set(LOADING_GAME_BEST_KEY, 'banana');
        expect(readLoadingGameBest()).toBe(0);
        store.set(LOADING_GAME_BEST_KEY, '-4');
        expect(readLoadingGameBest()).toBe(0);
    });

    it('persists a new best and reads it back (the restart case)', () => {
        expect(saveLoadingGameBest(12)).toBe(12);
        expect(store.get(LOADING_GAME_BEST_KEY)).toBe('12');
        expect(readLoadingGameBest()).toBe(12);
    });

    it('never lowers the record', () => {
        saveLoadingGameBest(12);
        expect(saveLoadingGameBest(5)).toBe(12);
        expect(saveLoadingGameBest(12)).toBe(12);
        expect(readLoadingGameBest()).toBe(12);
    });

    it('survives a store that throws (locked / unhydrated)', () => {
        store.set(LOADING_GAME_BEST_KEY, '9');
        vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('not hydrated'); });
        expect(readLoadingGameBest()).toBe(0);
        expect(() => saveLoadingGameBest(3)).not.toThrow();
        vi.restoreAllMocks();
    });
});
