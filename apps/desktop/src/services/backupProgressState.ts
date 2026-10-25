/**
 * backupProgressState — turns runBackup's progress events into one progress row
 * per destination (local folder, Google Drive), for the bars in Settings → Backup.
 *
 * Pure on purpose: the component just renders whatever these return, and the
 * event-to-row rules (which are easy to get subtly wrong — destinations are
 * written one after another, and a skipped or failed destination never emits a
 * "done" event of its own) are covered by tests instead of by eyeballing.
 *
 * `pct: null` means "running, but no measurable progress" → an indeterminate bar.
 * Only the Drive upload reports real byte counts; the local write has none.
 */
import type { DestinationLabel, DriveBackupProgress } from './driveBackup';

export type RowStage =
    | 'waiting' | 'preparing' | 'writing' | 'uploading' | 'verifying'
    | 'done' | 'skipped' | 'error';

export interface ProgressRow {
    stage: RowStage;
    /** 0–100, or null when running with nothing to measure. */
    pct: number | null;
}

export type ProgressRows = Partial<Record<DestinationLabel, ProgressRow>>;

/** What finishProgressRows needs from runBackup's result. */
export interface BackupRunOutcome {
    errors?: Partial<Record<DestinationLabel, string>>;
    local?: { skipped?: boolean };
    drive?: { skipped?: boolean };
}

const LABELS: DestinationLabel[] = ['local', 'drive'];
const IN_FLIGHT: RowStage[] = ['preparing', 'writing', 'uploading', 'verifying'];

export function initProgressRows(active: DestinationLabel[]): ProgressRows {
    const rows: ProgressRows = {};
    for (const l of active) rows[l] = { stage: 'waiting', pct: null };
    return rows;
}

function ratio(p?: { done: number; total: number }): number | null {
    if (!p || !(p.total > 0)) return null;
    return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

export function advanceProgressRows(rows: ProgressRows, ev: DriveBackupProgress): ProgressRows {
    const next: ProgressRows = { ...rows };

    switch (ev.phase) {
        case 'export':
        case 'encrypt': {
            // Shared preparation: every destination is being fed the same stream.
            const pct = ratio(ev.attachments);
            for (const l of LABELS) {
                const r = next[l];
                if (r && (r.stage === 'waiting' || r.stage === 'preparing')) {
                    next[l] = { stage: 'preparing', pct: pct ?? r.pct };
                }
            }
            return next;
        }
        case 'local':
        case 'upload': {
            const dest: DestinationLabel | undefined = ev.destination ?? (ev.phase === 'local' ? 'local' : 'drive');
            if (!next[dest]) return rows;
            // Destinations are committed one after another, so a different one
            // still verifying has just finished — it never emits its own "done".
            for (const l of LABELS) {
                if (l !== dest && next[l]?.stage === 'verifying') next[l] = { stage: 'done', pct: 100 };
            }
            const prev = next[dest]!;
            const pct = ev.transfer ? ratio(ev.transfer) : null;
            next[dest] = {
                stage: ev.phase === 'local' ? 'writing' : 'uploading',
                // Never walk backwards (a repeated message-only event carries no number).
                pct: pct ?? (prev.stage === 'uploading' ? prev.pct : null),
            };
            return next;
        }
        case 'verify': {
            if (ev.destination && next[ev.destination]) {
                next[ev.destination] = { stage: 'verifying', pct: null };
                return next;
            }
            return rows;
        }
        default:
            // 'done' / 'error' are whole-run events: finishProgressRows settles
            // each row from the actual result, which knows who failed.
            return rows;
    }
}

/**
 * Settle every row once the run is over. `outcome` is runBackup's result; pass
 * null when it threw (nothing finished, so anything still running failed).
 */
export function finishProgressRows(rows: ProgressRows, outcome: BackupRunOutcome | null): ProgressRows {
    const next: ProgressRows = {};
    for (const l of LABELS) {
        const r = rows[l];
        if (!r) continue;
        if (!outcome) {
            next[l] = r.stage === 'done' ? r : { stage: 'error', pct: null };
        } else if (outcome.errors?.[l]) {
            next[l] = { stage: 'error', pct: null };
        } else if (outcome[l]?.skipped) {
            next[l] = { stage: 'skipped', pct: 100 };
        } else {
            next[l] = { stage: 'done', pct: 100 };
        }
    }
    return next;
}

export function isRowRunning(row: ProgressRow): boolean {
    return IN_FLIGHT.includes(row.stage);
}

export const DESTINATION_NAME: Record<DestinationLabel, string> = {
    local: 'Local folder',
    drive: 'Google Drive',
};

export function rowStatusText(row: ProgressRow): string {
    switch (row.stage) {
        case 'waiting': return 'Waiting…';
        case 'preparing': return 'Encrypting…';
        case 'writing': return 'Writing…';
        case 'uploading': return row.pct === null ? 'Uploading…' : `Uploading ${row.pct}%`;
        case 'verifying': return 'Verifying…';
        case 'done': return 'Done';
        case 'skipped': return 'Already up to date';
        case 'error': return 'Failed';
    }
}
