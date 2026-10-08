import { describe, it, expect, beforeEach, vi } from 'vitest';

// axios reads window.location at import time, which this Node test env lacks;
// nothing here makes a request.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
import { rendererMemoryLine, type MemorySources } from './memoryReport';
import { putDecryptedMedia, releaseDecryptedMedia, clearDecryptedMediaCache, putMediaThumb } from './decryptedMediaCache';
import { formatFreezeReport } from './freezeLog';

const fake: MemorySources = {
    jsHeap: () => ({ used: 41 * 1048576, total: 60 * 1048576 }),
    dom: () => ({ nodes: 2400, images: 37, imagePixels: 9_400_000, canvases: 0, videos: 1 }),
};

describe('rendererMemoryLine — the Performance log memory snapshot', () => {
    beforeEach(() => clearDecryptedMediaCache());

    it('names every resident cache with a size, counts only', () => {
        putDecryptedMedia('att-1', 'blob:x-1', 3 * 1048576);
        putDecryptedMedia('att-2', 'blob:x-2', 1 * 1048576);
        releaseDecryptedMedia('att-2');
        putMediaThumb('blob:x-1', 'blob:t-1', 512 * 1024, 320, 200);
        const line = rendererMemoryLine(fake);
        expect(line).toContain('js 41/60MB');
        expect(line).toContain('dom 2400 nodes, 37 img 9.4MP, 0 canvas, 1 video');
        expect(line).toContain('media 4.0MB/2 (1 held)');
        expect(line).toContain('thumbs 0.5MB/1');
        expect(line).toMatch(/link-img [\d.]+MB\/\d+/);
        expect(line).toMatch(/avatars [\d.]+MB\/\d+/);
        expect(line).toMatch(/emoji [\d.]+MB\/\d+/);
        expect(line).toMatch(/history \d+ threads\/\d+ msgs/);
    });

    it('carries no ids, urls or names — only the fixed labels and numbers', () => {
        putDecryptedMedia('secret-attachment-id', 'blob:http://127.0.0.1/secret-url', 1024);
        const line = rendererMemoryLine(fake);
        expect(line).not.toMatch(/secret|blob:|http/);
        expect(line).toMatch(/^renderer now: [a-z0-9 _.,:/()|-]+$/i);
    });

    it('without performance.memory it still reports the rest', () => {
        expect(rendererMemoryLine({ ...fake, jsHeap: () => null })).toContain('js n/a');
    });

    it('rides in the copied report right under the header, and only when given', () => {
        const meta = { version: '1.0.17', platform: 'win32' };
        const withLine = formatFreezeReport([], { ...meta, memory: rendererMemoryLine(fake) });
        expect(withLine.split('\n')[1]).toMatch(/^renderer now: /);
        expect(formatFreezeReport([], meta)).not.toContain('renderer now');
    });
});
