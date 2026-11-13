import { describe, it, expect } from 'vitest';
import { KNOWN_GAMES, STORE_IDS, STORE_LABEL, isStoreId, lookupKnownGame, normGameName, steamArtRefs, steamStoreUrl } from './gameCatalog';

describe('gameCatalog', () => {
    it('every name (and alias) is unique after normalisation: no game shadows another', () => {
        const seen = new Map<string, string>();
        for (const k of KNOWN_GAMES) {
            for (const n of [k.name, ...(k.names ?? [])]) {
                const key = normGameName(n);
                expect(key, n).not.toBe('');
                expect(seen.get(key), `${n} collides with ${seen.get(key)}`).toBeUndefined();
                seen.set(key, n);
            }
        }
    });

    it('is text only: Steam ids, store words and https sites; no image data or image URLs', () => {
        for (const k of KNOWN_GAMES) {
            if (k.steamAppId !== undefined) expect(Number.isInteger(k.steamAppId) && k.steamAppId > 0, k.name).toBe(true);
            if (k.only !== undefined) expect(isStoreId(k.only), k.name).toBe(true);
            if (k.site !== undefined) {
                const u = new URL(k.site);
                expect(u.protocol, k.name).toBe('https:');
                expect(u.username + u.password + u.search + u.hash, k.name).toBe('');
            }
        }
        const json = JSON.stringify(KNOWN_GAMES);
        expect(json).not.toMatch(/data:|\.(png|jpe?g|gif|webp|svg|ico)\b/i);
    });

    it('"only" is claimed just for Valve titles (Steam) and for games that really have one store', () => {
        const only = Object.fromEntries(KNOWN_GAMES.filter(k => k.only).map(k => [k.name, k.only]));
        expect(only).toEqual({
            'Counter-Strike 2': 'steam', 'Dota 2': 'steam', 'Team Fortress 2': 'steam', 'Left 4 Dead 2': 'steam',
            'Deadlock': 'steam', "Garry's Mod": 'steam',
            VALORANT: 'riot', 'League of Legends': 'riot', Fortnite: 'epic', 'World of Warcraft': 'battlenet', Hearthstone: 'battlenet',
        });
        // A multi-platform title never claims a store a friend may not use.
        for (const n of ['Elden Ring', 'Grand Theft Auto V', 'Overwatch 2', 'Minecraft', 'Rocket League', 'Apex Legends']) {
            expect(lookupKnownGame(n)?.only, n).toBeUndefined();
        }
    });

    it('Steam-only titles all have a Steam id', () => {
        for (const k of KNOWN_GAMES.filter(k => k.only === 'steam')) expect(k.steamAppId, k.name).toBeGreaterThan(0);
    });

    it('finds a game despite case, punctuation, trademark signs and spellings', () => {
        expect(lookupKnownGame('counter-strike 2')?.steamAppId).toBe(730);
        expect(lookupKnownGame('HELLDIVERS™ 2')?.steamAppId).toBe(553850);
        expect(lookupKnownGame('Baldur’s Gate 3')?.steamAppId).toBe(1086940);
        expect(lookupKnownGame('PUBG: BATTLEGROUNDS')?.steamAppId).toBe(578080);
        expect(lookupKnownGame('Overwatch®')?.steamAppId).toBe(2357570);
        expect(lookupKnownGame('Grand Theft Auto V Legacy')?.steamAppId).toBe(271590);
        expect(lookupKnownGame('BeamNG.drive')?.steamAppId).toBe(284160);
        expect(lookupKnownGame('Minecraft')?.glyph).toBe('block');
        expect(lookupKnownGame('VALORANT')?.site).toBe('https://playvalorant.com/');
    });

    it('does not guess: an unknown, empty or absurd name is null', () => {
        for (const n of ['Some Indie Game', '', null, undefined, 'x'.repeat(201), 'Counter-Strike', 'Dota']) expect(lookupKnownGame(n), String(n)).toBeNull();
    });

    it('Minecraft has no Steam page to point at, so it never gets a Steam id', () => {
        expect(lookupKnownGame('Minecraft')?.steamAppId).toBeUndefined();
    });

    it('store words and labels', () => {
        expect(STORE_IDS).toEqual(['steam', 'epic', 'riot', 'battlenet', 'xbox', 'ea', 'ubisoft', 'gog']);
        expect(STORE_LABEL.epic).toBe('Epic Games');
        expect(isStoreId('origin')).toBe(false);
        expect(steamStoreUrl(730)).toBe('https://store.steampowered.com/app/730/');
        expect(steamArtRefs(730)).toEqual(['steam:730:portrait', 'steam:730:header', 'steam:730:capsule']);
    });
});
