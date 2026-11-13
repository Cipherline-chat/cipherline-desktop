import { describe, it, expect } from 'vitest';
import { artAppIdFor, buildGameRow, NO_GAME_ROW } from './gameRow';
import type { GameArtRecord } from './gameArt';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';
const rec = (o: Partial<GameArtRecord> = {}): GameArtRecord => ({ name: 'x', at: 1, ...o });

describe('buildGameRow: your own game', () => {
    it('shows the executable icon straight away, contained, before any store picture', () => {
        const r = buildGameRow({ name: 'BeamNG.drive', isSelf: true, rec: rec({ icon: PNG, store: 'steam', appId: 284160 }), steam: undefined });
        expect(r.art).toBe(PNG);
        expect(r.artShape).toBe('icon');
        expect(r.detail).toBe('on Steam');
        expect(r.url).toBe('https://store.steampowered.com/app/284160/');
        expect(r.linkLabel).toBe('Open BeamNG.drive on Steam');
    });

    it('swaps to the store picture when it arrives (same row, shape becomes cover)', () => {
        const r = buildGameRow({ name: 'BeamNG.drive', isSelf: true, rec: rec({ icon: PNG, store: 'steam', appId: 284160 }), steam: JPG });
        expect(r.art).toBe(JPG);
        expect(r.artShape).toBe('cover');
    });

    it('a second launch paints the cached final picture on the first frame, with no network answer yet', () => {
        const r = buildGameRow({ name: 'BeamNG.drive', isSelf: true, rec: rec({ icon: PNG, cover: JPG, appId: 284160 }), steam: undefined });
        expect(r.art).toBe(JPG);
    });

    it('a game from another launcher says so and does not link to Steam', () => {
        const r = buildGameRow({ name: 'VALORANT', isSelf: true, rec: rec({ icon: PNG, store: 'riot' }), steam: undefined });
        expect(r.detail).toBe('on Riot Games');
        expect(r.url).toBe('https://playvalorant.com/');
        expect(r.linkLabel).toBe('Open VALORANT’s website');
    });

    it('an unknown game with only an icon: no label, no link', () => {
        const r = buildGameRow({ name: 'My Homebrew Game', isSelf: true, rec: rec({ icon: PNG }), steam: undefined });
        expect(r).toMatchObject({ art: PNG, artShape: 'icon', detail: null, url: null, linkLabel: null });
    });

    it('Minecraft: its launcher icon when read, the cube drawing and the publisher site otherwise', () => {
        expect(buildGameRow({ name: 'Minecraft', isSelf: true, rec: rec({ icon: PNG }), steam: undefined }).art).toBe(PNG);
        const bare = buildGameRow({ name: 'Minecraft', isSelf: true, rec: null, steam: undefined });
        expect(bare).toMatchObject({ art: null, glyph: 'block', url: 'https://www.minecraft.net/', detail: null });
    });
});

describe('buildGameRow: a friend’s game (only their name is known)', () => {
    it('Steam title: the catalogue supplies the picture and the Steam link, no claim about where they own it', () => {
        const r = buildGameRow({ name: 'Elden Ring', isSelf: false, rec: null, steam: JPG });
        expect(r.art).toBe(JPG);
        expect(r.detail).toBeNull();
        expect(r.url).toBe('https://store.steampowered.com/app/1245620/');
        expect(r.linkLabel).toBe('Open Elden Ring on Steam');
    });

    it('a Valve title is Steam-only, so "on Steam" is true', () => {
        expect(buildGameRow({ name: 'Counter-Strike 2', isSelf: false, rec: null, steam: undefined }).detail).toBe('on Steam');
    });

    it('never borrows YOUR launcher for THEIR game', () => {
        // You also play Elden Ring from Epic; a friend's Elden Ring row must not say so.
        const r = buildGameRow({ name: 'Elden Ring', isSelf: false, rec: rec({ store: 'epic', appId: 1245620 }), steam: undefined });
        expect(r.detail).toBeNull();
        expect(r.url).toBe('https://store.steampowered.com/app/1245620/');
    });

    it('a game the catalogue does not know: just the name, nothing invented', () => {
        expect(buildGameRow({ name: 'Obscure Thing', isSelf: false, rec: null, steam: undefined })).toEqual({ ...NO_GAME_ROW });
    });

    it('a non-Steam exclusive: label plus the publisher site, no picture requested', () => {
        const r = buildGameRow({ name: 'VALORANT', isSelf: false, rec: null, steam: undefined });
        expect(r).toMatchObject({ art: null, detail: 'on Riot Games', url: 'https://playvalorant.com/' });
        expect(artAppIdFor('VALORANT', false, null)).toBeNull();
    });

    it('no name, no row', () => {
        expect(buildGameRow({ name: null, isSelf: false, rec: null, steam: undefined })).toBe(NO_GAME_ROW);
    });
});

describe('artAppIdFor', () => {
    it('your own library wins; a friend’s comes from the catalogue; a cached id is the last resort', () => {
        expect(artAppIdFor('Elden Ring', true, rec({ appId: 99 }))).toBe(99);
        expect(artAppIdFor('Elden Ring', false, rec({ appId: 99 }))).toBe(1245620);
        expect(artAppIdFor('Obscure Thing', false, rec({ appId: 99 }))).toBe(99);
        expect(artAppIdFor('Obscure Thing', false, null)).toBeNull();
        expect(artAppIdFor(null, true, null)).toBeNull();
    });
});
