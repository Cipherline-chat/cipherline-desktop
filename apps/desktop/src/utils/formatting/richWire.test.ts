/**
 * The WYSIWYG composer's wire bridge (richWire.ts): the editor document <->
 * exactly the Discord-style text the message parser reads. Round trips are
 * checked both ways, with fixed cases for every format, nesting and escapes,
 * and seeded random documents (no fast-check: a small LCG keeps runs
 * reproducible — the seed is in each failure message).
 */
import { describe, it, expect } from 'vitest';
import { docFromWire, wireFromDoc, wireFromDocChecked, canonicalDoc, literalDoc } from './richWire';
import { MARK, docsEqual, mkBlock, normalizeDoc, plainText, type Block, type BlockType, type Doc, type Run } from './richDoc';
import { parseMessage } from './markdown';

const { b, i, u, s, sp, c } = MARK;
const p = (...runs: Run[]) => mkBlock('p', runs);
const r = (t: string, m = 0): Run => ({ t, m });
const show = (d: Doc) => JSON.stringify(d.map(x => [x.type, x.q ? 'q' : '', x.ind, x.num, x.lang, x.runs.map(y => `${y.t}/${y.m}`)]));

/** doc -> wire -> doc is the identity (on the canonical doc). */
function roundTrips(d: Doc): { ok: boolean; text: string } {
    const w = wireFromDocChecked(d);
    return { ok: docsEqual(docFromWire(w.text), canonicalDoc(d)) && w.exact, text: w.text };
}

describe('wire -> doc: what the box shows for message text', () => {
    it('every inline format becomes a mark, with no markers left in the text', () => {
        const d = docFromWire('**b** *i* _i2_ __u__ ~~s~~ ||sp|| `c`');
        expect(d).toHaveLength(1);
        expect(d[0].runs.filter(x => x.m)).toEqual([r('b', b), r('i', i), r('i2', i), r('u', u), r('s', s), r('sp', sp), r('c', c)]);
        expect(plainText(d)).toBe('b i i2 u s sp c');
    });

    it('nesting combines marks (***x***, __*x*__, *a **b** c*)', () => {
        expect(docFromWire('***x***')[0].runs).toEqual([r('x', b | i)]);
        expect(docFromWire('__*x*__')[0].runs).toEqual([r('x', u | i)]);
        expect(docFromWire('*a **b** c*')[0].runs).toEqual([r('a ', i), r('b', b | i), r(' c', i)]);
        expect(docFromWire('||~~**deep**~~||')[0].runs).toEqual([r('deep', sp | s | b)]);
    });

    it('lines: headings, subtext, quotes, lists (nested, numbered from their start), code blocks', () => {
        const d = docFromWire('# one\n## two\n### three\n-# small\n> quoted\n- a\n  - b\n3. x\n4. y\n```js\nlet z = 1;\n```');
        expect(d.map(x => x.type)).toEqual(['h1', 'h2', 'h3', 'sub', 'p', 'ul', 'ul', 'ol', 'ol', 'code']);
        expect(d[4].q).toBe(true);
        expect(d[6].ind).toBe(1);
        expect([d[7].num, d[8].num]).toEqual([3, 4]);
        expect(d[9].lang).toBe('js');
        expect(plainText(d)).toBe('one\ntwo\nthree\nsmall\nquoted\na\nb\nx\ny\nlet z = 1;');
    });

    it('escapes come back as the literal character', () => {
        expect(plainText(docFromWire('\\*not italic\\* \\# not a heading'))).toBe('*not italic* # not a heading');
        expect(docFromWire('\\- not a list')[0].type).toBe('p');
        expect(docFromWire('1\\. not a list')[0].type).toBe('p');
    });

    it('links stay typed-out text (they still send as links)', () => {
        const d = docFromWire('see [the docs](https://example.com/a_b) or <https://x.com>');
        expect(d[0].runs).toEqual([r('see [the docs](https://example.com/a_b) or <https://x.com>')]);
    });

    it('empty lines the parser would drop survive: an empty item, heading, quote line, code block, a blank line by a fence', () => {
        const d = docFromWire('- \n  - \n3. \n# \n-# \n> \n```js\n```\n\n```\nx\n```\n');
        expect(d.map(x => [x.type, x.ind, x.q, x.runs.length])).toEqual([
            ['ul', 0, false, 0], ['ul', 1, false, 0], ['ol', 0, false, 0], ['h1', 0, false, 0], ['sub', 0, false, 0],
            ['p', 0, true, 0], ['code', 0, false, 0], ['p', 0, false, 0], ['code', 0, false, 1], ['p', 0, false, 0],
        ]);
        expect(d[2].num).toBe(3);
        expect(d[6].lang).toBe('js');
    });

    it('positive control: a plain "# x" line IS a heading on the wire (so the box must escape a literal one)', () => {
        expect(docFromWire('# x')[0].type).toBe('h1');
        expect(parseMessage('# x')[0].t).toBe('heading');
    });
});

