/**
 * Which websites open WITHOUT the "You're leaving Cipherline" check.
 *
 * Two tiers:
 *   • Built in — Cipherline's own domain, `cipherline.chat`, and every
 *     subdomain of it. Nothing else: the owner asked for a warning on every
 *     link that isn't trusted, and any third-party host baked in here would
 *     also silence the warning for a message linking to user content on it
 *     (a YouTube or GitHub link can still be a phishing page on that host's
 *     user-content corner). App-authored destinations — an OAuth sign-in the
 *     user just started, a Stripe receipt, the update download — skip the
 *     dialog by WHERE THE URL CAME FROM (`source: 'app'` in
 *     openExternalLink.ts), not by host, so they need no entry here.
 *   • User-trusted — per account, added by ticking "Always trust links to
 *     <site>" in the dialog and removed in Settings → Privacy → Trusted
 *     websites. Stored encrypted in secureLocalStore under
 *     `cipherline_trusted_link_domains_<userId>` (never raw localStorage).
 *
 * SUBDOMAINS, explicitly: an entry is a registrable domain (registrableDomain
 * .ts) and covers that domain AND all of its subdomains — the checkbox says
 * so in as many words. IP literals and single-label hosts are exact matches
 * only. Matching is on the URL parser's lowercase ASCII host, by label
 * boundary: `example.com` covers `www.example.com`, never `badexample.com`
 * or `example.com.evil.io`.
 *
 * Writes happen ONLY on a user action (the dialog's Visit with the box ticked,
 * Settings' Remove) and are refused while the account's records are still
 * loading (secureLocalStore.isAccountReady), so a cold namespace can never be
 * overwritten with an empty list.
 */
import { secureLocalStore } from '../secureLocalStore';
import { isIpLiteral } from './registrableDomain';

export const TRUSTED_DOMAINS_KEY_PREFIX = 'cipherline_trusted_link_domains_';
/** Built-in trusted sites (each covers its subdomains). */
export const BUILT_IN_TRUSTED_DOMAINS: readonly string[] = ['cipherline.chat'];
/** Upper bound on stored entries; a list this long is no longer a decision. */
export const MAX_TRUSTED_DOMAINS = 500;

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A stored entry must look exactly like a URL-parsed host: lowercase ASCII, no dots at the ends. */
export function isValidTrustedEntry(d: unknown): d is string {
    if (typeof d !== 'string') return false;
    return DOMAIN_RE.test(d) || isIpLiteral(d);
}

/** Does `entry` cover `host`? Label-boundary suffix match; IPs exact. */
export function entryCoversHost(entry: string, host: string): boolean {
    const h = host.toLowerCase();
    if (h === entry) return true;
    if (isIpLiteral(entry) || isIpLiteral(h) || !entry.includes('.')) return false;
    return h.endsWith(`.${entry}`);
}

export function isBuiltInTrustedHost(host: string): boolean {
    return BUILT_IN_TRUSTED_DOMAINS.some(d => entryCoversHost(d, host));
}

function currentUid(): string | null {
    try { return secureLocalStore.getItem('cipherline_user_id') || null; } catch { return null; }
}

const keyFor = (uid: string) => `${TRUSTED_DOMAINS_KEY_PREFIX}${uid}`;

function parseStored(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw) as unknown;
        const list = (v && typeof v === 'object' && Array.isArray((v as { domains?: unknown }).domains))
            ? (v as { domains: unknown[] }).domains : [];
        return [...new Set(list.filter(isValidTrustedEntry))].sort().slice(0, MAX_TRUSTED_DOMAINS);
    } catch {
        return [];
    }
}

// Snapshot cache so useSyncExternalStore gets a stable array per (uid, raw).
let cache: { uid: string | null; raw: string | null; list: string[] } = { uid: null, raw: null, list: [] };

/** The signed-in account's trusted sites, sorted. Empty when signed out. */
export function listTrustedDomains(): string[] {
    const uid = currentUid();
    let raw: string | null = null;
    if (uid) { try { raw = secureLocalStore.getItem(keyFor(uid)); } catch { raw = null; } }
    if (cache.uid === uid && cache.raw === raw) return cache.list;
    cache = { uid, raw, list: uid ? parseStored(raw) : [] };
    return cache.list;
}

export function isUserTrustedHost(host: string): boolean {
    return listTrustedDomains().some(d => entryCoversHost(d, host));
}

export function isTrustedHost(host: string): boolean {
    return isBuiltInTrustedHost(host) || isUserTrustedHost(host);
}

const listeners = new Set<() => void>();
export function subscribeTrustedDomains(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
function emit(): void { for (const fn of [...listeners]) { try { fn(); } catch { /* a listener's own problem */ } } }

/** True when there is a signed-in account whose records are loaded. */
export function canPersistTrust(): boolean {
    const uid = currentUid();
    return !!uid && secureLocalStore.isAccountReady(uid);
}

function write(mutate: (list: string[]) => string[]): boolean {
    const uid = currentUid();
    if (!uid || !secureLocalStore.isAccountReady(uid)) return false;
    const next = [...new Set(mutate(listTrustedDomains()).filter(isValidTrustedEntry))].sort();
    if (next.length > MAX_TRUSTED_DOMAINS) return false;
    try {
        secureLocalStore.setItem(TRUSTED_DOMAINS_KEY_PREFIX + uid, JSON.stringify({ v: 1, domains: next }));
    } catch {
        return false;
    }
    emit();
    return true;
}

/** Add a site (a registrable domain from the dialog). User action only. */
export function trustDomain(domain: string): boolean {
    const d = domain.toLowerCase();
    if (!isValidTrustedEntry(d) || isBuiltInTrustedHost(d)) return false;
    return write(list => [...list, d]);
}

/** Settings → Trusted websites → "Remove all" (after its in-page confirm). User action only. */
export function untrustAllDomains(): boolean {
    return write(() => []);
}

/** Remove a site (Settings → Privacy → Trusted websites). User action only. */
export function untrustDomain(domain: string): boolean {
    const d = domain.toLowerCase();
    return write(list => list.filter(x => x !== d));
}
