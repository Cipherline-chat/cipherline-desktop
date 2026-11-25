import { describe, it, expect } from 'vitest';
import { MediaRegistry } from './media-registry';

let n = 0;
const seq = () => (++n).toString(16).padStart(32, '0');

describe('MediaRegistry', () => {
    it('hands out clmedia://media/<128-bit token> and looks it up', () => {
        const r = new MediaRegistry();
        const src = r.register('https://cdn.example/a.mp4', 'video');
        expect(src).toMatch(/^clmedia:\/\/media\/[0-9a-f]{32}$/);
        expect(r.lookup(src)).toMatchObject({ url: 'https://cdn.example/a.mp4', kind: 'video' });
    });

    it('the same URL+kind keeps its token; a different kind gets another', () => {
        const r = new MediaRegistry(8, seq);
        const a = r.register('https://cdn.example/a.mp4', 'video');
        expect(r.register('https://cdn.example/a.mp4', 'video')).toBe(a);
        expect(r.register('https://cdn.example/a.mp4', 'image')).not.toBe(a);
    });

    it('is bounded: the least recently registered entry is forgotten', () => {
        const r = new MediaRegistry(2, seq);
        const a = r.register('https://cdn.example/a.mp4', 'video');
        const b = r.register('https://cdn.example/b.mp4', 'video');
        r.register('https://cdn.example/a.mp4', 'video'); // touch a
        const c = r.register('https://cdn.example/c.mp4', 'video');
        expect(r.size).toBe(2);
        expect(r.lookup(b)).toBeNull();
        expect(r.lookup(a)).not.toBeNull();
        expect(r.lookup(c)).not.toBeNull();
        // Re-registering an evicted URL works (new token).
        expect(r.lookup(r.register('https://cdn.example/b.mp4', 'video'))).not.toBeNull();
    });

    it('refuses what clmedia must never stream', () => {
        const r = new MediaRegistry();
        for (const bad of ['http://cdn.example/a.mp4', 'file:///etc/passwd', 'https://u:p@cdn.example/a.mp4', 'clmedia://media/x', '', 5, null]) {
            expect(() => r.register(bad, 'video'), String(bad)).toThrow();
        }
        expect(() => r.register('https://cdn.example/a.mp4', 'audio')).toThrow();
        expect(() => r.register('https://evil.example/a.mp4', 'video', (h) => h === 'cdn.medal.tv')).toThrow(/Host not allowed/);
        expect(r.size).toBe(0);
    });

    it('lookup: only exact clmedia://media/<token> of a registered entry', () => {
        const r = new MediaRegistry(8, seq);
        const src = r.register('https://cdn.example/a.mp4', 'video');
        const token = src.split('/').pop()!;
        for (const bad of [
            `clmedia://other/${token}`, `https://media/${token}`, `clmedia://media/${token}x`, 'clmedia://media/',
            `clmedia://media/${'f'.repeat(32)}`, 'clmedia://media/https://cdn.example/a.mp4', 'not a url',
        ]) {
            expect(r.lookup(bad), bad).toBeNull();
        }
        expect(r.lookup(`clmedia://media/${token}?x=1`)).not.toBeNull(); // query ignored, token still exact
    });
});
