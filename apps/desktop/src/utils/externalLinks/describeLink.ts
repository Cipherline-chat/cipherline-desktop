/**
 * Everything the "You're leaving Cipherline" dialog shows about a link, and
 * whether it needs the dialog at all. Pure: no React, no IPC.
 *
 * Input is an already-parsed https: or mailto: URL (openExternalLink.ts does
 * the scheme check); every host here is the URL parser's lowercase ASCII
 * host, which is also what trust is matched on.
 */
import { hostDisplay, isSpoofVerdict, type HostDisplay } from './idnDisplay';
import { registrableDomain } from './registrableDomain';
import { isBuiltInTrustedHost, isTrustedHost } from './trustedDomains';
import { hostNamedBy } from '../formatting/linkSafety';

/** The URL split for display; `host` is drawn as `subdomain` + bold `site`. */
export interface UrlParts {
    scheme: string;          // 'https://'
    userinfo: string;        // 'user:pass' or ''
    subdomain: string;       // shown host minus the registrable part, with its trailing dot
    site: string;            // shown registrable domain (bold)
    port: string;            // ':8443' or ''
    rest: string;            // path + query + fragment
}

export interface MailRecipient {
    address: string;         // shown form (local@shown-host)
    host: HostDisplay;
}

export interface LinkMismatch {
    /** What the visible text names (a host or an email domain), as shown. */
    says: string;
    /** Where it really goes (registrable domain of the destination), as shown. */
    goesTo: string;
}

interface Common {
    /** The validated, normalised URL that would be opened. */
    href: string;
    /** Masked-link text naming a different destination than the real one. */
    mismatch: LinkMismatch | null;
    /** Opens with no dialog: trusted destination AND no mismatch. */
    trusted: boolean;
    /**
     * A phishing shape: masked text naming another site, a look-alike/IDN
     * address shown raw, or (https) a user name before the @. Still asks when
     * "Warn before opening links" is off but "Still warn about suspicious
     * links" is on (linkWarningPrefs.ts).
     */
    suspicious: boolean;
    /** Built-in (Cipherline's own) destination. */
    builtIn: boolean;
    /** What "Always trust links to …" would store, or null when it can't be offered. */
    trustDomain: string | null;
    /** `trustDomain` as shown (Unicode when the IDN rule allows it). */
    trustDomainShown: string | null;
}

export interface HttpsLinkModel extends Common {
    kind: 'https';
    host: HostDisplay;
    parts: UrlParts;
    /** Shown as punycode because it could imitate another site. */
    spoofed: boolean;
}

export interface MailtoLinkModel extends Common {
    kind: 'mailto';
    recipients: MailRecipient[];
    /** The link also pre-fills a subject or a message. */
    prefills: boolean;
    spoofed: boolean;
}

export type LinkModel = HttpsLinkModel | MailtoLinkModel;

/** Map the registrable domain (ASCII) onto the shown host's labels. */
function splitShown(host: HostDisplay, siteAscii: string): { subdomain: string; site: string } {
    const n = siteAscii.split('.').length;
    const shownLabels = host.shown.split('.');
    if (n >= shownLabels.length) return { subdomain: '', site: host.shown };
    return {
        subdomain: `${shownLabels.slice(0, shownLabels.length - n).join('.')}.`,
        site: shownLabels.slice(shownLabels.length - n).join('.'),
    };
}

function shownSite(host: HostDisplay, siteAscii: string): string {
    return splitShown(host, siteAscii).site;
}

/** Same rule as linkSafety's masked-link check: the named host must be the
 *  destination host or a parent of it (`github.com` → `gist.github.com` is fine). */
function namesDifferentHost(named: string, actualHost: string): boolean {
    const target = actualHost.replace(/^www\./, '');
    return !(target === named || target.endsWith(`.${named}`));
}

