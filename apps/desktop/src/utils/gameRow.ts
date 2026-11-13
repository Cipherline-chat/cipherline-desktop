import type { GameArtRecord } from './gameArt';
import { lookupKnownGame, steamStoreUrl, STORE_LABEL, type GameGlyph } from './gameCatalog';

/**
 * What a "Playing <game>" row shows, from the pieces on hand. Pure (the hook
 * hooks/useGameArt.ts feeds it); the rules for what may be CLAIMED live here:
 *
 *  - "on <store>": your own game -> the launcher folder your executable sits in;
 *    a friend's -> only the catalogue's single store for a title sold through
 *    one store. A friend's game name cannot say where they own it, and the
 *    cached store of a game YOU also play says nothing about THEM.
 *  - the Steam link: needs a Steam app id and is labelled "on Steam" wherever
 *    it goes. Not offered when the store is known to be a different one.
 *  - no Steam page: the publisher's website if the catalogue has one, labelled
 *    as a website; otherwise no link at all.
 */
export interface GameRowInfo {
    art: string | null;
    /** 'icon' = an executable icon (shown contained), 'cover' = a store picture (fills the box). */
    artShape: 'icon' | 'cover' | null;
    detail: string | null;
    url: string | null;
    linkLabel: string | null;
    glyph: GameGlyph | null;
}

export const NO_GAME_ROW: GameRowInfo = { art: null, artShape: null, detail: null, url: null, linkLabel: null, glyph: null };

/** The Steam app id the picture is asked for: your own library's, else the catalogue's, else a cached one. */
export function artAppIdFor(name: string | null, isSelf: boolean, rec: GameArtRecord | null): number | null {
    if (!name) return null;
    return (isSelf ? rec?.appId ?? null : null) ?? lookupKnownGame(name)?.steamAppId ?? rec?.appId ?? null;
}

export function buildGameRow(a: {
    name: string | null; isSelf: boolean; rec: GameArtRecord | null;
    /** The Steam picture, when it has arrived. */
    steam: string | null | undefined;
}): GameRowInfo {
    const { name, isSelf, rec } = a;
    if (!name) return NO_GAME_ROW;
    const entry = lookupKnownGame(name);
    const cover = a.steam ?? rec?.cover ?? null;
    const icon = rec?.icon ?? null;

    const store = (isSelf ? rec?.store : null) ?? entry?.only ?? null;
    const ownAppId = isSelf ? rec?.appId ?? null : null;
    const linkApp = ownAppId ?? (store && store !== 'steam' ? null : entry?.steamAppId ?? null);
    let url: string | null = null;
    let linkLabel: string | null = null;
    if (linkApp) {
        url = steamStoreUrl(linkApp);
        linkLabel = `Open ${name} on Steam`;
    } else if (entry?.site) {
        url = entry.site;
        linkLabel = `Open ${name}’s website`;
    }
    return {
        art: cover ?? icon,
        artShape: cover ? 'cover' : icon ? 'icon' : null,
        detail: store ? `on ${STORE_LABEL[store]}` : null,
        url,
        linkLabel,
        glyph: entry?.glyph ?? null,
    };
}
