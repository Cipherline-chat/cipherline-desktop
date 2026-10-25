import { EGG_SEARCH_NOTES, MISNAMED_KEYS_POOL, SETTINGS_SEARCH_NOTES } from './eggPools';

/**
 * Which note (if any) a settings-search query earns: the factual security
 * notes (password / keys / secrets) first, then the playful ones (octopus /
 * squid / kraken / abyss). There is no switch: the playful touches are part
 * of the app (owner, 2026-10-20). `misnamed` = the wrong-cephalopod query,
 * which also makes every mounted Keys wiggle in protest.
 * `egg` names the Egg-hunter id the playful hits earn (utils/eggProgress.ts);
 * the factual notes never do.
 *
 * Reads only the user's own search text in the settings search box.
 */
export function settingsSearchPool(
    rawQuery: string,
): { pool: readonly string[]; misnamed: boolean; egg?: 'misnamed-keys' | 'abyss-search' } | null {
    const key = rawQuery.trim().toLowerCase();
    const factual = Object.prototype.hasOwnProperty.call(SETTINGS_SEARCH_NOTES, key) ? SETTINGS_SEARCH_NOTES[key] : undefined;
    if (factual) return { pool: factual, misnamed: false };   // factual notes are not eggs: never counted
    const playful = Object.prototype.hasOwnProperty.call(EGG_SEARCH_NOTES, key) ? EGG_SEARCH_NOTES[key] : undefined;
    if (!playful) return null;
    const misnamed = playful === MISNAMED_KEYS_POOL;
    return { pool: playful, misnamed, egg: misnamed ? 'misnamed-keys' : 'abyss-search' };
}
