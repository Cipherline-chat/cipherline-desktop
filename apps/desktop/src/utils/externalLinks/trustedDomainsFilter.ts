/**
 * The search box over Settings → Privacy → Trusted websites. Matches anywhere
 * in the domain, case-insensitively, and IDN-aware: an internationalised entry
 * is stored as punycode (`xn--mnchen-3ya.de`) and shown in Unicode
 * (`münchen.de`), and either spelling finds it — including a typed Unicode
 * name the URL parser turns into the stored punycode form.
 */
import { hostDisplay } from './idnDisplay';

export interface TrustedRow {
    /** Stored form (lowercase ASCII / punycode). */
    domain: string;
    /** Shown form (Unicode when the IDN rule allows it). */
    shown: string;
}

export function trustedRows(domains: readonly string[]): TrustedRow[] {
    return domains.map(domain => ({ domain, shown: hostDisplay(domain).shown }));
}

function asciiForm(q: string): string | null {
    if (/^[\x20-\x7e]*$/.test(q)) return null; // already ASCII: nothing to convert
    try { return new URL(`https://${q}/`).hostname; } catch { return null; }
}

export function filterTrustedRows(rows: readonly TrustedRow[], query: string): TrustedRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...rows];
    const qa = asciiForm(q);
    return rows.filter(r => {
        const unicode = (hostDisplay(r.domain).unicode ?? r.domain).toLowerCase();
        return r.domain.includes(q) || r.shown.toLowerCase().includes(q) || unicode.includes(q) || (!!qa && r.domain.includes(qa));
    });
}
