/**
 * How a BARE link (`https://…` typed or pasted into a message, or `<https://…>`)
 * reads in the rendered message body.
 *
 * A very long URL is shown shortened so it stops filling the screen; the full
 * URL stays the link's real target everywhere it matters (open path, hover
 * title, accessible name, Ctrl+C — see handleMessageCopy below). Only the
 * DISPLAY changes. The stored/sent text, search, reply previews, notifications
 * and "Copy Text" all work from the raw message and never see this.
 *
 * What is NOT shortened (callers never route these here): masked links
 * `[label](url)`, links in code, and short links.
 *
 * The rule (shortenLinkText):
 *  - A link whose full text is <= LINK_SHORTEN_THRESHOLD (48) chars is shown as typed.
 *  - Longer: drop the `http(s)://` and a leading `www.`, and keep the WHOLE host
 *    (with any port) — it is never trimmed, so a shortened link cannot disguise
 *    where it goes. The host is shown exactly as typed: an `xn--` punycode host
 *    stays punycode (never prettified to Unicode, which would hide a homograph).
 *  - The path/query/fragment then gets whatever is left of a LINK_DISPLAY_MAX (44)
 *    budget: a head, an ellipsis, and a short tail (LINK_TAIL = 10 chars, fewer
 *    when the budget is tight) because the end of a URL (an id, a query value, a
 *    file name) is often the meaningful part. Cuts never split a %XX escape or a
 *    surrogate pair.
 *  - A link carrying `user:pass@` before the host is left exactly as typed: that
 *    shape is the classic "looks like site A, goes to site B" trick, so we never
 *    rewrite it.
 */

export const LINK_SHORTEN_THRESHOLD = 48;
export const LINK_DISPLAY_MAX = 44;
export const LINK_TAIL = 10;
const ELLIPSIS = '…';

export interface ShortLink {
    /** What to show. Equal to the input when nothing was shortened. */
    text: string;
    shortened: boolean;
    /** The full host (and port) as typed, scheme and `www.` removed. '' if unparseable. */
    host: string;
}

function isHigh(c: number): boolean { return c >= 0xd800 && c <= 0xdbff; }
function isLow(c: number): boolean { return c >= 0xdc00 && c <= 0xdfff; }

export function shortenLinkText(url: string): ShortLink {
    const asTyped: ShortLink = { text: url, shortened: false, host: '' };
    const m = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i.exec(url);
    if (!m) return asTyped;
    let authority = m[2];
    const rest = m[3];
    if (authority.includes('@') || authority === '') return asTyped;
    if (/^www\./i.test(authority) && authority.slice(4).includes('.')) authority = authority.slice(4);
    if (url.length <= LINK_SHORTEN_THRESHOLD) return { text: url, shortened: false, host: authority };

    const bare = rest === '/' ? '' : rest;
    // Everything fits once the scheme / www. are dropped: no ellipsis needed.
    if (authority.length + bare.length <= LINK_DISPLAY_MAX) {
        return { text: authority + bare, shortened: true, host: authority };
    }
    // The host alone fills the budget: keep it whole, mark that a path follows.
    const avail = LINK_DISPLAY_MAX - authority.length;
    if (avail < 4) return { text: `${authority}/${ELLIPSIS}`, shortened: true, host: authority };

    const tailLen = avail >= 18 ? LINK_TAIL : Math.floor((avail - 1) / 3);
    let head = avail - 1 - tailLen;
    let tailStart = bare.length - tailLen;
    if (head > 0 && isHigh(bare.charCodeAt(head - 1))) head--;
    // Do not end the head inside a %XX escape.
    if (head > 0 && bare[head - 1] === '%') head--;
    else if (head > 1 && bare[head - 2] === '%') head -= 2;
    if (tailLen > 0) {
        if (isLow(bare.charCodeAt(tailStart))) tailStart++;
        // Do not begin the tail inside a %XX escape.
        if (bare[tailStart - 1] === '%') tailStart += 2;
        else if (bare[tailStart - 2] === '%') tailStart += 1;
    }
    const tail = tailLen > 0 && tailStart < bare.length ? bare.slice(tailStart) : '';
    return { text: authority + bare.slice(0, head) + ELLIPSIS + tail, shortened: true, host: authority };
}

/** Marks a rendered link element with the full URL it stands for (read by the copy handler). */
export const FULL_URL_ATTR = 'data-full-url';

/**
 * Props for the rendered link element of a shortened bare link: the hover
 * tooltip is the full URL, the accessible name is the full URL too (a screen
 * reader reads where it goes, never "ellipsis"), and the full URL is carried on
 * the element so a copy can restore it. Empty for a link shown as typed.
 */
export function shortLinkAnchorProps(url: string, link: ShortLink): Record<string, string> {
    if (!link.shortened) return {};
    return { title: url, 'aria-label': url, [FULL_URL_ATTR]: url };
}

// ── Copy ──────────────────────────────────────────────────────────────────────

export interface CopyLinkSpan {
    full: string;
    /** True when the selection covers this link's whole displayed text. */
    fullySelected: boolean;
}

/**
 * The text a copy should put on the clipboard: `selected` (what the browser
 * would copy) with each FULLY selected shortened link's displayed text swapped
 * for its full URL. `links` are the shortened links the selection touches, in
 * document order. A link that is only partly selected is copied as selected.
 * Returns null when nothing needed swapping (let the browser copy natively).
 */
export function expandCopiedLinks(selected: string, links: readonly CopyLinkSpan[]): string | null {
    let out = '';
    let cursor = 0;
    let changed = false;
    for (const l of links) {
        if (!l.fullySelected) continue;
        const short = shortenLinkText(l.full).text;
        const at = selected.indexOf(short, cursor);
        if (at < 0) continue;
        out += selected.slice(cursor, at) + l.full;
        cursor = at + short.length;
        changed = true;
    }
    return changed ? out + selected.slice(cursor) : null;
}

/** Copy handler for a message body: Ctrl+C over shortened links yields the full URLs. */
export function handleMessageCopy(e: { clipboardData: DataTransfer | null; preventDefault(): void; currentTarget: Element }): void {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !e.clipboardData) return;
    const range = sel.getRangeAt(0);
    const spans: CopyLinkSpan[] = [];
    e.currentTarget.querySelectorAll(`[${FULL_URL_ATTR}]`).forEach((el) => {
        if (!range.intersectsNode(el)) return;
        const full = el.getAttribute(FULL_URL_ATTR) ?? '';
        const t = el.firstChild;
        let fullySelected = false;
        if (t && el.childNodes.length === 1 && t.nodeType === 3) {
            const len = (t as Text).length;
            fullySelected = range.comparePoint(t, 0) !== -1 && range.comparePoint(t, len) !== 1;
        }
        spans.push({ full, fullySelected });
    });
    if (spans.length === 0) return;
    const text = expandCopiedLinks(sel.toString(), spans);
    if (text === null) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
}
