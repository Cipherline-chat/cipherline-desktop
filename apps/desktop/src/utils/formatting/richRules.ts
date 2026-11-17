/**
 * Typed Markdown shortcuts in the WYSIWYG composer, the way Slack and Notion
 * do them: the characters go in literally as typed, and the moment the
 * CLOSING marker is followed by a space or punctuation the span converts —
 * `**bold**` + space becomes bold "bold" and the markers disappear. A line
 * that starts `- ` / `* ` becomes a bullet, `1. ` a numbered item, `> ` a
 * quote, and ```` ``` ```` (optionally with a language) + Enter a code block.
 *
 * NOT here, on purpose: `# ` never becomes a heading. `#` is the channel
 * mention trigger (owner, 2026-11-16: "I don't think the heading should be a
 * # because that is used for channels"); headings come only from the
 * toolbar's H button.
 *
 * The editor applies a conversion as its own undo step on top of the literal
 * text, so Ctrl+Z right after it brings the typed markers back.
 */
import {
    MARK, blockLen, blockStart, blockText, locate, marksOfChar, mapMarks, normalizeDoc, sliceRuns,
    type Block, type Doc,
} from './richDoc';

export interface RuleResult {
    doc: Doc;
    /** Caret after the conversion (before the trigger character is typed). */
    sel: number;
    /** Marks the trigger character (and what follows) should be typed with. */
    marks: number;
}

/** Characters that complete an inline shortcut. */
export function isInlineTrigger(ch: string): boolean {
    return /^[\s.,;:!?)\]}"'’”]$/u.test(ch);
}

interface InlineSpec { open: string; close: string; bits: number; word?: boolean }

// Longest first: `***` before `**` before `*`.
const INLINE: readonly InlineSpec[] = [
    { open: '***', close: '***', bits: MARK.b | MARK.i },
    { open: '___', close: '___', bits: MARK.u | MARK.i, word: true },
    { open: '**', close: '**', bits: MARK.b },
    { open: '__', close: '__', bits: MARK.u },
    { open: '~~', close: '~~', bits: MARK.s },
    { open: '||', close: '||', bits: MARK.sp },
    { open: '*', close: '*', bits: MARK.i },
    { open: '_', close: '_', bits: MARK.i, word: true },
    { open: '`', close: '`', bits: MARK.c },
];

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/**
 * The inline shortcut that ends right at the caret, if any. `text` is the
 * line's text, `caret` the offset in it; the closing marker must end at the
 * caret. Returns the opener's offset and the spec.
 */
export function findInlineShortcut(b: Block, caret: number): { start: number; spec: InlineSpec } | null {
    if (b.type === 'code' || caret < 3) return null;
    const text = blockText(b).slice(0, caret);
    for (const spec of INLINE) {
        const { open, close } = spec;
        if (!text.endsWith(close)) continue;
        const ch = close[0];
        const closeAt = text.length - close.length;
        // The closer must be exactly this run of marker characters.
        if (text[closeAt - 1] === ch) continue;
        if (text[closeAt - 1] === '\\') continue;
        const before = text[closeAt - 1];
        if (spec.bits !== MARK.c && isSpace(before)) continue;
        // The nearest opener before it.
        let openAt = text.lastIndexOf(open, closeAt - 1);
        while (openAt >= 0 && openAt + open.length > closeAt - 1) openAt = text.lastIndexOf(open, openAt - 1);
        if (openAt < 0) continue;
        if (text[openAt - 1] === ch || text[openAt + open.length] === ch) continue;
        if (text[openAt - 1] === '\\') continue;
        const content = text.slice(openAt + open.length, closeAt);
        if (content.length === 0 || content.includes(open)) continue;
        if (spec.bits !== MARK.c && isSpace(content[0])) continue;
        if (spec.word && isWord(text[openAt - 1])) continue;
        // Nothing inside inline code converts, and the markers must be plain typed text.
        let codeHit = false;
        for (let k = openAt; k < closeAt + close.length; k++) if (marksOfChar(b, k) & MARK.c) { codeHit = true; break; }
        if (codeHit) continue;
        // `**` contains `*`: a single `*` must not be the tail of a `**` closer.
        return { start: openAt, spec };
    }
    return null;
}

