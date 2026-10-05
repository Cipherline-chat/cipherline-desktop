import { secureLocalStore } from './secureLocalStore';

/**
 * The `cl_hx_<uid>` marker: "this device already holds message history for this
 * account".
 *
 * WHY THIS IS ITS OWN MODULE. Reading it wrong is a data-integrity bug, not a
 * cosmetic one. A false "no history" sends the sign-in flow to a screen that
 * offers **restore from backup** — and accepting that writes an older vault
 * over local data that was never missing. So the read is the load-bearing part,
 * and it lives here where it can be tested directly against the real store
 * rather than inside a React component.
 *
 * THE SHAPE OF THE BUG THIS EXISTS TO PREVENT (reported 2026-09):
 *
 *   "If you sign out of an account on your PC then sign into another one, then
 *    go sign back into the original account, it says that no message history
 *    exists and it wants me to sync or restore backup. But if I start fresh all
 *    my history is still there as it should be."
 *
 * `cl_hx_<uid>` is NAMED for an account, so `secureLocalStore` treats it as a
 * per-account record: it is only in memory while that account is the bound one.
 * At the point the sign-in flow has to decide, `cipherline_user_id` has NOT been
 * written yet — `login()` runs afterwards — so after an in-session sign-out
 * (which tears the binding down and drops every key named for that account) a
 * plain synchronous read returns null. A cold start never hit it, because
 * `hydrate()` binds the stored account before React renders anything: hence
 * "if I start fresh all my history is still there".
 */

/** Storage key for the marker. Exported so the backup registry and tests
 *  reference one definition rather than re-spelling the template. */
export const localHistoryKey = (userId: string) => `cl_hx_${userId}`;

/**
 * Raw synchronous read. VALID ONLY when `userId`'s records are known to be in
 * memory — use {@link probeLocalHistory} anywhere that is not already
 * guaranteed. Kept exported because the post-login call sites (where the
 * account is bound and ready by construction) genuinely are that case.
 */
export function hasLocalHistory(userId: string): boolean {
    try { return secureLocalStore.getItem(localHistoryKey(userId)) === '1'; } catch { return false; }
}

export function markLocalHistory(userId: string): void {
    // Spelled as a literal template rather than `localHistoryKey(userId)` on
    // purpose: `backupRegistry.test.ts`'s source scan — the check that every
    // persisted key is deliberately included in or excluded from backups — only
    // recognises `setItem('<literal>` and `setItem(UPPER_CONST,`. Routing this
    // through a helper would hide the key from that check rather than satisfy it.
    try { secureLocalStore.setItem(`cl_hx_${userId}`, '1'); } catch { /* quota — non-fatal */ }
}

/**
 * Outcome of asking "does this device already hold history for this account?".
 *
 * THREE states, not two. "We could not read the local store" is NOT "you have
 * no history": only one of them may offer a restore. Conflating them is the
 * whole bug — a two-valued answer has nowhere to put "don't know", so it
 * defaults to the destructive branch.
 */
export type HistoryProbe = 'has' | 'none' | 'unreadable';

/**
 * Establish, for real, whether this device holds history for `userId`.
 *
 * Binds the account and WAITS for its records — exactly what AuthScreen's
 * restore-from-backup path already does before it writes per-account keys —
 * then re-checks `isAccountReady`, because the awaited account can change
 * underneath us (the belt-and-braces pattern used by every other per-account
 * read in the app).
 *
 * Binding before `login()` is safe: the caller has already authenticated (it is
 * holding the account's token), and `AuthContext`'s boot restores a session only
 * when token + userId + deviceId are ALL present, so a stray pointer left by an
 * abandoned sign-in authenticates nobody.
 */
export async function probeLocalHistory(userId: string): Promise<HistoryProbe> {
    if (!userId) return 'unreadable';
    try {
        // A locked keystore reads as empty for everything. Never let that
        // render as "you have no history" — it is the case where the user's
        // data is most certainly still there and least accessible.
        if (secureLocalStore.isLocked()) return 'unreadable';
        secureLocalStore.setItem('cipherline_user_id', userId);
        await secureLocalStore.whenAccountReady();
        if (!secureLocalStore.isAccountReady(userId)) return 'unreadable';
        return hasLocalHistory(userId) ? 'has' : 'none';
    } catch (e) {
        console.error('[localHistoryFlag] could not read local history state', e);
        return 'unreadable';
    }
}
