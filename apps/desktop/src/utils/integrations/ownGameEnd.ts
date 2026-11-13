/**
 * When THIS app's game detector last saw your own game end.
 *
 * Steam notices a closed game later than we do (its own presence lag, plus the
 * API's 60 s cache of Steam's answer). On your own profile the activity row
 * falls back to Steam's "now playing" only when the detector reports no game,
 * so right after a game closes Steam's still-playing answer would flash back
 * as a "Playing" row for a game you just quit. We know better, so Steam's row
 * waits: it is trusted only from a card fetched at least `STEAM_HOLD_MS` after
 * the detector saw the game end (by then both caches have turned over). A
 * game the detector never saw is unaffected - there is no end to wait for.
 *
 * In-memory only; nothing is stored or sent.
 */

export const STEAM_HOLD_MS = 120_000;

let endedAt: number | null = null;
const listeners = new Set<() => void>();

/** Call with the detected game's name each time it changes (null = none). */
export function noteOwnGame(name: string | null, previous: string | null, now: number = Date.now()): void {
    const next = name ? null : previous ? now : endedAt;
    if (next === endedAt) return;
    endedAt = next;
    listeners.forEach((f) => f());
}

export function ownGameEndedAt(): number | null { return endedAt; }

export function subscribeOwnGameEnd(f: () => void): () => void {
    listeners.add(f);
    return () => { listeners.delete(f); };
}

/**
 * May Steam's now-playing from a card fetched at `fetchedAt` be shown on your
 * own profile? Not while it could still be echoing a game the detector saw end.
 */
export function steamNowPlayingTrusted(fetchedAt: number, ended: number | null = endedAt): boolean {
    return ended === null || fetchedAt >= ended + STEAM_HOLD_MS;
}

/** Test seam. */
export function resetOwnGameEnd(): void { endedAt = null; listeners.clear(); }
