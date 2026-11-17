/**
 * The message composer's text box: WYSIWYG, so formatting shows as
 * formatting while you type (owner, 2026-11-16: "instead of me clicking bold
 * and it changing it to have **test** I want it to just bold the text").
 *
 * ## How it works
 * An in-house contenteditable whose DOM is a PROJECTION of a small document
 * model (utils/formatting/richDoc.ts): lines of styled text runs. The browser
 * never edits the DOM on its own except during IME composition — every
 * `beforeinput` is cancelled and applied to the model, and the touched lines
 * are re-rendered (utils … richDom.ts). Composition is let through and
 * reconciled from the DOM when it ends, so IMEs, dead keys and the emoji
 * panel work. What leaves the box is the model serialised to the same
 * Discord-style text the parser already reads (richWire.ts), verified by a
 * round trip; `value` / `onChange` speak that text, so drafts, edits,
 * mentions and sending keep working on strings.
 *
 * ## Why in-house rather than Lexical / ProseMirror
 * See docs/worklog/entries/2026-11-16-composer-wysiwyg.md: no new dependency
 * (and no shared-install surgery), ~30 KB of source instead of 100+ KB of
 * framework, and one grammar — the message parser itself decides what the box
 * shows.
 *
 * ## Safety
 * Nothing is ever written with innerHTML; a paste is read as text/plain only
 * (HTML on the clipboard is ignored), so pasted markup or styles can't get in.
 * Nothing here talks to the network.
 */
import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import {
    MARK, SIZE_MARKS, applyBlockAction, setSize, sizeBit, sizeInRange, sizeOfMarks, type SpanSize, blockLen, blockStart, blockText, commonMarks, deleteRange, docLen,
    indentLists, insertText, isDocEmpty, isListType, locate, marksAt, newlineAt, normalizeDoc,
    plainText, replaceWithFragment, setBlock, toggleMark, mkBlock,
    type Block, type BlockType, type Doc,
} from '../../utils/formatting/richDoc';
import { docFromWire, wireFromDoc } from '../../utils/formatting/richWire';
import { applyBlockShortcut, applyFenceShortcut, applyInlineShortcut, isInlineTrigger, type RuleResult } from '../../utils/formatting/richRules';
import { insertLink, type FormatAction } from '../../utils/formatting/composerFormat';
import { buildBlock, offsetInLine, patchBlock, pointInLine } from './richDom';
import '../../styles/formatting.css';
import '../../styles/rich-composer.css';

/** What is active at the caret / across the selection, for the toolbar's pressed states. */
export interface ActiveFormats {
    marks: number;
    block: BlockType;
    quote: boolean;
    /** Text size at the caret / across the selection (null = normal), or 'mixed'. */
    size?: SpanSize | null | 'mixed';
}

export interface RichComposerHandle {
    readonly element: HTMLDivElement | null;
    focus(): void;
    /** The box's plain text (formatting characters are literal text only). */
    getPlain(): string;
    /** Selection as flat plain-text offsets. */
    getSelection(): { start: number; end: number };
    setSelection(start: number, end?: number): void;
    /** Replace a plain-text range with literal text, as one undoable step; caret after it. */
    replaceRange(start: number, end: number, text: string): void;
    /** Type literal text over the selection (emoji picker). */
    insertAtSelection(text: string): void;
    placeCaretAtEnd(opts?: { focus?: boolean }): void;
    applyFormat(action: FormatAction): void;
    /** Text size for the selection, or (nothing selected) for what is typed next. null = normal. */
    applySize(size: SpanSize | null): void;
    /** Shift+Enter: continue / end a list, quote or code block, else a new line. */
    newline(): void;
    /** Enter on a ``` line: start a code block instead of sending. */
    enterShortcut(): boolean;
    /** A shortcut typed up to the caret but not finished with a space (`**bold**` then Enter). */
    commitPending(): boolean;
    /** Caret inside inline code or a code block (suggestion menus stay closed there). */
    caretInCode(): boolean;
    /** Replace a plain-text range with formatted content parsed from message text (paste prompt). */
    replaceWithWire(start: number, end: number, wire: string): void;
    /** Replace a plain-text range with a code block holding exactly that text (code paste prompt). */
    replaceWithCodeBlock(start: number, end: number, lang: string | null): void;
    isComposing(): boolean;
}

export interface RichComposerProps {
    /** Message text (display form: `@name`, `:emoji:`). */
    value: string;
    onChange: (value: string, info: { plain: string; caret: number }) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    /** Return true to take the paste over (files); text is then not inserted. */
    onPaste?: (e: React.ClipboardEvent<HTMLDivElement>, text: string) => boolean;
    /** After a text paste went in: where (plain offset) and exactly what. */
    onPasted?: (start: number, inserted: string, original: string) => void;
    onFormats?: (f: ActiveFormats) => void;
    /** The box's element once mounted (null on unmount), e.g. for menus to anchor to. */
    onElement?: (el: HTMLDivElement | null) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
    /** Cap on the serialised text; typing / pasting past it is cut. */
    maxLength?: number;
    className?: string;
    style?: React.CSSProperties;
    fontFamily?: string;
    /** Message size scale (1 = normal). */
    scale?: number;
    dataFont?: string;
    dataSize?: string;
    autoFocus?: boolean;
    ariaLabel?: string;
}

