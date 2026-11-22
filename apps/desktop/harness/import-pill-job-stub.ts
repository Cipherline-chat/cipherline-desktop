/* eslint-disable -- visual harness, not shipped */
// Import-pill harness (harness/import-pill.vite.config.ts): DiscordImportHost's
// view of the background import job, swapped for a fixed job so the REAL pill
// can be shot in every state. Only DiscordImportHost's import is redirected
// here; everything else (and this file) imports the real module.
export * from '../src/utils/discordImport/backgroundImport';
import { importJobIssues as realIssues, type ImportJob } from '../src/utils/discordImport/backgroundImport';
import type { ChannelReport } from '../src/utils/discordImport/history/runner';

const rep = (name: string, error: string | null = null): ChannelReport => ({
    channelId: `c-${name}`, name, messages: 1000, rows: error ? 0 : 1000, filesImported: 0, filesSkipped: [], pinsSaved: 0, pinsNoRoom: 0,
    truncated: false, ceilingHit: false, reactionsSkipped: 0, error, savable: [],
});
const LONG = 'The Extremely Long Community Server Name For Everyone Who Plays Together';

/** ?pill=<state> -> the job (and how many failed channels the report could retry). */
export const PILL_STATES: Record<string, { job: Partial<ImportJob>; retry?: number }> = {
    run: { job: { phase: 'history', percent: 17 } },
    run_start: { job: { phase: 'structure', percent: 2 } },
    run_late: { job: { phase: 'history', percent: 83 } },
    copy: { job: { kind: 'copy', phase: 'history', percent: 46 } },
    finishing: { job: { phase: 'history', percent: 100 } },
    stopping: { job: { phase: 'history', percent: 58, stopping: true } },
    done: { job: { phase: 'done', percent: 100, hReports: [rep('general'), rep('memes')] } },
    failed_retry: { job: { phase: 'done', percent: 100, hReports: [rep('general'), rep('memes', 'boom'), rep('art', 'boom')] }, retry: 2 },
    failed: { job: { phase: 'done', percent: 100, hReports: [rep('general'), rep('memes', 'boom'), rep('art', 'boom')] } },
    issues: { job: { phase: 'done', percent: 100, hReports: [rep('general'), { ...rep('memes'), filesSkipped: [{ filename: 'big.mp4', reason: 'too large' }] }] } },
    stopped: { job: { phase: 'done', percent: 100, stopped: { deleted: 0 }, hReports: [rep('general')] } },
    history_failed: { job: { phase: 'history-failed', percent: 61 } },
    structure_failed: { job: { phase: 'structure-failed', percent: 4 } },
    long: { job: { phase: 'history', percent: 9, serverName: LONG } },
    long_done: { job: { phase: 'done', percent: 100, serverName: LONG, hReports: [rep('general'), rep('memes', 'boom')] }, retry: 1 },
};

const q = new URLSearchParams(location.search);
const state = PILL_STATES[q.get('pill') ?? ''];
const job: ImportJob | null = state ? {
    id: 1, kind: 'import', phase: 'history', serverName: 'Fusion', guildName: 'Fusion HQ', progress: null, hProgress: null, report: null,
    hReports: null, error: null, hError: null, created: { id: 's1', name: 'Fusion' }, stopped: null, stopping: false, percent: 0,
    counts: { roles: 0, categories: 0, channels: 0, emojis: 0 } as ImportJob['counts'], emojiTotal: 0, stickerTotal: 0,
    includeEmojis: false, includeStickers: false, withHistory: true, importId: null, seen: false, viewing: false,
    ...state.job,
} as ImportJob : null;

export function useImportJob(): ImportJob | null { return job; }
export function retryableImportChannels(): ChannelReport[] {
    return Array.from({ length: state?.retry ?? 0 }, (_, i) => rep(`retry-${i}`, 'boom'));
}
export function importJobIssues(j: Parameters<typeof realIssues>[0]) {
    return { ...realIssues(j), retryable: retryableImportChannels() };
}
