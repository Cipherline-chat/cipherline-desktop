import { describe, it, expect, vi } from 'vitest';
import { GAME_ART_KEY, GAME_ART_MAX, GAME_ICON_MAX_CHARS, GameArtCache, forgetOwnGameArt, loadOwnGameArt, readOwnGameArt } from './gameArt';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////';

function kv(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('readOwnGameArt: the answer from main is checked field by field', () => {
    it('accepts a well-formed answer', () => {
        expect(readOwnGameArt({ name: 'BeamNG.drive', icon: PNG, store: 'steam', appId: 284160 })).toEqual({ name: 'BeamNG.drive', icon: PNG, store: 'steam', appId: 284160 });
    });

    it('turns every bad field into null and rejects a bad name outright', () => {
        const bad = readOwnGameArt({ name: 'X', icon: 'javascript:alert(1)', store: 'origin', appId: -3 });
        expect(bad).toEqual({ name: 'X', icon: null, store: null, appId: null });
        for (const icon of [JPG, 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,not base64!', 'data:image/png,raw', `data:image/png;base64,${'A'.repeat(GAME_ICON_MAX_CHARS)}`, 5, {}]) {
            expect(readOwnGameArt({ name: 'X', icon })?.icon, String(icon).slice(0, 30)).toBeNull();
        }
        for (const appId of [0, 1.5, 2 ** 31, '730', NaN, null]) expect(readOwnGameArt({ name: 'X', appId })?.appId).toBeNull();
        for (const raw of [null, undefined, 'x', 7, {}, { name: '' }, { name: 5 }, { name: 'x'.repeat(201) }]) expect(readOwnGameArt(raw)).toBeNull();
    });
});

describe('GameArtCache: the per-device record', () => {
    it('keeps a game across restarts (a new cache over the same store reads it back)', () => {
        const store = kv();
        new GameArtCache(store).put('Elden Ring', { icon: PNG, store: 'steam', appId: 1245620 });
        const again = new GameArtCache(store).get('ELDEN RING');
        expect(again).toMatchObject({ name: 'Elden Ring', icon: PNG, store: 'steam', appId: 1245620 });
    });

    it('merges pictures: the icon stays when the better one arrives', () => {
        const c = new GameArtCache(kv());
        c.put('X', { icon: PNG });
        c.put('X', { cover: JPG });
        expect(c.get('X')).toMatchObject({ icon: PNG, cover: JPG });
    });

    it('notifies only when something actually changed', () => {
        const c = new GameArtCache(kv());
        const cb = vi.fn();
        c.subscribe(cb);
        c.put('X', { icon: PNG });
        c.put('X', { icon: PNG });
        expect(cb).toHaveBeenCalledTimes(1);
        c.put('X', { cover: JPG });
        expect(cb).toHaveBeenCalledTimes(2);
    });

    it('is bounded and drops the least recently used game', () => {
        const store = kv();
        const c = new GameArtCache(store);
        for (let i = 0; i < GAME_ART_MAX + 4; i++) c.put(`Game ${i}`, { icon: PNG });
        expect(c.get('Game 0')).toBeNull();
        expect(c.get(`Game ${GAME_ART_MAX + 3}`)).not.toBeNull();
        const stored = JSON.parse(store.getItem(GAME_ART_KEY) ?? '{}');
        expect(Object.keys(stored).length).toBeLessThanOrEqual(GAME_ART_MAX);
    });

    it('refuses an oversize picture and survives a damaged or hostile record', () => {
        const c = new GameArtCache(kv());
        c.put('Big', { cover: `data:image/jpeg;base64,${'A'.repeat(GAME_ICON_MAX_CHARS)}` });
        expect(c.get('Big')?.cover).toBeUndefined();

        expect(new GameArtCache(kv({ [GAME_ART_KEY]: '{not json' })).get('X')).toBeNull();
        const hostile = JSON.stringify({
            x: { name: 'X', at: 1, icon: 'javascript:alert(1)' },
            y: { name: 'Y', at: 1, cover: 'https://evil.example/a.png' },
            z: { name: 'Z', at: 1, store: 'nope' },
            w: { name: 'NotW', at: 1, icon: PNG },
        });
        const h = new GameArtCache(kv({ [GAME_ART_KEY]: hostile }));
        for (const n of ['X', 'Y', 'Z', 'W', 'NotW']) expect(h.get(n), n).toBeNull();
    });

    it('a store that throws on write does not break the app', () => {
        const c = new GameArtCache({ getItem: () => null, setItem: () => { throw new Error('locked'); } });
        expect(() => c.put('X', { icon: PNG })).not.toThrow();
        expect(c.get('X')?.icon).toBe(PNG);
    });
});

describe('loadOwnGameArt', () => {
    it('asks main once per game and files the answer', async () => {
        const c = new GameArtCache(kv());
        const api = { getCurrentGameArt: vi.fn(async () => ({ name: 'Own Game A', icon: PNG, store: 'epic', appId: null })) };
        await Promise.all([loadOwnGameArt('Own Game A', c, api), loadOwnGameArt('Own Game A', c, api)]);
        await loadOwnGameArt('Own Game A', c, api);
        expect(api.getCurrentGameArt).toHaveBeenCalledTimes(1);
        expect(c.get('Own Game A')).toMatchObject({ icon: PNG, store: 'epic' });
    });

    it('ignores an answer about a different game (a race with the game changing)', async () => {
        const c = new GameArtCache(kv());
        const api = { getCurrentGameArt: vi.fn(async () => ({ name: 'Something Else', icon: PNG, store: null, appId: null })) };
        await loadOwnGameArt('Own Game B', c, api);
        expect(c.get('Own Game B')).toBeNull();
        expect(c.get('Something Else')).toBeNull();
    });

    it('does nothing without the bridge (website / tests) and swallows a failing bridge', async () => {
        const c = new GameArtCache(kv());
        await expect(loadOwnGameArt('Own Game C', c, {})).resolves.toBeUndefined();
        await expect(loadOwnGameArt('Own Game D', c, { getCurrentGameArt: async () => { throw new Error('x'); } })).resolves.toBeUndefined();
        await expect(loadOwnGameArt(null, c, {})).resolves.toBeUndefined();
    });

    it('asks again after the game ends and starts again', async () => {
        const c = new GameArtCache(kv());
        const api = { getCurrentGameArt: vi.fn(async () => ({ name: 'Own Game E', icon: null, store: null, appId: null })) };
        await loadOwnGameArt('Own Game E', c, api);
        forgetOwnGameArt('Own Game E');
        await loadOwnGameArt('Own Game E', c, api);
        expect(api.getCurrentGameArt).toHaveBeenCalledTimes(2);
    });
});
