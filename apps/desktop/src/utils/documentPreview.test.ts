/**
 * Received documents are previewed within fixed limits: a crafted .xlsx used to
 * freeze the renderer for 30+ s and take over a gigabyte (the "zip whose sheet
 * inflates to tens of megabytes" shape built below).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
    AUTO_INFLATE_LIMITS, AUTO_PREVIEW_MAX_BYTES, MANUAL_PREVIEW_MAX_BYTES, MANUAL_INFLATE_LIMITS,
    PREVIEW_KEEP_COLS, PREVIEW_KEEP_ROWS,
    csvPreview, previewGate, sheetsPreview, zipInflateProblem, cellText,
} from './documentPreview';
import { parseDocumentPreview, __setDocumentPreviewWorkerFactory, type PreviewWorkerLike } from './documentPreviewHost';

const toArrayBuffer = (b: Uint8Array | ArrayBuffer): ArrayBuffer =>
    b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function realXlsx(rows: unknown[][], sheets = 1): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    for (let s = 0; s < sheets; s++) {
        const ws = wb.addWorksheet(`S${s + 1}`);
        for (const r of rows) ws.addRow(r);
    }
    return toArrayBuffer(new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer));
}

/** The audit's shape: a tiny zip whose one sheet inflates to `mb` megabytes. */
async function inflatingXlsx(mb: number): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    const row = '<row r="1"><c r="A1"><v>1</v></c></row>';
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>' + row.repeat(Math.floor(mb * 1024 * 1024 / row.length)) + '</sheetData></worksheet>');
    return toArrayBuffer(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
}

describe('previewGate', () => {
    it('auto-previews small files, asks above the auto limit, refuses above the manual limit', () => {
        expect(previewGate(1024, false)).toEqual({ state: 'auto' });
        expect(previewGate(AUTO_PREVIEW_MAX_BYTES, false)).toEqual({ state: 'auto' });
        expect(previewGate(AUTO_PREVIEW_MAX_BYTES + 1, false)).toEqual({ state: 'ask', bytes: AUTO_PREVIEW_MAX_BYTES + 1 });
        expect(previewGate(AUTO_PREVIEW_MAX_BYTES + 1, true)).toEqual({ state: 'auto' });
        expect(previewGate(MANUAL_PREVIEW_MAX_BYTES + 1, true).state).toBe('too_large');
        expect(previewGate(Number.NaN, true).state).toBe('too_large');
    });
});

describe('zipInflateProblem', () => {
    it('passes a real workbook', async () => {
        expect(zipInflateProblem(await realXlsx([['a', 'b'], [1, 2]]), AUTO_INFLATE_LIMITS)).toBeNull();
    });

    it('refuses a small zip that inflates past the cap, without inflating it', async () => {
        const bomb = await inflatingXlsx(20);
        expect(bomb.byteLength).toBeLessThan(AUTO_PREVIEW_MAX_BYTES); // passes the size gate…
        const t = performance.now();
        expect(zipInflateProblem(bomb, AUTO_INFLATE_LIMITS)).toMatch(/inflates/); // …but not this one
        expect(zipInflateProblem(bomb, MANUAL_INFLATE_LIMITS)).toBeNull();
        expect(performance.now() - t).toBeLessThan(50);
    });

    it('refuses a highly compressed document automatically, but not on request', async () => {
        const dense = await inflatingXlsx(5); // ~330:1, under the 8 MB total
        expect(zipInflateProblem(dense, AUTO_INFLATE_LIMITS)).toMatch(/inflates/);
        expect(zipInflateProblem(dense, MANUAL_INFLATE_LIMITS)).toBeNull();
        expect(zipInflateProblem(await inflatingXlsx(0.5), AUTO_INFLATE_LIMITS)).toBeNull(); // under the ratio floor
    });

    it('refuses non-zips, truncated directories and zip64 markers; never throws', () => {
        expect(zipInflateProblem(new ArrayBuffer(10), { maxInflated: 1e9 })).toBe('not a zip');
        expect(zipInflateProblem(new TextEncoder().encode('just text, no zip here at all').buffer as ArrayBuffer, { maxInflated: 1e9 })).toBe('not a zip');
        const eocdOnly = new Uint8Array(22);
        new DataView(eocdOnly.buffer).setUint32(0, 0x06054b50, true);
        new DataView(eocdOnly.buffer).setUint16(10, 0xffff, true);
        expect(zipInflateProblem(eocdOnly.buffer, { maxInflated: 1e9 })).toMatch(/zip64/);
        const lying = new Uint8Array(22);
        const v = new DataView(lying.buffer);
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(10, 3, true);
        v.setUint32(12, 100, true);
        v.setUint32(16, 0, true);
        expect(zipInflateProblem(lying.buffer, { maxInflated: 1e9 })).toMatch(/out of range/);
        for (let k = 0; k < 200; k++) {
            const junk = new Uint8Array(64).map((_, i) => (i * 37 + k * 11) & 0xff);
            new DataView(junk.buffer).setUint32(42, 0x06054b50, true);
            expect(() => zipInflateProblem(junk.buffer, { maxInflated: 1e9 })).not.toThrow();
        }
    });
});