describe('doc -> wire: exactly the syntax the parser reads', () => {
    it('marks serialise with Discord delimiters', () => {
        expect(wireFromDoc([p(r('a '), r('b', b), r(' '), r('i', i), r(' '), r('u', u), r(' '), r('s', s), r(' '), r('x', sp), r(' '), r('c', c))]))
            .toBe('a **b** *i* __u__ ~~s~~ ||x|| `c`');
    });

    it('lines serialise with their prefixes; numbered lists count from their first item', () => {
        const d = normalizeDoc([
            mkBlock('h1', [r('H')]), mkBlock('h2', [r('H2')]), mkBlock('h3', [r('H3')]), mkBlock('sub', [r('s')]),
            mkBlock('p', [r('q')], { q: true }), mkBlock('ul', [r('a')]), mkBlock('ul', [r('b')], { ind: 1 }),
            mkBlock('p', [r('gap')]),
            mkBlock('ol', [r('x')], { num: 5 }), mkBlock('ol', [r('y')], { num: 1 }), mkBlock('code', [r('let a;\nlet b;')], { lang: 'ts' }),
        ]);
        expect(wireFromDoc(d)).toBe('# H\n## H2\n### H3\n-# s\n> q\n- a\n  - b\ngap\n5. x\n6. y\n```ts\nlet a;\nlet b;\n```');
    });

    it('plain text is sent byte for byte: no escapes where nothing would format', () => {
        for (const t of ['hello world', '2 * 3 = 6', 'snake_case_name', 'C# rocks', 'a - b', 'rate: 5/10', '#general is open', 'email@example.com', 'https://x.com/a_b_c', 'a | b', '~approx', "it's 1. fine"]) {
            expect(wireFromDoc(literalDoc(t)), t).toBe(t);
        }
    });

    it('a literal formatting character is escaped only where it would otherwise format', () => {
        expect(wireFromDoc(literalDoc('**not bold**'))).toBe('\\*\\*not bold\\*\\*');
        expect(wireFromDoc(literalDoc('# not a heading'))).toBe('\\# not a heading');
        expect(wireFromDoc(literalDoc('- not a list'))).toBe('\\- not a list');
        expect(wireFromDoc(literalDoc('1. not a list'))).toBe('1\\. not a list');
        expect(wireFromDoc(literalDoc('> not a quote'))).toBe('\\> not a quote');
        expect(wireFromDoc(literalDoc('-# not small'))).toBe('\\-# not small');
        // ...and they read back as the literal text.
        for (const t of ['**not bold**', '# not a heading', '- not a list', '1. not a list', '> not a quote', '`tick` ||x||', 'back\\slash\\*']) {
            expect(plainText(docFromWire(wireFromDoc(literalDoc(t)))), t).toBe(t);
            expect(docFromWire(wireFromDoc(literalDoc(t))).every(x => x.type === 'p' && !x.q && x.runs.every(y => y.m === 0)), t).toBe(true);
        }
    });

    it('URLs, mentions, channels and :emoji: are never escaped (an escape would break them)', () => {
        const d = [p(r('**x** '), r('bold', b), r(' https://x.com/a_b*c @some_user #dev_ops :party_parrot:'))];
        const w = wireFromDoc(d);
        expect(w).toContain('https://x.com/a_b*c');
        expect(w).toContain('@some_user');
        expect(w).toContain('#dev_ops');
        expect(w).toContain(':party_parrot:');
        expect(w).toContain('\\*\\*x\\*\\*');
    });

    it('italic next to bold uses `_` when `*` would run together', () => {
        const d = [p(r('a', b), r('b', i))];
        const w = wireFromDoc(d);
        expect(w).toBe('**a**_b_');
        expect(docsEqual(docFromWire(w), d)).toBe(true);
        // positive control: the naive form does NOT round-trip
        expect(docsEqual(docFromWire('**a***b*'), d)).toBe(false);
    });

    it('whitespace at the edge of a style is sent outside it (the wire cannot hold "* x*")', () => {
        expect(wireFromDoc([p(r('hi ', i), r('there'))])).toBe('*hi* there');
        expect(wireFromDoc([mkBlock('h1', [r('  Title')])])).toBe('# Title');
    });

    it('code: backticks inside, padding, and a code block holding a fence-looking line in a list item', () => {
        expect(wireFromDoc([p(r('a`b', c))])).toBe('``a`b``');
        expect(wireFromDoc([p(r('a``b', c))])).toBe('`a``b`');
        expect(wireFromDoc([p(r('`x', c))])).toBe('`` `x ``');
        for (const t of ['a`b', '`x', ' y ', 'x`', 'c``c']) {
            expect(docFromWire(wireFromDoc([p(r(t, c))]))[0].runs, t).toEqual([r(t, c)]);
        }
    });

    it('a quoted code block is not expressible, so the model never holds one', () => {
        const d = normalizeDoc([mkBlock('code', [r('x')], { q: true })]);
        expect(d[0].q).toBe(false);
    });

    it('empty lines round-trip (so a draft keeps them)', () => {
        const d = normalizeDoc([mkBlock('ul', []), mkBlock('ul', [], { ind: 1 }), mkBlock('ol', [], { num: 7 }), mkBlock('h2', []), mkBlock('p', [], { q: true }), mkBlock('code', [], { lang: 'py' }), mkBlock('p', []), mkBlock('code', [r('z')]), mkBlock('p', [])]);
        expect(roundTrips(d).ok).toBe(true);
    });
});

