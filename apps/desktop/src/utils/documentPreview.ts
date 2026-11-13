/**
 * Limits and pure helpers for the inline preview of a received document
 * (components/FileViewer.tsx): spreadsheets, Word files, CSV and text.
 *
 * The file is chosen by another user. Parsing it used to happen on the
 * renderer's main thread, automatically, with no size limit: a 5 MB crafted
 * .xlsx (a zip whose sheet inflates to tens of megabytes) froze the app for
 * over 30 seconds and took more than a gigabyte. Now:
 *
 *   - nothing is parsed automatically above AUTO_PREVIEW_MAX_BYTES; the user
 *     can ask for it ("Preview anyway") up to MANUAL_PREVIEW_MAX_BYTES;
 *   - a zip-based document (.xlsx, .docx) is refused before parsing when its
 *     central directory declares more than the inflate cap or too many
 *     entries (`zipInflateProblem`);
 *   - spreadsheets and Word files are parsed in a Worker that is terminated
 *     after PARSE_TIMEOUT_MS (utils/documentPreviewHost.ts), and only a few
 *     rows / characters come back;
 *   - CSV and text previews read only the head of the file.
 */

export const AUTO_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
export const MANUAL_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5000;
/**
 * Declared uncompressed / compressed ratio above which a document is not
 * previewed automatically (a real .xlsx / .docx is around 5-20:1; the
 * freeze shape is hundreds to one). Only checked once the inflated total is
 * past RATIO_FLOOR_BYTES, so a tiny repetitive file still previews.
 */
export const AUTO_MAX_RATIO = 100;
const RATIO_FLOOR_BYTES = 1024 * 1024;

export interface InflateLimits {
    maxInflated: number;
    /** Omitted = no ratio check. */
    maxRatio?: number;
}
export const AUTO_INFLATE_LIMITS: InflateLimits = { maxInflated: 8 * 1024 * 1024, maxRatio: AUTO_MAX_RATIO };
export const MANUAL_INFLATE_LIMITS: InflateLimits = { maxInflated: 40 * 1024 * 1024 };
export const PARSE_TIMEOUT_MS = 15_000;
/** How much of a CSV / text file a preview reads. */
export const TEXT_PREVIEW_READ_BYTES = 256 * 1024;

/** Rows / columns / sheets a spreadsheet preview keeps (the card shows 6 x 7). */
export const PREVIEW_KEEP_ROWS = 7;
export const PREVIEW_KEEP_COLS = 8;
export const PREVIEW_MAX_SHEETS = 50;
/** Characters of Word text kept (the card shows 600). */
export const WORD_PREVIEW_CHARS = 4000;
/** Longest cell text kept. */
const CELL_MAX = 200;

export type PreviewGate =
    | { state: 'auto' }
    | { state: 'ask'; bytes: number }
    | { state: 'too_large'; bytes: number };

/** May a file of `bytes` be previewed now? `forced` = the user clicked "Preview anyway". */
export function previewGate(bytes: number, forced: boolean): PreviewGate {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MANUAL_PREVIEW_MAX_BYTES) return { state: 'too_large', bytes };
    if (bytes > AUTO_PREVIEW_MAX_BYTES && !forced) return { state: 'ask', bytes };
    return { state: 'auto' };
}

/**
 * Why a zip-based document must not be inflated, or null. Reads only the
 * central directory (no decompression): entry count, and the sum of the
 * declared uncompressed sizes against `maxInflated` (and their ratio to the
 * file size against `maxRatio`). ZIP64 (sizes too big
 * for 32 bits) is refused outright: no previewable document needs it.
 *
 * Declared sizes can lie, so this is only the cheap first gate: the Worker
 * then runs `zipActualInflateProblem`, which inflates every entry under a byte
 * budget (jszip/exceljs inflate an entry in full and compare against the
 * declared size only afterwards).
 */
