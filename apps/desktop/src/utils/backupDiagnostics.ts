/**
 * The last backup, restore and repair outcome, as LABELS, for Report a problem.
 *
 * WHY (2026-11-26): a tester wrote "unable to back up as well" and sent a
 * report; nothing in it said why. A failed backup left no trace outside the
 * closed-beta event stream (which a normal user is not in), so the report was
 * inconclusive, and the support email that promised "the report includes the
 * error from the failed backup" was wrong. The outcome is now kept on this
 * device (it must survive the restart that usually follows a failure) and is a
 * `general` setting in EVERY report category, so whatever a user files it under
 * the failing step is there.
 *
 * LABELS ONLY, by construction, like storeHealthReport.ts:
 *   - `step`: a fixed word (guard / export / setup / write / open / decrypt / apply …),
 *   - `error`: the error NAME, reduced to letters — never its message, which can
 *     carry a folder path with the user's Windows name in it,
 *   - `reason`: a code from a closed set (backupFailureReason, plus the restore
 *     reasons below) — never text,
 *   - `dest`: local / drive / both, a small count of held records, an age.
 * No path, file name, account or device id, key name or content.
 */
import secureLocalStore from './secureLocalStore';
import { backupFailureReason } from './backupFailureReason';

export type BackupDiagOp = 'backup' | 'restore' | 'repair';

export interface BackupDiagRecord {
    ok: boolean;
    /** Where it stopped, or 'done'. */
    step: string;
    /** Error name, letters only; '' on success. */
    error: string;
    /** Closed-set reason code; '' on success. */
    reason: string;
    /** local | drive | both | ''. */
    dest: string;
    /** Records the store could not read at the time (backup: kept from the previous backup). */
    held: number;
    /** ms since epoch. */
    at: number;
}

type Store = Partial<Record<BackupDiagOp, BackupDiagRecord>>;

const WORD_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NAME_RE = /^[A-Za-z]{1,40}$/;

/** Restore-only reasons, on top of backupFailureReason's. */
const RESTORE_REASONS: Array<[RegExp, string]> = [
    [/different account|belongs to/i, 'wrong_account'],
    [/missing account information/i, 'no_account'],
    [/No backup (?:found|file)|not found/i, 'not_found'],
    [/Downloaded backup could not be read|could not be read/i, 'unreadable'],
    [/not a (?:backup|container)|bad magic|unsupported (?:backup|version)/i, 'not_a_backup'],
];

/** An error → `{ error, reason }`, both labels. Never throws. */
export function classifyBackupError(err: unknown): { error: string; reason: string } {
    const name = (err as { name?: unknown } | null)?.name;
    const message = (err as { message?: unknown } | null)?.message;
    const msg = typeof message === 'string' ? message : '';
    const error = typeof name === 'string' && NAME_RE.test(name) ? name : 'Error';
    const guard = (err as { reason?: unknown } | null)?.reason;
    if (error === 'BackupStoreUnreadableError' && typeof guard === 'string' && WORD_RE.test(guard)) return { error, reason: guard };
    if (error === 'BackupWrongPasswordError') return { error, reason: 'wrong_password' };
    for (const [re, reason] of RESTORE_REASONS) if (re.test(msg)) return { error, reason };
    return { error, reason: backupFailureReason(msg) };
}

const word = (v: unknown, fallback: string): string => (typeof v === 'string' && WORD_RE.test(v) ? v : fallback);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(99_999, Math.round(v)) : 0);

function read(): Store {
    try {
        const raw = secureLocalStore.getItem('cipherline_backup_diag_v1');
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Store : {};
    } catch { return {}; }
}

/** Keep the last outcome of `op`. Never throws: diagnostics must not fail the thing they describe. */
export function recordBackupDiag(op: BackupDiagOp, rec: { ok: boolean; step?: string; err?: unknown; dest?: string; held?: number; at?: number }): void {
    try {
        const c = rec.ok || rec.err === undefined ? { error: '', reason: '' } : classifyBackupError(rec.err);
        const next: BackupDiagRecord = {
            ok: rec.ok,
            step: word(rec.step, rec.ok ? 'done' : 'unknown'),
            error: c.error,
            reason: word(c.reason, 'other'),
            dest: ['local', 'drive', 'both'].includes(rec.dest ?? '') ? rec.dest! : '',
            held: count(rec.held),
            at: rec.at ?? Date.now(),
        };
        if (rec.ok) next.reason = '';
        secureLocalStore.setItem('cipherline_backup_diag_v1', JSON.stringify({ ...read(), [op]: next }));
    } catch { /* never */ }
}

/** The report's `general` settings for the last outcome of each operation. Scalars; absent when nothing was recorded. */
export function backupDiagSettings(now: number = Date.now(), stored: Store = read()): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const op of ['backup', 'restore', 'repair'] as const) {
        const r = stored[op];
        if (!r || typeof r.at !== 'number') continue;
        out[`${op}_last_ok`] = r.ok === true;
        out[`${op}_last_step`] = word(r.step, 'unknown');
        if (!r.ok) {
            out[`${op}_last_error`] = typeof r.error === 'string' && NAME_RE.test(r.error) ? r.error : 'Error';
            out[`${op}_last_reason`] = word(r.reason, 'other');
        }
        if (r.dest) out[`${op}_last_dest`] = word(r.dest, '');
        if (count(r.held)) out[`${op}_last_held`] = count(r.held);
        out[`${op}_last_age_h`] = Math.max(0, Math.round((now - r.at) / 360_000) / 10);
    }
    return out;
}
