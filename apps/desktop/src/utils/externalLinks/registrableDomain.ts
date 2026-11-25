/**
 * The registrable domain ("site", eTLD+1) of a hostname, from the Public
 * Suffix List: `www.bbc.co.uk` → `bbc.co.uk`, `alice.github.io` →
 * `alice.github.io` (github.io is a PRIVATE suffix: each user's pages are
 * their own site).
 *
 * WHY THE FULL LIST (psl) AND NOT A HAND LIST OF co.uk-STYLE SUFFIXES: the
 * registrable domain is what "Always trust links to …" stores, and a trusted
 * domain covers its subdomains. A heuristic that knows `co.uk` but not the
 * private section would offer "Always trust github.io" from a link to
 * `attacker.github.io` — and that would then trust every GitHub Pages site.
 * psl (MIT, already in the lockfile) ships the ICANN and private sections.
 *
 * Input is the URL parser's hostname: lowercase ASCII (punycode for IDNs).
 */
import { get as pslGet, parse as pslParse } from 'psl';

export interface Registrable {
    /** The registrable domain, or the whole host when there is none. */
    domain: string;
    /**
     * Whether the host can be offered as a trusted site. False when the host
     * IS a public suffix (`github.io`, `co.uk`) — trusting it would cover
     * unrelated sites — or is not a usable host at all.
     */
    trustable: boolean;
    /** IP literal or single-label host: trust is exact, never subdomains. */
    exactOnly: boolean;
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIpLiteral(host: string): boolean {
    return IPV4_RE.test(host) || (host.startsWith('[') && host.endsWith(']'));
}

export function registrableDomain(asciiHost: string): Registrable {
    const host = asciiHost.toLowerCase().replace(/\.$/, '');
    if (!host) return { domain: '', trustable: false, exactOnly: true };
    if (isIpLiteral(host)) return { domain: host, trustable: true, exactOnly: true };
    if (!host.includes('.')) {
        // A bare TLD (`com`) is a public suffix; `localhost`-style names are not.
        let listed = false;
        try { const p = pslParse(host); listed = 'listed' in p && p.listed; } catch { listed = false; }
        return { domain: host, trustable: !listed, exactOnly: true };
    }
    let domain: string | null = null;
    try { domain = pslGet(host); } catch { domain = null; }
    if (!domain) return { domain: host, trustable: false, exactOnly: true };
    return { domain, trustable: true, exactOnly: false };
}
