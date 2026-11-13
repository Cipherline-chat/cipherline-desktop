/**
 * The listener-side rules that decide whether someone else's entrance sound is
 * played, so it cannot be used to spam you. Pure and clock-injected; the call
 * UI feeds it one `decide()` per observed join.
 *
 *   - listener switch off, or that person muted by you   -> never
 *   - the same person joined again within REJOIN_WINDOW_MS -> no (a user
 *     rejoining in a loop stays silent; every join we SEE refreshes the window)
 *   - another entrance sound played < GLOBAL_GAP_MS ago     -> no (dropped, not
 *     queued: a burst of joiners makes one sound, not a backlog)
 *
 * State is in memory only: nothing about who joined when is stored or sent.
 */
export const REJOIN_WINDOW_MS = 30_000;
export const GLOBAL_GAP_MS = 2_000;
/** Bound on remembered joiners, so a very long call can't grow the map forever. */
const MAX_TRACKED = 256;

export type EntranceDecision = 'play' | 'disabled' | 'muted' | 'rejoin' | 'busy';

export interface EntranceListenerPrefs { enabled: boolean; muted: ReadonlySet<string> | readonly string[] }

export interface EntranceGate {
    decide(userId: string, nowMs: number, prefs: EntranceListenerPrefs): EntranceDecision;
    /**
     * Undo the `play` decision just made for `userId` (the sound did not
     * actually start): the rejoin window and the global gap go back to what
     * they were, so the next observation of this person can still play.
     */
    rollback(userId: string): void;
    reset(): void;
}

export function createEntranceGate(): EntranceGate {
    const lastJoin = new Map<string, number>();
    let lastPlayed = -Infinity;
    let undo: { userId: string; prevJoin: number | undefined; prevPlayed: number } | null = null;
    return {
        decide(userId, nowMs, prefs) {
            if (!prefs.enabled) return 'disabled';
            const muted = prefs.muted instanceof Set ? prefs.muted.has(userId) : (prefs.muted as readonly string[]).includes(userId);
            if (muted) return 'muted';
            const prev = lastJoin.get(userId);
            const snapshot = { userId, prevJoin: prev, prevPlayed: lastPlayed };
            lastJoin.set(userId, nowMs);
            if (lastJoin.size > MAX_TRACKED) {
                for (const [id, at] of lastJoin) if (nowMs - at >= REJOIN_WINDOW_MS) lastJoin.delete(id);
            }
            if (prev !== undefined && nowMs - prev < REJOIN_WINDOW_MS) return 'rejoin';
            if (nowMs - lastPlayed < GLOBAL_GAP_MS) return 'busy';
            lastPlayed = nowMs;
            undo = snapshot;
            return 'play';
        },
        rollback(userId) {
            if (!undo || undo.userId !== userId) return;
            if (undo.prevJoin === undefined) lastJoin.delete(userId); else lastJoin.set(userId, undo.prevJoin);
            lastPlayed = undo.prevPlayed;
            undo = null;
        },
        reset() { lastJoin.clear(); lastPlayed = -Infinity; undo = null; },
    };
}