describe('sheetsPreview keeps only what the card shows', () => {
    it('first rows and columns, with full counts', async () => {
        const rows = Array.from({ length: 50 }, (_, r) => Array.from({ length: 20 }, (_, c) => `r${r}c${c}`));
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await realXlsx(rows, 2));
        const out = sheetsPreview(wb as never);
        expect(out).toHaveLength(2);
        expect(out[0].name).toBe('S1');
        expect(out[0].totalRows).toBe(50);
        expect(out[0].totalCols).toBe(20);
        expect(out[0].rows).toHaveLength(PREVIEW_KEEP_ROWS);
        expect(out[0].rows[0]).toHaveLength(PREVIEW_KEEP_COLS);
        expect(out[0].rows[1][2]).toBe('r1c2');
    });

    it('cell values render as before (dates, rich text, formulas, errors)', () => {
        expect(cellText(null)).toBe('');
        expect(cellText(3)).toBe('3');
        expect(cellText({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
        expect(cellText({ formula: 'A1', result: 7 })).toBe('7');
        expect(cellText({ error: '#DIV/0!' })).toBe('#DIV/0!');
        expect(cellText('x'.repeat(10_000)).length).toBe(200);
    });
});

describe('csvPreview', () => {
    it('parses quotes and the delimiter as before, keeps the first rows, counts all', () => {
        const text = 'a,b,"c,d"\n1,"say ""hi""",3\n\n' + Array.from({ length: 30 }, (_, i) => `${i},x`).join('\n');
        const p = csvPreview(text, ',', false);
        expect(p.rows[0]).toEqual(['a', 'b', 'c,d']);
        expect(p.rows[1]).toEqual(['1', 'say "hi"', '3']);
        expect(p.totalRows).toBe(32);
        expect(p.totalCols).toBe(3);
        expect(p.rows).toHaveLength(PREVIEW_KEEP_ROWS);
    });

    it('drops the partial last line of a truncated read', () => {
        const p = csvPreview('a,b\nc,d\ne,', ',', true);
        expect(p.totalRows).toBe(2);
        expect(p.truncated).toBe(true);
    });

    it('is linear on a hostile file (one 256 KiB quoted cell)', () => {
        const t = performance.now();
        csvPreview('"' + 'x'.repeat(256 * 1024), ',', true);
        csvPreview(','.repeat(256 * 1024), ',', false);
        expect(performance.now() - t).toBeLessThan(200);
    });
});

// ── the worker host ─────────────────────────────────────────────────────────

class FakeWorker implements PreviewWorkerLike {
    onmessage: PreviewWorkerLike['onmessage'] = null;
    onerror: PreviewWorkerLike['onerror'] = null;
    terminated = false;
    private readonly reply: ((w: FakeWorker) => void) | null;
    constructor(reply: ((w: FakeWorker) => void) | null) { this.reply = reply; }
    postMessage(): void { if (this.reply) setTimeout(() => this.reply!(this), 0); }
    terminate(): void { this.terminated = true; }
}

afterEach(() => { __setDocumentPreviewWorkerFactory(null); vi.useRealTimers(); });

describe('parseDocumentPreview', () => {
    it('returns the worker\'s answer and terminates it', async () => {
        const w = new FakeWorker(self => self.onmessage?.({ data: { ok: true, kind: 'word', text: 'hello' } } as MessageEvent));
        __setDocumentPreviewWorkerFactory(async () => w);
        expect(await parseDocumentPreview('word', new ArrayBuffer(8), { maxInflated: 1 })).toEqual({ ok: true, kind: 'word', text: 'hello' });
        expect(w.terminated).toBe(true);
    });

    it('gives up after the timeout and terminates the worker (a parser stuck inflating)', async () => {
        vi.useFakeTimers();
        const w = new FakeWorker(null);
        __setDocumentPreviewWorkerFactory(async () => w);
        const p = parseDocumentPreview('excel', new ArrayBuffer(8), { maxInflated: 1 }, 1000);
        await vi.advanceTimersByTimeAsync(1001);
        expect(await p).toMatchObject({ ok: false, reason: 'timeout' });
        expect(w.terminated).toBe(true);
    });

    it('a worker that cannot start means no preview, never a main-thread parse', async () => {
        __setDocumentPreviewWorkerFactory(async () => { throw new Error('blocked'); });
        expect(await parseDocumentPreview('excel', new ArrayBuffer(8), { maxInflated: 1 })).toMatchObject({ ok: false, reason: 'unavailable' });
    });
});

// ── the worker itself, run in-process ────────────────────────────────────────

describe('documentPreview.worker', () => {
    it('parses a real workbook and refuses the inflating one before parsing', async () => {
        const posted: unknown[] = [];
        const g = globalThis as unknown as { self?: unknown };
        const prevSelf = g.self;
        const fakeSelf: { postMessage: (m: unknown) => void; onmessage?: (e: { data: unknown }) => Promise<void> } = { postMessage: m => posted.push(m) };
        g.self = fakeSelf;
        try {
            vi.resetModules();
            await import('../workers/documentPreview.worker');
            await fakeSelf.onmessage!({ data: { kind: 'excel', buf: await realXlsx([['h1', 'h2'], [1, 2]]), limits: AUTO_INFLATE_LIMITS } });
            await fakeSelf.onmessage!({ data: { kind: 'excel', buf: await inflatingXlsx(20), limits: AUTO_INFLATE_LIMITS } });
        } finally {
            g.self = prevSelf;
        }
        expect(posted[0]).toMatchObject({ ok: true, kind: 'excel', sheets: [{ name: 'S1', totalRows: 2, rows: [['h1', 'h2'], ['1', '2']] }] });
        expect(posted[1]).toMatchObject({ ok: false, reason: 'limits' });
    }, 30_000);
});
