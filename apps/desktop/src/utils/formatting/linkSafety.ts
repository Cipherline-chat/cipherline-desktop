/**
 * Masked links (`[label](https://…)`) hide their destination behind words —
 * the classic phishing shape is a label that LOOKS like one URL while the link
 * goes to another: `[https://paypal.com](https://paypa1.example)`.
 *
 * `maskedLinkCheck` reads the label the way a person would: if it names a host
 * (a URL or a bare domain), that host must be the destination's host or a
 * parent of it (`github.com` may go to `gist.github.com`, never to
 * `github.com.evil.io`). Hosts are compared after the URL parser has
 * normalised them, so a look-alike label written with Cyrillic letters becomes
 * punycode and no longer matches the Latin destination. A destination that is
 * itself an internationalised (punycode) host is flagged too.
 *
 * FormattedText always confirms before opening a masked link and shows the
 * real destination; a `deceptive` result turns that confirm into a warning.
 */

/** One whitespace-separated word of a label that names a host: `paypal.com`, `https://paypal.com/x`. */
const WORD_HOST_RE = /^[("'<]*(?:https?:\/\/)?((?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+[\p{L}]{2,63})(?:[/:?#][^\s]*)?[)"'>.,!?]*$/iu;
/** Words longer than this are not read as a host (keeps the check linear in the label). */
const WORD_MAX = 256;

/** The first host a label names, normalised, or null. */
export function hostNamedBy(labelText: string): string | null {
    for (const word of labelText.split(/\s+/)) {
        if (!word || word.length > WORD_MAX) continue;
        const m = WORD_HOST_RE.exec(word);
        if (m) return normaliseHost(m[1]);
    }
    return null;
}

function normaliseHost(host: string): string | null {
    try {
        return new URL(`https://${host}`).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

export interface MaskedLinkCheck {
    /** Destination host as the browser will see it ('' when unparseable). */
    targetHost: string;
    /** The host the LABEL names, when it names one. */
    labelHost: string | null;
    /** The label names a different site than the link goes to. */
    deceptive: boolean;
    /** The destination is an internationalised (punycode) host. */
    punycode: boolean;
}

export function maskedLinkCheck(labelText: string, url: string): MaskedLinkCheck {
    let targetHost = '';
    try { targetHost = new URL(url).hostname.toLowerCase(); } catch { /* stays '' */ }
    const target = targetHost.replace(/^www\./, '');
    const labelHost = hostNamedBy(labelText);
    const deceptive = !!labelHost && !(target === labelHost || target.endsWith(`.${labelHost}`));
    const punycode = targetHost.split('.').some(p => p.startsWith('xn--'));
    return { targetHost, labelHost, deceptive: deceptive || !targetHost, punycode };
}
