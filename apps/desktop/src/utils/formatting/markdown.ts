/**
 * Discord-style message formatting: parse message text into a small AST that
 * components/formatting/FormattedText.tsx turns into React elements.
 *
 * ## Why our own parser
 *
 * Message text is sender-controlled (it arrives decrypted from whoever wrote
 * it), so this file is a trust boundary in the same sense as
 * utils/contentValidation.ts. Two rules follow:
 *
 *  - NO HTML. The output is a tree of plain objects; the renderer builds React
 *    elements from it, so nothing a sender types is ever interpreted as markup.
 *    There is no `dangerouslySetInnerHTML` anywhere on this path.
 *  - LINEAR-ISH TIME on any input. Received text can be 200k characters
 *    (MAX_RECEIVED_TEXT_LENGTH), and every visible row re-renders it. The
 *    lazy-regex grammar Discord's client uses (simple-markdown) backtracks
 *    quadratically on runs of unmatched `*` / `_`; here every closing
 *    delimiter is found through tables precomputed in one pass, so an opener
 *    costs O(1) whether or not it matches, and nesting is capped
 *    (MAX_INLINE_DEPTH). See markdown.adversarial.test.ts.
 *
 * ## Grammar (Discord's, with the differences listed in docs/worklog)
 *
 * Blocks, line based:
 *   `# `, `## `, `### `  headings (rendered by weight/colour, NOT size)
 *   `-# `                subtext
 *   `> ` (consecutive lines) and `>>> ` (rest of the message)  quotes, not nested
 *   `- `, `* `, `1. `    lists; deeper indentation nests (MAX_LIST_DEPTH)
 *   a line with an unclosed ``` keeps following lines raw until it closes
 *
 * Inline, left to right:
 *   `\x`                 escapes any ASCII punctuation
 *   ``` ```lang\n…``` ``` code block (language optional), `code`, ``co`de``
 *   mention / custom-emoji tokens (`<@u:id:name>`, `<:name:id>`, `@everyone`)
 *                        are atomic: nothing inside one is ever formatting
 *   bare URLs            atomic too (so `a_b_c` in a URL is not italic)
 *   `<https://…>`        a link with its embed suppressed
 *   `[label](https://…)` masked link (https only; label may be formatted)
 *   `***x***` bold+italic, `**x**` bold, `*x*` / `_x_` italic,
 *   `__x__` underline, `___x___` underline+italic, `~~x~~` strike, `||x||` spoiler
 *   `[small]x[/small]`, `[large]x[/large]`  text size for a span (owner, 2026-11-16);
 *                        only these two tags exist (the MESSAGE_SIZES allowlist),
 *                        at most MAX_SIZE_SPANS per message (the rest render at
 *                        the size around them), `\[large]` is literal
 *
 * Code always wins: the delimiters inside a code span or block are never
 * looked at, and neither are those inside a token, URL or link target.
 */
import { findMentionTokens } from '../mentionTokens';

// ── AST ──────────────────────────────────────────────────────────────────────

export type InlineNode =
    | { t: 'text'; v: string }
    | { t: 'strong' | 'em' | 'u' | 'strike' | 'spoiler'; c: InlineNode[] }
    /** `[small]…[/small]` / `[large]…[/large]`: the span's text size (absolute, not relative to an outer span). */
    | { t: 'size'; size: SizeTag; c: InlineNode[] }
    | { t: 'code'; v: string }
    /** `clipped`: only the first lines, in a long message's collapsed preview (truncate.ts). */
    | { t: 'codeBlock'; lang: string | null; v: string; clipped?: boolean }
    /** `masked`: `[label](url)`. `angle`: `<url>` (no embed; label is the URL). */
    | { t: 'link'; url: string; kind: 'masked' | 'angle'; c: InlineNode[] };

export interface ListItem {
    c: InlineNode[];
    /** A nested list under this item, if any. */
    sub: ListBlock | null;
}

export interface ListBlock { t: 'list'; ordered: boolean; start: number; items: ListItem[] }

export type BlockNode =
    /** `pad`: the paragraph ends in a blank line that a block follows (see render). */
    | { t: 'para'; c: InlineNode[]; pad: boolean }
    | { t: 'heading'; level: 1 | 2 | 3; c: InlineNode[] }
    | { t: 'subtext'; c: InlineNode[] }
    | { t: 'quote'; c: BlockNode[] }
    | ListBlock;

