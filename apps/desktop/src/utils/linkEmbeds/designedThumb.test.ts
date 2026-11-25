/**
 * The designed card picture (embeds-always-thumb, step 5): its letter, a
 * stable colour per site, the page colour when it is a real one, and the two
 * layouts (centred for a card; lower-left for a video poster so the play
 * button never covers the tile). Drawn onto a recording fake 2D context (Node
 * has no canvas); the real pixels are in the real-Electron harness shots.
 */
import { describe, it, expect } from 'vitest';
import { designAccent, designLetter, drawDesigned, labelHue, designedThumb, designedPictureUrl, DESIGNED_W, DESIGNED_H } from './designedThumb';

function recorder() {
    const calls: { op: string; args: unknown[]; fillStyle?: unknown; font?: unknown }[] = [];
    const ctx: Record<string, unknown> = { fillStyle: '', font: '', globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic' };
    for (const op of ['fillRect', 'fillText', 'beginPath', 'moveTo', 'arcTo', 'closePath', 'fill', 'clip', 'save', 'restore', 'drawImage']) {
        ctx[op] = (...args: unknown[]) => { calls.push({ op, args, fillStyle: ctx.fillStyle, font: ctx.font }); };
    }
    ctx.measureText = (t: string) => ({ width: t.length * 10 });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('designed picture: what goes on it', () => {
    it('the first letter / digit of the site, www. dropped', () => {
        expect(designLetter('www.bbc.com')).toBe('B');
        expect(designLetter('medal')).toBe('M');
        expect(designLetter('8bit.io')).toBe('8');
        expect(designLetter('—')).toBe('•');
    });
    it('a stable colour per site (www. and case ignored), and different sites differ', () => {
        expect(labelHue('Example.com')).toBe(labelHue('www.example.com'));
        expect(new Set(['medal', 'example.com', 'twitch', 'tiktok', 'bbc.com', 'cdn.example'].map(labelHue)).size).toBeGreaterThan(4);
    });
    it('the page colour when it says something; near-white / near-black / malformed → the site colour', () => {
        expect(designAccent({ label: 'a', color: '#ff4655' })).toBe('#ff4655');
        const own = designAccent({ label: 'a' });
        expect(own).toMatch(/^#[0-9a-f]{6}$/);
        for (const c of ['#ffffff', '#000000', '#fefefe', 'red', undefined]) expect(designAccent({ label: 'a', color: c })).toBe(own);
    });
});

describe('drawDesigned', () => {
    it('card: background, the faint letter, the tile with the letter and the site name, centred', () => {
        const { ctx, calls } = recorder();
        drawDesigned(ctx, DESIGNED_W, DESIGNED_H, { label: 'example.com' });
        expect(calls[0]).toMatchObject({ op: 'fillRect', args: [0, 0, 640, 360] });
        const texts = calls.filter((c) => c.op === 'fillText').map((c) => c.args);
        expect(texts.map((t) => t[0])).toEqual(['E', 'E', 'example.com']);
        // Tile letter and name are centred horizontally.
        expect(texts[1][1]).toBe(320);
        expect(texts[2][1]).toBe(320);
        expect(calls.some((c) => c.op === 'drawImage')).toBe(false);
    });
    it('video poster: tile and name at the lower left (the play button owns the middle)', () => {
        const { ctx, calls } = recorder();
        drawDesigned(ctx, DESIGNED_W, DESIGNED_H, { label: 'Medal', play: true });
        const [, tileLetter, name] = calls.filter((c) => c.op === 'fillText').map((c) => c.args as [string, number, number]);
        expect(tileLetter[1]).toBeLessThan(120);
        expect(tileLetter[2]).toBeGreaterThan(250);
        expect(name[0]).toBe('Medal');
        expect(name[1]).toBeGreaterThan(tileLetter[1]);
    });
    it('with the site icon: drawn on a white plate, no tile letter', () => {
        const { ctx, calls } = recorder();
        const icon = { width: 64, height: 64 } as unknown as CanvasImageSource;
        drawDesigned(ctx, DESIGNED_W, DESIGNED_H, { label: 'amazon.com', icon });
        const fills = calls.filter((c) => c.op === 'fill');
        expect(fills[0].fillStyle).toBe('#ffffff');
        expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(1);
        expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[0])).toEqual(['A', 'amazon.com']);
    });
    it('a long name is cut with an ellipsis to fit', () => {
        const { ctx, calls } = recorder();
        drawDesigned(ctx, DESIGNED_W, DESIGNED_H, { label: 'a-very-long-subdomain.of-an-extremely-long-example-domain.example' });
        const name = calls.filter((c) => c.op === 'fillText').pop()!.args[0] as string;
        expect(name.endsWith('…')).toBe(true);
        expect(name.length * 10).toBeLessThanOrEqual(640 * 0.8 + 10);
    });
});

describe('where there is no canvas (tests, a broken GPU)', () => {
    it('the sender gets null (the chain sends no picture rather than failing) and the reader null (its own fallback)', async () => {
        expect(await designedThumb({ label: 'x' })).toBeNull();
        expect(designedPictureUrl({ label: 'x' })).toBeNull();
    });
});
