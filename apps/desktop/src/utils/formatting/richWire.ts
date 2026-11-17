/**
 * The WYSIWYG composer's model (richDoc.ts) <-> the Discord-style message
 * text every client already reads (markdown.ts). The wire format does not
 * change: what the composer sends is plain message text, exactly the syntax
 * a person could have typed.
 *
 * ## docFromWire(text)
 * Parses with the MESSAGE parser itself (parseMessage), so the box shows a
 * message exactly the way the feed renders it — there is no second grammar to
 * drift. Constructs the box has no tool for are kept as their literal source
 * text: masked links `[label](https://…)` and `<https://…>` stay typed-out
 * text (they still send as links). Escapes come back as the literal
 * character. A few EMPTY lines the parser would drop (an empty list item, an
 * empty heading, an empty quote line, an empty code block) are recognised in
 * the source first, so a draft with one survives a reload.
 *
 * ## wireFromDoc(doc)
 * Serialises lines and marks with the delimiters the parser reads — `**`
 * bold, `*` italic, `__` underline, `~~` strike, `||` spoiler, `` ` `` code,
 * `# `/`## `/`### ` headings, `-# ` subtext, `> ` quotes, `- `/`1. ` lists
 * (two spaces per level), ``` fences — and then CHECKS itself: the output is
 * parsed back and must give the same document. When it does not (a literal
 * `*` the person typed, two markers that would run together), it retries
 * with escapes on the lines that need them (`\*`, `\#`, `1\.` …) and with
 * `_` for italics next to a `**`. Literal text is escaped only where it would
 * otherwise turn into formatting, so plain messages read the same on a client
 * that shows the raw text (mobile today).
 *
 * Linear apart from the verification parse, which is the parser's own
 * linear-ish pass; retries happen only for lines that failed.
 */
import { parseMessage, lineTogglesFence, type BlockNode, type InlineNode, type ListBlock } from './markdown';
import {
    MARK, SIZE_MARKS, blockText, docLen, setSize, sizeInRange, type SpanSize, blockLen, docsEqual, mkBlock, normalizeDoc, normRuns, isListType, isHeadingType,
    type Block, type BlockType, type Doc, type Run,
} from './richDoc';

// ── wire -> doc ─────────────────────────────────────────────────────────────

/**
 * A private-use character standing in for "nothing" on lines the parser would
 * otherwise drop or merge: `- ` / `1. ` / `# ` / `-# ` / `> ` with no text, an
 * empty code block, and a blank line right next to a ``` fence (the parser
 * treats the line break there as the block's edge). The sentinel keeps each
 * such line where it is in the parse — an empty item stays in its list at its
 * depth — and restoreEmpty turns every block whose whole text is the sentinel
 * back into an empty one. Only ever in the parser's input here; never sent.
 */
const SENT = '';
const EMPTY_ITEM_RE = /^((?:> )?)( *(?:[-*]|\d{1,9}\.)) $/;
const EMPTY_HEADING_RE = /^((?:> )?)(#{1,3}|-#) $/;
const EMPTY_QUOTE_RE = /^> $/;
const FENCE_OPEN_RE = /^((?:> )?)```([A-Za-z0-9_+\-.#]{0,32})$/;

/** Mark the empty lines the parser would drop, so docFromWire can restore them. */
function markEmptyLines(text: string): string {
    if (!/(?:^|\n)(?:> )?(?: *(?:[-*]|\d{1,9}\.)|#{1,3}|-#|>) ?(?:\n|$)|```/.test(text)) return text;
    const lines = text.split('\n');
    const out: string[] = [];
    let fenceOpen = false;
    let afterFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fenceOpen) {
            out.push(line);
            if (lineTogglesFence(line)) { fenceOpen = false; afterFence = true; }
            continue;
        }
        const wasAfterFence = afterFence;
        afterFence = false;
        if (line === '' && (wasAfterFence || (i + 1 < lines.length && /^(?:> )?```/.test(lines[i + 1])))) {
            out.push(SENT);
            continue;
        }
        const f = FENCE_OPEN_RE.exec(line);
        if (f && lines[i + 1] === `${f[1]}\`\`\``) {
            out.push(line, `${f[1]}${SENT}`, lines[i + 1]);
            i++;
            afterFence = true;
            continue;
        }
        if (lineTogglesFence(line)) {
            out.push(line);
            fenceOpen = true;
            continue;
        }
        // A one-line ```x``` block: the line break after it is its edge too.
        if (line.endsWith('```') && line.indexOf('```') < line.length - 3) afterFence = true;
        let m = EMPTY_ITEM_RE.exec(line);
        if (m) { out.push(`${m[1]}${m[2]} ${SENT}`); continue; }
        m = EMPTY_HEADING_RE.exec(line);
        if (m) { out.push(`${m[1]}${m[2]} ${SENT}`); continue; }
        if (EMPTY_QUOTE_RE.test(line)) { out.push(`> ${SENT}`); continue; }
        out.push(line);
    }
    return out.join('\n');
}

