/**
 * Settings → Privacy → "Warn before opening links" and its sub-toggle "Still
 * warn about suspicious links" (owner 2026-11-24: "have a toggle to never
 * warn"). Per account, encrypted in secureLocalStore under
 * `cipherline_link_warning_prefs_<userId>`.
 *
 *   warn            (default ON)  ON: every untrusted link asks first.
 *   warnSuspicious  (default ON)  only consulted when `warn` is OFF: a link
 *                                 that is suspicious (masked text naming
 *                                 another site, a look-alike/IDN address shown
 *                                 raw, or a user name before the @) still asks.
 * Both OFF = never warn: no dialog at all. What NEVER turns off is the
 * real-click requirement in openExternalLink: a link opens only inside a
 * person's own click or key press, whatever these say.
 *
 * Signed out (or a stored value that does not parse) = the defaults. Written
 * only on a user action, never into an account whose records are still
 * loading (secureLocalStore.isAccountReady).
 */
import { secureLocalStore } from '../secureLocalStore';

export const LINK_WARNING_PREFS_KEY_PREFIX = 'cipherline_link_warning_prefs_';

export interface LinkWarningPrefs {
    warn: boolean;
    warnSuspicious: boolean;
}

export const DEFAULT_LINK_WARNING_PREFS: Readonly<LinkWarningPrefs> = Object.freeze({ warn: true, warnSuspicious: true });

function currentUid(): string | null {
    try { return secureLocalStore.getItem('cipherline_user_id') || null; } catch { return null; }
}

function parse(raw: string | null): LinkWarningPrefs {
    if (!raw) return { ...DEFAULT_LINK_WARNING_PREFS };
    try {
        const v = JSON.parse(raw) as Partial<LinkWarningPrefs> | null;
        return {
            // Anything but an explicit `false` keeps the safe default.
            warn: v?.warn !== false,
            warnSuspicious: v?.warnSuspicious !== false,
        };
    } catch {
        return { ...DEFAULT_LINK_WARNING_PREFS };
    }
}

let cache: { uid: string | null; raw: string | null; prefs: LinkWarningPrefs } = { uid: null, raw: null, prefs: { ...DEFAULT_LINK_WARNING_PREFS } };

export function getLinkWarningPrefs(): LinkWarningPrefs {
    const uid = currentUid();
    let raw: string | null = null;
    if (uid) { try { raw = secureLocalStore.getItem(LINK_WARNING_PREFS_KEY_PREFIX + uid); } catch { raw = null; } }
    if (cache.uid === uid && cache.raw === raw) return cache.prefs;
    cache = { uid, raw, prefs: parse(raw) };
    return cache.prefs;
}

const listeners = new Set<() => void>();
export function subscribeLinkWarningPrefs(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** User action only. Returns false when there is no loaded account to store it in. */
export function setLinkWarningPrefs(patch: Partial<LinkWarningPrefs>): boolean {
    const uid = currentUid();
    if (!uid || !secureLocalStore.isAccountReady(uid)) return false;
    const next = { ...getLinkWarningPrefs(), ...patch };
    try {
        secureLocalStore.setItem(LINK_WARNING_PREFS_KEY_PREFIX + uid, JSON.stringify({ v: 1, warn: next.warn, warnSuspicious: next.warnSuspicious }));
    } catch {
        return false;
    }
    for (const fn of [...listeners]) { try { fn(); } catch { /* listener's own problem */ } }
    return true;
}