// ── Property tests ───────────────────────────────────────────────────────────

function lcg(seed: number) {
    let x = seed >>> 0;
    return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
const pick = <T,>(rnd: () => number, a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const MARK_BITS = [b, i, u, s, sp, c];
const TYPES: BlockType[] = ['p', 'p', 'p', 'h1', 'h2', 'h3', 'sub', 'ul', 'ul', 'ol', 'code'];

/** Realistic documents: words separated by spaces, styles on whole words / phrases. */
function realisticDoc(rnd: () => number): Doc {
    const WORDS = ['hello', 'world', 'ship', 'it', 'snake_case', 'C#', 'v1.2', '@bob', '#general', ':tada:', 'https://example.com/a_b', 'café', 'שלום', '中文', '2', 'don’t', 'x/y', '(note)', 'end.'];
    const blocks: Block[] = [];
    const n = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
        const type = pick(rnd, TYPES);
        if (type === 'code') { blocks.push(mkBlock('code', [r(pick(rnd, ['const a = 1;', 'if (x) {\n  y();\n}', 'SELECT * FROM t;', 'a ** b']))], { lang: rnd() < 0.5 ? pick(rnd, ['js', 'py', 'sql']) : null })); continue; }
        const runs: Run[] = [];
        const words = 1 + Math.floor(rnd() * 6);
        let m = 0;
        for (let w = 0; w < words; w++) {
            if (rnd() < 0.35) { m = 0; for (const bit of MARK_BITS) if (rnd() < 0.25) m |= bit; }
            if (w > 0) runs.push(r(' ', 0));
            runs.push(r(pick(rnd, WORDS), m));
        }
        blocks.push(mkBlock(type, runs, { q: rnd() < 0.15, ind: Math.floor(rnd() * 3), num: 1 + Math.floor(rnd() * 9) }));
    }
    return normalizeDoc(blocks);
}

/** Hostile documents: literal markers, styles glued to URLs, code next to code, odd characters. */
function hostileDoc(rnd: () => number): Doc {
    const BITS = ['hello', 'a', 'b_c', 'x*y', '2', ' ', '@bob', '#general', ':smile:', 'https://x.com/a_b', 'C#', '1.', '-', '>', '`', '\\', '~', '|', '**', '_', 'é', '中文', 'שלום'];
    const blocks: Block[] = [];
    const n = 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
        const type = pick(rnd, TYPES);
        if (type === 'code') { blocks.push(mkBlock('code', [r('const a = 1;\n  b()')], { lang: rnd() < 0.5 ? 'js' : null })); continue; }
        const runs: Run[] = [];
        const count = Math.floor(rnd() * 4);
        for (let w = 0; w < count; w++) {
            let m = 0;
            for (const bit of MARK_BITS) if (rnd() < 0.2) m |= bit;
            runs.push(r(pick(rnd, BITS) + (rnd() < 0.5 ? ' ' : ''), m));
        }
        blocks.push(mkBlock(type, runs, { q: rnd() < 0.2, ind: Math.floor(rnd() * 3), num: 1 + Math.floor(rnd() * 5) }));
    }
    return normalizeDoc(blocks);
}