const NODE_MARK: Record<string, number> = { strong: MARK.b, em: MARK.i, u: MARK.u, strike: MARK.s, spoiler: MARK.sp };

/** Literal source text of a link node (the box keeps link syntax as typed text). */
function linkRuns(n: Extract<InlineNode, { t: 'link' }>, m: number, out: Run[]): void {
    if (n.kind === 'angle') { out.push({ t: `<${n.url}>`, m }); return; }
    out.push({ t: '[', m });
    for (const c of n.c) inlineRuns(c, m, out, null);
    out.push({ t: `](${n.url})`, m });
}

/**
 * Inline nodes -> runs. `blocks` receives code blocks met inside a paragraph
 * (they become their own block); without it (a heading, a list item) a code
 * block is kept as inline code.
 */
function inlineRuns(n: InlineNode, m: number, out: Run[], blocks: { split: (code: Block) => void } | null): void {
    switch (n.t) {
        case 'text': out.push({ t: n.v, m }); return;
        case 'code': out.push({ t: n.v, m: m | MARK.c }); return;
        case 'codeBlock':
            if (blocks) blocks.split(mkBlock('code', n.v ? [{ t: n.v, m: 0 }] : [], { lang: n.lang }));
            else out.push({ t: n.v.replace(/\n/g, ' '), m: m | MARK.c });
            return;
        case 'link': linkRuns(n, m, out); return;
        case 'size': {
            // Absolute: an inner size replaces the outer one.
            const bit = n.size === 'small' ? MARK.sm : MARK.lg;
            for (const c of n.c) inlineRuns(c, (m & ~SIZE_MARKS) | bit, out, blocks);
            return;
        }
        default:
            for (const c of n.c) inlineRuns(c, m | NODE_MARK[n.t], out, blocks);
    }
}

function paraBlocks(nodes: InlineNode[], q: boolean, out: Block[]): void {
    const startLen = out.length;
    let runs: Run[] = [];
    let endsInCode = false;
    // A code block is its own block: the text before it is one line, the text after it the next.
    const sink = {
        split: (code: Block) => {
            if (runs.length) { out.push(mkBlock('p', runs, { q })); runs = []; }
            out.push({ ...code, q });
            endsInCode = true;
        },
    };
    for (const n of nodes) {
        endsInCode = false;
        inlineRuns(n, 0, runs, sink);
        if (runs.length) endsInCode = false;
    }
    if (runs.length || out.length === startLen || !endsInCode) out.push(mkBlock('p', runs, { q }));
}

function listBlocks(list: ListBlock, depth: number, q: boolean, out: Block[]): void {
    list.items.forEach((item, i) => {
        const runs: Run[] = [];
        for (const n of item.c) inlineRuns(n, 0, runs, null);
        out.push(mkBlock(list.ordered ? 'ol' : 'ul', runs, { q, ind: depth, num: list.start + i }));
        if (item.sub) listBlocks(item.sub, depth + 1, q, out);
    });
}

