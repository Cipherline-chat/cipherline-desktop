import { describe, it, expect } from 'vitest';
import { validateEmojiUpload, EMOJI_MAX_BYTES } from './imageUploadValidation';

/** Mirrors AttachmentsService's own emoji upload validation exactly — see
 *  docs/custom-emoji-design.md. This is a client-side pre-check only; the
 *  server enforces the same rules regardless. */

function fileOf(type: string, size: number): File {
    const file = new File([new Uint8Array(size)], 'pick.bin', { type });
    return file;
}

describe('validateEmojiUpload', () => {
    it('accepts a small PNG', () => {
        const res = validateEmojiUpload(fileOf('image/png', 1024));
        expect(res.ok).toBe(true);
    });

    it('accepts an animated GIF within the cap', () => {
        const res = validateEmojiUpload(fileOf('image/gif', EMOJI_MAX_BYTES - 1));
        expect(res.ok).toBe(true);
    });

    it('rejects no file', () => {
        const res = validateEmojiUpload(undefined);
        expect(res.ok).toBe(false);
    });

    it('rejects a non-image MIME type', () => {
        const res = validateEmojiUpload(fileOf('application/pdf', 1024));
        expect(res.ok).toBe(false);
    });

    it('rejects SVG (excluded even though it is technically an image MIME)', () => {
        const res = validateEmojiUpload(fileOf('image/svg+xml', 1024));
        expect(res.ok).toBe(false);
    });

    it('rejects a file over the 5 MiB cap, even one well under the 10 MiB avatar cap', () => {
        const res = validateEmojiUpload(fileOf('image/png', EMOJI_MAX_BYTES + 1));
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toContain('5.0 MB');
    });

    it('accepts a file exactly at the cap boundary', () => {
        const res = validateEmojiUpload(fileOf('image/png', EMOJI_MAX_BYTES));
        expect(res.ok).toBe(true);
    });
});
