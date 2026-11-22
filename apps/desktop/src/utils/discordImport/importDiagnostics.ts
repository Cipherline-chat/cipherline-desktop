/**
 * Beta diagnostics for the Discord import (owner 2026-11-22: #files_pictures failed twice with "Something
 * went wrong talking to Discord" and nothing reached us, so the cause had to be found by reading code).
 *
 * Two kinds, sent through the normal beta reporter (gated by the server switch AND the user's toggle,
 * deduped, hourly-capped):
 *   - `import_channel_failed`: one per channel that did not come over (or the whole copy stopping): the step
 *     it stopped at, our error code, the HTTP status, the error class, whether it can be retried;
 *   - `import_files_skipped`: one per run when files / messages were left out: counts by reason.
 *
 * Labels and counts ONLY: no message text, file names, sizes of a named file, Discord ids, channel / server
 * names, Cipherline ids. Everything passes the reporter's own sanitizer (enum-shaped strings, numbers,
 * booleans), and importDiagnostics.test.ts checks it.
 */
import { reportBeta } from '../betaDiagnostics/reporter';
import type { BetaEventKind } from '../betaDiagnostics/types';
import { failureOf, type ChannelReport } from './history/runner';

export interface ImportDiagContext {
    job: 'import' | 'copy';
    /** This run was a Retry of failed channels. */
    retry: boolean;
    /** The whole message copy stopped (session refused, a crash in the runner…). */
    stopped?: unknown;
}

const label = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : undefined;

export function importDiagEvents(reports: ChannelReport[], ctx: ImportDiagContext): Array<[BetaEventKind, Record<string, unknown>]> {
    const out: Array<[BetaEventKind, Record<string, unknown>]> = [];
    for (const r of reports) {
        if (r.error === null) continue;
        const f = r.failure ?? { step: 'unknown', code: 'unknown' };
        out.push(['import_channel_failed', {
            step: label(f.step) ?? 'unknown',
            code: label(f.code) ?? 'unknown',
            ...(typeof f.status === 'number' && Number.isInteger(f.status) ? { status: f.status } : {}),
            ...(label(f.errorName) ? { error_name: label(f.errorName) } : {}),
            retryable: r.rows === 0,
            partly_posted: r.rows > 0,
            messages_skipped: r.messagesSkipped ?? 0,
            job: ctx.job,
            retry: ctx.retry,
        }]);
    }
    if (ctx.stopped !== undefined) {
        const f = failureOf(ctx.stopped, 'session');
        out.push(['import_channel_failed', {
            step: label(f.step) ?? 'session', code: label(f.code) ?? 'unknown',
            ...(typeof f.status === 'number' ? { status: f.status } : {}),
            ...(label(f.errorName) ? { error_name: label(f.errorName) } : {}),
            whole_copy: true, job: ctx.job, retry: ctx.retry,
        }]);
    }
    const byCode: Record<string, number> = {};
    let files = 0;
    let channels = 0;
    for (const r of reports) {
        if (r.filesSkipped.length > 0) channels++;
        for (const f of r.filesSkipped) {
            files++;
            const code = f.code === 'refused' ? 'upload_failed' : f.code ?? 'other';
            byCode[code] = (byCode[code] ?? 0) + 1;
        }
    }
    const unreadable = reports.reduce((t, r) => t + (r.unreadable ?? 0), 0);
    const partial = reports.filter(r => r.partial).length;
    if (files > 0 || unreadable > 0 || partial > 0) {
        out.push(['import_files_skipped', {
            files, channels, ...byCode,
            ...(unreadable ? { unreadable } : {}),
            ...(partial ? { partial } : {}),
            job: ctx.job, retry: ctx.retry,
        }]);
    }
    return out;
}

/** Send them. Never throws (diagnostics must not break the import). */
export function reportImportDiagnostics(reports: ChannelReport[], ctx: ImportDiagContext): void {
    try {
        for (const [kind, detail] of importDiagEvents(reports, ctx)) {
            if (kind === 'import_channel_failed') reportBeta('import_channel_failed', detail);
            else reportBeta('import_files_skipped', detail);
        }
    } catch { /* never */ }
}
