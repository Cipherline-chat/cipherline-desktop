import { secureLocalStore } from './secureLocalStore';

/**
 * The Firewall game's best score (loading + offline screens), kept across
 * restarts. Device-global (no user id in the key): the loading screen shows
 * before anyone is signed in, and a high score isn't account data. Stored in
 * secureLocalStore like every other renderer-side value, so it is encrypted at
 * rest — and a locked store simply never persists it (it falls back to the
 * in-memory best for the session).
 */
export const LOADING_GAME_BEST_KEY = 'cipherline_loading_game_best';

export function readLoadingGameBest(): number {
    try {
        const n = Number(secureLocalStore.getItem(LOADING_GAME_BEST_KEY));
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
        return 0; // store not hydrated / unavailable
    }
}

/** Persist `score` if it beats the stored best; returns the best now on record. */
export function saveLoadingGameBest(score: number): number {
    const stored = readLoadingGameBest();
    if (!Number.isFinite(score) || score <= stored) return stored;
    const next = Math.floor(score);
    try { secureLocalStore.setItem(LOADING_GAME_BEST_KEY, String(next)); } catch { /* best-effort */ }
    return next;
}
