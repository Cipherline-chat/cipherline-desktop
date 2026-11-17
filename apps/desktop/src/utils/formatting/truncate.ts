/**
 * The collapsed preview of a LONG formatted message (components/LongMessage),
 * cut on the parsed TREE, not on the text.
 *
 * Cutting the source text (what longMessage.collapsedPreview did for plain
 * text) cannot be made safe once text has structure: a cut can leave a ```
 * fence open (the rest renders as backticks), a list half-built, or — worst —
 * a `||spoiler` open, which renders the hidden words IN CLEAR. So the preview
 * parses the message and keeps whole nodes until a budget of characters and
 * lines runs out:
 *  - text is cut at a line break or word boundary, never inside a mention /
 *    emoji token or a URL;
 *  - a spoiler / bold / link that is cut stays a spoiler / bold / link
 *    (its node is kept with fewer children);
 *  - a code block keeps its first N lines and is marked `clipped` (the
 *    renderer fades it and hides its copy button — copy from the full view);
 *  - lists keep their first items, quotes their first blocks.
 *
 * Only a bounded prefix of a huge message is parsed (`previewSource`), cut
 * where no spoiler is open and with a dangling fence closed, so a collapsed
 * 100k-character message still costs a few thousand characters of work.
 */
import { closeDanglingFence, type BlockNode, type InlineNode, type ListBlock } from './markdown';
import { findMentionTokens } from '../mentionTokens';

export interface PreviewBudget {
    /** Characters of text shown. */
    chars: number;
    /** Lines (block starts, line breaks, code lines) shown. */
    lines: number;
}

export const PREVIEW_BUDGET: PreviewBudget = { chars: 700, lines: 12 };
/** At most this much of a long message is parsed for its preview. */
export const PREVIEW_SOURCE_MAX = 20_000;
/** A code block in a preview always shows at least this many lines (when it has them). */
const MIN_CODE_LINES = 3;

/**
 * The part of `text` a preview is built from: all of it when short enough,
 * else a prefix ending on a line break, cut back so no `||` is left open
 * (which would show a spoiler's text as plain), with an open fence closed.
 */
export function previewSource(text: string): string {
    if (text.length <= PREVIEW_SOURCE_MAX) return text;
    let cut = text.lastIndexOf('\n', PREVIEW_SOURCE_MAX);
    if (cut < PREVIEW_SOURCE_MAX / 2) cut = PREVIEW_SOURCE_MAX;
    let src = text.slice(0, cut);
    const pipes: number[] = [];
    for (let at = src.indexOf('||'); at >= 0; at = src.indexOf('||', at + 2)) {
        if (at === 0 || src[at - 1] !== '\\') pipes.push(at);
    }
    if (pipes.length % 2 === 1) src = src.slice(0, pipes[pipes.length - 1]);
    return closeDanglingFence(src);
}

