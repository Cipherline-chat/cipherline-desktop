/**
 * Typed shortcuts in the WYSIWYG composer (richRules.ts) and the model edits
 * behind the toolbar and the Enter rules (richDoc.ts).
 */
import { describe, it, expect } from 'vitest';
import { applyBlockShortcut, applyFenceShortcut, applyInlineShortcut, isInlineTrigger } from './richRules';
import {
    MARK, applyBlockAction, commonMarks, deleteRange, docLen, insertText, indentLists, marksAt, mkBlock, newlineAt,
    normalizeDoc, plainText, toggleMark, type Doc, type Run,
} from './richDoc';
import { literalDoc, wireFromDoc } from './richWire';

const { b, i, u, s, sp, c } = MARK;
const r = (t: string, m = 0): Run => ({ t, m });
/** A one-line literal doc with the caret at its end. */
const typed = (t: string): [Doc, number] => [literalDoc(t), t.length];

describe('inline shortcuts convert on the closing marker + a space / punctuation', () => {
    const cases: [string, string, number][] = [
        ['**bold**', 'bold', b],
        ['*italic*', 'italic', i],
        ['_italic_', 'italic', i],
        ['__under__', 'under', u],
        ['~~strike~~', 'strike', s],
        ['||secret||', 'secret', sp],
        ['`code`', 'code', c],
        ['***both***', 'both', b | i],
    ];
    for (const [src, text, bits] of cases) {
        it(`${src} -> styled "${text}", markers gone`, () => {
            const [d, at] = typed(`say ${src}`);
            const res = applyInlineShortcut(d, at);
            expect(res).not.toBeNull();
            expect(plainText(res!.doc)).toBe(`say ${text}`);
            expect(res!.doc[0].runs).toEqual([r('say '), r(text, bits)]);
            expect(res!.sel).toBe(`say ${text}`.length);
            // what follows is typed unstyled
            expect(res!.marks).toBe(0);
        });
    }

    it('triggers are whitespace and closing punctuation, never another marker character', () => {
        for (const ch of [' ', '.', ',', '!', '?', ')', ':', ';', '"']) expect(isInlineTrigger(ch), ch).toBe(true);
        for (const ch of ['*', '_', '~', '|', '`', 'a', '1', '#']) expect(isInlineTrigger(ch), ch).toBe(false);
    });

    it('leaves non-shortcuts alone (no false positives)', () => {
        for (const t of ['2 * 3 *', 'snake_case_', 'a ** b**', '** x**', '*x *', '__', '****', '\\*x*', 'x_y_', 'my_var_name_']) {
            const [d, at] = typed(t);
            expect(applyInlineShortcut(d, at), t).toBeNull();
        }
    });

    it('a shortcut inside a code span or a code block never converts', () => {
        const d = normalizeDoc([mkBlock('p', [r('**x**', c)])]);
        expect(applyInlineShortcut(d, 5)).toBeNull();
        const code = normalizeDoc([mkBlock('code', [r('**x**')])]);
        expect(applyInlineShortcut(code, 5)).toBeNull();
    });

    it('keeps styles already on the text inside (italic inside bold)', () => {
        const d = normalizeDoc([mkBlock('p', [r('**a '), r('b', i), r(' c**')])]);
        const res = applyInlineShortcut(d, plainText(d).length)!;
        expect(res.doc[0].runs).toEqual([r('a ', b), r('b', b | i), r(' c', b)]);
    });

    it('the result sends as the same syntax the person typed', () => {
        const [d, at] = typed('a **b** c');
        const res = applyInlineShortcut(literalDoc('a **b**'), 7)!;
        expect(wireFromDoc(res.doc)).toBe('a **b**');
        // positive control: unconverted, the same characters are escaped (sent literally)
        expect(wireFromDoc(d)).not.toBe('a **b** c');
        expect(at).toBe(9);
    });
});

