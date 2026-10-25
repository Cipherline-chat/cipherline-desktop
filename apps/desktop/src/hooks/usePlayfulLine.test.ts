// @vitest-environment jsdom
/**
 * Egg: playful empty states (Home search with no matches, Game Activity with
 * nothing detected, friends search with no match). One hook, three call sites.
 * Controls: the switch OFF returns the plain line; the same seed keeps the
 * same joke across renders; different seeds rotate; every pool still says the
 * useful thing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { usePlayfulLine } = await import('./useEasterEggs');
const { EMPTY_SEARCH_POOL, NO_GAME_POOL, FRIENDS_NO_MATCH_POOL } = await import('../utils/eggPools');
const { hashSeed } = await import('../utils/easterEggs');
/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    store.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const Probe: React.FC<{ plain: string; pool: readonly string[]; seed: number }> = ({ plain, pool, seed }) =>
    React.createElement('span', { id: 'l' }, usePlayfulLine(plain, pool, seed));
const line = (plain: string, pool: readonly string[], seed: number) => {
    act(() => root.render(React.createElement(Probe, { plain, pool, seed })));
    return host.querySelector('#l')!.textContent;
};
const src = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

describe('usePlayfulLine', () => {
    it('a pool line; same seed = same line; next seed = next line', () => {
        expect(line('No matches', EMPTY_SEARCH_POOL, 3)).toBe(EMPTY_SEARCH_POOL[3]);
        expect(line('No matches', EMPTY_SEARCH_POOL, 3)).toBe(EMPTY_SEARCH_POOL[3]);
        expect(line('No matches', EMPTY_SEARCH_POOL, 4)).toBe(EMPTY_SEARCH_POOL[0]);
    });
    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        expect(line('No matches', EMPTY_SEARCH_POOL, 3)).toBe(EMPTY_SEARCH_POOL[3]);
        expect(line('', FRIENDS_NO_MATCH_POOL, 1)).toBe(FRIENDS_NO_MATCH_POOL[1]);
    });
    it('an empty pool falls back to the plain line', () => {
        expect(line('No matches', [], 3)).toBe('No matches');
    });
});

describe('the pools keep doing their job', () => {
    it('every empty-search line still says "No matches"', () => {
        for (const l of EMPTY_SEARCH_POOL) expect(l).toMatch(/^No matches/);
    });
    it('every no-game line keeps the instruction, and the first is the original sentence', () => {
        expect(NO_GAME_POOL[0]).toBe('Launch something and it’ll show up here within a few seconds.');
        for (const l of NO_GAME_POOL) expect(l).toMatch(/Launch (something|a game)/);
    });
    it('hashSeed is stable and spreads different queries', () => {
        expect(hashSeed('zzz')).toBe(hashSeed('zzz'));
        expect(new Set(['a', 'b', 'c', 'ab', 'abc'].map(hashSeed)).size).toBe(5);
    });
});

describe('wiring', () => {
    it('Home search, Game Activity and the friends search use the hook with a plain fallback', () => {
        expect(src('components/HomePanel.tsx')).toMatch(/usePlayfulLine\('No matches', EMPTY_SEARCH_POOL, hashSeed\(search\)\)/);
        expect(src('components/HomePanel.tsx')).toMatch(/search \? noMatchLine : 'Start typing to search'/);
        expect(src('components/GameActivitySettings.tsx')).toMatch(/usePlayfulLine\(NO_GAME_POOL\[0\], NO_GAME_POOL, dayNumber\(new Date\(\)\)\)/);
        expect(src('components/FriendsPane.tsx')).toMatch(/usePlayfulLine\('', FRIENDS_NO_MATCH_POOL, hashSeed\(search\)\)/);
    });
});