export function zipInflateProblem(buf: ArrayBuffer, limits: InflateLimits): string | null {
    const { maxInflated, maxRatio } = limits;
    const n = buf.byteLength;
    if (n < 22) return 'not a zip';
    const v = new DataView(buf);
    // End of central directory: last 22 bytes + up to 64 KiB of comment.
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 0xffff); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return 'not a zip';
    const entries = v.getUint16(eocd + 10, true);
    const cdSize = v.getUint32(eocd + 12, true);
    const cdOffset = v.getUint32(eocd + 16, true);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return 'zip64 is not previewed';
    if (entries > MAX_ZIP_ENTRIES) return 'too many entries';
    if (cdOffset + cdSize > n) return 'central directory out of range';
    let p = cdOffset;
    let total = 0;
    for (let k = 0; k < entries; k++) {
        if (p + 46 > n || v.getUint32(p, true) !== 0x02014b50) return 'bad central directory';
        const compressed = v.getUint32(p + 20, true);
        const uncompressed = v.getUint32(p + 24, true);
        if (compressed === 0xffffffff || uncompressed === 0xffffffff) return 'zip64 is not previewed';
        total += uncompressed;
        if (total > maxInflated) return 'inflates past the preview limit';
        p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    if (maxRatio !== undefined && total > RATIO_FLOOR_BYTES && total / n > maxRatio) return 'inflates past the preview limit';
    return null;
}

/**
 * Why a zip-based document must not be handed to the parser, or null — judged
 * on what the entries REALLY inflate to. Walks the central directory and
 * inflates each deflate stream through a counting, abortable
 * DecompressionStream('deflate-raw'), discarding the output:
 *
 *   - an entry whose actual size differs from its declared size is refused
 *     (that is what a lying central directory looks like), the moment it
 *     exceeds the declared size — so no entry is ever inflated past its
 *     declared size, and the declared sizes were already capped by
 *     `zipInflateProblem`;
 *   - the running actual total is held to `maxInflated` as well;
 *   - a stored entry (method 0) has no expansion; its size is the compressed
 *     size, which must equal the declared one;
 *   - any other compression method is refused (the parsers would fail on it).
 *
 * Memory is a few stream chunks, whatever the file claims. Call it only after
 * `zipInflateProblem` returned null (it relies on that for structure).
 */
export async function zipActualInflateProblem(buf: ArrayBuffer, limits: InflateLimits): Promise<string | null> {
    const n = buf.byteLength;
    const v = new DataView(buf);
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 0xffff); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return 'not a zip';
    const entries = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    let actualTotal = 0;
    for (let k = 0; k < entries; k++) {
        if (p + 46 > n || v.getUint32(p, true) !== 0x02014b50) return 'bad central directory';
        const method = v.getUint16(p + 10, true);
        const compressed = v.getUint32(p + 20, true);
        const declared = v.getUint32(p + 24, true);
        const lfh = v.getUint32(p + 42, true);
        p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);

        if (compressed === 0 && declared === 0) continue; // a directory or an empty file
        if (lfh + 30 > n || v.getUint32(lfh, true) !== 0x04034b50) return 'bad local header';
        const start = lfh + 30 + v.getUint16(lfh + 26, true) + v.getUint16(lfh + 28, true);
        if (start + compressed > n) return 'entry data out of range';

        let actual: number;
        if (method === 0) {
            actual = compressed;
        } else if (method === 8) {
            const r = await countInflated(new Uint8Array(buf, start, compressed), declared);
            if (r === 'error') return 'corrupt entry';
            actual = r;
        } else {
            return 'unsupported compression method';
        }
        if (actual !== declared) return 'entry size does not match the central directory';
        actualTotal += actual;
        if (actualTotal > limits.maxInflated) return 'inflates past the preview limit';
    }
    return null;
}

/**
 * Inflate a raw-deflate stream, discarding the output, and stop as soon as it
 * has produced more than `cap` bytes. Resolves the byte count (cap + something
 * when aborted — callers compare against the declared size) or 'error'.
 */
async function countInflated(data: Uint8Array, cap: number): Promise<number | 'error'> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
        const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        reader = stream.getReader();
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return total;
            total += value.byteLength;
            if (total > cap) {
                await reader.cancel().catch(() => { /* the abort is the point */ });
                return total;
            }
        }
    } catch {
        try { await reader?.cancel(); } catch { /* ignore */ }
        return 'error';
    }
}

export interface SheetPreview {
    name: string;
    /** At most PREVIEW_KEEP_ROWS rows of at most PREVIEW_KEEP_COLS cells. */
    rows: string[][];
    totalRows: number;
    totalCols: number;
}

