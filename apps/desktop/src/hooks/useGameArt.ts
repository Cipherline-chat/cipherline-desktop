import { useEffect, useSyncExternalStore } from 'react';
import { useArt } from './useIntegrations';
import { gameArtCache, loadOwnGameArt, type GameArtRecord } from '../utils/gameArt';
import { steamArtRefs } from '../utils/gameCatalog';
import { artAppIdFor, buildGameRow, type GameRowInfo } from '../utils/gameRow';

/**
 * The picture, source label and link for a "Playing <game>" row. Painted in
 * this order, each swapped in place inside the row's fixed-size art box (so
 * nothing moves when a better one lands):
 *
 *   the cached final picture (this device remembers it)  - frame one
 *   your own executable icon (YOU only, read by main)     - as soon as main answers
 *   the game's Steam store picture (through our proxy)    - when it arrives
 *
 * What may be claimed ("on Steam", the link) is decided in utils/gameRow.ts.
 */
export type { GameRowInfo } from '../utils/gameRow';

/** The cached record for a game, re-read whenever the cache changes. */
export function useGameArtRecord(name: string | null): GameArtRecord | null {
    useSyncExternalStore(gameArtCache.subscribe, gameArtCache.getVersion, () => 0);
    return name ? gameArtCache.get(name) : null;
}

export function useGameArt(name: string | null, o: { isSelf: boolean; token: string | null }): GameRowInfo {
    const rec = useGameArtRecord(name);

    // Your own game: ask main once (a no-op when the status hook already did).
    useEffect(() => {
        if (o.isSelf && name) void loadOwnGameArt(name);
    }, [o.isSelf, name]);

    const appId = artAppIdFor(name, o.isSelf, rec);
    const steam = useArt(appId ? steamArtRefs(appId) : null, o.token);
    useEffect(() => {
        if (name && steam) gameArtCache.put(name, { cover: steam });
    }, [name, steam]);

    return buildGameRow({ name, isSelf: o.isSelf, rec, steam });
}