function blocksFromTree(nodes: BlockNode[], q: boolean, out: Block[]): void {
    for (const node of nodes) {
        switch (node.t) {
            case 'para': paraBlocks(node.c, q, out); break;
            case 'heading': {
                const runs: Run[] = [];
                for (const n of node.c) inlineRuns(n, 0, runs, null);
                out.push(mkBlock(`h${node.level}` as BlockType, runs, { q }));
                break;
            }
            case 'subtext': {
                const runs: Run[] = [];
                for (const n of node.c) inlineRuns(n, 0, runs, null);
                out.push(mkBlock('sub', runs, { q }));
                break;
            }
            case 'quote':
                if (node.c.length === 0) out.push(mkBlock('p', [], { q: true }));
                else blocksFromTree(node.c, true, out);
                break;
            case 'list': listBlocks(node, 0, q, out); break;
        }
    }
}

/** Every block whose whole text is the sentinel (markEmptyLines) is an empty one. */
function restoreEmpty(doc: Block[]): Block[] {
    return doc.map(b => (b.runs.length === 1 && b.runs[0].t === SENT ? { ...b, runs: [] } : b));
}

/** The composer document for a message's (display-form) text. */
export function docFromWire(text: string): Doc {
    if (typeof text !== 'string' || text.length === 0) return [mkBlock('p')];
    const src = markEmptyLines(text.replace(/\r\n?/g, '\n'));
    const out: Block[] = [];
    blocksFromTree(parseMessage(src), false, out);
    return normalizeDoc(restoreEmpty(normalizeDoc(out) as Block[]));
}

// ── doc -> wire ─────────────────────────────────────────────────────────────

type InlineMark = 'b' | 'i' | 'u' | 's' | 'sp' | 'sm' | 'lg';
/** Fixed order (outermost first): a size span wraps the other styles. */
const STACK_MARKS: readonly InlineMark[] = ['lg', 'sm', 'sp', 's', 'u', 'b', 'i'];

interface SerOpts {
    /** Escape literal formatting characters (only for lines that need it). */
    escape: boolean;
    /** The italic delimiter. */
    italic: '*' | '_';
    /** Open the longest-running mark outermost (true) or use a fixed order. */
    byExtent: boolean;
}

const DEFAULT_OPTS: SerOpts = { escape: false, italic: '*', byExtent: true };

function closeDelim(mk: InlineMark, o: SerOpts): string {
    if (mk === 'sm') return '[/small]';
    if (mk === 'lg') return '[/large]';
    return delim(mk, o);
}

function delim(mk: InlineMark, o: SerOpts): string {
    switch (mk) {
        case 'sm': return '[small]';
        case 'lg': return '[large]';
        case 'b': return '**';
        case 'i': return o.italic;
        case 'u': return '__';
        case 's': return '~~';
        default: return '||';
    }
}