const clipCell = (s: string) => (s.length > CELL_MAX ? s.slice(0, CELL_MAX) : s);

/** One ExcelJS cell value as preview text. */
export function cellText(v: unknown): string {
    if (v == null) return '';
    if (v instanceof Date) return v.toLocaleDateString();
    if (typeof v === 'object') {
        const o = v as { richText?: unknown; result?: unknown; error?: unknown };
        if (Array.isArray(o.richText)) return clipCell(o.richText.map(rt => String((rt as { text?: unknown })?.text ?? '')).join(''));
        if ('result' in o) return clipCell(String(o.result ?? ''));
        if ('error' in o) return clipCell(String(o.error));
        return '';
    }
    return clipCell(String(v));
}

/** Minimal ExcelJS surface used here (the Worker passes the real workbook). */
export interface WorkbookLike {
    eachSheet(cb: (ws: { name: string; eachRow(opts: { includeEmpty: boolean }, cb: (row: { values: unknown }) => void): void }) => void): void;
}

/**
 * The bounded preview of a loaded workbook: per sheet, the first rows (with
 * trailing empty rows trimmed the way the old renderer did), the row and
 * column counts, and no more than PREVIEW_MAX_SHEETS sheets.
 */
export function sheetsPreview(wb: WorkbookLike): SheetPreview[] {
    const out: SheetPreview[] = [];
    wb.eachSheet(ws => {
        if (out.length >= PREVIEW_MAX_SHEETS) return;
        const rows: string[][] = [];
        let totalRows = 0;
        let lastNonEmpty = 0;
        let totalCols = 0;
        ws.eachRow({ includeEmpty: false }, row => {
            const vals = Array.isArray(row.values) ? (row.values as unknown[]) : [];
            const width = Math.max(0, vals.length - 1);
            totalRows++;
            totalCols = Math.max(totalCols, width);
            let empty = true;
            const cells: string[] = [];
            for (let i = 1; i < vals.length; i++) {
                const t = cellText(vals[i]);
                if (t !== '') empty = false;
                if (cells.length < PREVIEW_KEEP_COLS) cells.push(t);
            }
            if (!empty) lastNonEmpty = totalRows;
            if (rows.length < PREVIEW_KEEP_ROWS) rows.push(cells);
        });
        // Trailing all-empty rows don't count (the old renderer trimmed them).
        totalRows = lastNonEmpty;
        const kept = rows.slice(0, Math.min(rows.length, totalRows));
        const width = Math.min(totalCols, PREVIEW_KEEP_COLS);
        out.push({
            name: clipCell(String(ws.name ?? '')),
            rows: kept.map(r => [...r, ...Array(Math.max(0, width - r.length)).fill('')]),
            totalRows,
            totalCols,
        });
    });
    return out;
}

export interface CsvPreview {
    rows: string[][];
    totalRows: number;
    totalCols: number;
    /** The file continues past what was read: counts are lower bounds. */
    truncated: boolean;
}

/**
 * Parse the head of a CSV/TSV for the preview card. Quoted cells, doubled
 * quotes and the delimiter behave as before; only the first PREVIEW_KEEP_ROWS
 * rows are kept, but every row read is counted. `truncated` says `text` is
 * only the head of the file (the last, possibly partial, line is dropped).
 */
export function csvPreview(text: string, delimiter: string, truncated: boolean): CsvPreview {
    const lines = text.split(/\r?\n/);
    if (truncated && lines.length > 1) lines.pop();
    const rows: string[][] = [];
    let totalRows = 0;
    let totalCols = 0;
    for (const line of lines) {
        if (!line.trim()) continue;
        const cells: string[] = [];
        let cell = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
                else inQuote = !inQuote;
            } else if (ch === delimiter && !inQuote) { cells.push(cell); cell = ''; }
            else if (cell.length < CELL_MAX) cell += ch;
        }
        cells.push(cell);
        totalRows++;
        totalCols = Math.max(totalCols, cells.length);
        if (rows.length < PREVIEW_KEEP_ROWS) rows.push(cells.slice(0, PREVIEW_KEEP_COLS));
    }
    return { rows, totalRows, totalCols, truncated };
}

/** "1.2 MB" for the gate's message. */
export function formatPreviewBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