interface State extends PreviewBudget { done: boolean }

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/** A cut position <= `limit` in `v` that is not inside a token or URL, preferring a line break, then a space. */
export function safeCut(v: string, limit: number): number {
    if (limit >= v.length) return v.length;
    const floor = Math.floor(limit / 2);
    let cut = v.lastIndexOf('\n', limit);
    if (cut < floor) {
        let i = limit;
        while (i > floor && !/\s/.test(v[i - 1])) i--;
        cut = i > floor ? i : limit;
    }
    const window = v.slice(0, Math.min(v.length, limit + 400));
    const spans: [number, number][] = findMentionTokens(window).map(m => [m.index, m.index + m[0].length]);
    for (const m of window.matchAll(URL_RE)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    for (const [s, e] of spans) if (s < cut && cut < e) cut = s;
    const prev = v.charCodeAt(cut - 1);
    if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
    return cut;
}

function takeText(v: string, st: State): string {
    // Characters and line breaks both spend the budget.
    let i = 0;
    let chars = st.chars;
    let lines = st.lines;
    while (i < v.length && chars > 0 && lines > 0) {
        if (v.charCodeAt(i) === 10) lines--;
        chars--;
        i++;
    }
    if (i >= v.length) {
        st.chars = chars;
        st.lines = lines;
        return v;
    }
    st.done = true;
    return v.slice(0, safeCut(v, i)).replace(/\s+$/, '');
}

function truncInline(nodes: readonly InlineNode[], st: State): InlineNode[] {
    const out: InlineNode[] = [];
    for (const n of nodes) {
        if (st.done) break;
        switch (n.t) {
            case 'text': {
                const v = takeText(n.v, st);
                if (v) out.push({ t: 'text', v });
                break;
            }
            case 'code': {
                if (n.v.length <= st.chars) { st.chars -= n.v.length; out.push(n); } else st.done = true;
                break;
            }
            case 'codeBlock': {
                const all = n.v.split('\n');
                st.lines -= 1; // the language / copy row
                let take = 0;
                let chars = 0;
                while (take < all.length && (take < MIN_CODE_LINES || (take < st.lines && chars + all[take].length <= st.chars))) {
                    chars += all[take].length + 1;
                    take++;
                }
                if (take === 0) { st.done = true; break; }
                st.lines -= take;
                st.chars -= chars;
                if (take < all.length) {
                    out.push({ t: 'codeBlock', lang: n.lang, v: all.slice(0, take).join('\n'), clipped: true });
                    st.done = true;
                } else {
                    out.push(n);
                }
                break;
            }
            default: {
                const c = truncInline(n.c, st);
                if (c.length > 0) out.push({ ...n, c });
            }
        }
        if (st.chars <= 0 || st.lines <= 0) st.done = true;
    }
    return out;
}

function truncList(list: ListBlock, st: State): ListBlock | null {
    const items: ListBlock['items'] = [];
    for (const it of list.items) {
        if (st.done || st.lines <= 0) { st.done = true; break; }
        st.lines -= 1;
        const c = truncInline(it.c, st);
        const sub = it.sub && !st.done ? truncList(it.sub, st) : null;
        if (c.length > 0 || sub) items.push({ c, sub });
    }
    return items.length > 0 ? { ...list, items } : null;
}

function truncBlocks(blocks: readonly BlockNode[], st: State): BlockNode[] {
    const out: BlockNode[] = [];
    for (const b of blocks) {
        if (st.done || st.lines <= 0) { st.done = true; break; }
        switch (b.t) {
            case 'para': {
                st.lines -= 1;
                const c = truncInline(b.c, st);
                if (b.pad && !st.done) st.lines -= 1;
                if (c.length > 0 || b.pad) out.push({ t: 'para', c, pad: b.pad && !st.done });
                break;
            }
            case 'heading':
            case 'subtext': {
                st.lines -= 1;
                const c = truncInline(b.c, st);
                if (c.length > 0) out.push({ ...b, c });
                break;
            }
            case 'quote': {
                const c = truncBlocks(b.c, st);
                if (c.length > 0) out.push({ t: 'quote', c });
                break;
            }
            case 'list': {
                const l = truncList(b, st);
                if (l) out.push(l);
                break;
            }
        }
    }
    return out;
}

/** The first `budget` worth of a parsed message, as whole, well-formed nodes; `cut` says whether anything was left out. */
export function truncateBlocks(blocks: readonly BlockNode[], budget: PreviewBudget = PREVIEW_BUDGET): { blocks: BlockNode[]; cut: boolean } {
    const st: State = { ...budget, done: false };
    const out = truncBlocks(blocks, st);
    // Whatever the walk left behind is "cut", whether it stopped mid-node or between blocks.
    const cut = st.done || out.length < blocks.length;
    // The last kept paragraph never pads (nothing follows it on screen).
    const last = out[out.length - 1];
    if (last && last.t === 'para') out[out.length - 1] = { ...last, pad: false };
    return { blocks: out, cut };
}
