/**
 * The formatter runs on SENDER-CONTROLLED text (up to MAX_RECEIVED_TEXT_LENGTH
 * = 200k characters) on every render of every visible row, so it must stay
 * fast on inputs built to hurt a backtracking parser: long runs of `*` / `_`,
 * thousands of unmatched openers, deep nesting, and seeded random soup. Each
 * case asserts a time budget generous enough for a loaded CI box but far below
 * what a quadratic parser takes (a quadratic pass over 200k characters is
 * tens of seconds), plus structural invariants (no throw, no text lost).
 */
import { describe, it, expect } from 'vitest';
import { parseMessage, parseInline, MAX_INLINE_DEPTH, type InlineNode, type BlockNode } from './markdown';
import { stripFormatting, embedUrlsOf } from './plainText';
import { highlight } from './highlight';

const N = 200_000;

function time(fn: () => void): number {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
}

function depthOf(nodes: readonly InlineNode[]): number {
    let d = 0;
    for (const n of nodes) {
        if ('c' in n) d = Math.max(d, 1 + depthOf(n.c));
    }
    return d;
}

/** Every character of the source is accounted for by text/code (markers aside). */
function textLen(blocks: readonly BlockNode[]): number {
    let n = 0;
    const inl = (ns: readonly InlineNode[]) => { for (const x of ns) { if (x.t === 'text' || x.t === 'code' || x.t === 'codeBlock') n += x.v.length; else inl(x.c); } };
    const blk = (bs: readonly BlockNode[]) => { for (const b of bs) { if (b.t === 'quote') blk(b.c); else if (b.t === 'list') { const w = (l: typeof b) => l.items.forEach(it => { inl(it.c); if (it.sub) w(it.sub); }); w(b); } else inl(b.c); } };
    blk(blocks);
    return n;
}

// Seeded PRNG (mulberry32) so a failure reproduces.
function rng(seed: number) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Budget per 200k-character case. Measured well under 300ms on the dev box;
// a quadratic regression takes orders of magnitude longer.
const BUDGET_MS = 2_500;

describe('adversarial inputs stay linear-ish', () => {
    const cases: [string, string][] = [
        ['200k asterisks', '*'.repeat(N)],
        ['200k underscores', '_'.repeat(N)],
        ['200k tildes / pipes', '~|'.repeat(N / 2)],
        ['unmatched italic openers', '*a '.repeat(N / 3)],
        ['unmatched bold openers', '**a '.repeat(N / 4)],
        ['unmatched underscore openers', ' _a'.repeat(N / 3)],
        ['openers with whitespace-preceded closers', 'a *b *c '.repeat(N / 8)],
        ['alternating ** and *', '***a**b*'.repeat(N / 8)],
        ['unclosed brackets', '['.repeat(N)],
        ['brackets with no target', '[a]'.repeat(N / 3)],
        ['link targets without labels', '](https://x.y)'.repeat(N / 14)],
        ['backtick runs of varying length', '`a``b```c'.repeat(N / 9)],
        ['unclosed fences', '```x\n'.repeat(N / 5)],
        ['escapes everywhere', '\\*\\_'.repeat(N / 4)],
        ['angle brackets', '<http'.repeat(N / 5)],
        ['mention-token lookalikes', '<@u:'.repeat(N / 4)],
        ['long URL', 'https://x.com/' + 'a_b*c~d|'.repeat(N / 8)],
        ['many short lines of list markers', '- *\n'.repeat(N / 4)],
        ['quote lines', '> **a\n'.repeat(N / 7)],
    ];

    for (const [name, src] of cases) {
        it(name, () => {
            let blocks: BlockNode[] = [];
            const ms = time(() => { blocks = parseMessage(src); });
            expect(ms).toBeLessThan(BUDGET_MS);
            expect(Array.isArray(blocks)).toBe(true);
            // Plain-text and embed passes go through the same parse.
            expect(time(() => { stripFormatting(src + ' '); embedUrlsOf(src + '  '); })).toBeLessThan(BUDGET_MS * 2);
        });
    }

    it('deep nesting is capped and still parses', () => {
        const open = '**__~~||*'.repeat(400);
        const close = '*||~~__**'.repeat(400);
        const src = `${open}x${close}`;
        let nodes: InlineNode[] = [];
        expect(time(() => { nodes = parseInline(src); })).toBeLessThan(BUDGET_MS);
        expect(depthOf(nodes)).toBeLessThanOrEqual(MAX_INLINE_DEPTH + 2);
    });

    it('deeply nested link labels / spoilers do not recurse without bound', () => {
        const src = '||'.repeat(5000) + 'x' + '||'.repeat(5000);
        let nodes: InlineNode[] = [];
        expect(time(() => { nodes = parseInline(src); })).toBeLessThan(BUDGET_MS);
        expect(depthOf(nodes)).toBeLessThanOrEqual(MAX_INLINE_DEPTH + 1);
    });

    it('the highlighter is linear and capped', () => {
        const big = '"unterminated \\" string '.repeat(800) + '/* open comment '.repeat(500);
        expect(time(() => highlight(big, 'js'))).toBeLessThan(BUDGET_MS);
        const markup = '<a b="'.repeat(3000);
        expect(time(() => highlight(markup, 'html'))).toBeLessThan(BUDGET_MS);
        // Above the cap: one plain segment, no scan at all.
        expect(highlight('x'.repeat(30_000), 'js')).toHaveLength(1);
    });
});

describe('seeded random soup', () => {
    const letters = (s: string) => (s.match(/[ab]/g) ?? []).length;
    const soup = (seed: number, alphabet: readonly string[]) => {
        const r = rng(seed);
        let src = '';
        while (src.length < 4000) src += alphabet[Math.floor(r() * alphabet.length)];
        return src;
    };
    const full = ['*', '**', '_', '__', '~~', '||', '`', '```', '\\', '[', ']', '(', ')', '](https://e.x/)', '<', '>', '<@u:i:n_m>', '\n', '> ', '- ', '# ', ' ', 'a', 'b', 'https://u.rl/x_y ', '1. '];
    // Without spoilers (hidden in plain text) and fences (a fence's language word is not text).
    const lossless = full.filter(t => t !== '||' && t !== '```');

    for (let seed = 1; seed <= 30; seed++) {
        it(`seed ${seed}: parses without throwing and invents no text`, () => {
            const src = soup(seed, full);
            let blocks: BlockNode[] = [];
            expect(() => { blocks = parseMessage(src); }).not.toThrow();
            expect(textLen(blocks)).toBeLessThanOrEqual(src.length);
            expect(letters(stripFormatting(src))).toBeLessThanOrEqual(letters(src));
        });
        it(`seed ${seed}: without spoilers / fences, every letter survives into the plain text`, () => {
            const src = soup(seed + 1000, lossless);
            expect(letters(stripFormatting(src))).toBe(letters(src));
        });
    }
});