/** A code span for `t`: enough backticks, padded when it starts / ends with one or with spaces on both sides. */
function codeSpan(t: string): string {
    // The parser closes a span on the next backtick run of EXACTLY the
    // opener's length (1 or 2), so pick a length no run inside has.
    const runs = new Set((t.match(/`+/g) ?? []).map(x => x.length));
    const fence = !runs.has(1) ? '`' : '``';
    const pad = t.startsWith('`') || t.endsWith('`') || (t.length >= 2 && t.startsWith(' ') && t.endsWith(' ') && t.trim() !== '');
    return pad ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
}

const WORD = /[\p{L}\p{N}]/u;
const isWord = (ch: string | undefined): boolean => !!ch && WORD.test(ch);
/** Trailing characters the parser drops from a bare URL (markdown.ts URL_TRAILING). */
const URL_TRAILING_CHARS = ".,:;!?'\")*_~|";
/**
 * Spans never escaped: a masked-link target, URLs (an escape would end them)
 * and mention / channel / emoji display forms.
 */
const PROTECT_RE = /\]\([ \t]*<?https:\/\/[^\s<>()]+>?[ \t]*\)|<https?:\/\/[^\s>]+>|https?:\/\/[^\s<>"{}|\\^`[\]]+|@[\p{L}\p{N}_.-]+|#[\p{L}\p{N}_-]+|:[A-Za-z0-9_+-]+:/gu;

function protectMask(text: string): Uint8Array | null {
    PROTECT_RE.lastIndex = 0;
    let mask: Uint8Array | null = null;
    for (let m = PROTECT_RE.exec(text); m; m = PROTECT_RE.exec(text)) {
        mask ??= new Uint8Array(text.length);
        let end = m.index + m[0].length;
        // A bare URL ends where the parser ends it (markdown.ts URL_TRAILING):
        // a closing `*` / `~` / `|` after it is formatting, not URL.
        if (m[0].startsWith('http')) while (end > m.index && URL_TRAILING_CHARS.includes(text[end - 1])) end--;
        mask.fill(1, m.index, end);
    }
    return mask;
}

function escapeChar(text: string, k: number, mask: Uint8Array | null, runEnd: number): string {
    const ch = text[k];
    if (mask && mask[k]) return ch;
    switch (ch) {
        // A backslash before punctuation, or at the end of a run (a closing
        // delimiter may follow it), would escape the next character.
        case '\\': return k === runEnd - 1 || /[!-/:-@[-`{-~]/.test(text[k + 1] ?? '') ? '\\\\' : ch;
        case '*': case '~': case '|': case '`': return `\\${ch}`;
        // A literal `[large]` / `[/small]` typed as text would become a size span.
        case '[': return /^(?:\/)?(?:small|large)\]/.test(text.slice(k + 1, k + 8)) ? '\\[' : ch;
        // `_` between two letters can never open or close an italic.
        case '_': return isWord(text[k - 1]) && isWord(text[k + 1]) && text[k + 1] !== '_' && text[k - 1] !== '_' ? ch : '\\_';
        default: return ch;
    }
}

/**
 * The marks to strip from whitespace at the edges of a marked span: `* x*`
 * is not italic on the wire, so a typed trailing space inside bold/italic
 * sends as an ordinary space (and the box's model is compared the same way).
 */
function trimEdgeMarks(runs: readonly Run[]): readonly Run[] {
    if (!runs.some(r => r.m & (MARK.b | MARK.i | MARK.u | MARK.s) && /^\s|\s$/.test(r.t))) return runs;
    const text = runs.map(r => r.t).join('');
    const marks: number[] = [];
    for (const r of runs) for (let k = 0; k < r.t.length; k++) marks.push(r.m);
    for (const bit of [MARK.b, MARK.i, MARK.u, MARK.s]) {
        let k = 0;
        while (k < text.length) {
            if (!(marks[k] & bit)) { k++; continue; }
            let e = k;
            while (e < text.length && marks[e] & bit) e++;
            let s = k;
            while (s < e && /\s/.test(text[s])) { marks[s] &= ~bit; s++; }
            let t = e - 1;
            while (t >= s && /\s/.test(text[t])) { marks[t] &= ~bit; t--; }
            k = e;
        }
    }
    const out: Run[] = [];
    for (let k = 0; k < text.length; k++) {
        const last = out[out.length - 1];
        if (last && last.m === marks[k]) last.t += text[k];
        else out.push({ t: text[k], m: marks[k] });
    }
    return out;
}

/** Whitespace a heading / list item / subtext starts with cannot be sent (the prefix eats it). */
function trimLeading(runs: readonly Run[]): readonly Run[] {
    if (!runs.length || !/^\s/.test(runs[0].t)) return runs;
    const out = runs.slice();
    while (out.length && /^\s/.test(out[0].t)) {
        const t = out[0].t.replace(/^\s+/, '');
        if (t) { out[0] = { ...out[0], t }; break; }
        out.shift();
    }
    return out;
}

/**
 * The model as the parser can express it: edge whitespace unmarked, heading /
 * list / subtext content without leading whitespace, code-block text without
 * leading / trailing blank lines. wireFromDoc serialises THIS, and the
 * round-trip guarantee is docFromWire(wireFromDoc(d)) == canonicalDoc(d).
 */
export function canonicalDoc(doc: Doc): Doc {
    let changed = false;
    const out = doc.map(b => {
        if (b.type === 'code') {
            const t = blockText(b);
            const trimmed = t.replace(/^\n+/, '').replace(/\n+$/, '');
            if (trimmed === t) return b;
            changed = true;
            return { ...b, runs: trimmed ? [{ t: trimmed, m: 0 }] : [] };
        }
        let runs = trimEdgeMarks(b.runs);
        if (isHeadingType(b.type) || isListType(b.type) || b.type === 'sub') runs = trimLeading(runs);
        runs = normRuns(runs);
        if (runs === b.runs) return b;
        changed = true;
        return { ...b, runs };
    });
    return changed ? normalizeDoc(out) : doc;
}

/** Serialise one non-code block's inline content. */
function inlineWire(runs: readonly Run[], o: SerOpts): string {
    if (runs.length === 0) return '';
    const text = runs.map(r => r.t).join('');
    const mask = o.escape ? protectMask(text) : null;
    let out = '';
    const stack: InlineMark[] = [];
    let at = 0;
    const extent = (k: number, bit: number): number => {
        let n = 0;
        for (let j = k; j < runs.length && runs[j].m & bit; j++) n += runs[j].t.length;
        return n;
    };
    for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        const want = r.m;
        let j = stack.findIndex(mk => !(want & MARK[mk]));
        if (j < 0) j = stack.length;
        for (let t = stack.length - 1; t >= j; t--) out += closeDelim(stack[t], o);
        stack.length = j;
        const open = STACK_MARKS.filter(mk => want & MARK[mk] && !stack.includes(mk));
        if (o.byExtent) open.sort((x, y) => extent(k, MARK[y]) - extent(k, MARK[x]) || STACK_MARKS.indexOf(x) - STACK_MARKS.indexOf(y));
        for (const mk of open) { out += delim(mk, o); stack.push(mk); }
        if (want & MARK.c) {
            out += codeSpan(r.t);
        } else if (o.escape) {
            for (let c = 0; c < r.t.length; c++) out += escapeChar(text, at + c, mask, at + r.t.length);
        } else {
            out += r.t;
        }
        at += r.t.length;
    }
    for (let t = stack.length - 1; t >= 0; t--) out += closeDelim(stack[t], o);
    return out;
}

/** A paragraph line the parser would read as a block (heading, list, quote, subtext): escape its marker. */
function escapeLineStart(line: string): string {
    let m = /^(#{1,3})([ \t]+\S|[ \t]*$)/.exec(line);
    if (m && (m[2].trim() !== '' || / $/.test(line))) return `\\${line}`;
    if (/^-#[ \t]+(\S|$)/.test(line)) return `\\${line}`;
    if (/^> /.test(line) || /^>>>( |$)/.test(line)) return `\\${line}`;
    m = /^([ \t]*)([-*])([ \t]+)/.exec(line);
    if (m) return `${m[1]}\\${line.slice(m[1].length)}`;
    m = /^([ \t]*)(\d{1,9})\.([ \t]+)/.exec(line);
    if (m) return `${m[1]}${m[2]}\\.${line.slice(m[1].length + m[2].length + 1)}`;
    return line;
}

function quotePrefix(q: boolean): string { return q ? '> ' : ''; }

/** One block as wire line(s). */
function blockWire(b: Block, o: SerOpts): string {
    const qp = quotePrefix(b.q);
    if (b.type === 'code') {
        const t = blockText(b);
        const lang = b.lang ?? '';
        const lines = t ? [`\`\`\`${lang}`, ...t.split('\n'), '```'] : [`\`\`\`${lang}`, '```'];
        return lines.map(l => qp + l).join('\n');
    }
    const body = inlineWire(b.runs, o);
    const empty = blockLen(b) === 0;
    switch (b.type) {
        case 'h1': case 'h2': case 'h3':
            return `${qp}${'#'.repeat(Number(b.type[1]))} ${body}`;
        case 'sub':
            return `${qp}-# ${body}`;
        case 'ul':
            return `${qp}${'  '.repeat(b.ind)}- ${body}`;
        case 'ol':
            return `${qp}${'  '.repeat(b.ind)}${b.num}. ${body}`;
        default:
            if (empty) return b.q ? '> ' : '';
            return qp + escapeLineStart(body);
    }
}

/** Every block serialised with `opts[i]`. */
function joinWire(doc: Doc, opts: readonly SerOpts[]): string {
    let s = '';
    for (let i = 0; i < doc.length; i++) {
        if (i > 0) s += '\n';
        s += blockWire(doc[i], opts[i]);
    }
    return s;
}

const VARIANTS: readonly SerOpts[] = [
    { escape: false, italic: '*', byExtent: true },
    { escape: true, italic: '*', byExtent: true },
    { escape: true, italic: '_', byExtent: true },
    { escape: true, italic: '*', byExtent: false },
    { escape: true, italic: '_', byExtent: false },
];

/** Whether one block alone round-trips with these options. */
function blockRoundTrips(b0: Block, o: SerOpts): boolean {
    // Alone, a nested item would be a top-level one.
    const b = isListType(b0.type) ? { ...b0, ind: 0 } : b0;
    const back = docFromWire(blockWire(b, o));
    return back.length === 1 && docsEqual(back, [b]);
}

export interface WireResult {
    text: string;
    /** False when even the escaped forms could not express the box exactly (best effort sent). */
    exact: boolean;
}

/**
 * The message text for a composer document. Verified: the text parses back
 * to the same document (see canonicalDoc); lines that do not are re-written
 * with escapes / the other italic delimiter.
 */
export function wireFromDocChecked(doc0: Doc): WireResult {
    const doc = canonicalDoc(doc0);
    const opts: SerOpts[] = doc.map(() => DEFAULT_OPTS);
    let text = joinWire(doc, opts);
    if (!needsCheck(doc)) return { text, exact: true };
    if (docsEqual(docFromWire(text), doc)) return { text, exact: true };
    // Fix the lines that fail on their own.
    for (let i = 0; i < doc.length; i++) {
        const b = doc[i];
        if (b.type === 'code' || blockRoundTrips(b, opts[i])) continue;
        const ok = VARIANTS.find(v => v !== DEFAULT_OPTS && blockRoundTrips(b, v));
        opts[i] = ok ?? VARIANTS[1];
    }
    text = joinWire(doc, opts);
    if (docsEqual(docFromWire(text), doc)) return { text, exact: true };
    // Lines that interact (emphasis can span a paragraph's lines): escape every
    // paragraph-ish line that has a formatting character.
    for (let i = 0; i < doc.length; i++) {
        if (doc[i].type === 'code' || opts[i].escape) continue;
        if (/[*_~|`\\]/.test(blockText(doc[i]))) opts[i] = VARIANTS[1];
    }
    text = joinWire(doc, opts);
    return { text, exact: docsEqual(docFromWire(text), doc) };
}

/** Fast path: a document with no formatting characters, marks or special lines needs no verification parse. */
function needsCheck(doc: Doc): boolean {
    for (const b of doc) {
        if (b.type !== 'p' || b.q) return true;
        for (const r of b.runs) {
            if (r.m !== 0) return true;
            if (/[*_~|`\\[<#>\-\d]/.test(r.t)) return true;
        }
    }
    return false;
}

export function wireFromDoc(doc: Doc): string {
    return wireFromDocChecked(doc).text;
}

/** The literal (unformatted) document for plain text: every character as typed. */
export function literalDoc(text: string): Doc {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    return normalizeDoc(lines.map(l => mkBlock('p', l ? [{ t: l, m: 0 }] : [])));
}

// ── Message size <-> span sizes ──────────────────────────────────────────────

/**
 * Back-compat with the per-message `size` field (packages/shared
 * MESSAGE_SIZES): when EVERY character of a message has the same span size,
 * the composer sends it as the message field with clean text — what older
 * clients (which know only the field, or nothing) render best. Anything mixed
 * is sent as `[small]` / `[large]` spans and no field. Code-block text counts
 * as normal, so a message with a code block and large text is "mixed".
 */
export function extractUniformSize(wire: string): { text: string; size: SpanSize | null } {
    if (!wire.includes('[small]') && !wire.includes('[large]')) return { text: wire, size: null };
    const doc = docFromWire(wire);
    const size = sizeInRange(doc, 0, docLen(doc));
    if (size === null || size === 'mixed') return { text: wire, size: null };
    return { text: wireFromDoc(setSize(doc, 0, docLen(doc), null)), size };
}

/** The other way, for loading an edit: a message's `size` field as spans over all of its text. */
export function applyMessageSize(wire: string, size: SpanSize | null): string {
    if (!size || !wire) return wire;
    const doc = docFromWire(wire);
    return wireFromDoc(setSize(doc, 0, docLen(doc), size));
}