const EMAIL_WORD_RE = /^[("'<]*(?:mailto:)?[^\s@<>()"']+@((?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+[\p{L}]{2,63})[)"'>.,!?]*$/iu;

function normaliseHost(h: string): string | null {
    try { return new URL(`https://${h}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** The first host the label names: a URL / bare domain, or an email address's domain. */
function labelNamedHost(label: string): string | null {
    const host = hostNamedBy(label);
    if (host) return host;
    for (const word of label.split(/\s+/)) {
        if (!word || word.length > 256) continue;
        const m = EMAIL_WORD_RE.exec(word);
        if (m) return normaliseHost(m[1]);
    }
    return null;
}

function trustOffer(asciiHost: string): { domain: string | null; shown: string | null; display: HostDisplay } {
    const display = hostDisplay(asciiHost);
    const reg = registrableDomain(asciiHost);
    if (!reg.trustable || isBuiltInTrustedHost(asciiHost)) return { domain: null, shown: null, display };
    return { domain: reg.domain, shown: shownSite(display, reg.domain), display };
}

function describeHttps(u: URL, label: string | undefined): HttpsLinkModel {
    const ascii = u.hostname.toLowerCase();
    const host = hostDisplay(ascii);
    const reg = registrableDomain(ascii);
    const { subdomain, site } = splitShown(host, reg.domain || ascii);
    const userinfo = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}` : '';
    const parts: UrlParts = {
        scheme: `${u.protocol}//`,
        userinfo,
        subdomain,
        site,
        port: u.port ? `:${u.port}` : '',
        rest: `${u.pathname}${u.search}${u.hash}`,
    };
    const named = label ? labelNamedHost(label) : null;
    const mismatch = named && namesDifferentHost(named, ascii)
        ? { says: hostDisplay(named).shown, goesTo: site }
        : null;
    const builtIn = isBuiltInTrustedHost(ascii);
    const offer = trustOffer(ascii);
    return {
        kind: 'https',
        href: u.href,
        host,
        parts,
        spoofed: isSpoofVerdict(host.verdict),
        mismatch,
        builtIn,
        suspicious: !!mismatch || isSpoofVerdict(host.verdict) || !!userinfo,
        trusted: isTrustedHost(ascii) && !mismatch,
        // Never offer to trust a site from a link whose text lied about it, or
        // one whose name is shown raw because it could imitate another site
        // (the box would read "trust xn--pple-43d.com" to someone who thinks
        // they are on apple.com).
        trustDomain: mismatch || isSpoofVerdict(host.verdict) ? null : offer.domain,
        trustDomainShown: mismatch || isSpoofVerdict(host.verdict) ? null : offer.shown,
    };
}

function safeDecode(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

function describeMailto(u: URL, label: string | undefined): MailtoLinkModel {
    const addrs: string[] = [];
    const push = (list: string) => { for (const a of safeDecode(list).split(',')) { const t = a.trim(); if (t) addrs.push(t); } };
    push(u.pathname);
    let prefills = false;
    for (const [k, v] of u.searchParams) {
        const key = k.toLowerCase();
        if (key === 'to' || key === 'cc' || key === 'bcc') push(v);
        else if (key === 'subject' || key === 'body') prefills = prefills || v.length > 0;
    }
    const recipients: MailRecipient[] = [];
    const asciiHosts: string[] = [];
    for (const a of addrs) {
        const at = a.lastIndexOf('@');
        const local = at > 0 ? a.slice(0, at) : a;
        const ascii = at > 0 ? normaliseHost(a.slice(at + 1)) : null;
        const host = hostDisplay(ascii ?? '');
        if (ascii) asciiHosts.push(ascii);
        recipients.push({ address: ascii ? `${local}@${host.shown}` : a, host });
    }
    const allParsed = recipients.length > 0 && asciiHosts.length === recipients.length;
    const sites = [...new Set(asciiHosts.map(h => registrableDomain(h).domain))];
    const named = label ? labelNamedHost(label) : null;
    const firstHost = asciiHosts[0] ?? '';
    const mismatch = named && (!allParsed || asciiHosts.some(h => namesDifferentHost(named, h)))
        ? { says: hostDisplay(named).shown, goesTo: firstHost ? shownSite(hostDisplay(firstHost), registrableDomain(firstHost).domain) : 'an address that can’t be read' }
        : null;
    const builtIn = allParsed && asciiHosts.every(isBuiltInTrustedHost);
    const trusted = allParsed && asciiHosts.every(isTrustedHost) && !mismatch;
    const spoofed = recipients.some(r => isSpoofVerdict(r.host.verdict));
    const offer = allParsed && sites.length === 1 && !mismatch && !spoofed ? trustOffer(firstHost) : null;
    return {
        kind: 'mailto',
        href: u.href,
        recipients,
        prefills,
        spoofed,
        mismatch,
        builtIn,
        suspicious: !!mismatch || spoofed,
        trusted,
        trustDomain: offer?.domain ?? null,
        trustDomainShown: offer?.shown ?? null,
    };
}

/** Build the dialog model for a parsed https:/mailto: URL. */
export function describeExternalLink(u: URL, opts: { label?: string } = {}): LinkModel {
    return u.protocol === 'mailto:' ? describeMailto(u, opts.label) : describeHttps(u, opts.label);
}
