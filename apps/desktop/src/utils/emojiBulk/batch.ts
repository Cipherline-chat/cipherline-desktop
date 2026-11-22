/**
 * Bulk emoji upload: the pure logic shared by Server Settings -> Emojis and
 * Settings -> My Emojis (components/emoji/BulkEmojiDialog.tsx is the view).
 *
 * Everything here is UX only. The API stays the authority for server emojis
 * (permission, storage, count, type, size) and a personal emoji never leaves
 * this device in plaintext; a client check just saves a round trip and says
 * why before the person waits for it.
 *
 * - names: a file name becomes a valid emoji name (the ONE rule in
 *   utils/emojiNames), made unique against the library and the rest of the batch
 *   by appending _2, _3, ...
 * - rows: each picked file is a row; `validateRows` gives each its own problem
 *   (file rule, name rule, duplicate, no room left)
 * - `runBatch`: a small worker pool with a minimum gap between starts and a
 *   back-off on 429 (Retry-After). One failure never stops the others; an abort
 *   stops everything not yet started.
 */
import { EMOJI_NAME_MAX, isEmojiName } from '../emojiNames';
import { suggestEmojiName } from '../personalEmoji/token';

/** Most files one batch takes in. Beyond this the picker is a poor tool. */
export const BULK_EMOJI_MAX_FILES = 100;

export type RowStatus = 'ready' | 'queued' | 'uploading' | 'waiting' | 'done' | 'error' | 'cancelled';

export interface BulkRow {
    id: string;
    file: File;
    name: string;
    status: RowStatus;
    /** Why the last attempt failed (status 'error') or was skipped ('cancelled'). */
    error?: string;
    /** While 'waiting': seconds the server asked us to hold off. */
    waitSeconds?: number;
}

/** Statuses a row can still be (re)uploaded from. */
export const isPendingStatus = (s: RowStatus): boolean => s === 'ready' || s === 'error' || s === 'cancelled';

/** `Red Heart!!.PNG` -> `red_heart_`-style, always a valid name (2-32, a-z0-9_). */
export function deriveEmojiName(fileName: string): string {
    return suggestEmojiName(fileName);
}

/** `base` if free, else `base_2`, `base_3`, ... trimmed so the result stays within 32 characters. */
export function uniqueEmojiName(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100000; n++) {
        const suffix = `_${n}`;
        const cand = base.slice(0, EMOJI_NAME_MAX - suffix.length).replace(/_+$/, '') + suffix;
        if (!taken.has(cand)) return cand;
    }
    return base;
}

let rowSeq = 0;
export const newRowId = (): string => `bulk-${++rowSeq}`;

/** Turn picked files into rows, names unique against `existingNames` and each other (and `already`, if adding more). */
export function buildRows(
    files: readonly File[],
    existingNames: Iterable<string>,
    already: readonly BulkRow[] = [],
): BulkRow[] {
    const taken = new Set<string>(existingNames);
    for (const r of already) taken.add(r.name);
    const out: BulkRow[] = [];
    for (const file of files) {
        const name = uniqueEmojiName(deriveEmojiName(file.name), taken);
        taken.add(name);
        out.push({ id: newRowId(), file, name, status: 'ready' });
    }
    return out;
}

export interface RowCheckOptions {
    existingNames: Iterable<string>;
    /** How many more emojis fit when the dialog opened. */
    slots: number;
    /** Why this file cannot be an emoji, or null. */
    fileProblem: (f: File) => string | null;
}

export const NAME_RULE_TEXT = '2 to 32 characters: letters, numbers and underscores.';
export const NO_ROOM_PREFIX = 'No room';

/**
 * One problem string per row that has one (rows without a problem are absent).
 * Only rows that can still be uploaded are judged; a row already done counts
 * as taken (its name, its slot). The slot limit is applied in list order to
 * rows that are otherwise fine, so removing a row hands its slot to the next.
 */
export function validateRows(rows: readonly BulkRow[], opts: RowCheckOptions): Map<string, string> {
    const problems = new Map<string, string>();
    const taken = new Set<string>(opts.existingNames);
    let used = 0;
    for (const r of rows) if (r.status === 'done') { taken.add(r.name); used++; }
    for (const r of rows) {
        if (!isPendingStatus(r.status)) continue;
        const fileProblem = opts.fileProblem(r.file);
        if (fileProblem) { problems.set(r.id, fileProblem); continue; }
        if (!isEmojiName(r.name)) { problems.set(r.id, NAME_RULE_TEXT); continue; }
        if (taken.has(r.name)) { problems.set(r.id, `The name :${r.name}: is already taken. Pick another.`); continue; }
        taken.add(r.name);
        if (used >= opts.slots) {
            problems.set(r.id, opts.slots <= 0
                ? `${NO_ROOM_PREFIX} left. Remove an emoji first.`
                : `${NO_ROOM_PREFIX} for this one. Remove a row to choose which ones fit.`);
            continue;
        }
        used++;
    }
    return problems;
}

