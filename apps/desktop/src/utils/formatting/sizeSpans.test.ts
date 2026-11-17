/**
 * Text size as a SPAN style (owner, 2026-11-16: "highlight some text make it
 * big, and other text make it small, all in one message"): the inline syntax
 * `[small]…[/small]` / `[large]…[/large]` in the parser, the composer's model
 * and serializer, the plain-text paths, validation, and back-compat with the
 * per-message `size` field.
 */
import { describe, it, expect } from 'vitest';
import { MAX_SIZE_SPANS, parseMessage, type InlineNode } from './markdown';
import { applyMessageSize, canonicalDoc, docFromWire, extractUniformSize, literalDoc, wireFromDoc, wireFromDocChecked } from './richWire';
import { MARK, docLen, docsEqual, mkBlock, normalizeDoc, plainText, setSize, sizeInRange, type Block, type BlockType, type Doc, type Run } from './richDoc';
import { MAX_MESSAGE_SCALE, MAX_SIZE_TAGS, SIZE_OPTIONS, messageSizeOf, scaledPx, sizeScaleFor } from './messageSize';
import { stripFormatting } from './plainText';
import { toPlainText } from '../messagePreviewText';
import { contentProblem } from '../contentValidation';

const { b, i, u, s, sp, c, sm, lg } = MARK;
const r = (t: string, m = 0): Run => ({ t, m });
const inline = (text: string): InlineNode[] => {
    const blocks = parseMessage(text);
    expect(blocks[0].t).toBe('para');
    return (blocks[0] as { c: InlineNode[] }).c;
};

