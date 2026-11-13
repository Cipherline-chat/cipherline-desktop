import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

const { REPORT_IMAGE_MAX_BYTES, REPORT_IMAGE_MAX_COUNT, pickReportImages, reportedFileProblem, sniffReportImageType, uploadReportEvidence } =
    await import('./reportEvidenceFiles');

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0)));
const GIF = [...'GIF89a'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0, 0, 0]);
const file = (bytes: number[], name = 'a.png', type = 'image/png', pad = 0) =>
    new File([new Uint8Array([...bytes, ...new Array(pad).fill(0)])], name, { type });

beforeEach(() => { post.mockReset(); });

describe('sniffReportImageType', () => {
    it('PNG, JPEG and WebP by their first bytes', () => {
        expect(sniffReportImageType(new Uint8Array(PNG))).toBe('image/png');
        expect(sniffReportImageType(new Uint8Array(JPG))).toBe('image/jpeg');
        expect(sniffReportImageType(new Uint8Array(WEBP))).toBe('image/webp');
    });
    it('not GIF, not SVG, not text, not short input', () => {
        expect(sniffReportImageType(new Uint8Array(GIF))).toBeNull();
        expect(sniffReportImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
        expect(sniffReportImageType(new TextEncoder().encode('hello world, this is text'))).toBeNull();
        expect(sniffReportImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    });
});

describe('pickReportImages', () => {
    it('accepts real images whatever their name or declared type says', async () => {
        const r = await pickReportImages(0, [file(JPG, 'shot.png', 'image/png'), file(WEBP, 'x.bin', '')]);
        expect(r.problems).toEqual([]);
        expect(r.accepted.map(a => a.type)).toEqual(['image/jpeg', 'image/webp']);
    });

    it('refuses a file that only CLAIMS to be an image', async () => {
        const r = await pickReportImages(0, [file([...'not an image at all'].map(c => c.charCodeAt(0)), 'evil.png', 'image/png')]);
        expect(r.accepted).toHaveLength(0);
        expect(r.problems[0]).toMatch(/evil\.png is not a PNG, JPEG or WebP/);
    });

    it('refuses a GIF', async () => {
        const r = await pickReportImages(0, [file(GIF, 'a.gif', 'image/gif')]);
        expect(r.accepted).toHaveLength(0);
    });

    it('refuses over 8 MB, accepts exactly 8 MB', async () => {
        const big = file(PNG, 'big.png', 'image/png', REPORT_IMAGE_MAX_BYTES + 1 - PNG.length);
        const ok = file(PNG, 'ok.png', 'image/png', REPORT_IMAGE_MAX_BYTES - PNG.length);
        expect(big.size).toBe(REPORT_IMAGE_MAX_BYTES + 1);
        expect(ok.size).toBe(REPORT_IMAGE_MAX_BYTES);
        const r = await pickReportImages(0, [big, ok]);
        expect(r.problems[0]).toMatch(/larger than 8 MB/);
        expect(r.accepted.map(a => a.file.name)).toEqual(['ok.png']);
    });

    it('allows at most 4 in total, counting what is already attached', async () => {
        const five = Array.from({ length: 5 }, (_, i) => file(PNG, `s${i}.png`));
        const first = await pickReportImages(0, five);
        expect(first.accepted).toHaveLength(REPORT_IMAGE_MAX_COUNT);
        expect(first.problems).toHaveLength(1);
        const more = await pickReportImages(3, [file(PNG, 'a.png'), file(PNG, 'b.png')]);
        expect(more.accepted).toHaveLength(1);
        expect((await pickReportImages(4, [file(PNG)])).accepted).toHaveLength(0);
    });
});

describe('uploadReportEvidence', () => {
    it('posts the raw bytes with the sniffed type, to the report, with the kind', async () => {
        post.mockResolvedValue({ data: {} });
        const blob = file(PNG);
        expect(await uploadReportEvidence({ reportId: 'r 1', kind: 'screenshot', blob, type: 'image/png', token: 'T' })).toBe(true);
        const [url, body, cfg] = post.mock.calls[0];
        expect(url).toMatch(/\/reports\/r%201\/evidence\?kind=screenshot$/);
        expect(body).toBe(blob);
        expect(cfg.headers).toEqual({ Authorization: 'Bearer T', 'Content-Type': 'image/png' });
    });

    it('resolves false (never throws) when the server refuses', async () => {
        post.mockImplementation(async () => { throw new Error('413'); });
        expect(await uploadReportEvidence({ reportId: 'r', kind: 'attachment', blob: file(PNG), type: 'image/png', token: 'T' })).toBe(false);
    });
});

describe('reportedFileProblem', () => {
    it.each(['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG', 'image/png; charset=binary'])('%s can be sent', (mime) => {
        expect(reportedFileProblem({ mime, byte_size: 10 })).toBeNull();
    });
    it.each(['video/mp4', 'video/webm', 'image/gif', 'image/svg+xml', 'application/pdf', 'audio/mpeg', '', 'image/png.exe'])('%j is the wrong type', (mime) => {
        expect(reportedFileProblem({ mime, byte_size: 10 })).toBe('type');
    });
    it('a missing file or type is refused, not assumed fine', () => {
        expect(reportedFileProblem(undefined)).toBe('type');
        expect(reportedFileProblem({ byte_size: 10 })).toBe('type');
    });
    it('the size limit is exact: at the limit is fine, one byte over is not', () => {
        expect(reportedFileProblem({ mime: 'image/png', byte_size: REPORT_IMAGE_MAX_BYTES })).toBeNull();
        expect(reportedFileProblem({ mime: 'image/png', byte_size: REPORT_IMAGE_MAX_BYTES + 1 })).toBe('size');
    });
});