describe('line shortcuts (typed space)', () => {
    it('`- ` and `* ` make a bullet, `1. ` a numbered item (keeping its number), `> ` a quote', () => {
        const bullet = applyBlockShortcut(literalDoc('-'), 1)!;
        expect(bullet.doc[0].type).toBe('ul');
        expect(plainText(bullet.doc)).toBe('');
        expect(applyBlockShortcut(literalDoc('*'), 1)!.doc[0].type).toBe('ul');
        const num = applyBlockShortcut(literalDoc('7.'), 2)!;
        expect([num.doc[0].type, num.doc[0].num]).toEqual(['ol', 7]);
        const q = applyBlockShortcut(literalDoc('>'), 1)!;
        expect([q.doc[0].type, q.doc[0].q]).toEqual(['p', true]);
    });

    it('works in front of existing text (the rest of the line stays)', () => {
        const d = literalDoc('-hello');
        const res = applyBlockShortcut(d, 1)!;
        expect(res.doc[0].type).toBe('ul');
        expect(plainText(res.doc)).toBe('hello');
    });

    it('`# ` NEVER becomes a heading (# is the channel trigger); nor does ## / ###', () => {
        for (const t of ['#', '##', '###']) {
            expect(applyBlockShortcut(literalDoc(t), t.length), t).toBeNull();
        }
        // ...and the typed text sends literally, so it reads back as text, not a heading.
        expect(wireFromDoc(literalDoc('# hello'))).toBe('\\# hello');
    });

    it('only at the start of a plain line, right after the marker', () => {
        expect(applyBlockShortcut(literalDoc('a -'), 3)).toBeNull();
        expect(applyBlockShortcut(normalizeDoc([mkBlock('h1', [r('-')])]), 1)).toBeNull();
        expect(applyBlockShortcut(normalizeDoc([mkBlock('p', [r('-', c)])]), 1)).toBeNull();
    });
});

describe('``` + Enter makes a code block', () => {
    it('with or without a language', () => {
        const res = applyFenceShortcut(literalDoc('```'), 3)!;
        expect([res.doc[0].type, res.doc[0].lang, plainText(res.doc)]).toEqual(['code', null, '']);
        expect(applyFenceShortcut(literalDoc('```py'), 5)!.doc[0].lang).toBe('py');
    });
    it('not mid-line, not with text after the fence', () => {
        expect(applyFenceShortcut(literalDoc('a ```'), 5)).toBeNull();
        expect(applyFenceShortcut(literalDoc('```js x'), 7)).toBeNull();
        expect(applyFenceShortcut(literalDoc('```'), 2)).toBeNull();
    });
});

describe('Shift+Enter (the newline key) — the owner\'s Enter rules, in the model', () => {
    it('a list item with text continues the list; numbers count up', () => {
        const d = normalizeDoc([mkBlock('ol', [r('one')], { num: 1 })]);
        const res = newlineAt(d, 3);
        expect(res.kind).toBe('continue');
        expect(res.doc.map(x => [x.type, x.num])).toEqual([['ol', 1], ['ol', 2]]);
        expect(res.sel).toBe(4);
    });
    it('an EMPTY item ends the list (nested: steps out one level first)', () => {
        const d = normalizeDoc([mkBlock('ul', [r('a')]), mkBlock('ul', [])]);
        const res = newlineAt(d, 2);
        expect(res.kind).toBe('exit');
        expect(res.doc.map(x => x.type)).toEqual(['ul', 'p']);
        const nested = normalizeDoc([mkBlock('ul', [r('a')]), mkBlock('ul', [], { ind: 1 })]);
        expect(newlineAt(nested, 2).doc[1]).toMatchObject({ type: 'ul', ind: 0 });
    });
    it('a quote continues; an empty quote line ends it', () => {
        const d = normalizeDoc([mkBlock('p', [r('q')], { q: true })]);
        const res = newlineAt(d, 1);
        expect(res.doc.map(x => x.q)).toEqual([true, true]);
        expect(newlineAt(res.doc, 2).doc.map(x => x.q)).toEqual([true, false]);
    });
    it('inside a code block it is a line break; on an empty last line it leaves the block', () => {
        const d = normalizeDoc([mkBlock('code', [r('x')])]);
        const one = newlineAt(d, 1);
        expect(plainText(one.doc)).toBe('x\n');
        expect(one.doc).toHaveLength(1);
        const out = newlineAt(one.doc, 2);
        expect(out.kind).toBe('exit');
        expect(out.doc.map(x => x.type)).toEqual(['code', 'p']);
        expect(plainText(out.doc)).toBe('x\n');
    });
    it('anywhere else it is a plain new line (a heading\'s next line is normal text)', () => {
        const d = normalizeDoc([mkBlock('h2', [r('Title')])]);
        const res = newlineAt(d, 5);
        expect(res.kind).toBe('newline');
        expect(res.doc.map(x => x.type)).toEqual(['h2', 'p']);
        expect(newlineAt(literalDoc('ab'), 1).doc.map(plainTextOf)).toEqual(['a', 'b']);
    });
});

const plainTextOf = (blk: { runs: readonly Run[] }) => blk.runs.map(x => x.t).join('');

