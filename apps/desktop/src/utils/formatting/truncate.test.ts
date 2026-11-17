/**
 * Long formatted messages: the line-aware long-message rule and the
 * tree-cut collapsed preview (utils/formatting/truncate.ts).
 */
import { describe, it, expect } from 'vitest';
import { parseMessage, type BlockNode, type InlineNode } from './markdown';
import { truncateBlocks, previewSource, safeCut, PREVIEW_SOURCE_MAX } from './truncate';
import { isLongMessage, longMessageStats, longMessageLabel, LONG_MESSAGE_MAX_LINES } from '../longMessage';

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const CODE60 = '```ts\n' + lines(60, i => `const v${i} = ${i};`) + '\n```';

function flat(blocks: readonly BlockNode[]): InlineNode[] {
    const out: InlineNode[] = [];
    const inl = (ns: readonly InlineNode[]) => { for (const n of ns) { out.push(n); if ('c' in n) inl(n.c); } };
    for (const b of blocks) {
        if (b.t === 'quote') out.push(...flat(b.c));
        else if (b.t === 'list') { const w = (l: typeof b) => l.items.forEach(it => { inl(it.c); if (it.sub) w(it.sub); }); w(b); }
        else inl(b.c);
    }
    return out;
}
const textOf = (blocks: readonly BlockNode[]) => flat(blocks).filter(n => n.t === 'text').map(n => (n as { v: string }).v).join('');

describe('isLongMessage counts lines, not just characters', () => {
    it(`more than ${LONG_MESSAGE_MAX_LINES} lines collapses, however short`, () => {
        expect(isLongMessage(lines(30, () => 'x'))).toBe(false);
        expect(isLongMessage(lines(31, () => 'x'))).toBe(true);
        expect(CODE60.length).toBeLessThan(1500);
        expect(isLongMessage(CODE60)).toBe(true);
    });
    it('the character rule is unchanged', () => {
        expect(isLongMessage('x'.repeat(5000))).toBe(false);
        expect(isLongMessage('x'.repeat(5001))).toBe(true);
    });
    it('the footer names the lines when lines made it long', () => {
        expect(longMessageLabel(longMessageStats(CODE60))).toMatch(/^Long message · 62 lines · [\d,]+ characters · ~1 min read$/);
        expect(longMessageLabel(longMessageStats('x '.repeat(3000)))).toMatch(/^Long message · 6,000 characters/);
    });
});

describe('truncateBlocks — the collapsed preview is well-formed', () => {
    it('a long code block keeps its first lines as a clipped code block', () => {
        const { blocks, cut } = truncateBlocks(parseMessage('here it is:\n' + CODE60));
        expect(cut).toBe(true);
        const code = flat(blocks).find(n => n.t === 'codeBlock') as { v: string; clipped?: boolean; lang: string };
        expect(code).toBeDefined();
        expect(code.clipped).toBe(true);
        expect(code.lang).toBe('ts');
        const shown = code.v.split('\n');
        expect(shown.length).toBeGreaterThanOrEqual(3);
        expect(shown.length).toBeLessThan(12);
        expect(shown[0]).toBe('const v0 = 0;');
        // No fence characters leak into the text.
        expect(textOf(blocks)).not.toContain('```');
    });

    it('a code block that fits is kept whole and not clipped', () => {
        const { blocks } = truncateBlocks(parseMessage('```\na\nb\n```'));
        expect(flat(blocks).find(n => n.t === 'codeBlock')).toEqual({ t: 'codeBlock', lang: null, v: 'a\nb' });
    });

    it('a cut inside a spoiler keeps it a spoiler (never shows its text in clear)', () => {
        const secret = 'the butler did it '.repeat(80);
        const { blocks } = truncateBlocks(parseMessage(`spoilers ahead: ||${secret}|| more`));
        const all = flat(blocks);
        const sp = all.find(n => n.t === 'spoiler');
        expect(sp).toBeDefined();
        // Outside the spoiler node, no secret text and no literal pipes.
        const outside = (blocks[0] as { c: InlineNode[] }).c.filter(n => n.t === 'text').map(n => (n as { v: string }).v).join('');
        expect(outside).not.toContain('butler');
        expect(outside).not.toContain('||');
    });

    it('lists stay lists (first items only); headings and quotes survive', () => {
        const src = '# Plan\n> context line\n' + lines(40, i => `- item ${i}`);
        const { blocks } = truncateBlocks(parseMessage(src));
        expect(blocks[0].t).toBe('heading');
        expect(blocks[1].t).toBe('quote');
        const list = blocks.find(b => b.t === 'list') as { items: unknown[] };
        expect(list.items.length).toBeGreaterThan(3);
        expect(list.items.length).toBeLessThan(12);
    });

    it('text is cut at a word / line boundary, never inside a mention token or URL', () => {
        const long = 'word '.repeat(130) + '<@r:role1:Server Admins> and https://example.com/a/very/long/path ' + 'tail '.repeat(100);
        const { blocks } = truncateBlocks(parseMessage(long), { chars: 660, lines: 12 });
        const t = textOf(blocks);
        expect(t).not.toMatch(/<@r:[^>]*$/);
        expect(!/https?:\/\/\S*$/.test(t) || t.endsWith('/a/very/long/path')).toBe(true);
        expect(t.endsWith('word') || t.endsWith('Admins>') || t.endsWith('and') || t.endsWith('path')).toBe(true);
    });

    it('safeCut prefers a line break, then a space, and pulls out of a token', () => {
        expect(safeCut('aaaa bbbb\ncccc dddd', 17)).toBe(9);
        expect(safeCut('aaaa bbbb ccccccccc', 14)).toBe(10);
        // No boundary in the back half of the window: cut where the budget says.
        expect(safeCut('aaaa bbbbbbbbbbbbbbb', 12)).toBe(12);
        expect(safeCut('x <@u:id:Long Name Here> y', 15)).toBe(2);
    });

    it('a short message is not cut', () => {
        const r = truncateBlocks(parseMessage('**hi** there'));
        expect(r.cut).toBe(false);
    });
});

describe('previewSource bounds the work on a huge message', () => {
    it('short text is untouched', () => {
        expect(previewSource('abc')).toBe('abc');
    });
    it('a huge message is cut to a prefix with no open spoiler and no open fence', () => {
        const head = 'x\n'.repeat(5000);
        const huge = head + '||' + 'secret '.repeat(5000) + '||' + '\n```\n' + 'y\n'.repeat(5000);
        const src = previewSource(huge);
        expect(src.length).toBeLessThanOrEqual(PREVIEW_SOURCE_MAX + 4);
        expect(src).not.toContain('secret');
        const huge2 = 'a\n'.repeat(100) + '```\n' + 'code\n'.repeat(20_000);
        expect(previewSource(huge2).endsWith('\n```')).toBe(true);
    });
});