/** Rows (ids) past the slot limit, so "Keep the first N" can drop exactly those. */
export function overSlotIds(rows: readonly BulkRow[], problems: ReadonlyMap<string, string>): string[] {
    return rows.filter(r => isPendingStatus(r.status) && (problems.get(r.id) ?? '').startsWith(NO_ROOM_PREFIX)).map(r => r.id);
}

// ── rate limiting ────────────────────────────────────────────────────────────

export const DEFAULT_429_WAIT_MS = 15_000;
export const MAX_429_WAIT_MS = 90_000;

/** Milliseconds to wait when `err` is an HTTP 429 (honouring Retry-After), else null. */
export function retryAfterMs(err: unknown, nowMs: number = Date.now()): number | null {
    const res = (err as { response?: { status?: number; headers?: Record<string, unknown> } } | null)?.response;
    if (!res || res.status !== 429) return null;
    const h = res.headers ?? {};
    const raw = h['retry-after'] ?? h['Retry-After'];
    let ms = DEFAULT_429_WAIT_MS;
    if (raw != null && String(raw).trim() !== '') {
        const secs = Number(raw);
        if (Number.isFinite(secs)) ms = secs * 1000;
        else {
            const at = Date.parse(String(raw));
            if (Number.isFinite(at)) ms = at - nowMs;
        }
    }
    return Math.min(MAX_429_WAIT_MS, Math.max(1000, ms));
}

/**
 * The server emoji create route allows 20 per minute per person (apps/api
 * server-emojis.controller.ts). A batch of up to 10 fits in that without
 * pacing; a bigger one is spaced just under the limit so it never trips it.
 */
export function serverCreateGapMs(batchSize: number): number {
    return batchSize > 10 ? 3100 : 0;
}

// ── runner ───────────────────────────────────────────────────────────────────

export interface RunBatchOptions {
    rows: readonly BulkRow[];
    upload: (row: BulkRow, signal: AbortSignal) => Promise<void>;
    concurrency: number;
    /** Least time between two upload STARTS across the pool. */
    minGapMs?: number;
    signal: AbortSignal;
    onRow: (id: string, patch: Partial<Pick<BulkRow, 'status' | 'error' | 'waitSeconds'>>) => void;
    /** A message to stop the whole batch (server storage full), or null. */
    fatalMessage?: (err: unknown) => string | null;
    errorMessage: (err: unknown) => string;
    maxRateRetries?: number;
    /** Test seams. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
}

export interface BatchSummary { done: number; failed: number; cancelled: number }

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
});

export async function runBatch(o: RunBatchOptions): Promise<BatchSummary> {
    const sleep = o.sleep ?? realSleep;
    const now = o.now ?? Date.now;
    const gap = o.minGapMs ?? 0;
    const maxRetries = o.maxRateRetries ?? 6;
    const queue = [...o.rows];
    const summary: BatchSummary = { done: 0, failed: 0, cancelled: 0 };
    let nextStart = 0;
    let fatal: string | null = null;
    for (const r of queue) o.onRow(r.id, { status: 'queued', error: undefined, waitSeconds: undefined });

    /** Reserve the next start time (synchronously, so workers never share one) and wait for it. */
    const takeTurn = async () => {
        const t = now();
        const start = Math.max(t, nextStart);
        nextStart = start + gap;
        if (start > t) await sleep(start - t, o.signal);
    };

    const cancel = (id: string, why?: string) => {
        summary.cancelled++;
        o.onRow(id, { status: 'cancelled', error: why, waitSeconds: undefined });
    };

    const worker = async () => {
        for (;;) {
            if (o.signal.aborted || fatal) return;
            const row = queue.shift();
            if (!row) return;
            let attempts = 0;
            for (;;) {
                await takeTurn();
                if (o.signal.aborted) { cancel(row.id); break; }
                if (fatal) { cancel(row.id, `Skipped: ${fatal}`); break; }
                o.onRow(row.id, { status: 'uploading', error: undefined, waitSeconds: undefined });
                try {
                    await o.upload(row, o.signal);
                    summary.done++;
                    o.onRow(row.id, { status: 'done', error: undefined, waitSeconds: undefined });
                    break;
                } catch (err) {
                    if (o.signal.aborted) { cancel(row.id); break; }
                    const wait = retryAfterMs(err, now());
                    if (wait != null && attempts < maxRetries) {
                        attempts++;
                        o.onRow(row.id, { status: 'waiting', waitSeconds: Math.ceil(wait / 1000) });
                        // Everyone holds off, not just this row: the limit is per person.
                        nextStart = Math.max(nextStart, now() + wait);
                        continue;
                    }
                    const f = o.fatalMessage?.(err) ?? null;
                    if (f) fatal = f;
                    summary.failed++;
                    o.onRow(row.id, { status: 'error', error: o.errorMessage(err), waitSeconds: undefined });
                    break;
                }
            }
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
    for (const r of queue) cancel(r.id, fatal ? `Skipped: ${fatal}` : undefined);
    return summary;
}
