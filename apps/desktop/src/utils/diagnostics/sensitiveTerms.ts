/**
 * Sensitive-terms collector for the diagnostic report scrubber: every name the
 * app currently holds in memory that must never appear in a report — the
 * signed-in user's own username / display name / email, friends' names,
 * server, channel, group and DM conversation names, call titles — plus the OS
 * account name (from main).
 *
 * Sources REGISTER themselves (registerSensitiveTermsSource) and are only
 * called when a report is being built, so collecting costs nothing until
 * someone opens the reporter. Dashboard registers its live state (friends,
 * conversations, servers, channels); the reporter host adds the auth user and
 * the OS account. A source returns any object graph and names are harvested
 * from it by KEY (`name`, `username`, `display_name`, `email`, …) — the
 * collector never needs to know each feature's data shape, and a source
 * cannot accidentally hand it message content (content lives under keys this
 * walker ignores).
 */

type Source = () => unknown;
const sources = new Map<string, Source>();

/** Register (or replace) a named source. Returns an unregister function. */
export function registerSensitiveTermsSource(id: string, fn: Source): () => void {
    sources.set(id, fn);
    return () => { if (sources.get(id) === fn) sources.delete(id); };
}

/** Object keys whose string values are names. */
const NAME_KEYS = new Set([
    'name', 'username', 'user_name', 'display_name', 'displayName', 'global_name', 'nickname', 'nick',
    'email', 'title', 'server_name', 'channel_name', 'conversation_name', 'group_name', 'call_name',
]);

const MAX_NODES = 20_000;
const MAX_TERMS_OUT = 2_000;

/** Harvest name-like strings from an arbitrary object graph (bounded walk). */
export function harvestNames(root: unknown, out: Set<string> = new Set()): Set<string> {
    let budget = MAX_NODES;
    const seen = new WeakSet<object>();
    const walk = (v: unknown, depth: number): void => {
        if (budget-- <= 0 || depth > 6 || v === null || typeof v !== 'object') return;
        if (seen.has(v as object)) return;
        seen.add(v as object);
        if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
        if (v instanceof Map) { for (const x of v.values()) walk(x, depth + 1); return; }
        if (v instanceof Set) { for (const x of v) walk(x, depth + 1); return; }
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (typeof val === 'string') {
                if (NAME_KEYS.has(k)) addTerm(out, val);
            } else if (val && typeof val === 'object') {
                walk(val, depth + 1);
            }
        }
    };
    walk(root, 0);
    return out;
}

/** Add a term, plus the local part of an email (it shows up in paths). */
export function addTerm(out: Set<string>, raw: unknown): void {
    if (typeof raw !== 'string') return;
    const t = raw.trim();
    if (t.length < 3 || t.length > 200) return;
    out.add(t);
    const at = t.indexOf('@');
    if (at >= 3) out.add(t.slice(0, at));
}

export interface CollectOptions {
    /** Extra terms supplied directly (auth user, OS account name). */
    extra?: readonly unknown[];
}

/** Call every registered source and return the de-duplicated term list. */
export function collectSensitiveTerms(opts: CollectOptions = {}): string[] {
    const out = new Set<string>();
    for (const t of opts.extra ?? []) addTerm(out, t);
    for (const fn of sources.values()) {
        try { harvestNames(fn(), out); } catch { /* a broken source must not block a report */ }
        if (out.size > MAX_TERMS_OUT * 2) break;
    }
    // Longest first: the scrubber caps at MAX_TERMS and longer names are the
    // more specific ones.
    return [...out].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS_OUT);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Drop terms that occur, whole-word and case-insensitively, inside the
 * report's STRUCTURED values (codec names, enums, GPU vendor, CPU model,
 * static perf labels — strings our own code or the OS produced).
 *
 * WHY: scrubDeep runs the term rule over every string in the payload. A
 * friend called "video", a server called "Intel" or a channel called "auto"
 * would otherwise turn `kind: 'video'`, `driver_vendor: 'Intel'` and
 * `codec_pref: 'auto'` into `<name>` and wreck the report. A term that
 * matches one of those values cannot reveal anything by staying in — the
 * same word is already in the report as data — so it is dropped from the
 * list for this report only. Free text (error messages, stacks, the
 * description) is still scrubbed with every other term.
 */
export function filterTermsAgainstStructured(terms: readonly string[], structured: readonly string[]): string[] {
    const hay = structured.join('\n');
    if (!hay) return [...terms];
    return terms.filter(t => {
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t.normalize('NFKC'))}(?![\\p{L}\\p{N}_])`, 'iu');
        return !re.test(hay);
    });
}

/** Test hook. */
export function __resetSensitiveTermsForTests(): void {
    sources.clear();
}
