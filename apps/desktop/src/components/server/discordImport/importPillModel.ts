import type { ImportIssues, ImportJob } from '../../../utils/discordImport/backgroundImport';

/**
 * What the background Discord import's title-bar pill says (ImportPill.tsx
 * draws it). Pure; tested in ImportPill.test.ts.
 */
/** danger = finished with a failed channel (red, owner 2026-11-22); warn = stopped, or finished with lesser issues. */
export type ImportPillTone = 'run' | 'finishing' | 'ok' | 'warn' | 'danger';

export interface ImportPillModel {
    tone: ImportPillTone;
    /** Muted words before the name ("Importing", "Copying into", "Messages copied into"). */
    lead: string | null;
    /** The server's name, in the display font; truncates with an ellipsis. */
    name: string;
    /** Muted words after the name ("imported", "2 channels failed", "import stopped"). */
    detail: string | null;
    /** The right-hand end: the percentage (mono), a status word, or the click's action. */
    tail: string;
    tailKind: 'percent' | 'status' | 'action';
    /** 0-100 while the job runs (the fill), null once it has finished. */
    percent: number | null;
    /** The whole sentence (accessible name, tests). */
    label: string;
}

type PillJob = Pick<ImportJob, 'phase' | 'serverName' | 'percent'>
    & Partial<Pick<ImportJob, 'kind' | 'stopping' | 'stopped' | 'hReports'>>;

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What the pill needs of `importJobIssues(job)` (backgroundImport.ts). */
export type PillIssues = Pick<ImportIssues, 'failed' | 'retryable' | 'any'>;

/**
 * What the pill says for a job. `issues` = `importJobIssues(job)`: a failed
 * channel turns the finished pill red and keeps it there until it is retried
 * or the job is dismissed (the host never hides it on its own); with any
 * channel the report can retry in place, the action reads "Retry" (the click
 * still just opens the report, where Retry / Retry all are). Without `issues`,
 * failed channels are read from `hReports` and none counts as retryable.
 */
export function importPillModel(j: PillJob, issues?: PillIssues): ImportPillModel {
    const copy = j.kind === 'copy';
    const name = j.serverName;
    const make = (m: Omit<ImportPillModel, 'label'>): ImportPillModel => ({
        ...m,
        label: [[m.lead, m.name, m.detail].filter(Boolean).join(' '), m.tail].join(' · '),
    });
    switch (j.phase) {
        case 'structure':
        case 'history': {
            const pct = clampPct(j.percent);
            const lead = copy ? 'Copying into' : 'Importing';
            if (j.stopping) return make({ tone: 'finishing', lead, name, detail: null, tail: 'stopping…', tailKind: 'status', percent: pct });
            if (pct >= 100) return make({ tone: 'finishing', lead, name, detail: null, tail: 'finishing…', tailKind: 'status', percent: 100 });
            return make({ tone: 'run', lead, name, detail: null, tail: `${pct}%`, tailKind: 'percent', percent: pct });
        }
        case 'done': {
            const failed = issues ? issues.failed.length : (j.hReports ?? []).filter(r => r.error !== null).length;
            const retryable = issues ? issues.retryable.length : 0;
            if (failed > 0) {
                return make({
                    tone: 'danger', lead: null, name, detail: `${plural(failed, 'channel', 'channels')} failed`,
                    tail: retryable > 0 ? 'Retry' : 'See report', tailKind: 'action', percent: null,
                });
            }
            if (j.stopped) return make({ tone: 'warn', lead: null, name, detail: copy ? 'copy stopped' : 'import stopped', tail: 'See report', tailKind: 'action', percent: null });
            // Nothing failed, but files / messages were left out or a channel only partly came over.
            if (issues?.any) return make({ tone: 'warn', lead: null, name, detail: copy ? 'copied with issues' : 'imported with issues', tail: 'See report', tailKind: 'action', percent: null });
            return copy
                ? make({ tone: 'ok', lead: 'Messages copied into', name, detail: null, tail: 'See report', tailKind: 'action', percent: null })
                : make({ tone: 'ok', lead: null, name, detail: 'imported', tail: 'See report', tailKind: 'action', percent: null });
        }
        case 'history-failed':
            return make({ tone: 'warn', lead: null, name, detail: copy ? 'copy stopped' : 'import stopped', tail: 'See report', tailKind: 'action', percent: null });
        case 'structure-failed':
            return make({ tone: 'warn', lead: null, name, detail: 'import stopped', tail: 'Try again', tailKind: 'action', percent: null });
        case 'cancelled':
            return make({ tone: 'warn', lead: null, name, detail: 'import cancelled', tail: 'Details', tailKind: 'action', percent: null });
    }
}
