/**
 * Formatted message text reduced to what it SAYS, for every surface that shows
 * a message outside its own bubble on one line or in a toast: the
 * conversation-list preview, reply quotes and the "Replying to" bar, OS
 * notifications, the pinned panel and search.
 *
 * `**ship it**` previews as "ship it", a code block as its code, a masked link
 * as its label. A spoiler NEVER previews its content (a notification or a
 * sidebar line would otherwise reveal exactly what the sender hid): it reads
 * SPOILER_PLACEHOLDER instead, and spoiler text is therefore not searchable
 * either.
 *
 * Mention / emoji tokens pass through untouched (the token grammar is atomic in
 * the parser), so callers still run `mentionsToDisplayText` afterwards.
 */
import { parseMessage, type BlockNode, type InlineNode, type ListBlock } from './markdown';

export const SPOILER_PLACEHOLDER = '[spoiler]';

function inlinePlain(nodes: readonly InlineNode[]): string {
    let out = '';
    for (const n of nodes) {
        switch (n.t) {
            case 'text': out += n.v; break;
            case 'code': out += n.v; break;
            case 'codeBlock': out += `\n${n.v}\n`; break;
            case 'spoiler': out += SPOILER_PLACEHOLDER; break;
            case 'link': out += inlinePlain(n.c); break;
            default: out += inlinePlain(n.c); break;
        }
    }
    return out;
}

function listPlain(list: ListBlock, indent: string, out: string[]): void {
    list.items.forEach((item, i) => {
        const marker = list.ordered ? `${list.start + i}. ` : '• ';
        out.push(indent + marker + inlinePlain(item.c));
        if (item.sub) listPlain(item.sub, indent + '  ', out);
    });
}

function blocksPlain(blocks: readonly BlockNode[], out: string[]): void {
    for (const b of blocks) {
        switch (b.t) {
            case 'para': out.push(inlinePlain(b.c).replace(/^\n+|\n+$/g, '')); break;
            case 'heading':
            case 'subtext': out.push(inlinePlain(b.c)); break;
            case 'quote': blocksPlain(b.c, out); break;
            case 'list': listPlain(b, '', out); break;
        }
    }
}

/** Message text with the formatting syntax removed (spoilers hidden). */
export function stripFormatting(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return '';
    const out: string[] = [];
    blocksPlain(parseMessage(text), out);
    return out.join('\n');
}

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/** A URL without the sentence punctuation after it: `(see https://x.y/a).` -> `https://x.y/a`. */
function trimUrl(u: string): string {
    let end = u.length;
    for (;;) {
        const c = u[end - 1];
        if ('.,:;!?\'"*_~'.includes(c)) { end--; continue; }
        if (c === ')') {
            const body = u.slice(0, end);
            if ((body.match(/\(/g)?.length ?? 0) < (body.match(/\)/g)?.length ?? 0)) { end--; continue; }
        }
        return u.slice(0, end);
    }
}

/** One link the collector found: `bare` = typed as plain text, else a masked / `<url>` link. */
export interface LinkHit { url: string; bare: boolean }

function collectInline(nodes: readonly InlineNode[], out: LinkHit[], angle = false): void {
    for (const n of nodes) {
        switch (n.t) {
            case 'text':
                for (const m of n.v.matchAll(URL_RE)) out.push({ url: trimUrl(m[0]), bare: true });
                break;
            case 'link':
                // A masked link embeds its real destination (so the card shows
                // where it actually goes). `<url>` is the sender opting out.
                if (n.kind === 'masked' || angle) out.push({ url: n.url, bare: false });
                break;
            case 'code':
            case 'codeBlock':
            case 'spoiler':
                // Code is not a link, and a spoiler's link must not preview
                // (an image embed would show what the spoiler hides).
                break;
            default:
                collectInline(n.c, out, angle);
        }
    }
}

function collectBlocks(blocks: readonly BlockNode[], out: LinkHit[], angle = false): void {
    for (const b of blocks) {
        if (b.t === 'quote') collectBlocks(b.c, out, angle);
        else if (b.t === 'list') {
            const walk = (l: ListBlock) => l.items.forEach(it => { collectInline(it.c, out, angle); if (it.sub) walk(it.sub); });
            walk(b);
        } else collectInline(b.c, out, angle);
    }
}

/**
 * Every link a message shares, for the "Shared links" list: bare URLs, masked
 * destinations and `<url>` links — but not a URL inside code or a spoiler
 * (listing it would reveal what the spoiler hides) or written as a label.
 */
export function sharedLinksOf(text: string): string[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    const out: LinkHit[] = [];
    collectBlocks(parseMessage(text), out, true);
    return [...new Set(out.map(h => h.url))];
}

/**
 * Embed links in document order, NOT deduplicated, each tagged bare vs masked
 * (the invite-link hider needs to know which occurrences were typed as plain
 * text). Same inclusion rules as `embedUrlsOf`.
 */
export function embedLinkHitsOf(text: string): LinkHit[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    const out: LinkHit[] = [];
    collectBlocks(parseMessage(text), out);
    return out;
}

/**
 * The URLs a message should show embeds / link cards for, in order, deduplicated:
 * bare URLs and masked-link destinations, but not URLs inside code, inside a
 * spoiler, inside a link's label, or written as `<url>`.
 */
export function embedUrlsOf(text: string): string[] {
    return [...new Set(embedLinkHitsOf(text).map(h => h.url))];
}
