/**
 * Cipherline server-invite links in message text.
 *
 * A bare invite URL that renders an invite card is removed from the displayed
 * text (the card is the message); a masked link `[join us](https://…/invite/x)`
 * the sender wrote on purpose stays visible. Display only: what is sent,
 * stored, copied, quoted or edited is always the original text.
 *
 * Accepted forms (the API's `GET /invite/:code` ignores trailing slash, query
 * and fragment, and sanitises the code to [A-Za-z0-9_-]; the website serves it
 * only on the apex host, so `www.` is NOT accepted):
 *   http(s)://cipherline.chat/invite/CODE[/][?query][#fragment]   (host case-insensitive)
 * Not an invite: other paths (`/invite/CODE/icon`, `/ref/CODE`), other hosts.
 */
import { embedLinkHitsOf, embedUrlsOf } from './plainText';

/** Characters the message URL grammar allows (markdown.ts URL_STICKY). */
const URL_CHARS = '[^\\s<>"{}|\\\\^`[\\]]';
/** A final char that is not sentence punctuation / closing formatting (markdown.ts URL_TRAILING). */
const URL_END = '[^\\s<>"{}|\\\\^`[\\]\'.,:;!?*_~)]';
const INVITE_SRC = String.raw`https?:\/\/cipherline\.chat\/invite\/[A-Za-z0-9_-]*[A-Za-z0-9-]\/?(?:[?#]${URL_CHARS}*${URL_END})?`;
const INVITE_FULL = new RegExp(`^${INVITE_SRC}$`, 'i');
const INVITE_CODE = /^https?:\/\/cipherline\.chat\/invite\/([A-Za-z0-9_-]+)/i;

/** The invite code of an invite URL (any accepted form), else null. */
export function inviteCodeFromUrl(url: string): string | null {
    if (!INVITE_FULL.test(url)) return null;
    return INVITE_CODE.exec(url)?.[1] ?? null;
}

/** At most this many embeds render per message (ChatPane `.slice(0, 3)`). */
export const MAX_EMBEDS = 3;

const MEMO = new Map<string, string>();
const MEMO_MAX = 300;

const isHSpace = (c: string | undefined) => c === ' ' || c === '\t';
/** A line left holding nothing but (at most) a block marker. */
const EMPTY_LINE = /^\s*(?:>>>|>|-#|#{1,3}|[-*]|\d{1,9}\.)?\s*$/;

interface Span { s: number; e: number }

/**
 * `text` without the bare invite URLs that get a card. Parsed-message level:
 * a candidate counts only if the message parser (the one `embedUrlsOf` uses)
 * sees it as a plain-text link, so code, spoilers, `<url>`, masked links and
 * link labels are untouched; an invite beyond the embed cap keeps its text.
 * Whitespace around a removed URL is tidied (no double spaces, no blank line
 * left behind, no dangling edges). Returns `text` itself when nothing changes.
 */
export function stripBareInviteLinks(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text;
    if (!/cipherline\.chat\/invite\//i.test(text)) return text;
    const hit = MEMO.get(text);
    if (hit !== undefined) return hit;
    const out = compute(text);
    MEMO.set(text, out);
    if (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value as string);
    return out;
}

function compute(raw: string): string {
    const text = raw.replace(/\r\n?/g, '\n');
    const re = new RegExp(`(?<![\\p{L}\\p{N}_\\\\])${INVITE_SRC}`, 'giu');
    const cands: Span[] = [];
    for (const m of text.matchAll(re)) cands.push({ s: m.index!, e: m.index! + m[0].length });
    if (cands.length === 0) return raw;

    // Probe: swap every candidate for a unique invite URL and parse. The probes
    // the parser reports as plain-text embed links are the bare occurrences (a
    // masked destination reports bare:false; code / spoiler / <url> / labels
    // report nothing).
    let probe = '';
    let at = 0;
    cands.forEach((c, k) => {
        probe += text.slice(at, c.s) + `https://cipherline.chat/invite/clprobe${k}z`;
        at = c.e;
    });
    probe += text.slice(at);
    const bareProbes = new Set<number>();
    for (const h of embedLinkHitsOf(probe)) {
        const m = /^https:\/\/cipherline\.chat\/invite\/clprobe(\d+)z$/.exec(h.url);
        if (m && h.bare) bareProbes.add(Number(m[1]));
    }

    // Only URLs inside the embed cap actually get a card.
    const carded = new Set(embedUrlsOf(text).slice(0, MAX_EMBEDS));
    const remove = cands.filter((c, k) => bareProbes.has(k) && carded.has(text.slice(c.s, c.e)));
    if (remove.length === 0) return raw;

    const result: string[] = [];
    let lineStart = 0;
    let dropped = false;
    for (const line of text.split('\n')) {
        const lineEnd = lineStart + line.length;
        const spans = remove.filter(c => c.s >= lineStart && c.e <= lineEnd).map(c => ({ s: c.s - lineStart, e: c.e - lineStart }));
        lineStart = lineEnd + 1;
        if (spans.length === 0) {
            const blank = line.trim() === '';
            // A blank line right after a dropped one would leave a double gap.
            if (blank && dropped && (result.length === 0 || result[result.length - 1].trim() === '')) continue;
            if (!blank) dropped = false;
            result.push(line);
            continue;
        }
        let cur = line;
        for (const sp of spans.reverse()) cur = removeSpan(cur, sp);
        if (EMPTY_LINE.test(cur)) { dropped = true; continue; }
        dropped = false;
        result.push(cur);
    }
    if (dropped) while (result.length > 0 && result[result.length - 1].trim() === '') result.pop();
    const joined = result.join('\n');
    return joined.trim() === '' ? '' : joined;
}

function removeSpan(line: string, { s, e }: Span): string {
    let l = s;
    let r = e;
    while (l > 0 && isHSpace(line[l - 1])) l--;
    while (r < line.length && isHSpace(line[r])) r++;
    const before = line.slice(0, l);
    const after = line.slice(r);
    // Line edge: drop the whitespace on that side too.
    if (l === 0 || r === line.length) return before + after;
    // Glued on both sides (`(URL)`): nothing to tidy.
    if (l === s && r === e) return before + after;
    // Mid-line: one space between words, none before closing punctuation.
    return /^[,.;:!?)\]]/.test(after) ? before + after : `${before} ${after}`;
}
