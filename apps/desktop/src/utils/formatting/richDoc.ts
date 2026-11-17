/**
 * The WYSIWYG composer's document model (components/composer/RichComposer.tsx).
 *
 * The box no longer holds Markdown: it holds a list of LINE BLOCKS, each a
 * list of text RUNS carrying a set of inline marks. Toolbar buttons, the
 * Ctrl/Cmd shortcuts and the typed shortcuts (utils/formatting/richRules.ts)
 * all edit this model; utils/formatting/richWire.ts turns it into exactly the
 * Discord-style text the message parser (markdown.ts) reads, and back.
 *
 * Positions are FLAT plain-text offsets: every block's text, joined by one
 * '\n' per block boundary (a code block's own line breaks count as text). The
 * model never holds a marker character for formatting — a `*` in a run is a
 * literal asterisk the person typed.
 *
 * Every function here is pure (a Doc is never mutated) and keeps the identity
 * of blocks it did not change, which is what lets the editor re-render only
 * the lines an edit touched.
 */

// ── Model ────────────────────────────────────────────────────────────────────

export const MARK = { b: 1, i: 2, u: 4, s: 8, sp: 16, c: 32, sm: 64, lg: 128 } as const;
export type MarkName = keyof typeof MARK;
export const MARK_NAMES: readonly MarkName[] = ['b', 'i', 'u', 's', 'sp', 'c', 'sm', 'lg'];
/** Every mark bit set. */
export const ALL_MARKS = 255;
/**
 * Text size is a span style too (owner, 2026-11-16: "highlight some text make
 * it big, and other text make it small, all in one message"): `sm` / `lg`,
 * never both; no bit = normal. Code-block text has no size (it is normal).
 */
export const SIZE_MARKS = MARK.sm | MARK.lg;
export type SpanSize = 'small' | 'large';
export const sizeBit = (size: SpanSize | null): number => (size === 'small' ? MARK.sm : size === 'large' ? MARK.lg : 0);
export const sizeOfMarks = (m: number): SpanSize | null => (m & MARK.lg ? 'large' : m & MARK.sm ? 'small' : null);

export interface Run {
    /** Literal text (never contains '\n' outside a code block). */
    t: string;
    /** Bitmask of MARK values. */
    m: number;
}

export type BlockType = 'p' | 'h1' | 'h2' | 'h3' | 'sub' | 'ul' | 'ol' | 'code';

export interface Block {
    type: BlockType;
    /** Inside a quote (`> `). Any block type can be quoted. */
    q: boolean;
    /** List nesting depth (lists only; 0 otherwise). */
    ind: number;
    /** Numbered lists: this item's number (recomputed from the first item of its list). */
    num: number;
    /** Code blocks: the fence language, or null. */
    lang: string | null;
    /** A code block has exactly one unmarked run (its text may contain '\n'). */
    runs: readonly Run[];
}

export type Doc = readonly Block[];