describe('the parser reads size spans', () => {
    it('[large] and [small] become size nodes; the markers are not text', () => {
        expect(inline('[large]big[/large] and [small]tiny[/small]')).toEqual([
            { t: 'size', size: 'large', c: [{ t: 'text', v: 'big' }] },
            { t: 'text', v: ' and ' },
            { t: 'size', size: 'small', c: [{ t: 'text', v: 'tiny' }] },
        ]);
    });

    it('nests with the other styles, both ways, and a size inside a size', () => {
        expect(inline('**[large]x[/large]**')).toEqual([{ t: 'strong', c: [{ t: 'size', size: 'large', c: [{ t: 'text', v: 'x' }] }] }]);
        expect(inline('[large]**x** ||y||[/large]')).toEqual([{ t: 'size', size: 'large', c: [
            { t: 'strong', c: [{ t: 'text', v: 'x' }] }, { t: 'text', v: ' ' }, { t: 'spoiler', c: [{ t: 'text', v: 'y' }] },
        ] }]);
        expect(inline('[small]a [large]b[/large] c[/small]')).toEqual([{ t: 'size', size: 'small', c: [
            { t: 'text', v: 'a ' }, { t: 'size', size: 'large', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' },
        ] }]);
        const h = parseMessage('# [large]Title[/large]')[0];
        expect(h).toMatchObject({ t: 'heading', c: [{ t: 'size', size: 'large' }] });
        expect(inline('[large]run `code` here[/large]')[0]).toMatchObject({ t: 'size', c: [{ t: 'text' }, { t: 'code', v: 'code' }, { t: 'text' }] });
    });

    it('only the two allowlisted tags; escaped, unclosed, empty, mis-cased or in code = literal text', () => {
        for (const t of ['\\[large]x[/large]', '[large]x', 'x[/large]', '[large][/large]', '[huge]x[/huge]', '[Large]x[/Large]', '[big]x[/big]', '`[large]x[/large]`', '[ large]x[/large]']) {
            const nodes = inline(t);
            expect(JSON.stringify(nodes).includes('"size"'), t).toBe(false);
        }
        expect(stripFormatting('\\[large]x[/large]')).toBe('[large]x[/large]');
    });

    it('links next to a size span still work (and a span is not a link label)', () => {
        const n = inline('[large]see[/large] [docs](https://example.com)');
        expect(n[0]).toMatchObject({ t: 'size' });
        expect(n[2]).toMatchObject({ t: 'link', url: 'https://example.com' });
    });

    it(`honours at most MAX_SIZE_SPANS (${MAX_SIZE_SPANS}) spans per message; the rest render at the surrounding size, without markers`, () => {
        const text = Array.from({ length: MAX_SIZE_SPANS + 50 }, (_, k) => `[large]w${k}[/large]`).join(' ');
        const nodes = inline(text);
        expect(nodes.filter(n => n.t === 'size')).toHaveLength(MAX_SIZE_SPANS);
        expect(stripFormatting(text)).not.toContain('[');
        // the budget is per message: the next message gets a fresh one
        expect(inline('[large]again[/large]')[0].t).toBe('size');
    });

    it('stays linear on hostile input (100k unmatched openers / closers)', () => {
        const t0 = performance.now();
        parseMessage('[large]'.repeat(15_000));
        parseMessage('[/large]x'.repeat(12_000));
        parseMessage('[small][large]'.repeat(7_000) + 'x' + '[/large]'.repeat(7_000));
        expect(performance.now() - t0).toBeLessThan(2500);
    });
});

describe('plain text never shows a marker (notifications, previews, search, reply quotes)', () => {
    const msgs = ['[large]Big news[/large] at [small]3pm[/small]', '**[large]Bold big[/large]** ok', '- [small]item[/small]\n# [large]Head[/large]', '[small]a [large]b[/large] c[/small]'];
    it('toPlainText and stripFormatting drop every tag', () => {
        for (const m of msgs) {
            for (const out of [toPlainText(m), stripFormatting(m)]) {
                expect(out, m).not.toMatch(/\[\/?(small|large)\]/);
            }
        }
        expect(toPlainText('[large]Big news[/large] at [small]3pm[/small]')).toBe('Big news at 3pm');
    });
    it('positive control: the raw text does contain them', () => {
        expect(msgs.every(m => /\[(small|large)\]/.test(m))).toBe(true);
    });
});

describe('the composer model <-> the wire', () => {
    it('size marks serialise as tags and read back', () => {
        const d = [mkBlock('p', [r('a '), r('big', lg), r(' b '), r('tiny', sm)])];
        expect(wireFromDoc(d)).toBe('a [large]big[/large] b [small]tiny[/small]');
        expect(docsEqual(docFromWire(wireFromDoc(d)), d)).toBe(true);
    });

    it('nest with other marks (size outermost) and an inner size replaces the outer one', () => {
        const d = [mkBlock('p', [r('x', lg | b), r(' y', lg), r('z', sm | i)])];
        const w = wireFromDoc(d);
        expect(w).toBe('[large]**x** y[/large][small]*z*[/small]');
        expect(docsEqual(docFromWire(w), d)).toBe(true);
        expect(docFromWire('[small]a [large]b[/large][/small]')[0].runs).toEqual([r('a ', sm), r('b', lg)]);
    });

    it('a literal "[large]" typed as text is escaped, so it never becomes a span', () => {
        const w = wireFromDoc(literalDoc('type [large]this[/large] literally'));
        expect(w).toBe('type \\[large]this\\[/large] literally');
        expect(JSON.stringify(parseMessage(w)).includes('"size"')).toBe(false);
        // positive control: unescaped, it would be a span
        expect(JSON.stringify(parseMessage('type [large]this[/large] literally')).includes('"size"')).toBe(true);
    });

    it('sizeInRange: one size, normal, or mixed (whitespace ignored, code-block text is normal)', () => {
        const d = normalizeDoc([mkBlock('p', [r('big', lg), r(' '), r('big', lg)]), mkBlock('p', [r('n')]), mkBlock('code', [r('x')])]);
        expect(sizeInRange(d, 0, 7)).toBe('large');
        expect(sizeInRange(d, 0, 9)).toBe('mixed');
        expect(sizeInRange(d, 8, 9)).toBeNull();
        expect(sizeInRange(normalizeDoc([mkBlock('p', [r('x', lg)]), mkBlock('code', [r('y')])]), 0, 3)).toBe('mixed');
    });

    it('setSize changes only the size (other styles kept, code blocks untouched)', () => {
        const d = normalizeDoc([mkBlock('p', [r('ab', b | lg)]), mkBlock('code', [r('c')])]);
        const out = setSize(d, 0, docLen(d), 'small');
        expect(out[0].runs).toEqual([r('ab', b | sm)]);
        expect(out[1].runs).toEqual([r('c')]);
        expect(setSize(out, 0, 2, null)[0].runs).toEqual([r('ab', b)]);
    });

    // Round-trip property: sizes mixed into every other style.
    function lcg(seed: number) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }
    const WORDS = ['hello', 'big', 'small', 'snake_case', 'C#', '@bob', '#general', ':tada:', 'https://example.com/a_b', 'café', '中文', '2', 'x/y', 'end.'];
    const TYPES: BlockType[] = ['p', 'p', 'p', 'h1', 'h2', 'sub', 'ul', 'ol', 'code'];
    function randomDoc(rnd: () => number): Doc {
        const blocks: Block[] = [];
        for (let k = 0, n = 1 + Math.floor(rnd() * 5); k < n; k++) {
            const type = TYPES[Math.floor(rnd() * TYPES.length)];
            if (type === 'code') { blocks.push(mkBlock('code', [r('let a = 1;')])); continue; }
            const runs: Run[] = [];
            let m = 0;
            for (let w = 0, n2 = 1 + Math.floor(rnd() * 6); w < n2; w++) {
                if (rnd() < 0.4) {
                    m = 0;
                    for (const bit of [b, i, u, s, sp, c]) if (rnd() < 0.2) m |= bit;
                    const z = rnd();
                    m |= z < 0.33 ? sm : z < 0.66 ? lg : 0;
                }
                if (w > 0) runs.push(r(' ', rnd() < 0.5 ? m & (sm | lg) : 0));
                runs.push(r(WORDS[Math.floor(rnd() * WORDS.length)], m));
            }
            blocks.push(mkBlock(type, runs, { q: rnd() < 0.15, ind: Math.floor(rnd() * 2), num: 1 + Math.floor(rnd() * 5) }));
        }
        return normalizeDoc(blocks);
    }

    it('2,000 seeded documents mixing sizes with every style: doc -> wire -> doc is exact', () => {
        const rnd = lcg(1116);
        for (let k = 0; k < 2000; k++) {
            const d = randomDoc(rnd);
            const w = wireFromDocChecked(d);
            const back = docFromWire(w.text);
            expect(w.exact && docsEqual(back, canonicalDoc(d)), `case ${k}: ${JSON.stringify(w.text)}`).toBe(true);
        }
    });

    it('edits round-trip: a sent message loaded back into the box and saved unchanged sends the same text', () => {
        const rnd = lcg(42);
        for (let k = 0; k < 500; k++) {
            const sent = wireFromDoc(randomDoc(rnd));
            const again = wireFromDoc(docFromWire(sent));
            expect(again, `case ${k}`).toBe(sent);
        }
    });
});