/**
 * Apply the inline shortcut ending at the caret (`pos`, flat): delete both
 * markers and add the style to the text between them.
 */
export function applyInlineShortcut(doc: Doc, pos: number): RuleResult | null {
    const { bi, off } = locate(doc, pos);
    const b = doc[bi];
    const hit = findInlineShortcut(b, off);
    if (!hit) return null;
    const { start, spec } = hit;
    const base = blockStart(doc, bi);
    const contentStart = start + spec.open.length;
    const closeAt = off - spec.close.length;
    // What follows is typed in the style AROUND the span: the character before
    // the opener — or, at a line start, the opener's own (so an armed text
    // size survives the conversion) without the style just applied.
    const outside = (start > 0 ? marksOfChar(b, start - 1) : marksOfChar(b, start) & ~spec.bits) & ~MARK.c;
    // Remove the closer, then the opener; style the content.
    let runs = [...sliceRuns(b.runs, 0, start), ...sliceRuns(b.runs, contentStart, closeAt), ...sliceRuns(b.runs, off, blockLen(b))];
    const next = doc.slice();
    next[bi] = { ...b, runs };
    const contentLen = closeAt - contentStart;
    let d = normalizeDoc(next);
    d = mapMarks(d, base + start, base + start + contentLen, m => m | spec.bits);
    runs = [];
    return { doc: d, sel: base + start + contentLen, marks: outside };
}

/**
 * A line-start shortcut completed by a typed SPACE at `pos`: `-`/`*` ->
 * bullet, `1.` -> numbered item (keeps its number), `>` -> quote. Only on a
 * plain paragraph line, only when the caret sits right after the marker at
 * the start of the line. `#` is deliberately absent.
 */
export function applyBlockShortcut(doc: Doc, pos: number): RuleResult | null {
    const { bi, off } = locate(doc, pos);
    const b = doc[bi];
    if (b.type !== 'p') return null;
    const head = blockText(b).slice(0, off);
    let patch: Partial<Block> | null = null;
    if (head === '-' || head === '*') patch = { type: 'ul', ind: 0 };
    else if (/^\d{1,9}\.$/.test(head)) patch = { type: 'ol', ind: 0, num: parseInt(head, 10) };
    else if (head === '>' && !b.q) patch = { q: true };
    if (!patch) return null;
    // The marker characters must be plain (not inside inline code).
    for (let k = 0; k < off; k++) if (marksOfChar(b, k) & MARK.c) return null;
    const next = doc.slice();
    next[bi] = { ...b, ...patch, runs: sliceRuns(b.runs, off, blockLen(b)) };
    const base = blockStart(doc, bi);
    // The text that follows keeps the style the marker was typed in (an armed size).
    return { doc: normalizeDoc(next), sel: base, marks: marksOfChar(b, 0) & ~MARK.c };
}

const FENCE_LINE = /^```([A-Za-z0-9_+\-.#]{0,32})$/;

/**
 * ```` ``` ```` (or ```` ```js ````) alone on a line + Enter / Shift+Enter:
 * the line becomes an empty code block with the caret inside.
 */
export function applyFenceShortcut(doc: Doc, pos: number): RuleResult | null {
    const { bi, off } = locate(doc, pos);
    const b = doc[bi];
    if (b.type === 'code' || off !== blockLen(b)) return null;
    const m = FENCE_LINE.exec(blockText(b));
    if (!m) return null;
    for (let k = 0; k < off; k++) if (marksOfChar(b, k) & MARK.c) return null;
    const next = doc.slice();
    next[bi] = { type: 'code', q: b.q, ind: 0, num: 1, lang: m[1] || null, runs: [] };
    return { doc: normalizeDoc(next), sel: blockStart(doc, bi), marks: 0 };
}