interface Snapshot { doc: Doc; a: number; f: number }
type HistoryKind = 'type' | 'push' | 'none';

const HISTORY_MAX = 300;
const COALESCE_MS = 900;
const MARK_FOR: Partial<Record<FormatAction, number>> = {
    bold: MARK.b, italic: MARK.i, underline: MARK.u, strike: MARK.s, spoiler: MARK.sp, code: MARK.c,
};

/** Text of the selection for the clipboard: plain, list items as "• " / "1. ". */
function clipboardText(doc: Doc, a: number, b: number): string {
    const out: string[] = [];
    let start = 0;
    for (const blk of doc) {
        const len = blockLen(blk);
        const end = start + len;
        if (start > b) break;
        if (end >= a) {
            const x = Math.max(0, a - start);
            const y = Math.min(len, b - start);
            const marker = blk.type === 'ul' ? '• ' : blk.type === 'ol' ? `${blk.num}. ` : '';
            const prefix = x === 0 && y > 0 && marker ? `${'  '.repeat(blk.ind)}${marker}` : '';
            out.push(prefix + blockText(blk).slice(x, y));
        }
        start = end + 1;
    }
    return out.join('\n');
}

export const RichComposer = React.forwardRef<RichComposerHandle, RichComposerProps>(function RichComposer(props, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const docRef = useRef<Doc>(docFromWire(props.value));
    const selRef = useRef<{ a: number; f: number }>({ a: 0, f: 0 });
    const lastValueRef = useRef<string>(props.value);
    const cacheRef = useRef(new WeakMap<Block, HTMLElement>());
    const renderedRef = useRef<Doc>([]);
    const pastRef = useRef<Snapshot[]>([]);
    const futureRef = useRef<Snapshot[]>([]);
    const lastKindRef = useRef<{ kind: HistoryKind; at: number; pos: number } | null>(null);
    /** Marks for the next typed character (toolbar on an empty selection, or "keep typing in bold"). */
    const typingMarksRef = useRef<number | null>(null);
    /** Where the caret is expected after our own edit; any other selection drops typingMarks. */
    const expectSelRef = useRef<number | null>(null);
    const composingRef = useRef(false);
    const renderingRef = useRef(false);
    const propsRef = useRef(props);
    propsRef.current = props;

    // ── Rendering ────────────────────────────────────────────────────────────

    const render = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        renderingRef.current = true;
        const doc = docRef.current;
        const prev = renderedRef.current;
        const cache = cacheRef.current;
        const els: HTMLElement[] = [];
        const used = new Set<HTMLElement>();
        for (let i = 0; i < doc.length; i++) {
            const b = doc[i];
            let el = cache.get(b);
            if (el && used.has(el)) el = undefined;
            if (!el && prev.length === doc.length && prev[i] !== b && !doc.includes(prev[i])) {
                // Same line, new text: patch the old element in place.
                const old = cache.get(prev[i]);
                if (old && !used.has(old) && old.parentNode === root && patchBlock(old, prev[i], b)) {
                    el = old;
                    cache.delete(prev[i]);
                }
            }
            if (!el) el = buildBlock(b);
            cache.set(b, el);
            used.add(el);
            els.push(el);
        }
        let child: ChildNode | null = root.firstChild;
        for (const el of els) {
            if (child === el) { child = child.nextSibling; continue; }
            root.insertBefore(el, child);
        }
        while (child) {
            const next: ChildNode | null = child.nextSibling;
            root.removeChild(child);
            child = next;
        }
        // Quote grouping (rounded ends) depends on the neighbours.
        for (let i = 0; i < doc.length; i++) {
            const q = doc[i].q;
            els[i].classList.toggle('rc-qs', q && !(i > 0 && doc[i - 1].q));
            els[i].classList.toggle('rc-qe', q && !(i + 1 < doc.length && doc[i + 1].q));
            els[i].classList.toggle('rc-cs', doc[i].type === 'code' && !(i > 0 && doc[i - 1].type === 'code'));
        }
        const empty = isDocEmpty(doc) && doc[0].type === 'p' && !doc[0].q;
        if (empty) root.setAttribute('data-empty', ''); else root.removeAttribute('data-empty');
        renderedRef.current = doc;
        renderingRef.current = false;
    }, []);

    const pointFor = useCallback((pos: number): [Node, number] => {
        const root = rootRef.current!;
        const doc = docRef.current;
        const { bi, off } = locate(doc, pos);
        const el = root.children[bi] as HTMLElement | undefined;
        if (!el) return [root, 0];
        return pointInLine(el, doc[bi], off);
    }, []);

    const flatFor = useCallback((node: Node, offset: number): number | null => {
        const root = rootRef.current;
        if (!root) return null;
        if (node === root) {
            const kids = root.childNodes;
            if (offset >= kids.length) return docLen(docRef.current);
            return blockStart(docRef.current, offset);
        }
        let line: Node | null = node;
        while (line && line.parentNode !== root) line = line.parentNode;
        if (!line) return null;
        const bi = Array.prototype.indexOf.call(root.childNodes, line) as number;
        if (bi < 0) return null;
        const doc = docRef.current;
        const off = offsetInLine(line, node, offset);
        if (bi >= doc.length) return docLen(doc);
        return blockStart(doc, bi) + Math.min(off, blockLen(doc[bi]));
    }, []);

    const isFocused = () => {
        const root = rootRef.current;
        return !!root && typeof document !== 'undefined' && document.activeElement === root;
    };

    const applyDomSelection = useCallback(() => {
        const root = rootRef.current;
        if (!root || !isFocused()) return;
        const sel = document.getSelection();
        if (!sel) return;
        const [an, ao] = pointFor(selRef.current.a);
        const [fn, fo] = pointFor(selRef.current.f);
        renderingRef.current = true;
        try { sel.setBaseAndExtent(an, ao, fn, fo); } catch { /* detached during a re-render */ }
        renderingRef.current = false;
        // Keep the caret in view (we cancelled the browser's own edit, so it won't).
        const rng = sel.rangeCount ? sel.getRangeAt(0) : null;
        const rect = rng && typeof rng.getBoundingClientRect === 'function' ? rng.getBoundingClientRect() : null;
        if (rect && (rect.top || rect.bottom)) {
            const box = root.getBoundingClientRect();
            if (rect.bottom > box.bottom) root.scrollTop += rect.bottom - box.bottom + 2;
            else if (rect.top < box.top) root.scrollTop -= box.top - rect.top + 2;
        }
    }, [pointFor]);

    const readDomSelection = useCallback((): boolean => {
        const root = rootRef.current;
        if (!root || typeof document === 'undefined') return false;
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) return false;
        const a = flatFor(sel.anchorNode, sel.anchorOffset);
        const f = sel.focusNode && root.contains(sel.focusNode) ? flatFor(sel.focusNode, sel.focusOffset) : a;
        if (a === null || f === null) return false;
        selRef.current = { a, f };
        return true;
    }, [flatFor]);

    const formats = useCallback((): ActiveFormats => {
        const doc = docRef.current;
        const { a, f } = selRef.current;
        const s = Math.min(a, f);
        const e = Math.max(a, f);
        const { bi } = locate(doc, s);
        const blk = doc[bi];
        const marks = s === e ? (typingMarksRef.current ?? marksAt(doc, s)) : commonMarks(doc, s, e);
        const size = blk.type === 'code' && s === e ? null : s === e ? sizeOfMarks(marks) : sizeInRange(doc, s, e);
        return { marks: blk.type === 'code' ? 0 : marks, block: blk.type, quote: blk.q, size };
    }, []);

    const formatsRaf = useRef(0);
    const notifyFormats = useCallback(() => {
        const cb = propsRef.current.onFormats;
        if (!cb) return;
        if (typeof requestAnimationFrame !== 'function') { cb(formats()); return; }
        cancelAnimationFrame(formatsRaf.current);
        formatsRaf.current = requestAnimationFrame(() => cb(formats()));
    }, [formats]);

    // ── Committing edits ─────────────────────────────────────────────────────

    const emit = useCallback(() => {
        const doc = docRef.current;
        const value = wireFromDoc(doc);
        lastValueRef.current = value;
        const caret = Math.max(selRef.current.a, selRef.current.f);
        propsRef.current.onChange(value, { plain: plainText(doc), caret });
    }, []);

    const pushHistory = useCallback((kind: HistoryKind, pos: number) => {
        if (kind === 'none') return;
        const now = Date.now();
        const last = lastKindRef.current;
        const coalesce = kind === 'type' && last?.kind === 'type' && now - last.at < COALESCE_MS && last.pos === selRef.current.a;
        if (!coalesce) {
            pastRef.current.push({ doc: docRef.current, a: selRef.current.a, f: selRef.current.f });
            if (pastRef.current.length > HISTORY_MAX) pastRef.current.shift();
        }
        futureRef.current = [];
        lastKindRef.current = { kind, at: now, pos };
    }, []);

    const commit = useCallback((doc: Doc, a: number, f: number = a, kind: HistoryKind = 'push') => {
        if (doc !== docRef.current) pushHistory(kind, a);
        else if (kind !== 'type') lastKindRef.current = null;
        // Anything but plain typing (a selection replaced or deleted, a paste,
        // a block change, a picked suggestion…) ends a pending style: the
        // selectionchange that would drop it can arrive after the edit (Ctrl+A
        // then Backspace), and must not leave bold armed for the next words.
        // Callers that keep one (typing, a converted shortcut) set it again.
        if (kind !== 'type') typingMarksRef.current = null;
        docRef.current = doc;
        selRef.current = { a, f };
        expectSelRef.current = a === f ? a : null;
        render();
        applyDomSelection();
        emit();
        notifyFormats();
    }, [pushHistory, render, applyDomSelection, emit, notifyFormats]);

    /** A new doc from an insertion, cut to maxLength (or null when nothing fits). */
    const fitInsert = useCallback((from: number, to: number, text: string, marks: number): { doc: Doc; sel: number; text: string } | null => {
        const max = propsRef.current.maxLength;
        let t = text;
        let r = insertText(docRef.current, from, to, t, marks);
        if (!max) return { ...r, text: t };
        const before = lastValueRef.current.length;
        for (let tries = 0; tries < 4; tries++) {
            const len = wireFromDoc(r.doc).length;
            if (len <= max || len <= before) return { ...r, text: t };
            const cut = Math.max(0, t.length - (len - max));
            if (cut === 0) return null;
            t = t.slice(0, cut);
            r = insertText(docRef.current, from, to, t, marks);
        }
        return null;
    }, []);

    const currentSel = () => {
        const { a, f } = selRef.current;
        return { s: Math.min(a, f), e: Math.max(a, f) };
    };

    /** Apply a typed shortcut on top of the literal text, as its own undo step. */
    const applyRule = useCallback((res: RuleResult, then?: string) => {
        let doc = res.doc;
        let sel = res.sel;
        if (then) {
            const r = insertText(doc, sel, sel, then, res.marks);
            doc = r.doc;
            sel = r.sel;
        }
        typingMarksRef.current = res.marks;
        commit(doc, sel, sel, 'push');
        typingMarksRef.current = res.marks;
        lastKindRef.current = null;
    }, [commit]);

    const typeText = useCallback((text: string) => {
        const { s, e } = currentSel();
        const doc0 = docRef.current;
        if (s !== e) {
            // Typing over a selection keeps the selected text's style.
            const r = fitInsert(s, e, text, commonMarks(doc0, s, e));
            if (r) commit(r.doc, r.sel, r.sel, 'push');
            return;
        }
        const marks = typingMarksRef.current ?? marksAt(doc0, s);
        if (text.length === 1) {
            // Typed shortcuts: the literal character goes in first as its own
            // undo step, then the conversion — so Ctrl+Z brings the markers back.
            const blockRule = text === ' ' ? applyBlockShortcut(doc0, s) : null;
            const inlineRule = !blockRule && isInlineTrigger(text) ? applyInlineShortcut(doc0, s) : null;
            const rule = blockRule ?? inlineRule;
            if (rule) {
                const lit = fitInsert(s, s, text, marks);
                if (!lit) return;
                commit(lit.doc, lit.sel, lit.sel, 'push');
                // A line shortcut eats its space; an inline one keeps the trigger character.
                applyRule(rule, blockRule ? undefined : text);
                return;
            }
        }
        const r = fitInsert(s, s, text, marks);
        if (!r) return;
        const keep = typingMarksRef.current;
        commit(r.doc, r.sel, r.sel, 'type');
        if (keep !== null) typingMarksRef.current = keep;
        else typingMarksRef.current = marks === marksAt(r.doc, r.sel) ? null : marks;
    }, [commit, fitInsert, applyRule]);

    /** `kind: 'type'` for a key-by-key delete (consecutive ones undo together). */
    const deleteSel = useCallback((from: number, to: number, kind: HistoryKind = 'push') => {
        const r = deleteRange(docRef.current, from, to);
        commit(r.doc, r.sel, r.sel, kind);
    }, [commit]);

    /** Backspace at the start of a styled line takes the line's style off instead of joining lines. */
    const backspaceAtLineStart = useCallback((): boolean => {
        const { s, e } = currentSel();
        if (s !== e) return false;
        const doc = docRef.current;
        const { bi, off } = locate(doc, s);
        if (off !== 0) return false;
        const b = doc[bi];
        let patch: Partial<Block> | null = null;
        if (isListType(b.type)) patch = b.ind > 0 ? { ind: b.ind - 1 } : { type: 'p', ind: 0 };
        else if (b.type !== 'p' && b.type !== 'code') patch = { type: 'p' };
        else if (b.q) patch = { q: false };
        else if (b.type === 'code') {
            const r = applyBlockAction(doc, s, s, 'codeBlock');
            commit(r.doc, s, s, 'push');
            return true;
        }
        if (!patch) return false;
        commit(setBlock(doc, bi, patch), s, s, 'push');
        return true;
    }, [commit]);

    const undo = useCallback(() => {
        const snap = pastRef.current.pop();
        if (!snap) return;
        futureRef.current.push({ doc: docRef.current, a: selRef.current.a, f: selRef.current.f });
        docRef.current = snap.doc;
        selRef.current = { a: snap.a, f: snap.f };
        lastKindRef.current = null;
        typingMarksRef.current = null;
        render(); applyDomSelection(); emit(); notifyFormats();
    }, [render, applyDomSelection, emit, notifyFormats]);

    const redo = useCallback(() => {
        const snap = futureRef.current.pop();
        if (!snap) return;
        pastRef.current.push({ doc: docRef.current, a: selRef.current.a, f: selRef.current.f });
        docRef.current = snap.doc;
        selRef.current = { a: snap.a, f: snap.f };
        lastKindRef.current = null;
        typingMarksRef.current = null;
        render(); applyDomSelection(); emit(); notifyFormats();
    }, [render, applyDomSelection, emit, notifyFormats]);

    // ── Composition (IME) and anything the browser did on its own ───────────

    /** Bring the model in line with what the DOM shows (after composition). */
    const reconcileFromDom = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        const lines: string[] = [];
        root.childNodes.forEach(n => { lines.push(n.textContent ?? ''); });
        const domPlain = lines.join('\n');
        const doc = docRef.current;
        const modelPlain = plainText(doc);
        // Where the caret is in the DOM as it stands (its text is the new text).
        let caret: number | null = null;
        const sel = document.getSelection();
        if (sel && sel.focusNode && root.contains(sel.focusNode)) {
            let line: Node | null = sel.focusNode;
            while (line && line.parentNode !== root) line = line.parentNode;
            if (line) {
                const idx = Array.prototype.indexOf.call(root.childNodes, line) as number;
                let base = 0;
                for (let i = 0; i < idx; i++) base += lines[i].length + 1;
                caret = base + offsetInLine(line, sel.focusNode, sel.focusOffset);
            }
        }
        // Every line element the browser may have touched is rebuilt.
        for (const b of renderedRef.current) cacheRef.current.delete(b);
        renderedRef.current = [];
        while (root.firstChild) root.removeChild(root.firstChild);
        if (domPlain === modelPlain) {
            render();
            if (caret !== null) selRef.current = { a: caret, f: caret };
            applyDomSelection();
            return;
        }
        let p = 0;
        while (p < domPlain.length && p < modelPlain.length && domPlain[p] === modelPlain[p]) p++;
        let s = 0;
        while (s < domPlain.length - p && s < modelPlain.length - p
            && domPlain[domPlain.length - 1 - s] === modelPlain[modelPlain.length - 1 - s]) s++;
        const inserted = domPlain.slice(p, domPlain.length - s);
        const marks = typingMarksRef.current ?? marksAt(doc, p);
        const r = insertText(doc, p, modelPlain.length - s, inserted, marks);
        const at = caret ?? r.sel;
        pushHistory('type', p);
        docRef.current = r.doc;
        selRef.current = { a: Math.min(at, docLen(r.doc)), f: Math.min(at, docLen(r.doc)) };
        expectSelRef.current = selRef.current.a;
        render();
        applyDomSelection();
        emit();
        notifyFormats();
    }, [render, applyDomSelection, emit, notifyFormats, pushHistory]);

    // ── Native events ────────────────────────────────────────────────────────

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const targetRange = (e: InputEvent): { s: number; e: number } | null => {
            const ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
            if (!ranges.length) return null;
            const r = ranges[0];
            const a = flatFor(r.startContainer, r.startOffset);
            const b = flatFor(r.endContainer, r.endOffset);
            if (a === null || b === null) return null;
            return { s: Math.min(a, b), e: Math.max(a, b) };
        };
        const onBeforeInput = (ev: Event) => {
            const e = ev as InputEvent;
            if (composingRef.current || e.isComposing || e.inputType === 'insertCompositionText' || e.inputType === 'deleteCompositionText' || e.inputType === 'insertFromComposition') return;
            e.preventDefault();
            if (propsRef.current.disabled) return;
            readDomSelection();
            const { s, e: end } = currentSel();
            const type = e.inputType;
            switch (type) {
                case 'insertText':
                case 'insertReplacementText': {
                    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
                    if (!text) return;
                    if (type === 'insertReplacementText') {
                        const tr = targetRange(e);
                        if (tr) { selRef.current = { a: tr.s, f: tr.e }; }
                    }
                    typeText(text);
                    return;
                }
                case 'insertParagraph':
                case 'insertLineBreak':
                    handleRef.current?.newline();
                    return;
                case 'insertFromPaste':
                case 'insertFromPasteAsQuotation':
                case 'insertFromDrop':
                case 'insertFromYank': {
                    const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
                    const tr = type === 'insertFromDrop' ? targetRange(e) : null;
                    if (tr) selRef.current = { a: tr.s, f: tr.e };
                    if (text) typeText(text.replace(/\r\n?/g, '\n'));
                    return;
                }
                case 'historyUndo': undo(); return;
                case 'historyRedo': redo(); return;
                case 'formatBold': handleRef.current?.applyFormat('bold'); return;
                case 'formatItalic': handleRef.current?.applyFormat('italic'); return;
                case 'formatUnderline': handleRef.current?.applyFormat('underline'); return;
                case 'formatStrikeThrough': handleRef.current?.applyFormat('strike'); return;
                default:
                    break;
            }
            if (type.startsWith('delete')) {
                if (s !== end && type !== 'deleteByDrag') { deleteSel(s, end); return; }
                const backward = type.includes('Backward');
                if (backward && backspaceAtLineStart()) return;
                const tr = targetRange(e);
                if (tr && tr.e > tr.s) { deleteSel(tr.s, tr.e, type === 'deleteContentBackward' || type === 'deleteContentForward' ? 'type' : 'push'); return; }
                if (type === 'deleteByDrag' || type === 'deleteByCut') return;
                // No target range (older engines, tests): one character / code point.
                const plain = plainText(docRef.current);
                if (backward && s > 0) {
                    const step = s >= 2 && /[\uDC00-\uDFFF]/.test(plain[s - 1]) && /[\uD800-\uDBFF]/.test(plain[s - 2]) ? 2 : 1;
                    deleteSel(s - step, s, 'type');
                } else if (!backward && s < plain.length) {
                    const step = /[\uD800-\uDBFF]/.test(plain[s]) && /[\uDC00-\uDFFF]/.test(plain[s + 1] ?? '') ? 2 : 1;
                    deleteSel(s, s + step, 'type');
                }
            }
        };
        const onCompositionStart = () => {
            composingRef.current = true;
            root.removeAttribute('data-empty');
        };
        const onCompositionEnd = () => {
            composingRef.current = false;
            reconcileFromDom();
        };
        const onInput = (ev: Event) => {
            if (composingRef.current || (ev as InputEvent).isComposing) return;
            // Something changed the DOM without a cancellable beforeinput.
            const lines: string[] = [];
            root.childNodes.forEach(n => { lines.push(n.textContent ?? ''); });
            if (lines.join('\n') !== plainText(docRef.current) || root.childNodes.length !== docRef.current.length) reconcileFromDom();
        };
        const onSelectionChange = () => {
            if (renderingRef.current || composingRef.current) return;
            if (!readDomSelection()) return;
            const { a, f } = selRef.current;
            if (!(a === f && expectSelRef.current === a)) typingMarksRef.current = null;
            expectSelRef.current = null;
            lastKindRef.current = null;
            notifyFormats();
        };
        root.addEventListener('beforeinput', onBeforeInput);
        root.addEventListener('compositionstart', onCompositionStart);
        root.addEventListener('compositionend', onCompositionEnd);
        root.addEventListener('input', onInput);
        document.addEventListener('selectionchange', onSelectionChange);
        return () => {
            root.removeEventListener('beforeinput', onBeforeInput);
            root.removeEventListener('compositionstart', onCompositionStart);
            root.removeEventListener('compositionend', onCompositionEnd);
            root.removeEventListener('input', onInput);
            document.removeEventListener('selectionchange', onSelectionChange);
        };
    }, [flatFor, readDomSelection, typeText, deleteSel, backspaceAtLineStart, undo, redo, reconcileFromDom, notifyFormats]);

    // ── The value prop (drafts, edit, clear after send) ──────────────────────

    useLayoutEffect(() => {
        if (props.value === lastValueRef.current && renderedRef.current.length) return;
        const fresh = props.value !== lastValueRef.current;
        lastValueRef.current = props.value;
        if (fresh) {
            docRef.current = docFromWire(props.value);
            // A new message (cleared after send, an edit loaded, a draft): its own history.
            pastRef.current = [];
            futureRef.current = [];
            lastKindRef.current = null;
            typingMarksRef.current = null;
            const len = docLen(docRef.current);
            selRef.current = { a: Math.min(selRef.current.a, len), f: Math.min(selRef.current.f, len) };
        }
        render();
        applyDomSelection();
        notifyFormats();
    }, [props.value, render, applyDomSelection, notifyFormats]);

    useEffect(() => {
        const onElement = propsRef.current.onElement;
        onElement?.(rootRef.current);
        return () => onElement?.(null);
    }, []);

    useEffect(() => {
        if (props.autoFocus && rootRef.current && !props.disabled) rootRef.current.focus({ preventScroll: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only, like the textarea's autoFocus
    }, []);

    // ── Imperative handle ────────────────────────────────────────────────────

    const handleRef = useRef<RichComposerHandle | null>(null);
    const handle: RichComposerHandle = {
        get element() { return rootRef.current; },
        focus() {
            const root = rootRef.current;
            if (!root) return;
            if (document.activeElement !== root) root.focus({ preventScroll: true });
            applyDomSelection();
        },
        getPlain() { return plainText(docRef.current); },
        getSelection() {
            if (isFocused() && !composingRef.current) readDomSelection();
            const { s, e } = currentSel();
            return { start: s, end: e };
        },
        setSelection(start, end = start) {
            const len = docLen(docRef.current);
            selRef.current = { a: Math.max(0, Math.min(start, len)), f: Math.max(0, Math.min(end, len)) };
            typingMarksRef.current = null;
            applyDomSelection();
            notifyFormats();
        },
        replaceRange(start, end, text) {
            // The replacement keeps the style of what it replaces (a `#ge` typed
            // in bold becomes a bold `#general`), else of the text before it.
            const doc = docRef.current;
            const marks = (end > start ? commonMarks(doc, start, end) : marksAt(doc, start)) & ~MARK.c;
            const r = fitInsert(start, end, text, marks);
            if (!r) return;
            commit(r.doc, r.sel, r.sel, 'push');
            lastKindRef.current = null;
        },
        insertAtSelection(text) {
            const { s, e } = currentSel();
            const r = fitInsert(s, e, text, typingMarksRef.current ?? marksAt(docRef.current, s));
            if (!r) return;
            commit(r.doc, r.sel, r.sel, 'push');
        },
        placeCaretAtEnd(opts = {}) {
            const root = rootRef.current;
            const len = docLen(docRef.current);
            selRef.current = { a: len, f: len };
            if (root && opts.focus !== false && document.activeElement !== root) root.focus({ preventScroll: true });
            applyDomSelection();
            if (root) root.scrollTop = root.scrollHeight;
            notifyFormats();
        },
        applySize(size) {
            if (propsRef.current.disabled) return;
            if (isFocused()) readDomSelection();
            const { s, e } = currentSel();
            const doc = docRef.current;
            if (s === e) {
                // Like Ctrl+B with nothing selected: the size is armed for what comes next.
                const cur = typingMarksRef.current ?? marksAt(doc, s);
                typingMarksRef.current = (cur & ~SIZE_MARKS) | sizeBit(size);
                expectSelRef.current = s;
                applyDomSelection();
                notifyFormats();
                return;
            }
            commit(setSize(doc, s, e, size), selRef.current.a, selRef.current.f, 'push');
        },
        applyFormat(action) {
            if (propsRef.current.disabled) return;
            if (isFocused()) readDomSelection();
            const { s, e } = currentSel();
            const doc = docRef.current;
            const bit = MARK_FOR[action];
            if (bit !== undefined) {
                // Code over several lines is a code block.
                if (action === 'code' && plainText(doc).slice(s, e).includes('\n')) { handle.applyFormat('codeBlock'); return; }
                if (s === e) {
                    const cur = typingMarksRef.current ?? marksAt(doc, s);
                    typingMarksRef.current = cur ^ bit;
                    expectSelRef.current = s;
                    applyDomSelection();
                    notifyFormats();
                    return;
                }
                const r = toggleMark(doc, s, e, bit);
                commit(r.doc, selRef.current.a, selRef.current.f, 'push');
                return;
            }
            if (action === 'link') {
                const plain = plainText(doc);
                const res = insertLink(plain, s, e);
                const inserted = res.value.slice(s, res.value.length - (plain.length - e));
                const r = fitInsert(s, e, inserted, marksAt(doc, s) & ~MARK.c);
                if (!r) return;
                commit(r.doc, res.selStart, res.selEnd, 'push');
                return;
            }
            const r = applyBlockAction(doc, s, e, action as 'bullet' | 'number' | 'quote' | 'heading' | 'codeBlock');
            const keepDir = selRef.current.a <= selRef.current.f;
            commit(r.doc, keepDir ? r.sel : r.selEnd, keepDir ? r.selEnd : r.sel, 'push');
        },
        newline() {
            if (propsRef.current.disabled) return;
            if (isFocused()) readDomSelection();
            let { s, e } = currentSel();
            if (s !== e) {
                const r = deleteRange(docRef.current, s, e);
                commit(r.doc, r.sel, r.sel, 'push');
                s = e = r.sel;
            }
            const pending = applyInlineShortcut(docRef.current, s);
            if (pending) {
                applyRule(pending);
                s = currentSel().s;
            }
            const fence = applyFenceShortcut(docRef.current, s);
            if (fence) { applyRule(fence); return; }
            const r = newlineAt(docRef.current, s);
            commit(r.doc, r.sel, r.sel, 'push');
            typingMarksRef.current = null;
        },
        enterShortcut() {
            if (isFocused()) readDomSelection();
            const { s, e } = currentSel();
            if (s !== e) return false;
            const fence = applyFenceShortcut(docRef.current, s);
            if (!fence) return false;
            applyRule(fence);
            return true;
        },
        commitPending() {
            if (isFocused()) readDomSelection();
            const { s, e } = currentSel();
            if (s !== e) return false;
            const res = applyInlineShortcut(docRef.current, s);
            if (!res) return false;
            applyRule(res);
            return true;
        },
        caretInCode() {
            const { s } = currentSel();
            const doc = docRef.current;
            if (doc[locate(doc, s).bi].type === 'code') return true;
            return !!((typingMarksRef.current ?? marksAt(doc, s)) & MARK.c);
        },
        replaceWithWire(start, end, wire) {
            const frag = docFromWire(wire);
            const r = replaceWithFragment(docRef.current, start, end, frag);
            commit(r.doc, r.sel, r.sel, 'push');
        },
        replaceWithCodeBlock(start, end, lang) {
            const doc = docRef.current;
            const text = plainText(doc).slice(start, end);
            const frag: Doc = [mkBlock('code', text ? [{ t: text, m: 0 }] : [], { lang })];
            const r = replaceWithFragment(doc, start, end, frag);
            commit(normalizeDoc(r.doc), r.sel, r.sel, 'push');
        },
        isComposing() { return composingRef.current; },
    };
    handleRef.current = handle;
    useImperativeHandle(ref, () => handle);

    // ── React events ─────────────────────────────────────────────────────────

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        propsRef.current.onKeyDown?.(e);
        if (e.defaultPrevented || composingRef.current || e.nativeEvent.isComposing) return;
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key.toLowerCase();
        if (mod && !e.altKey && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
        if (mod && !e.altKey && !e.shiftKey && k === 'y') { e.preventDefault(); redo(); return; }
        if (e.key === 'Tab' && !mod && !e.altKey) {
            readDomSelection();
            const { s, e: end } = currentSel();
            const next = indentLists(docRef.current, s, end, e.shiftKey ? -1 : 1);
            if (next) { e.preventDefault(); commit(next, selRef.current.a, selRef.current.f, 'push'); }
        }
    };

    const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
        // Always ours: the browser would paste HTML (markup, styles) into a contenteditable.
        e.preventDefault();
        if (propsRef.current.disabled) return;
        const text = (e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') || '').replace(/\r\n?/g, '\n');
        if (propsRef.current.onPaste?.(e, text)) return;
        if (!text) return;
        readDomSelection();
        const { s, e: end } = currentSel();
        const r = fitInsert(s, end, text, typingMarksRef.current ?? marksAt(docRef.current, s) & ~MARK.c);
        if (!r) return;
        commit(r.doc, r.sel, r.sel, 'push');
        propsRef.current.onPasted?.(s, r.text, text);
    };

    const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
        readDomSelection();
        const { s, e: end } = currentSel();
        if (s === end) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', clipboardText(docRef.current, s, end));
    };

    const onCut = (e: React.ClipboardEvent<HTMLDivElement>) => {
        readDomSelection();
        const { s, e: end } = currentSel();
        if (s === end) return;
        e.preventDefault();
        if (propsRef.current.disabled) return;
        e.clipboardData.setData('text/plain', clipboardText(docRef.current, s, end));
        deleteSel(s, end);
    };

    // A click places the caret itself; any other focus (Tab, Ctrl+L, focus())
    // puts it back where it was, like a textarea does.
    const pointerFocusRef = useRef(false);
    const onFocus = () => {
        propsRef.current.onFocus?.();
        if (!pointerFocusRef.current) applyDomSelection();
        pointerFocusRef.current = false;
        notifyFormats();
    };

    const { placeholder, disabled, className, style, fontFamily, scale, dataFont, dataSize, ariaLabel } = props;
    return (
        <div
            ref={rootRef}
            data-chat-input=""
            data-rich-composer=""
            className={`rc-root${className ? ` ${className}` : ''}`}
            role="textbox"
            aria-multiline="true"
            aria-label={ariaLabel ?? placeholder ?? 'Message'}
            aria-placeholder={placeholder}
            aria-disabled={disabled || undefined}
            data-placeholder={placeholder}
            data-msg-font={dataFont}
            data-msg-size={dataSize}
            contentEditable={!disabled}
            suppressContentEditableWarning
            spellCheck
            dir="auto"
            tabIndex={disabled ? -1 : 0}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCopy={onCopy}
            onCut={onCut}
            onPointerDown={() => { pointerFocusRef.current = true; }}
            onFocus={onFocus}
            onBlur={() => { pointerFocusRef.current = false; propsRef.current.onBlur?.(); }}
            style={{
                ...style,
                fontFamily,
                ...(scale && scale !== 1 ? { ['--cl-msg-scale' as string]: String(scale) } : {}),
            }}
        />
    );
});

export default RichComposer;