describe('back-compat with the per-message `size` field', () => {
    it('old messages render exactly as before: the field still scales the whole body (Large is now 1.5x)', () => {
        expect(messageSizeOf({ type: 'text', text: 'hi', size: 'large' })).toBe('large');
        expect(scaledPx(15, 'large')).toBe('22.5px');
        expect(scaledPx(15, 'small')).toBe('13.125px');
        expect(sizeScaleFor('large')).toBe(MAX_MESSAGE_SCALE);
        expect(SIZE_OPTIONS.find(o => o.id === 'large')?.scale).toBe(1.5);
    });

    it('a one-size message is sent as the field with CLEAN text (best for older clients)', () => {
        expect(extractUniformSize('[large]hello **world**[/large]')).toEqual({ text: 'hello **world**', size: 'large' });
        expect(extractUniformSize('[small]a[/small]\n- [small]b[/small]')).toEqual({ text: 'a\n- b', size: 'small' });
    });

    it('mixed sizes stay spans, with no field; plain text has neither', () => {
        expect(extractUniformSize('[large]big[/large] normal')).toEqual({ text: '[large]big[/large] normal', size: null });
        expect(extractUniformSize('[large]a[/large] [small]b[/small]').size).toBeNull();
        expect(extractUniformSize('[large]a[/large]\n```\ncode\n```').size).toBeNull();
        expect(extractUniformSize('just text')).toEqual({ text: 'just text', size: null });
    });

    it('editing a message that has the field: it loads as a span over all its text, and saves back to the field', () => {
        const box = applyMessageSize('**hi** there', 'large');
        expect(box).toBe('[large]**hi** there[/large]');
        expect(plainText(docFromWire(box))).toBe('hi there');
        expect(extractUniformSize(box)).toEqual({ text: '**hi** there', size: 'large' });
        expect(applyMessageSize('x', null)).toBe('x');
    });
});

describe('validation', () => {
    it(`a text with more than MAX_SIZE_TAGS (${MAX_SIZE_TAGS}) size openers is refused; up to it is fine`, () => {
        const many = (n: number) => '[large]x[/large] '.repeat(n);
        expect(contentProblem({ type: 'text', text: many(MAX_SIZE_TAGS) })).toBeNull();
        expect(contentProblem({ type: 'text', text: many(MAX_SIZE_TAGS + 1) })).not.toBeNull();
        expect(contentProblem({ type: 'edit', target_id: 'm1', text: many(MAX_SIZE_TAGS + 1) })).not.toBeNull();
        expect(contentProblem({ type: 'text', text: '[large]normal message[/large]' })).toBeNull();
    });
});
