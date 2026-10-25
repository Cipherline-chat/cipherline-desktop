import { describe, it, expect } from 'vitest';
import { qrMatrix, shareLinkFor } from './shareCard';

describe('share card', () => {
    it('links to the invite page for a well-formed code, else to the site (never builds a URL from garbage)', () => {
        expect(shareLinkFor('7C41E9A2')).toEqual({ url: 'https://cipherline.chat/ref/7C41E9A2', label: 'cipherline.chat/ref/7C41E9A2' });
        for (const bad of [null, undefined, '', 'a/b', '../x', 'x'.repeat(40), 'café']) {
            expect(shareLinkFor(bad as string | null).url).toBe('https://cipherline.chat');
        }
    });

    it('encodes the link as a real QR symbol (finder patterns in three corners)', () => {
        const m = qrMatrix('https://cipherline.chat/ref/7C41E9A2');
        expect(m.size).toBeGreaterThanOrEqual(21);
        expect((m.size - 17) % 4).toBe(0);
        for (const [r, c] of [[0, 0], [0, m.size - 7], [m.size - 7, 0]]) {
            // 7x7 ring, then a light ring, then the 3x3 core
            expect(m.dark(r, c) && m.dark(r + 6, c + 6) && m.dark(r + 3, c + 3)).toBe(true);
            expect(m.dark(r + 1, c + 1)).toBe(false);
        }
    });
});