describe('round-trip properties (seeded)', () => {
    it('realistic documents: doc -> wire -> doc is EXACT for every one of 2,000', () => {
        const rnd = lcg(20261116);
        for (let k = 0; k < 2000; k++) {
            const d = realisticDoc(rnd);
            const rt = roundTrips(d);
            expect(rt.ok, `case ${k}: ${rt.text}\n${show(canonicalDoc(d))}\n${show(docFromWire(rt.text))}`).toBe(true);
        }
    });

    it('hostile documents: at least 98% exact, and the rest still parse to the same TEXT', () => {
        const rnd = lcg(7);
        let exact = 0;
        const N = 2000;
        for (let k = 0; k < N; k++) {
            const d = hostileDoc(rnd);
            const rt = roundTrips(d);
            if (rt.ok) exact++;
        }
        expect(exact / N).toBeGreaterThanOrEqual(0.98);
    });

    it('wire -> doc -> wire -> doc is stable (the box never drifts on re-load)', () => {
        const rnd = lcg(99);
        const ATOMS = ['**bold**', '*it*', '__u__', '~~s~~', '||sp||', '`c`', 'plain', ' ', '\n', '# H\n', '- item\n', '1. one\n', '> q\n', '```js\nx\n```\n', '[l](https://a.b)', '\\*', 'snake_case', '-# s\n', '  - nested\n'];
        for (let k = 0; k < 1500; k++) {
            let w = '';
            const n = 1 + Math.floor(rnd() * 8);
            for (let j = 0; j < n; j++) w += pick(rnd, ATOMS);
            const d1 = docFromWire(w);
            const w2 = wireFromDoc(d1);
            const d2 = docFromWire(w2);
            expect(docsEqual(d2, canonicalDoc(d1)), `case ${k}: ${JSON.stringify(w)} -> ${JSON.stringify(w2)}`).toBe(true);
            // and the second serialisation is a fixed point
            expect(wireFromDoc(d2), `case ${k}`).toBe(w2);
        }
    });

    it('positive control: a serialiser that drops the escapes fails the property', () => {
        const d = literalDoc('**a** and # b');
        const naive = plainText(d);
        expect(docsEqual(docFromWire(naive), canonicalDoc(d))).toBe(false);
        expect(docsEqual(docFromWire(wireFromDoc(d)), canonicalDoc(d))).toBe(true);
    });
});

describe('performance', () => {
    it('serialising + verifying a 4,000-character formatted message stays well inside a keystroke', () => {
        const runs: Run[] = [];
        while (runs.reduce((n, x) => n + x.t.length, 0) < 4000) runs.push(r('some words here ', 0), r('bold bit', b), r(' and ', 0), r('code', c), r(' ', 0));
        const d = normalizeDoc([p(...runs), mkBlock('ul', [r('item', i)]), mkBlock('code', [r('x = 1')])]);
        wireFromDoc(d);
        const t0 = performance.now();
        const N = 40;
        for (let k = 0; k < N; k++) wireFromDoc([...d.slice(0, 0), { ...d[0], runs: [...d[0].runs, r(String(k), 0)] }, ...d.slice(1)]);
        const per = (performance.now() - t0) / N;
        // Measured ~1-3 ms on the dev box under load; 25 ms is the "never noticeable" ceiling.
        expect(per).toBeLessThan(25);
    });
});
