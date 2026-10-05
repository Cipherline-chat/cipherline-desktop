import { describe, it, expect } from 'vitest';
import { thumbnailJpegDataUrl, THUMBNAIL_JPEG_QUALITY, EMPTY_THUMBNAIL_DATA_URL } from './thumbnailDataUrl';

describe('thumbnailJpegDataUrl', () => {
    it('encodes as a JPEG data URL at the fixed quality', () => {
        let q = -1;
        const url = thumbnailJpegDataUrl({ isEmpty: () => false, toJPEG: (quality) => { q = quality; return Buffer.from([0xff, 0xd8, 0xff]); } });
        expect(url).toBe('data:image/jpeg;base64,/9j/');
        expect(q).toBe(THUMBNAIL_JPEG_QUALITY);
    });

    it('an empty thumbnail yields what toDataURL() always returned for it, without encoding', () => {
        expect(thumbnailJpegDataUrl({ isEmpty: () => true, toJPEG: () => { throw new Error('must not encode'); } })).toBe(EMPTY_THUMBNAIL_DATA_URL);
        expect(EMPTY_THUMBNAIL_DATA_URL).toBe('data:image/png;base64,');
    });
});
