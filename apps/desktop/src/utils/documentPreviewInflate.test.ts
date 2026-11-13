/**
 * Audit run 2, lead 12 — the inflate cap must hold on what a zip's entries
 * REALLY inflate to, not on the sizes its central directory declares. Real
 * jszip builds the archives (expansion kept to a few MiB / 64 MiB of zeros,
 * never gigabytes); the central directory is then rewritten to lie.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AUTO_INFLATE_LIMITS, MANUAL_INFLATE_LIMITS, zipInflateProblem, zipActualInflateProblem } from './documentPreview';

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

/** Rewrite the declared uncompressed size of the central-directory entry called `name`. */
function declareSize(zip: ArrayBuffer, name: string, size: number): ArrayBuffer {
    const out = zip.slice(0);
    const v = new DataView(out);
    const bytes = new Uint8Array(out);
    let eocd = out.byteLength - 22;
    while (v.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const entries = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    let hit = false;
    for (let k = 0; k < entries; k++) {
        const nameLen = v.getUint16(p + 28, true);
        const n = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
        if (n === name) { v.setUint32(p + 24, size, true); hit = true; }
        p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    if (!hit) throw new Error(`no entry ${name}`);
    return out;
}

/** A valid-looking package plus one decoy entry of `mb` MiB of zeros (deflates ~1000:1). */
async function packageWithDecoy(mb: number, method: 'DEFLATE' | 'STORE' = 'DEFLATE'): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('docProps/decoy.bin', new Uint8Array(mb * 1024 * 1024), { compression: method, compressionOptions: { level: 1 } });
    return toArrayBuffer(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

const DECOY = 'docProps/decoy.bin';

describe('a zip that lies about its sizes', () => {
    it('CLAIM VERIFIED: the declared-size pre-check passes a decoy declaring 100 bytes that inflates to MiBs', async () => {
        const honest = await packageWithDecoy(6);
        const lying = declareSize(honest, DECOY, 100);
        expect(honest.byteLength).toBeLessThan(64 * 1024); // 6 MiB of zeros in a few KB
        expect(zipInflateProblem(lying, AUTO_INFLATE_LIMITS)).toBeNull(); // blind to the lie
    });

    it('is rejected by the actual-bytes check, quickly and without holding the expansion', async () => {
        const lying = declareSize(await packageWithDecoy(64), DECOY, 100); // 64 MiB of zeros declared as 100 bytes
        expect(zipInflateProblem(lying, AUTO_INFLATE_LIMITS)).toBeNull();
        const before = process.memoryUsage().arrayBuffers;
        const t = performance.now();
        expect(await zipActualInflateProblem(lying, AUTO_INFLATE_LIMITS)).toBe('entry size does not match the central directory');
        expect(performance.now() - t).toBeLessThan(2000);
        expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024); // aborted after a chunk, not 64 MiB
    }, 60_000);

    it('an entry that declares MORE than it holds is refused too (declared != actual either way)', async () => {
        const over = declareSize(await packageWithDecoy(1), DECOY, 3 * 1024 * 1024);
        expect(zipInflateProblem(over, MANUAL_INFLATE_LIMITS)).toBeNull(); // (the auto ratio gate would catch this one on its own)
        expect(await zipActualInflateProblem(over, MANUAL_INFLATE_LIMITS)).toMatch(/does not match/);
    });

    it('a corrupt deflate stream is refused, never thrown', async () => {
        const z = new Uint8Array(await packageWithDecoy(1));
        for (let i = 100; i < 140 && i < z.length; i++) z[i] = 0xff;
        await expect(zipActualInflateProblem(z.buffer as ArrayBuffer, AUTO_INFLATE_LIMITS)).resolves.toEqual(expect.any(String));
    });

    it('the worker refuses the lying file before exceljs sees it, and still parses the honest one', async () => {
        const posted: unknown[] = [];
        const g = globalThis as unknown as { self?: unknown };
        const prevSelf = g.self;
        const fakeSelf: { postMessage: (m: unknown) => void; onmessage?: (e: { data: unknown }) => Promise<void> } = { postMessage: m => posted.push(m) };
        g.self = fakeSelf;
        try {
            vi.resetModules();
            await import('../workers/documentPreview.worker');
            await fakeSelf.onmessage!({ data: { kind: 'excel', buf: declareSize(await packageWithDecoy(8), DECOY, 100), limits: AUTO_INFLATE_LIMITS } });
            await fakeSelf.onmessage!({ data: { kind: 'excel', buf: await realXlsx([['h1', 'h2'], [1, 2]]), limits: AUTO_INFLATE_LIMITS } });
        } finally {
            g.self = prevSelf;
        }
        expect(posted[0]).toMatchObject({ ok: false, reason: 'limits', message: expect.stringMatching(/does not match/) });
        expect(posted[1]).toMatchObject({ ok: true, kind: 'excel', sheets: [{ name: 'S1', totalRows: 2 }] });
    }, 30_000);
});

describe('honest files and the stored-entry control', () => {
    it('real workbooks pass (auto and manual limits)', async () => {
        const x = await realXlsx([['a', 'b'], [1, 2]], 3);
        expect(await zipActualInflateProblem(x, AUTO_INFLATE_LIMITS)).toBeNull();
        expect(await zipActualInflateProblem(x, MANUAL_INFLATE_LIMITS)).toBeNull();
        const big = await realXlsx(Array.from({ length: 2000 }, (_, r) => Array.from({ length: 10 }, (_, c) => `cell ${r}/${c}`)));
        expect(zipInflateProblem(big, AUTO_INFLATE_LIMITS)).toBeNull();
        expect(await zipActualInflateProblem(big, AUTO_INFLATE_LIMITS)).toBeNull();
    });

    it('an honest large-but-legal entry (declared == actual, under the cap) passes', async () => {
        expect(await zipActualInflateProblem(await packageWithDecoy(2), MANUAL_INFLATE_LIMITS)).toBeNull();
    });

    it('stored (method 0) entries: honest passes, a lying declared size is refused', async () => {
        const stored = await packageWithDecoy(1, 'STORE');
        expect(await zipActualInflateProblem(stored, AUTO_INFLATE_LIMITS)).toBeNull();
        const lying = declareSize(stored, DECOY, 10);
        expect(zipInflateProblem(lying, AUTO_INFLATE_LIMITS)).toBeNull();
        expect(await zipActualInflateProblem(lying, AUTO_INFLATE_LIMITS)).toMatch(/does not match/);
    });

    it('empty entries and directories are skipped; non-zips never throw', async () => {
        const zip = new JSZip();
        zip.folder('xl');
        zip.file('empty.txt', '');
        zip.file('a.txt', 'hello');
        const z = toArrayBuffer(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
        expect(await zipActualInflateProblem(z, AUTO_INFLATE_LIMITS)).toBeNull();
        expect(await zipActualInflateProblem(new ArrayBuffer(30), AUTO_INFLATE_LIMITS)).toBe('not a zip');
    });

    it('the running actual total is held to maxInflated', async () => {
        expect(await zipActualInflateProblem(await packageWithDecoy(2), { maxInflated: 1024 * 1024 })).toMatch(/inflates past/);
    });
});
