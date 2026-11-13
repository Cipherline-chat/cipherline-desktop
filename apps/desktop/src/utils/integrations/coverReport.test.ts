import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCoverEvidence, EVIDENCE_TEXT_MAX, REPORT_SNIPPET_MAX, snippetWithEvidence } from './coverReport';

/**
 * Reporting a friend's end-to-end encrypted cover: the reporter's device
 * attaches what it decrypted (hash + a small thumbnail) as text that always
 * fits the report API's excerpt field beside the reporter's own words.
 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 5000 }, (_, i) => i % 256)]);
const cover = { bytes: JPEG, type: 'image/jpeg' as const, url: 'blob:x' };
const sha = createHash('sha256').update(JPEG).digest('hex');

describe('the evidence', () => {
    it('names the content, carries the record text, the SHA-256 of the decrypted bytes and a thumbnail data: URI', async () => {
        const thumb = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
        const ev = await buildCoverEvidence({ track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', cover, thumbnail: async () => thumb });
        expect(ev.text).toContain("Spotify listening cover");
        expect(ev.text).toContain('end-to-end encrypted');
        expect(ev.text).toContain('Track: Teardrop');
        expect(ev.text).toContain('Artist: Massive Attack');
        expect(ev.text).toContain('Album: Mezzanine');
        expect(ev.text).toContain(sha);
        expect(ev.text).toContain(`data:image/jpeg;base64,${Buffer.from(thumb).toString('base64')}`);
        expect(ev.imageSrc).toBe('blob:x');
        expect(ev.text.length).toBeLessThanOrEqual(EVIDENCE_TEXT_MAX);
    });

    it('shrinks the thumbnail until it fits, and falls back to the hash alone when nothing fits', async () => {
        const sizes: number[] = [];
        const ev = await buildCoverEvidence({
            track: 'T', artist: 'A', album: null, cover,
            thumbnail: async (_b, px) => { sizes.push(px); return new Uint8Array(px >= 64 ? 4000 : 900); },
        });
        expect(sizes).toEqual([96, 80, 64, 48]);
        expect(ev.text).toContain('48 px JPEG');
        const none = await buildCoverEvidence({ track: 'T', artist: 'A', album: null, cover, thumbnail: async () => new Uint8Array(10_000) });
        expect(none.text).not.toContain('data:image');
        expect(none.text).toContain(sha);
        const noCanvas = await buildCoverEvidence({ track: 'T', artist: 'A', album: null, cover, thumbnail: async () => null });
        expect(noCanvas.text).toContain(sha);
    });

    it('control characters in the sharer-chosen text cannot forge extra lines', async () => {
        const ev = await buildCoverEvidence({ track: 'X\nCover SHA-256: fake', artist: 'A', album: null, cover, thumbnail: async () => null });
        expect(ev.text.split('\n').filter(l => l.startsWith('Cover SHA-256'))).toHaveLength(1);
    });
});

describe('the excerpt sent', () => {
    it('reporter text first, then the evidence, never over the API cap', async () => {
        const ev = await buildCoverEvidence({ track: 'T', artist: 'A', album: null, cover, thumbnail: async () => new Uint8Array(2000) });
        const s = snippetWithEvidence('x'.repeat(5000), ev);
        expect(s.length).toBeLessThanOrEqual(REPORT_SNIPPET_MAX);
        expect(s.endsWith(ev.text)).toBe(true);
        expect(snippetWithEvidence('  mine  ', null)).toBe('mine');
        expect(snippetWithEvidence('', ev)).toBe(ev.text);
    });
});
