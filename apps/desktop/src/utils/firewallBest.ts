/**
 * The Home easter-egg game's best score, per account, encrypted at rest.
 *
 * `secureLocalStore` (never raw localStorage): the key carries the account
 * id, so the store seals it under that account's own subkey and another
 * account on the same machine neither sees nor overwrites it. Classified in
 * services/backupRegistry.ts (excluded: a game score is not account data
 * worth carrying in a backup file).
 *
 * The loading screen keeps its own best for the session only, on purpose
 * (it can run before anyone is signed in); this one is Home's.
 */
import secureLocalStore from './secureLocalStore';

export const firewallBestKey = (userId: string) => `cipherline_firewall_best_${userId}`;

/** The stored best for this account; 0 when there is none or it is unreadable. */
export function readFirewallBest(userId: string | null | undefined): number {
    if (!userId) return 0;
    try {
        const n = Number(secureLocalStore.getItem(firewallBestKey(userId)));
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
        return 0;
    }
}

/** Store `best` if it beats the stored one. Returns the best after the call. */
export function writeFirewallBest(userId: string | null | undefined, best: number): number {
    const stored = readFirewallBest(userId);
    if (!userId || !Number.isFinite(best) || Math.floor(best) <= stored) return stored;
    const next = Math.floor(best);
    try {
        secureLocalStore.setItem(`cipherline_firewall_best_${userId}`, String(next));
    } catch {
        return stored;
    }
    return next;
}
