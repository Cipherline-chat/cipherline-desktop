/**
 * A post card's text (phase 4: a tweet, a Reddit excerpt) as plain text with
 * links. The text is user content from the sender's message: it is NEVER
 * parsed as HTML or markdown. Only bare http(s) URLs become links, and those
 * open through openExternalLink (which validates them) like any link in chat.
 */

export type PostTextPart = { text: string } | { url: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// Punctuation that ends a sentence rather than a URL.
const TRAILING = /[.,;:!?)\]}'"»”’]+$/;

export function postTextParts(text: string): PostTextPart[] {
    const out: PostTextPart[] = [];
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
        let url = m[0];
        // Drop trailing punctuation one character at a time; a ")" stays when it
        // closes a "(" inside the URL (Wikipedia-style links).
        while (TRAILING.test(url)) {
            const last = url[url.length - 1];
            if (last === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
            url = url.slice(0, -1);
        }
        const start = m.index ?? 0;
        if (start > last) out.push({ text: text.slice(last, start) });
        let ok = false;
        try { ok = /^https?:$/.test(new URL(url).protocol); } catch { ok = false; }
        out.push(ok ? { url } : { text: url });
        last = start + url.length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
}

/** 1234 → "1.2K", 1_500_000 → "1.5M" (scores, comment counts). */
export function compactCount(n: number): string {
    const a = Math.abs(n);
    const fmt = (v: number, s: string) => `${n < 0 ? '-' : ''}${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${s}`;
    if (a >= 1e9) return fmt(a / 1e9, 'B');
    if (a >= 1e6) return fmt(a / 1e6, 'M');
    if (a >= 1e4) return fmt(a / 1e3, 'K');
    return String(n);
}

/** Which post card a link gets, from the READER's own reading of it. */
export type PostProvider = 'x' | 'reddit';
