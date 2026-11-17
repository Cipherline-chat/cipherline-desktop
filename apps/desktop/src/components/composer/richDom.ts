/**
 * DOM side of the WYSIWYG composer (RichComposer.tsx): building a line's
 * element from the model, and mapping DOM points <-> flat model offsets.
 *
 * Everything is built with createElement + text nodes. Nothing here ever
 * assigns innerHTML, so nothing a person types or pastes can become markup.
 */
import { MARK, blockLen, blockText, type Block, type Run } from '../../utils/formatting/richDoc';

const MARK_TAGS: readonly { bit: number; tag: string; cls: string }[] = [
    // Size outermost, so everything inside (inline code included) scales with it.
    { bit: MARK.lg, tag: 'span', cls: 'rc-lg' },
    { bit: MARK.sm, tag: 'span', cls: 'rc-sm' },
    { bit: MARK.sp, tag: 'span', cls: 'rc-spoiler' },
    { bit: MARK.s, tag: 's', cls: 'cl-fmt-s' },
    { bit: MARK.u, tag: 'u', cls: 'cl-fmt-u' },
    { bit: MARK.b, tag: 'strong', cls: 'cl-fmt-b' },
    { bit: MARK.i, tag: 'em', cls: 'cl-fmt-i' },
    { bit: MARK.c, tag: 'code', cls: 'rc-icode' },
];

/** The text node of each run of a built line, in order. */
const runTexts = new WeakMap<HTMLElement, Text[]>();

function blockClass(b: Block): string {
    let c = `rc-b rc-${b.type}`;
    if (b.q) c += ' rc-q';
    return c;
}

function buildRun(r: Run): { node: Node; text: Text } {
    const text = document.createTextNode(r.t);
    let node: Node = text;
    // Innermost first: code is always the innermost element.
    for (let k = MARK_TAGS.length - 1; k >= 0; k--) {
        const mt = MARK_TAGS[k];
        if (!(r.m & mt.bit)) continue;
        const el = document.createElement(mt.tag);
        el.className = mt.cls;
        el.appendChild(node);
        node = el;
    }
    return { node, text };
}

/** A fresh element for one line. */
export function buildBlock(b: Block): HTMLElement {
    const el = document.createElement('div');
    el.className = blockClass(b);
    el.setAttribute('dir', 'auto');
    if (b.type === 'ul' || b.type === 'ol') { el.style.setProperty('--rc-ind', String(b.ind)); el.setAttribute('data-ind', String(b.ind)); }
    if (b.type === 'ol') el.setAttribute('data-n', `${b.num}.`);
    if (b.type === 'code' && b.lang) el.setAttribute('data-lang', b.lang);
    const texts: Text[] = [];
    if (b.type === 'code') {
        const t = blockText(b);
        const node = document.createTextNode(t);
        el.appendChild(node);
        texts.push(node);
        // pre-wrap shows no line after a final '\n' without something on it.
        if (t === '' || t.endsWith('\n')) el.appendChild(fillerBr());
    } else if (b.runs.length === 0) {
        el.appendChild(fillerBr());
    } else {
        for (const r of b.runs) {
            const { node, text } = buildRun(r);
            el.appendChild(node);
            texts.push(text);
        }
    }
    runTexts.set(el, texts);
    return el;
}

function fillerBr(): HTMLBRElement {
    const br = document.createElement('br');
    br.setAttribute('data-rc-fill', '');
    return br;
}

/**
 * Update a line's element in place when only the TEXT of its runs changed
 * (typing inside a word): the same text nodes keep their spellcheck state and
 * nothing re-lays out but the line. False when the structure differs.
 */
export function patchBlock(el: HTMLElement, prev: Block, next: Block): boolean {
    if (prev.type !== next.type || prev.q !== next.q || prev.ind !== next.ind || prev.num !== next.num || prev.lang !== next.lang) return false;
    if (next.type === 'code') return false;
    if (prev.runs.length !== next.runs.length || next.runs.length === 0) return false;
    for (let k = 0; k < next.runs.length; k++) if (prev.runs[k].m !== next.runs[k].m) return false;
    const texts = runTexts.get(el);
    if (!texts || texts.length !== next.runs.length) return false;
    for (let k = 0; k < next.runs.length; k++) {
        if (!texts[k].isConnected || !el.contains(texts[k])) return false;
    }
    for (let k = 0; k < next.runs.length; k++) if (texts[k].data !== next.runs[k].t) texts[k].data = next.runs[k].t;
    return true;
}

/** The plain text the DOM of one line holds (what the browser may have typed into it). */
export function domLineText(node: Node): string {
    return node.textContent ?? '';
}

/** Offset of a DOM point inside a line element, in characters of that line's text. */
export function offsetInLine(lineEl: Node, node: Node, offset: number): number {
    if (node === lineEl && offset === 0) return 0;
    const doc = lineEl.ownerDocument;
    if (!doc) return 0;
    const range = doc.createRange();
    range.setStart(lineEl, 0);
    try {
        range.setEnd(node, offset);
    } catch {
        return 0;
    }
    return range.toString().length;
}

/** A DOM point for an offset inside a line element (left affinity at run boundaries). */
export function pointInLine(lineEl: HTMLElement, b: Block, off: number): [Node, number] {
    const texts = runTexts.get(lineEl);
    if (!texts || texts.length === 0 || blockLen(b) === 0) return [lineEl, 0];
    let left = off;
    for (let k = 0; k < texts.length; k++) {
        const len = texts[k].data.length;
        if (left <= len) {
            // At the very end of a run followed by another, prefer the end of
            // this one (typing continues its style) — except at offset 0.
            return [texts[k], left];
        }
        left -= len;
    }
    const last = texts[texts.length - 1];
    return [last, last.data.length];
}
