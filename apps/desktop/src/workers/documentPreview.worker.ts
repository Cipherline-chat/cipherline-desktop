/**
 * Parses a received spreadsheet or Word file for its inline preview, off the
 * UI thread (see utils/documentPreview.ts for the limits and why). One job per
 * worker: the host terminates it when the answer arrives or the time is up, so
 * whatever the parser allocated is released with it.
 */
import { sheetsPreview, zipInflateProblem, WORD_PREVIEW_CHARS, type InflateLimits, type WorkbookLike } from '../utils/documentPreview';
// Static, not `import()`: a code-splitting worker can't be emitted in Vite's
// default IIFE worker format, so a dynamic import here fails `vite build`.
// The worker itself is only loaded on demand (documentPreviewHost), so the
// parsers still cost nothing until a preview is needed.
import * as exceljsModule from 'exceljs';
import * as mammothModule from 'mammoth';

export type DocumentPreviewRequest = { kind: 'excel' | 'word'; buf: ArrayBuffer; limits: InflateLimits };
export type DocumentPreviewResponse =
    | { ok: true; kind: 'excel'; sheets: ReturnType<typeof sheetsPreview> }
    | { ok: true; kind: 'word'; text: string }
    | { ok: false; reason: 'limits' | 'failed'; message: string };

const post = (msg: DocumentPreviewResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<DocumentPreviewRequest>) => {
    const { kind, buf, limits } = e.data;
    try {
        const problem = zipInflateProblem(buf, limits);
        if (problem) { post({ ok: false, reason: 'limits', message: problem }); return; }
        if (kind === 'excel') {
            const mod = exceljsModule;
            const ExcelJS = (mod as unknown as { default?: unknown }).default ?? mod;
            const wb = new (ExcelJS as { Workbook: new () => WorkbookLike & { xlsx: { load(b: ArrayBuffer): Promise<unknown> } } }).Workbook();
            await wb.xlsx.load(buf);
            post({ ok: true, kind: 'excel', sheets: sheetsPreview(wb) });
        } else {
            const mod = mammothModule;
            const mammoth = ((mod as unknown as { default?: unknown }).default ?? mod) as { extractRawText(o: { arrayBuffer: ArrayBuffer }): Promise<{ value?: unknown }> };
            const result = await mammoth.extractRawText({ arrayBuffer: buf });
            const text = typeof result?.value === 'string' ? result.value.slice(0, WORD_PREVIEW_CHARS) : '';
            post({ ok: true, kind: 'word', text });
        }
    } catch (err) {
        post({ ok: false, reason: 'failed', message: (err as { message?: string })?.message ?? String(err) });
    }
};