export type SizeTag = 'small' | 'large';
/** Size spans honoured per message; past it the text keeps the size around it (no markers shown). */
export const MAX_SIZE_SPANS = 200;
const SIZE_OPEN_LEN = 7;  // `[small]` / `[large]`
const SIZE_CLOSE_LEN = 8; // `[/small]` / `[/large]`
function sizeTagAt(src: string, i: number): SizeTag | null {
    if (src.charCodeAt(i) !== 91) return null;
    if (src.startsWith('[small]', i)) return 'small';
    if (src.startsWith('[large]', i)) return 'large';
    return null;
}

/** How deep emphasis / spoiler / link nesting goes before the rest is plain text. */
export const MAX_INLINE_DEPTH = 8;
/** How deep a list nests; deeper items join the deepest list. */
export const MAX_LIST_DEPTH = 6;

// ── Character classes ────────────────────────────────────────────────────────

const ESCAPABLE = /[!-/:-@[-`{-~]/; // ASCII punctuation, CommonMark's escapable set
const NON_ASCII_WORD = /[\p{L}\p{N}]/u;

function isWordChar(ch: string | undefined): boolean {
    if (ch === undefined || ch === '') return false;
    const c = ch.charCodeAt(0);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    return c > 127 && NON_ASCII_WORD.test(ch);
}

function isSpace(ch: string | undefined): boolean {
    return ch === undefined || ch === '' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ';
}

/** The bare-URL grammar the message renderer has always linkified (ChatPane URL_REGEX). */
const URL_STICKY = /https?:\/\/[^\s<>"{}|\\^`[\]]+/y;
/** Trailing characters that end a sentence or close formatting rather than belong to a URL. */
const URL_TRAILING = new Set(['.', ',', ':', ';', '!', '?', '\'', '"', ')', '*', '_', '~', '|']);
const ANGLE_STICKY = /<(https?:\/\/[^\s<>]+)>/y;
/**
 * `](https://…)` right after a link label. One level of balanced parentheses
 * inside the URL (Wikipedia-style), optional `<…>` around it. The character
 * classes exclude both parentheses, so the match is unambiguous (linear).
 */
const TARGET_STICKY = /\]\([ \t]*<?(https:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?[ \t]*\)/y;
const LANG_RE = /^([A-Za-z0-9_+\-.#]{1,32})\n/;

type DelimChar = '*' | '_' | '~' | '|';
const DELIMS: readonly DelimChar[] = ['*', '_', '~', '|'];

interface Run { start: number; end: number }

interface CodeHit { end: number; node: InlineNode }

/** Everything the inline parser looks up in O(1): built once per inline source. */
interface Prepass {
    src: string;
    /** 1 where a token / code / URL / angle link starts (cheap "is this special" test). */
    starts: Uint8Array;
    tokenEnd: Map<number, number>;
    code: Map<number, CodeHit>;
    url: Map<number, number>;
    angle: Map<number, { end: number; url: string }>;
    /** Keyed by the position of the label's closing `]`. */
    target: Map<number, { end: number; url: string }>;
    /** escaped[i] = 1: char i is escaped by the backslash at i-1. */
    escaped: Uint8Array;
    /** Positions of `[/small]` / `[/large]` (unescaped, outside code and tokens), ascending. */
    sizeClose: Record<SizeTag, number[]>;
    runs: Record<DelimChar, Run[]>;
    /** Index of the run (of src[i]'s char) covering i, or -1. */
    runAt: Int32Array;
    /** nextValid[c][k][r]: the first run index >= r that can close a k-wide `c` delimiter, or -1. */
    nextValid: Record<DelimChar, Partial<Record<1 | 2 | 3, Int32Array>>>;
}

// ── Closer / opener rules ────────────────────────────────────────────────────

function closerOk(c: DelimChar, k: number, len: number, before: string | undefined, after: string | undefined): boolean {
    if (len < k) return false;
    switch (c) {
        case '*':
            // A single `*` closes only an odd run (so `**` pairs inside an
            // italic stay bold) and never right after whitespace.
            return k === 1 ? len % 2 === 1 && !isSpace(before) : true;
        case '_':
            if (k === 1) return len % 2 === 1 && !isSpace(before) && !isWordChar(after);
            if (k === 3) return !isWordChar(after);
            return true;
        default:
            return k === 2;
    }
}

function openerOk(src: string, c: DelimChar, k: number, i: number, to: number): boolean {
    if (i + k >= to) return false;
    const next = src[i + k];
    if (c === '*') return k !== 1 || !isSpace(next);
    // Underscores inside a word never open italics (snake_case_names).
    if (c === '_' && (k === 1 || k === 3)) return !isWordChar(src[i - 1]) && !isSpace(next);
    return true;
}

function kindsFor(c: DelimChar, len: number): number[] {
    if (c === '~' || c === '|') return len >= 2 ? [2] : [];
    if (len === 1) return [1];
    if (len === 2) return [2];
    return [3, 2, 1];
}

// ── Prepass ──────────────────────────────────────────────────────────────────

function lowerBound(arr: number[], x: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function stripCodeSpan(v: string): string {
    // CommonMark: one space either side is padding when both are present.
    if (v.length >= 2 && v[0] === ' ' && v[v.length - 1] === ' ' && v.trim() !== '') return v.slice(1, -1);
    return v;
}

function codeBlockNode(content: string): InlineNode | null {
    const m = LANG_RE.exec(content);
    if (m) {
        const body = content.slice(m[0].length).replace(/^\n+/, '').replace(/\n+$/, '');
        if (body.length > 0) return { t: 'codeBlock', lang: m[1].toLowerCase(), v: body };
    }
    const body = content.replace(/^\n+/, '').replace(/\n+$/, '');
    if (body.length === 0) return null;
    return { t: 'codeBlock', lang: null, v: body };
}

function prepass(src: string): Prepass {
    const n = src.length;
    const starts = new Uint8Array(n + 1);
    const escaped = new Uint8Array(n + 1);
    const tokenEnd = new Map<number, number>();
    for (const m of findMentionTokens(src)) {
        tokenEnd.set(m.index, m.index + m[0].length);
        starts[m.index] = 1;
    }

    // Raw backtick runs (escapes ignored: a backslash is literal inside code),
    // skipping tokens. Indexed by length for "next run of exactly k".
    const tickByLen = new Map<number, number[]>();
    const tickEnd = new Map<number, number>();
    for (let i = 0; i < n;) {
        const te = tokenEnd.get(i);
        if (te !== undefined) { i = te; continue; }
        if (src.charCodeAt(i) === 96 /* ` */) {
            let j = i;
            while (j < n && src.charCodeAt(j) === 96) j++;
            const len = j - i;
            let list = tickByLen.get(len);
            if (!list) { list = []; tickByLen.set(len, list); }
            list.push(i);
            tickEnd.set(i, j);
            i = j;
            continue;
        }
        i++;
    }

    // Pass 1: escapes and code, left to right (code is found before anything
    // else so nothing inside it is ever formatting).
    const code = new Map<number, CodeHit>();
    const inCode = new Uint8Array(n + 1);
    let noMoreFence = false;
    for (let i = 0; i < n;) {
        const te = tokenEnd.get(i);
        if (te !== undefined) { i = te; continue; }
        const ch = src.charCodeAt(i);
        if (ch === 92 /* \ */ && i + 1 < n && ESCAPABLE.test(src[i + 1])) {
            escaped[i + 1] = 1;
            i += 2;
            continue;
        }
        if (ch === 96) {
            let j = i;
            while (j < n && src.charCodeAt(j) === 96) j++;
            const len = j - i;
            if (len >= 3 && !noMoreFence) {
                const close = src.indexOf('```', i + 3);
                if (close < 0) noMoreFence = true;
                else {
                    const node = codeBlockNode(src.slice(i + 3, close));
                    if (node) {
                        const end = close + 3;
                        code.set(i, { end, node });
                        starts[i] = 1;
                        inCode.fill(1, i, end);
                        i = end;
                        continue;
                    }
                }
            }
            if (len <= 2) {
                const list = tickByLen.get(len) ?? [];
                const at = lowerBound(list, j);
                if (at < list.length) {
                    const cs = list[at];
                    const v = src.slice(j, cs);
                    if (v.length > 0) {
                        const end = cs + len;
                        code.set(i, { end, node: { t: 'code', v: stripCodeSpan(v) } });
                        starts[i] = 1;
                        inCode.fill(1, i, end);
                        i = end;
                        continue;
                    }
                }
            }
            i = j;
            continue;
        }
        i++;
    }

    // Pass 2: URLs, link targets and delimiter runs, outside code and tokens.
    const url = new Map<number, number>();
    const angle = new Map<number, { end: number; url: string }>();
    const target = new Map<number, { end: number; url: string }>();
    const runs: Record<DelimChar, Run[]> = { '*': [], '_': [], '~': [], '|': [] };
    const sizeClose: Record<SizeTag, number[]> = { small: [], large: [] };
    const runAt = new Int32Array(n + 1).fill(-1);
    for (let i = 0; i < n;) {
        if (inCode[i]) { i = code.get(i)?.end ?? i + 1; continue; }
        const te = tokenEnd.get(i);
        if (te !== undefined) { i = te; continue; }
        const ch = src[i];
        if (escaped[i]) { i++; continue; }
        if (ch === 'h' && (src.startsWith('https://', i) || src.startsWith('http://', i)) && !isWordChar(src[i - 1])) {
            URL_STICKY.lastIndex = i;
            const m = URL_STICKY.exec(src);
            if (m) {
                let end = i + m[0].length;
                while (end > i && URL_TRAILING.has(src[end - 1])) end--;
                if (end > i) {
                    url.set(i, end);
                    starts[i] = 1;
                    i = end;
                    continue;
                }
            }
        }
        if (ch === '<' && src.startsWith('<http', i)) {
            ANGLE_STICKY.lastIndex = i;
            const m = ANGLE_STICKY.exec(src);
            if (m) {
                const end = i + m[0].length;
                angle.set(i, { end, url: m[1] });
                starts[i] = 1;
                i = end;
                continue;
            }
        }
        if (ch === '[' && src.charCodeAt(i + 1) === 47 /* / */) {
            const tag: SizeTag | null = src.startsWith('[/small]', i) ? 'small' : src.startsWith('[/large]', i) ? 'large' : null;
            if (tag) { sizeClose[tag].push(i); i += SIZE_CLOSE_LEN; continue; }
        }
        if (ch === ']' && src[i + 1] === '(') {
            TARGET_STICKY.lastIndex = i;
            const m = TARGET_STICKY.exec(src);
            if (m) {
                const end = i + m[0].length;
                target.set(i, { end, url: m[1] });
                i = end;
                continue;
            }
        }
        if (ch === '*' || ch === '_' || ch === '~' || ch === '|') {
            let j = i + 1;
            while (j < n && src[j] === ch && !escaped[j]) j++;
            const list = runs[ch];
            const idx = list.length;
            list.push({ start: i, end: j });
            runAt.fill(idx, i, j);
            i = j;
            continue;
        }
        i++;
    }

    const nextValid = {} as Prepass['nextValid'];
    for (const c of DELIMS) {
        nextValid[c] = {};
        const list = runs[c];
        for (const k of (c === '~' || c === '|') ? [2] : [1, 2, 3]) {
            const arr = new Int32Array(list.length + 1);
            arr[list.length] = -1;
            for (let r = list.length - 1; r >= 0; r--) {
                const run = list[r];
                arr[r] = closerOk(c, k, run.end - run.start, src[run.start - 1], src[run.end]) ? r : arr[r + 1];
            }
            nextValid[c][k as 1 | 2 | 3] = arr;
        }
    }

    return { src, starts, tokenEnd, code, url, angle, target, escaped, sizeClose, runs, runAt, nextValid };
}

// ── Inline parse ─────────────────────────────────────────────────────────────

/** The content end (= closer start) for a k-wide `c` opener whose run is `openRun`, or -1. */
function findCloser(pp: Prepass, c: DelimChar, k: number, openRun: number, contentStart: number, to: number): number {
    const list = pp.runs[c];
    const first = openRun + 1;
    const table = pp.nextValid[c][k as 1 | 2 | 3];
    if (table && first <= list.length) {
        const r = table[first];
        if (r >= 0 && list[r].end <= to) {
            const pos = list[r].end - k;
            return pos > contentStart ? pos : -1;
        }
    }
    // The one run that straddles `to` is clipped there: what lies past `to`
    // belongs to an enclosing closer, so "after" is the end of the range.
    if (to >= 1 && pp.src[to - 1] === c) {
        const s = pp.runAt[to - 1];
        if (s >= first && list[s].start < to && list[s].end > to) {
            const len = to - list[s].start;
            if (closerOk(c, k, len, pp.src[list[s].start - 1], undefined)) {
                const pos = to - k;
                return pos > contentStart ? pos : -1;
            }
        }
    }
    return -1;
}

function wrap(c: DelimChar, k: number, children: InlineNode[]): InlineNode {
    if (c === '~') return { t: 'strike', c: children };
    if (c === '|') return { t: 'spoiler', c: children };
    if (c === '*') {
        if (k === 1) return { t: 'em', c: children };
        if (k === 2) return { t: 'strong', c: children };
        return { t: 'strong', c: [{ t: 'em', c: children }] };
    }
    if (k === 1) return { t: 'em', c: children };
    if (k === 2) return { t: 'u', c: children };
    return { t: 'u', c: [{ t: 'em', c: children }] };
}

function parseRange(pp: Prepass, from: number, to: number, depth: number, inLink: boolean): InlineNode[] {
    const { src } = pp;
    const out: InlineNode[] = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
    let i = from;
    while (i < to) {
        const ch = src[i];
        if (pp.starts[i]) {
            const te = pp.tokenEnd.get(i);
            if (te !== undefined && te <= to) { buf += src.slice(i, te); i = te; continue; }
            const ch2 = pp.code.get(i);
            if (ch2 && ch2.end <= to) {
                if (ch2.node.t === 'codeBlock') {
                    // A code block is a block on screen: the line break that led
                    // into its opening fence and the one ending its closing fence
                    // are the block's own edges, not blank lines.
                    if (buf.endsWith('\n')) buf = buf.slice(0, -1);
                    flush();
                    out.push(ch2.node);
                    i = ch2.end;
                    if (i < to && src[i] === '\n') i++;
                    continue;
                }
                flush();
                out.push(ch2.node);
                i = ch2.end;
                continue;
            }
            const ue = pp.url.get(i);
            if (ue !== undefined && ue <= to) { buf += src.slice(i, ue); i = ue; continue; }
            const an = pp.angle.get(i);
            if (an && an.end <= to) {
                if (inLink) { buf += src.slice(i, an.end); i = an.end; continue; }
                flush();
                out.push({ t: 'link', url: an.url, kind: 'angle', c: [{ t: 'text', v: an.url }] });
                i = an.end;
                continue;
            }
        }
        if (ch === '\\' && i + 1 < to && pp.escaped[i + 1]) {
            buf += src[i + 1];
            i += 2;
            continue;
        }
        if (ch === '[' && depth < MAX_INLINE_DEPTH) {
            // A size span: the next closer of the same tag inside this range.
            const tag = sizeTagAt(src, i);
            if (tag) {
                const list = pp.sizeClose[tag];
                const at = lowerBound(list, i + SIZE_OPEN_LEN);
                const close = at < list.length ? list[at] : -1;
                if (close > i + SIZE_OPEN_LEN && close + SIZE_CLOSE_LEN <= to) {
                    flush();
                    const kids = parseRange(pp, i + SIZE_OPEN_LEN, close, depth + 1, inLink);
                    if (sizeBudget > 0) { sizeBudget--; out.push({ t: 'size', size: tag, c: kids }); } else out.push(...kids);
                    i = close + SIZE_CLOSE_LEN;
                    continue;
                }
            }
        }
        if (ch === '[' && !inLink) {
            // The label runs to the first `]` (no brackets or newlines inside),
            // stepping over escapes, code and tokens; the `](url)` right after
            // it was found by the prepass.
            let j = i + 1;
            while (j < to) {
                const cj = src[j];
                if (cj === '\\' && pp.escaped[j + 1]) { j += 2; continue; }
                if (pp.starts[j]) {
                    const ce = pp.code.get(j)?.end ?? pp.tokenEnd.get(j);
                    if (ce !== undefined) { j = ce; continue; }
                }
                if (cj === ']' || cj === '[' || cj === '\n') break;
                j++;
            }
            const tg = j < to && src[j] === ']' && j > i + 1 ? pp.target.get(j) : undefined;
            if (tg && tg.end <= to) {
                flush();
                out.push({ t: 'link', url: tg.url, kind: 'masked', c: parseRange(pp, i + 1, j, depth + 1, true) });
                i = tg.end;
                continue;
            }
        }
        if ((ch === '*' || ch === '_' || ch === '~' || ch === '|') && pp.runAt[i] >= 0 && !pp.escaped[i]) {
            const c = ch as DelimChar;
            const runIdx = pp.runAt[i];
            const runEnd = Math.min(pp.runs[c][runIdx].end, to);
            const len = runEnd - i;
            let matched = false;
            if (depth < MAX_INLINE_DEPTH) {
                for (const k of kindsFor(c, len)) {
                    if (!openerOk(src, c, k, i, to)) continue;
                    const close = findCloser(pp, c, k, runIdx, i + k, to);
                    if (close < 0) continue;
                    flush();
                    out.push(wrap(c, k, parseRange(pp, i + k, close, depth + 1, inLink)));
                    i = close + k;
                    matched = true;
                    break;
                }
            }
            if (!matched) { buf += src.slice(i, runEnd); i = runEnd; }
            continue;
        }
        // Plain text up to the next character that could start something.
        let j = i + 1;
        while (j < to && !pp.starts[j]) {
            const cj = src.charCodeAt(j);
            if (cj === 92 || cj === 91 || cj === 42 || cj === 95 || cj === 126 || cj === 124) break; // \ [ * _ ~ |
            j++;
        }
        buf += src.slice(i, j);
        i = j;
    }
    flush();
    return out;
}

/** Inline-only parse of one run of text (a paragraph, heading, list item…). */
/** Size spans left for the message being parsed (reset per parseMessage / parseInline call). */
let sizeBudget = MAX_SIZE_SPANS;

export function parseInline(src: string): InlineNode[] {
    sizeBudget = MAX_SIZE_SPANS;
    return parseInlineSrc(src);
}

function parseInlineSrc(src: string): InlineNode[] {
    if (src.length === 0) return [];
    return parseRange(prepass(src), 0, src.length, 0, false);
}

// ── Blocks ───────────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,3})[ \t]+(\S.*)$/;
const SUBTEXT_RE = /^-#[ \t]+(\S.*)$/;
const LIST_RE = /^([ \t]*)([-*]|\d{1,9}\.)[ \t]+(\S.*)$/;

/** True when this line leaves a ``` fence open (an odd number of unescaped fences). */
export function lineTogglesFence(line: string): boolean {
    let count = 0;
    let at = line.indexOf('```');
    while (at >= 0) {
        if (at === 0 || line[at - 1] !== '\\') count++;
        at = line.indexOf('```', at + 3);
    }
    return count % 2 === 1;
}

function indentWidth(s: string): number {
    let w = 0;
    for (const ch of s) w += ch === '\t' ? 2 : 1;
    return w;
}

interface ListLine { indent: number; ordered: boolean; num: number; content: string }

function buildList(lines: ListLine[]): ListBlock[] {
    const roots: ListBlock[] = [];
    const stack: { indent: number; list: ListBlock }[] = [];
    for (const ln of lines) {
        const item: ListItem = { c: parseInlineSrc(ln.content), sub: null };
        if (stack.length === 0) {
            const list: ListBlock = { t: 'list', ordered: ln.ordered, start: ln.ordered ? ln.num : 1, items: [item] };
            roots.push(list);
            stack.push({ indent: ln.indent, list });
            continue;
        }
        let top = stack[stack.length - 1];
        if (ln.indent > top.indent && stack.length < MAX_LIST_DEPTH) {
            const parent = top.list.items[top.list.items.length - 1];
            if (parent.sub) {
                parent.sub.items.push(item);
            } else {
                parent.sub = { t: 'list', ordered: ln.ordered, start: ln.ordered ? ln.num : 1, items: [item] };
            }
            stack.push({ indent: ln.indent, list: parent.sub });
            continue;
        }
        while (stack.length > 1 && ln.indent < stack[stack.length - 1].indent) stack.pop();
        top = stack[stack.length - 1];
        if (stack.length === 1 && top.list.ordered !== ln.ordered) {
            // Switching between `-` and `1.` at the top level starts a new list.
            const list: ListBlock = { t: 'list', ordered: ln.ordered, start: ln.ordered ? ln.num : 1, items: [item] };
            roots.push(list);
            stack[0] = { indent: ln.indent, list };
            continue;
        }
        top.list.items.push(item);
    }
    return roots;
}

function parseBlocks(src: string, inQuote: boolean): BlockNode[] {
    const lines = src.split('\n');
    const blocks: BlockNode[] = [];
    let para: string[] = [];
    const flush = () => {
        if (para.length === 0) return;
        const text = para.join('\n');
        // `pad` is provisional: it is cleared below for the last block.
        blocks.push({ t: 'para', c: parseInlineSrc(text), pad: para[para.length - 1] === '' });
        para = [];
    };
    let fenceOpen = false;
    let li = 0;
    while (li < lines.length) {
        const line = lines[li];
        if (fenceOpen) {
            para.push(line);
            if (lineTogglesFence(line)) fenceOpen = false;
            li++;
            continue;
        }
        if (lineTogglesFence(line)) {
            para.push(line);
            fenceOpen = true;
            li++;
            continue;
        }
        if (!inQuote && (line.startsWith('>>> ') || line === '>>>')) {
            flush();
            const rest = [line.slice(4), ...lines.slice(li + 1)].join('\n');
            blocks.push({ t: 'quote', c: parseBlocks(rest, true) });
            li = lines.length;
            break;
        }
        if (!inQuote && line.startsWith('> ')) {
            flush();
            const q: string[] = [];
            while (li < lines.length && (lines[li].startsWith('> ') || lines[li] === '>')) {
                q.push(lines[li].slice(2));
                li++;
            }
            blocks.push({ t: 'quote', c: parseBlocks(q.join('\n'), true) });
            continue;
        }
        const h = HEADING_RE.exec(line);
        if (h) {
            flush();
            blocks.push({ t: 'heading', level: h[1].length as 1 | 2 | 3, c: parseInlineSrc(h[2]) });
            li++;
            continue;
        }
        const s = SUBTEXT_RE.exec(line);
        if (s) {
            flush();
            blocks.push({ t: 'subtext', c: parseInlineSrc(s[1]) });
            li++;
            continue;
        }
        if (LIST_RE.test(line)) {
            flush();
            const items: ListLine[] = [];
            while (li < lines.length && !lineTogglesFence(lines[li])) {
                const m = LIST_RE.exec(lines[li]);
                if (!m) break;
                const ordered = m[2] !== '-' && m[2] !== '*';
                items.push({ indent: indentWidth(m[1]), ordered, num: ordered ? parseInt(m[2], 10) : 1, content: m[3] });
                li++;
            }
            blocks.push(...buildList(items));
            continue;
        }
        para.push(line);
        li++;
    }
    flush();
    // A paragraph whose last line is blank keeps that blank line on screen
    // when another block follows it (pre-wrap drops a final newline). The last
    // block never pads, so a message ending in "\n" looks exactly as before.
    const last = blocks[blocks.length - 1];
    if (last && last.t === 'para') last.pad = false;
    return blocks;
}

// ── Public API ───────────────────────────────────────────────────────────────

const CACHE_MAX = 400;
const cache = new Map<string, BlockNode[]>();

/**
 * Parse message text into blocks. Results are memoised by text (the AST is
 * treated as immutable by every consumer), because a feed re-renders every
 * visible row on each composer keystroke.
 */
export function parseMessage(text: string): BlockNode[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    const hit = cache.get(text);
    if (hit) {
        cache.delete(text);
        cache.set(text, hit);
        return hit;
    }
    sizeBudget = MAX_SIZE_SPANS;
    const blocks = parseBlocks(text.replace(/\r\n?/g, '\n'), false);
    cache.set(text, blocks);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return blocks;
}

/** True when the parse is a single paragraph of plain text (nothing to format). */
export function isPlainParse(blocks: readonly BlockNode[]): boolean {
    return blocks.length === 1 && blocks[0].t === 'para' && blocks[0].c.every(n => n.t === 'text');
}

/** Closes a ``` fence left open at the END of a cut-down preview, so the preview shows code, not backticks. */
export function closeDanglingFence(text: string): string {
    let open = false;
    let at = text.indexOf('```');
    while (at >= 0) {
        if (at === 0 || text[at - 1] !== '\\') open = !open;
        at = text.indexOf('```', at + 3);
    }
    return open ? `${text}\n\`\`\`` : text;
}