export const MAX_LIST_INDENT = 5;
const LANG_OK = /^[A-Za-z0-9_+\-.#]{1,32}$/;

export function mkBlock(type: BlockType = 'p', runs: readonly Run[] = [], extra: Partial<Block> = {}): Block {
    return { type, q: false, ind: 0, num: 1, lang: null, ...extra, runs };
}

export function textRun(t: string, m = 0): Run { return { t, m }; }

export function emptyDoc(): Doc { return [mkBlock('p')]; }

export const isListType = (t: BlockType): boolean => t === 'ul' || t === 'ol';
export const isHeadingType = (t: BlockType): boolean => t === 'h1' || t === 'h2' || t === 'h3';

export function blockText(b: Block): string {
    if (b.runs.length === 1) return b.runs[0].t;
    let s = '';
    for (const r of b.runs) s += r.t;
    return s;
}

export function blockLen(b: Block): number {
    let n = 0;
    for (const r of b.runs) n += r.t.length;
    return n;
}

export function docLen(doc: Doc): number {
    let n = Math.max(0, doc.length - 1);
    for (const b of doc) n += blockLen(b);
    return n;
}

/** The plain text of the document: block texts joined by '\n'. */
export function plainText(doc: Doc): string {
    return doc.map(blockText).join('\n');
}

export function isDocEmpty(doc: Doc): boolean {
    return doc.length === 1 && blockLen(doc[0]) === 0;
}

/** Block index and offset inside it for a flat offset (clamped). Boundaries resolve to the END of the earlier block. */
export function locate(doc: Doc, pos: number): { bi: number; off: number } {
    let p = Math.max(0, pos);
    for (let bi = 0; bi < doc.length; bi++) {
        const len = blockLen(doc[bi]);
        if (p <= len) return { bi, off: p };
        p -= len + 1;
    }
    const last = doc.length - 1;
    return { bi: last, off: blockLen(doc[last]) };
}

/** Flat offset of the start of block `bi`. */
export function blockStart(doc: Doc, bi: number): number {
    let n = 0;
    for (let i = 0; i < bi && i < doc.length; i++) n += blockLen(doc[i]) + 1;
    return n;
}

export function flatOf(doc: Doc, bi: number, off: number): number {
    return blockStart(doc, bi) + off;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** Drop empty runs and merge neighbours with the same marks. Returns the SAME array when already normal. */
export function normRuns(runs: readonly Run[]): readonly Run[] {
    let ok = true;
    for (let i = 0; i < runs.length; i++) {
        if (runs[i].t.length === 0 || (i > 0 && runs[i - 1].m === runs[i].m)) { ok = false; break; }
    }
    if (ok) return runs;
    const out: Run[] = [];
    for (const r of runs) {
        if (r.t.length === 0) continue;
        const last = out[out.length - 1];
        if (last && last.m === r.m) out[out.length - 1] = { t: last.t + r.t, m: r.m };
        else out.push(r);
    }
    return out;
}

/** Runs covering [a, b) of a run list's text. */
export function sliceRuns(runs: readonly Run[], a: number, b: number): Run[] {
    const out: Run[] = [];
    let at = 0;
    for (const r of runs) {
        const s = at;
        const e = at + r.t.length;
        at = e;
        if (e <= a || s >= b) continue;
        out.push({ t: r.t.slice(Math.max(0, a - s), Math.min(r.t.length, b - s)), m: r.m });
    }
    return out;
}

/** Marks of the character at block offset `off` (0 when out of range). */
export function marksOfChar(b: Block, off: number): number {
    let at = 0;
    for (const r of b.runs) {
        if (off < at + r.t.length) return r.m;
        at += r.t.length;
    }
    return 0;
}

function mapRunMarks(runs: readonly Run[], a: number, b: number, fn: (m: number, ch: string) => number): Run[] {
    const out: Run[] = [];
    let at = 0;
    for (const r of runs) {
        const s = at;
        const e = at + r.t.length;
        at = e;
        if (e <= a || s >= b) { out.push(r); continue; }
        const x = Math.max(a, s) - s;
        const y = Math.min(b, e) - s;
        if (x > 0) out.push({ t: r.t.slice(0, x), m: r.m });
        // Per character only where the mapping depends on the character.
        let buf = '';
        let bufM = -1;
        for (let k = x; k < y; k++) {
            const nm = fn(r.m, r.t[k]);
            if (nm !== bufM && buf) { out.push({ t: buf, m: bufM }); buf = ''; }
            bufM = nm;
            buf += r.t[k];
        }
        if (buf) out.push({ t: buf, m: bufM });
        if (y < r.t.length) out.push({ t: r.t.slice(y), m: r.m });
    }
    return out;
}

// ── Normalisation ───────────────────────────────────────────────────────────

function sameBlockShape(a: Block, b: Block): boolean {
    return a.type === b.type && a.q === b.q && a.ind === b.ind && a.num === b.num && a.lang === b.lang;
}

/**
 * The editor's invariants, applied after every edit:
 *  - runs are normal; a code block is ONE unmarked run;
 *  - only a code block holds '\n' (anything else is split into lines);
 *  - list nesting is at most one deeper than the item above it (what the
 *    parser can express), and items nested under the same parent share the
 *    first one's kind (the parser joins them into one list);
 *  - numbered items count up from the first item of their list;
 *  - non-list blocks have ind 0; there is always at least one block.
 * Unchanged blocks keep their identity.
 */
export function normalizeDoc(doc: Doc): Doc {
    const out: Block[] = [];
    let changed = false;
    for (const b0 of doc) {
        let b = b0;
        if (b.type === 'code') {
            const t = blockText(b);
            const runsOk = t === '' ? b.runs.length === 0 : (b.runs.length === 1 && b.runs[0].m === 0);
            const langOk = b.lang === null || LANG_OK.test(b.lang);
            // Never quoted: the message parser reads a `> ` line holding a fence
            // as the fence (markdown.ts checks fences first), so a quoted code
            // block can't be sent faithfully.
            if (!runsOk || b.ind !== 0 || !langOk || b.q) {
                b = { ...b, q: false, ind: 0, lang: langOk ? b.lang : null, runs: runsOk ? b.runs : (t ? [{ t, m: 0 }] : []) };
            }
        } else {
            const runs = normRuns(b.runs);
            if (runs !== b.runs) b = { ...b, runs };
            if ((!isListType(b.type) && b.ind !== 0) || b.lang !== null) b = { ...b, ind: isListType(b.type) ? b.ind : 0, lang: null };
            if (runs.some(r => r.t.includes('\n'))) {
                // Split into lines: the first keeps the block's kind, the rest are
                // continuation lines (list items continue the list, others are paragraphs).
                const text = blockText(b);
                let at = 0;
                let first = true;
                for (const line of text.split('\n')) {
                    const lineRuns = sliceRuns(b.runs, at, at + line.length);
                    at += line.length + 1;
                    const t: BlockType = first || isListType(b.type) ? b.type : 'p';
                    out.push({ ...b, type: t, ind: isListType(t) ? b.ind : 0, runs: normRuns(lineRuns) });
                    first = false;
                }
                changed = true;
                continue;
            }
        }
        if (b !== b0) changed = true;
        out.push(b);
    }
    if (out.length === 0) { out.push(mkBlock('p')); changed = true; }

    // List structure (mirrors markdown.ts buildList): heads[d] = the kind of
    // the list open at depth d, counters[d] = its last number.
    let heads: BlockType[] = [];
    let counters: number[] = [];
    for (let i = 0; i < out.length; i++) {
        const b = out[i];
        if (!isListType(b.type)) { heads = []; counters = []; continue; }
        const prev = i > 0 ? out[i - 1] : null;
        const inList = prev !== null && isListType(prev.type) && prev.q === b.q;
        if (!inList) { heads = []; counters = []; }
        const maxInd = inList ? Math.min(prev!.ind + 1, MAX_LIST_INDENT) : 0;
        const ind = Math.max(0, Math.min(b.ind, maxInd));
        heads.length = Math.min(heads.length, ind + 1);
        counters.length = Math.min(counters.length, ind + 1);
        let type = b.type;
        let num: number;
        const startNum = type === 'ol' ? Math.max(0, Math.min(999_999_999, Math.floor(b.num) || 0)) : 1;
        if (heads[ind] !== undefined) {
            if (ind > 0) type = heads[ind];
            if (type === heads[ind]) {
                num = counters[ind] + 1;
            } else {
                // Switching between `-` and `1.` at the top level starts a new list.
                heads = [type];
                counters = [];
                num = type === 'ol' ? Math.max(0, Math.min(999_999_999, Math.floor(b.num) || 0)) : 1;
            }
        } else {
            heads[ind] = type;
            num = startNum;
        }
        counters[ind] = num;
        if (type === 'ul') num = 1;
        if (ind !== b.ind || type !== b.type || num !== b.num) {
            out[i] = { ...b, ind, type, num };
            changed = true;
        }
    }
    return changed ? out : doc;
}

// ── Edits ────────────────────────────────────────────────────────────────────

export interface EditResult { doc: Doc; sel: number }

function withRuns(b: Block, runs: readonly Run[]): Block {
    return { ...b, runs };
}

const runsText = (runs: readonly Run[]): string => runs.map(r => r.t).join('');

/**
 * Replace [from, to) with a fragment (a list of blocks). The fragment's first
 * block merges into the text before the range and its last into the text
 * after it; the line the range starts on keeps its kind (an empty plain line
 * takes the fragment's, so pasting a list into an empty box is a list).
 * Inside a code block everything is literal text. The caret lands after the
 * inserted content.
 */
export function replaceWithFragment(doc: Doc, from: number, to: number, frag: Doc): EditResult {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const A = locate(doc, a);
    const B = locate(doc, b);
    const first = doc[A.bi];
    const last = doc[B.bi];
    const headRuns = sliceRuns(first.runs, 0, A.off);
    const tailRuns = sliceRuns(last.runs, B.off, blockLen(last));
    const before = doc.slice(0, A.bi);
    const after = doc.slice(B.bi + 1);
    const asLiteral = (runs: readonly Run[]): Run[] => (runs.length ? [{ t: runsText(runs), m: 0 }] : []);

    const mid: Block[] = [];
    let caretBlock = 0;
    let caretOff = 0;
    if (first.type === 'code') {
        const ins = frag.map(blockText).join('\n');
        mid.push(withRuns(first, asLiteral([...headRuns, { t: ins, m: 0 }, ...tailRuns])));
        caretOff = A.off + ins.length;
    } else if (frag.length === 0 || (frag.length === 1 && frag[0].type !== 'code')) {
        const fr = frag.length ? frag[0].runs : [];
        const takeFrag = frag.length === 1 && headRuns.length === 0 && tailRuns.length === 0 && first.type === 'p' && frag[0].type !== 'p';
        const base = takeFrag ? { ...frag[0], q: frag[0].q || first.q } : first;
        // A code block's tail (deleting into one) is literal text.
        const tail = last.type === 'code' ? asLiteral(tailRuns) : tailRuns;
        mid.push(withRuns(base, [...headRuns, ...fr, ...tail]));
        caretOff = A.off + runsText(fr).length;
    } else {
        const f0 = frag[0];
        if (f0.type !== 'code') {
            const takeFrag = headRuns.length === 0 && first.type === 'p';
            mid.push(takeFrag ? { ...f0, q: f0.q || first.q } : withRuns(first, [...headRuns, ...f0.runs]));
        } else {
            if (headRuns.length) mid.push(withRuns(first, headRuns));
            mid.push({ ...f0, q: f0.q || first.q });
        }
        for (let i = 1; i < frag.length; i++) mid.push({ ...frag[i], q: frag[i].q || first.q });
        caretBlock = mid.length - 1;
        const L = mid[caretBlock];
        caretOff = blockLen(L);
        if (tailRuns.length) {
            if (L.type !== 'code' && last.type !== 'code') mid[caretBlock] = withRuns(L, [...L.runs, ...tailRuns]);
            else if (last.type === 'code') mid.push(withRuns(last, asLiteral(tailRuns)));
            else mid.push(withRuns(last, tailRuns));
        }
    }
    let sel = 0;
    for (const blk of before) sel += blockLen(blk) + 1;
    for (let i = 0; i < caretBlock; i++) sel += blockLen(mid[i]) + 1;
    sel += caretOff;
    const next = normalizeDoc([...before, ...mid, ...after]);
    return { doc: next, sel: Math.min(sel, docLen(next)) };
}

/** Insert literal text (may contain '\n') over [from, to) with the given marks. */
export function insertText(doc: Doc, from: number, to: number, text: string, marks = 0): EditResult {
    const t = text.replace(/\r\n?/g, '\n');
    const a = Math.min(from, to);
    const { bi } = locate(doc, a);
    const host = doc[bi];
    if (host.type === 'code' || !t.includes('\n')) {
        if (t.length === 0) return replaceWithFragment(doc, from, to, []);
        return replaceWithFragment(doc, from, to, [mkBlock('p', [{ t, m: host.type === 'code' ? 0 : marks }])]);
    }
    // Several lines: the first joins the line at the caret; the rest continue
    // it (a list continues the list, a quote the quote; anything else is a new
    // paragraph line).
    const lines = t.split('\n');
    const cont: Partial<Block> = isListType(host.type)
        ? { type: host.type, ind: host.ind, q: host.q }
        : { type: 'p', q: host.q };
    const frag: Block[] = lines.map((line, i) => (i === 0
        ? mkBlock('p', line ? [{ t: line, m: marks }] : [])
        : mkBlock(cont.type as BlockType, line ? [{ t: line, m: marks }] : [], { q: !!cont.q, ind: cont.ind ?? 0 })));
    // The first fragment line merges into the host, so its kind is irrelevant;
    // replaceWithFragment would give an EMPTY host the fragment's kind: keep the host's.
    const res = replaceWithFragment(doc, from, to, frag);
    return res;
}

export function deleteRange(doc: Doc, from: number, to: number): EditResult {
    if (from === to) return { doc, sel: from };
    return replaceWithFragment(doc, from, to, []);
}

/** The block indices [first, last] a range touches (a range ending at a line start does not include that line). */
export function blockSpan(doc: Doc, from: number, to: number): [number, number] {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const A = locate(doc, a);
    const B = locate(doc, b);
    let lastBi = B.bi;
    if (b > a && B.off === 0 && lastBi > A.bi) lastBi--;
    return [A.bi, lastBi];
}

// ── Marks ────────────────────────────────────────────────────────────────────

/**
 * Marks for text typed at `pos` with no stored marks: those of the character
 * before it on the same line (the one after it at a line start). Inline code
 * does not extend past its right edge (typing after `code` is plain again).
 */
export function marksAt(doc: Doc, pos: number): number {
    const { bi, off } = locate(doc, pos);
    const b = doc[bi];
    if (b.type === 'code' || blockLen(b) === 0) return 0;
    if (off > 0) {
        const left = marksOfChar(b, off - 1);
        const right = off < blockLen(b) ? marksOfChar(b, off) : -1;
        if (left & MARK.c && (right === -1 || !(right & MARK.c))) return left & ~MARK.c;
        return left;
    }
    return marksOfChar(b, 0) & ~MARK.c;
}

/** Marks every selected character has (code-block text has none). Collapsed: 0. */
/**
 * The size across [from, to): the one size every non-whitespace character
 * has (null = normal), or 'mixed'. Code-block text counts as normal.
 */
export function sizeInRange(doc: Doc, from: number, to: number): SpanSize | null | 'mixed' {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    let seen: SpanSize | null | undefined;
    let start = 0;
    for (const blk of doc) {
        const len = blockLen(blk);
        const x = Math.max(0, a - start);
        const y = Math.min(len, b - start);
        if (y > x) {
            for (const r of sliceRuns(blk.runs, x, y)) {
                if (r.t.trim() === '') continue;
                const sz = blk.type === 'code' ? null : sizeOfMarks(r.m);
                if (seen === undefined) seen = sz; else if (seen !== sz) return 'mixed';
            }
        }
        start += len + 1;
        if (start > b) break;
    }
    return seen ?? null;
}

/** Set the size of [from, to) (null = normal), leaving every other style alone. */
export function setSize(doc: Doc, from: number, to: number, size: SpanSize | null): Doc {
    const bit = sizeBit(size);
    return mapMarks(doc, from, to, m => (m & ~SIZE_MARKS) | bit);
}

export function commonMarks(doc: Doc, from: number, to: number): number {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    if (a === b) return 0;
    // Whitespace-only runs don't count (the space between two bold words),
    // unless the selection is nothing but whitespace.
    let acc = ALL_MARKS;
    let accWs = ALL_MARKS;
    let any = false;
    let anyWs = false;
    const [b0, b1] = blockSpan(doc, a, b);
    let start = blockStart(doc, b0);
    for (let bi = b0; bi <= b1; bi++) {
        const blk = doc[bi];
        const len = blockLen(blk);
        const x = Math.max(0, a - start);
        const y = Math.min(len, b - start);
        if (y > x) {
            if (blk.type === 'code') return 0;
            for (const r of sliceRuns(blk.runs, x, y)) {
                if (r.t.trim() === '') { accWs &= r.m; anyWs = true; continue; }
                acc &= r.m;
                any = true;
            }
        }
        start += len + 1;
    }
    return any ? acc : anyWs ? accWs : 0;
}

/**
 * Toggle a mark over [from, to): add it everywhere unless every selected
 * character already has it, then remove it. Whitespace at the edges of the
 * selection is left out (a bold space renders as nothing on the wire), and
 * code-block text never takes inline marks.
 */
export function toggleMark(doc: Doc, from: number, to: number, bit: number): EditResult & { on: boolean } {
    let a = Math.min(from, to);
    let b = Math.max(from, to);
    const plain = plainText(doc);
    while (a < b && /\s/.test(plain[a])) a++;
    while (b > a && /\s/.test(plain[b - 1])) b--;
    if (a >= b) return { doc, sel: Math.max(from, to), on: false };
    const has = (commonMarks(doc, a, b) & bit) === bit;
    const on = !has;
    const [b0, b1] = blockSpan(doc, a, b);
    const next = doc.slice();
    let start = blockStart(doc, b0);
    for (let bi = b0; bi <= b1; bi++) {
        const blk = doc[bi];
        const len = blockLen(blk);
        const x = Math.max(0, a - start);
        const y = Math.min(len, b - start);
        if (y > x && blk.type !== 'code') {
            next[bi] = withRuns(blk, mapRunMarks(blk.runs, x, y, m => (on ? m | bit : m & ~bit)));
        }
        start += len + 1;
    }
    return { doc: normalizeDoc(next), sel: Math.max(from, to), on };
}

/** Set marks over [from, to) to exactly `fn(old)`. */
export function mapMarks(doc: Doc, from: number, to: number, fn: (m: number) => number): Doc {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    if (a === b) return doc;
    const [b0, b1] = blockSpan(doc, a, b);
    const next = doc.slice();
    let start = blockStart(doc, b0);
    for (let bi = b0; bi <= b1; bi++) {
        const blk = doc[bi];
        const len = blockLen(blk);
        const x = Math.max(0, a - start);
        const y = Math.min(len, b - start);
        if (y > x && blk.type !== 'code') next[bi] = withRuns(blk, mapRunMarks(blk.runs, x, y, m => fn(m)));
        start += len + 1;
    }
    return normalizeDoc(next);
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function mapBlocks(doc: Doc, b0: number, b1: number, fn: (b: Block, i: number) => Block | Block[]): Doc {
    const out: Block[] = [];
    for (let i = 0; i < doc.length; i++) {
        if (i < b0 || i > b1) { out.push(doc[i]); continue; }
        const r = fn(doc[i], i);
        if (Array.isArray(r)) out.push(...r); else out.push(r);
    }
    return normalizeDoc(out);
}

/** A code block as plain paragraph lines (marks gone, quote kept). */
function codeToLines(b: Block): Block[] {
    const text = blockText(b);
    return text.split('\n').map(line => mkBlock('p', line ? [{ t: line, m: 0 }] : [], { q: b.q }));
}

export type BlockAction = 'bullet' | 'number' | 'quote' | 'heading' | 'codeBlock';

/**
 * A line-level toolbar action on every line the selection touches:
 *  - bullet / number: toggle that list (switching kinds replaces the other);
 *  - quote: toggle the quote;
 *  - heading: cycle H1 -> H2 -> H3 -> normal (on the first line's level);
 *  - codeBlock: turn the lines into one code block, or a code block back into lines.
 * The flat selection is preserved where the text did not move.
 */
export function applyBlockAction(doc: Doc, from: number, to: number, action: BlockAction): EditResult & { selEnd: number } {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const [b0, b1] = blockSpan(doc, a, b);
    const blocks = doc.slice(b0, b1 + 1);
    if (action === 'codeBlock') return toggleCodeBlockAction(doc, a, b);
    let next: Doc;
    if (action === 'quote') {
        const all = blocks.every(x => x.q);
        next = mapBlocks(doc, b0, b1, x => ({ ...x, q: !all }));
    } else if (action === 'heading') {
        const firstLevel = blocks[0].type === 'h1' ? 1 : blocks[0].type === 'h2' ? 2 : blocks[0].type === 'h3' ? 3 : 0;
        const nextType: BlockType = firstLevel === 0 ? 'h1' : firstLevel === 1 ? 'h2' : firstLevel === 2 ? 'h3' : 'p';
        next = mapBlocks(doc, b0, b1, x => (x.type === 'code' ? codeToLines(x).map(l => ({ ...l, type: nextType })) : { ...x, type: nextType, ind: 0 }));
    } else {
        const type: BlockType = action === 'bullet' ? 'ul' : 'ol';
        const nonEmpty = blocks.filter(x => blockLen(x) > 0 || blocks.length === 1);
        const all = nonEmpty.length > 0 && nonEmpty.every(x => x.type === type);
        next = mapBlocks(doc, b0, b1, x => {
            if (x.type === 'code') return codeToLines(x).map(l => (all ? l : { ...l, type }));
            if (all) return { ...x, type: 'p', ind: 0 };
            if (blockLen(x) === 0 && blocks.length > 1) return x;
            return { ...x, type, ind: isListType(x.type) ? x.ind : 0, num: 1 };
        });
    }
    // Code blocks may have become several lines: keep the caret at the same text.
    return { doc: next, sel: Math.min(a, docLen(next)), selEnd: Math.min(b, docLen(next)) };
}

function toggleCodeBlockAction(doc: Doc, a: number, b: number): EditResult & { selEnd: number } {
    const [b0, b1] = blockSpan(doc, a, b);
    const blocks = doc.slice(b0, b1 + 1);
    if (blocks.every(x => x.type === 'code')) {
        const next = mapBlocks(doc, b0, b1, x => codeToLines(x));
        return { doc: next, sel: a, selEnd: Math.min(b, docLen(next)) };
    }
    const A = locate(doc, a);
    const B = locate(doc, b);
    const first = doc[A.bi];
    // A selection inside one line (not the whole line): split it out into its own block.
    if (A.bi === B.bi && b > a && first.type !== 'code' && !(A.off === 0 && B.off === blockLen(first))) {
        const head = sliceRuns(first.runs, 0, A.off);
        const sel = blockText(first).slice(A.off, B.off);
        const tail = sliceRuns(first.runs, B.off, blockLen(first));
        const parts: Block[] = [];
        if (head.length) parts.push(withRuns(first, head));
        parts.push(mkBlock('code', [{ t: sel, m: 0 }], { q: first.q }));
        if (tail.length) parts.push(withRuns(first, tail));
        const next = normalizeDoc([...doc.slice(0, A.bi), ...parts, ...doc.slice(A.bi + 1)]);
        const codeStart = blockStart(doc, A.bi) + (head.length ? A.off + 1 : 0);
        return { doc: next, sel: codeStart, selEnd: codeStart + sel.length };
    }
    const text = blocks.map(blockText).join('\n');
    const code = mkBlock('code', text ? [{ t: text, m: 0 }] : [], { q: blocks[0].q });
    const next = normalizeDoc([...doc.slice(0, b0), code, ...doc.slice(b1 + 1)]);
    const start = blockStart(doc, b0);
    return { doc: next, sel: Math.max(start, a), selEnd: Math.min(start + text.length, b) };
}

/** Tab / Shift+Tab on list lines: nest or un-nest. Null when no list line is selected. */
export function indentLists(doc: Doc, from: number, to: number, delta: 1 | -1): Doc | null {
    const [b0, b1] = blockSpan(doc, from, to);
    let any = false;
    const next = mapBlocks(doc, b0, b1, x => {
        if (!isListType(x.type)) return x;
        any = true;
        return { ...x, ind: Math.max(0, Math.min(MAX_LIST_INDENT, x.ind + delta)) };
    });
    return any ? next : null;
}

/**
 * Shift+Enter (the composer's "new line" key), at a collapsed caret:
 *  - list item with text: break the line and start the next item (numbers count up);
 *  - EMPTY list item: end the list (the line becomes a normal line);
 *  - quote line: the next line is quoted too; an empty quote line ends the quote;
 *  - code block: a line break inside it; on an empty last line, leave the block;
 *  - heading: the new line is a normal line;
 *  - otherwise a plain new line.
 */
export function newlineAt(doc: Doc, pos: number): EditResult & { kind: 'continue' | 'exit' | 'newline' } {
    const { bi, off } = locate(doc, pos);
    const b = doc[bi];
    const len = blockLen(b);
    if (b.type === 'code') {
        const text = blockText(b);
        if (len === 0) {
            // Shift+Enter in an empty code block: there is nothing to keep, so it goes.
            const next = normalizeDoc([...doc.slice(0, bi), mkBlock('p', [], { q: b.q }), ...doc.slice(bi + 1)]);
            return { doc: next, sel: pos, kind: 'exit' };
        }
        if (off === len && text.endsWith('\n')) {
            const trimmed = text.slice(0, -1);
            const next = normalizeDoc([...doc.slice(0, bi), withRuns(b, trimmed ? [{ t: trimmed, m: 0 }] : []), mkBlock('p', [], { q: b.q }), ...doc.slice(bi + 1)]);
            return { doc: next, sel: blockStart(doc, bi) + trimmed.length + 1, kind: 'exit' };
        }
        const r = insertText(doc, pos, pos, '\n');
        return { ...r, kind: 'newline' };
    }
    if (len === 0 && (isListType(b.type) || (b.q && b.type === 'p'))) {
        const exited: Block = isListType(b.type)
            ? (b.ind > 0 ? { ...b, ind: b.ind - 1 } : { ...b, type: 'p', ind: 0 })
            : { ...b, q: false };
        const next = normalizeDoc([...doc.slice(0, bi), exited, ...doc.slice(bi + 1)]);
        return { doc: next, sel: pos, kind: 'exit' };
    }
    const head = sliceRuns(b.runs, 0, off);
    const tail = sliceRuns(b.runs, off, len);
    const nextType: BlockType = isListType(b.type) ? b.type : 'p';
    const second: Block = { ...b, type: nextType, ind: isListType(nextType) ? b.ind : 0, num: b.num + 1, runs: tail };
    const firstBlk = withRuns(b, head);
    const next = normalizeDoc([...doc.slice(0, bi), firstBlk, second, ...doc.slice(bi + 1)]);
    return { doc: next, sel: blockStart(doc, bi) + off + 1, kind: isListType(b.type) || b.q ? 'continue' : 'newline' };
}

/** Change one block's kind/attributes (keeping its text), e.g. for a typed shortcut. */
export function setBlock(doc: Doc, bi: number, patch: Partial<Block>): Doc {
    return normalizeDoc(doc.map((b, i) => (i === bi ? { ...b, ...patch } : b)));
}

// ── Comparison ───────────────────────────────────────────────────────────────

export function runsEqual(a: readonly Run[], b: readonly Run[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i].t !== b[i].t || a[i].m !== b[i].m) return false;
    return true;
}

export function blocksEqual(a: Block, b: Block): boolean {
    return a.type === b.type && a.q === b.q && a.ind === b.ind
        && (a.type !== 'ol' || a.num === b.num)
        && (a.type !== 'code' || a.lang === b.lang)
        && runsEqual(normRuns(a.runs), normRuns(b.runs));
}

export function docsEqual(a: Doc, b: Doc): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!blocksEqual(a[i], b[i])) return false;
    return true;
}

export { sameBlockShape };