describe('toolbar edits on the model', () => {
    it('bold toggles on a selection and off again; edge spaces stay plain', () => {
        const d = literalDoc('say hello ');
        const on = toggleMark(d, 3, 10, b);
        expect(on.on).toBe(true);
        expect(on.doc[0].runs).toEqual([r('say '), r('hello', b), r(' ')]);
        const off = toggleMark(on.doc, 4, 9, b);
        expect(off.doc[0].runs).toEqual([r('say hello ')]);
    });
    it('a mixed selection becomes fully styled first (like every editor)', () => {
        const d = normalizeDoc([mkBlock('p', [r('ab', b), r('cd')])]);
        expect(toggleMark(d, 0, 4, b).doc[0].runs).toEqual([r('abcd', b)]);
    });
    it('the heading button cycles H1 -> H2 -> H3 -> normal', () => {
        let d: Doc = literalDoc('Title');
        const seen: string[] = [];
        for (let k = 0; k < 4; k++) { d = applyBlockAction(d, 2, 2, 'heading').doc; seen.push(d[0].type); }
        expect(seen).toEqual(['h1', 'h2', 'h3', 'p']);
        // and the H heading sends with the existing wire syntax
        expect(wireFromDoc(applyBlockAction(literalDoc('Title'), 0, 0, 'heading').doc)).toBe('# Title');
    });
    it('lists toggle, and switching kinds replaces the other', () => {
        const d = literalDoc('a\nb');
        const ul = applyBlockAction(d, 0, 3, 'bullet').doc;
        expect(ul.map(x => x.type)).toEqual(['ul', 'ul']);
        const ol = applyBlockAction(ul, 0, 3, 'number').doc;
        expect(ol.map(x => [x.type, x.num])).toEqual([['ol', 1], ['ol', 2]]);
        expect(applyBlockAction(ol, 0, 3, 'number').doc.map(x => x.type)).toEqual(['p', 'p']);
    });
    it('code block: whole lines become one block; a part of a line is split out; and back', () => {
        const d = literalDoc('a\nb');
        const cb = applyBlockAction(d, 0, 3, 'codeBlock').doc;
        expect(cb.map(x => x.type)).toEqual(['code']);
        expect(plainText(cb)).toBe('a\nb');
        expect(applyBlockAction(cb, 0, 0, 'codeBlock').doc.map(x => x.type)).toEqual(['p', 'p']);
        const part = applyBlockAction(literalDoc('say x = 1 ok'), 4, 9, 'codeBlock').doc;
        expect(part.map(x => [x.type, plainTextOf(x)])).toEqual([['p', 'say '], ['code', 'x = 1'], ['p', ' ok']]);
    });
    it('Tab nests list items (one level deeper than the item above at most)', () => {
        const d = normalizeDoc([mkBlock('ul', [r('a')]), mkBlock('ul', [r('b')])]);
        const once = indentLists(d, 2, 2, 1)!;
        expect(once.map(x => x.ind)).toEqual([0, 1]);
        expect(indentLists(once, 2, 2, 1)!.map(x => x.ind)).toEqual([0, 1]);
        expect(indentLists(literalDoc('x'), 0, 0, 1)).toBeNull();
    });
    it('typing continues the style on the left; inline code does not extend past its right edge', () => {
        const d = normalizeDoc([mkBlock('p', [r('bold', b), r('code', c)])]);
        expect(marksAt(d, 2)).toBe(b);
        expect(marksAt(d, 8)).toBe(0);
        expect(marksAt(d, 6)).toBe(c);
    });
    it('commonMarks ignores the space between two styled words', () => {
        const d = normalizeDoc([mkBlock('p', [r('a', b), r(' '), r('b', b)])]);
        expect(commonMarks(d, 0, 3)).toBe(b);
    });
});

describe('multi-line text edits', () => {
    it('pasting lines into a list continues the list; into a paragraph makes paragraphs', () => {
        const li = normalizeDoc([mkBlock('ul', [r('ab')])]);
        const res = insertText(li, 1, 1, 'X\nY');
        expect(res.doc.map(x => [x.type, plainTextOf(x)])).toEqual([['ul', 'aX'], ['ul', 'Yb']]);
        expect(res.sel).toBe(4);
        const para = insertText(literalDoc('ab'), 1, 1, 'X\nY').doc;
        expect(para.map(x => [x.type, plainTextOf(x)])).toEqual([['p', 'aX'], ['p', 'Yb']]);
    });
    it('deleting across lines joins them into the first line\'s kind', () => {
        const d = normalizeDoc([mkBlock('h1', [r('Head')]), mkBlock('ul', [r('item')])]);
        const res = deleteRange(d, 2, 7);
        expect(res.doc.map(x => [x.type, plainTextOf(x)])).toEqual([['h1', 'Heem']]);
        expect(docLen(res.doc)).toBe(4);
    });
    it('text into a code block is literal (no styles)', () => {
        const d = normalizeDoc([mkBlock('code', [r('x')])]);
        const res = insertText(d, 1, 1, '\n**y**', b);
        expect(res.doc[0].runs).toEqual([r('x\n**y**')]);
    });
});
