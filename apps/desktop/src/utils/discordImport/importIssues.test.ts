// @vitest-environment jsdom
/**
 * The #files_pictures follow-up (owner 2026-11-22): "when the import finishes if there are issues like this,
 * I'd like the pop up to say issues found in red or something so they don't just dismiss it and then never
 * get the chance to retry", plus the beta diagnostics that would have told us the cause.
 *
 *   - importJobIssues: failed / retryable / partial channels, files and messages left out;
 *   - per-channel Retry (only that channel runs, into the same session);
 *   - the title-bar pill stays in its red danger state ("<server> 1 channel failed · Retry") until retried / dismissed;
 *   - the finish toast says "issues found" (error tone, stays until dismissed);
 *   - diagnostics: import_channel_failed (step / code / status / class) and import_files_skipped (counts),
 *     labels only, sent through reportBeta, surviving the reporter's sanitizer unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.hoisted(() => {
    // jsdom has no matchMedia; a UI module reads it when loaded.
    if (typeof window !== 'undefined' && !window.matchMedia) {
        Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
    }
});
const store = new Map<string, string>();
vi.mock('../secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        whenAccountReady: () => Promise.resolve(),
    },
}));
const beta = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]> }));
vi.mock('../betaDiagnostics/reporter', () => ({ reportBeta: (kind: string, detail: Record<string, unknown>) => { beta.calls.push([kind, detail]); } }));

import {
    dismissImportJob, getImportJob, importJobIssues, resetImportJobForTests, retryFailedImportChannels, startImportJob, type ImportJobInput,
} from './backgroundImport';
import { importDiagEvents } from './importDiagnostics';
import { sanitizeDetail } from '../betaDiagnostics/sanitize';
import { DiscordImportHost } from '../../components/server/discordImport/DiscordImportHost';
import { filesSkippedSummary } from './importIssuesText';
import { importPillModel } from '../../components/server/discordImport/importPillModel';
import type { ChannelReport } from './history/runner';
import type { DiscordImportApi, GuildSnapshot, ImportMessage } from './types';
import type { DiscordHistoryHost } from './history/host';

/** The title-bar pill for a job, as the host builds it (tone + the sentence it reads out). */
const pillText = (j: NonNullable<ReturnType<typeof getImportJob>>) => { const m = importPillModel(j, importJobIssues(j)); return { label: m.label, tone: m.tone }; };

const SID = '5e1e0000-0000-4000-8000-000000000001';
const SNAPSHOT: GuildSnapshot = {
    guild: { id: '800000000000000001', name: 'Pixel Farm Co-op', description: null, hasIcon: false, hasBanner: false },
    body: { name: 'Pixel Farm Co-op', roles: [], channels: [1, 2, 3].map(id => ({ id, type: 0, name: `c${id}`, position: id })) },
    emojis: [], counts: { roles: 0, categories: 0, channels: 3, emojis: 0 }, notMapped: [],
};

const until = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 2)); }
};

function channel(n: number, withFile: boolean) {
    const messages: ImportMessage[] = Array.from({ length: n }, (_, i) => ({
        id: String(900000000000000000n + BigInt(i)), ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), edited: false,
        author: { id: '700000000000000001', name: 'Sam', username: 'sam', kind: 'user' as const, avatarRef: null },
        content: `secret words ${i}`, mentionNames: {}, replyTo: null, stickers: [], poll: null, pinned: false, reactions: [], embeds: [],
        files: withFile && i === 0 ? [{ ref: 'r-big', filename: 'holiday-video.mov', size: 612 * 1024 * 1024, mime: 'video/quicktime', voice: false }] : [],
    }));
    return { ok: true as const, messages, pins: [], truncated: false, names: { roles: {}, channels: {} } };
}

let failing: Map<number, { code: string; message: string; step?: string; status?: number; errorName?: string }>;
let completes: number;
let reads: number[];
let api: Record<string, ReturnType<typeof vi.fn>>;

function input(): ImportJobInput {
    const history = {
        api: () => ({
            createSession: async () => ({ id: 'imp-1' }),
            registerAuthors: async (_i: string, a: unknown[]) => ({ author_ids: a.map((_, k) => `ref-${k}`) }),
            postBatch: async (_i: string, b: { seq_start: number; rows: unknown[] }) => ({ ids: b.rows.map((_, k) => `m-${b.seq_start + k}`), seq_next: b.seq_start + b.rows.length }),
            initiateFiles: async () => [], save: async () => ({ results: [], used_bytes: 0, limit_bytes: 0 }),
            complete: async () => { completes++; return {}; },
        }),
        prepareChannelKeys: async () => undefined,
        sealRow: async (json: string) => ({ epoch: 1, nonce_b64: 'n', ciphertext_b64: btoa(unescape(encodeURIComponent(json))).slice(0, 40), signature_b64: 's' }),
        encryptFile: async () => { throw new Error('no'); }, upload: async () => undefined,
        storage: async () => ({ used_bytes: 0, limit_bytes: 1 }), emojiIds: async () => ({}),
        cancel: async () => ({ deleted: 0 }), deviceId: 'dev-1', maxFileBytes: 25 * 1024 * 1024,
    } as unknown as DiscordHistoryHost;
    return {
        api: api as unknown as DiscordImportApi,
        host: {
            importGuild: vi.fn(async () => ({ server_id: SID, name: 'Pixel Farm Co-op', channel_refs: { 'c:1': 'ch-1', 'c:2': 'ch-2', 'c:3': 'ch-3' }, role_refs: {} })),
            listEmojiNames: vi.fn(async () => []), createEmoji: vi.fn(async () => undefined), upload: vi.fn(async () => ({ attachmentId: 'a', keyB64: 'k', nonceB64: 'n' })),
        },
        history, guildId: SNAPSHOT.guild.id, snapshot: SNAPSHOT, serverName: 'Pixel Farm Co-op', description: null,
        includeImages: false, includeEmojis: false, includeStickers: false,
        historyChannels: [{ num: 1, name: 'general_chat' }, { num: 2, name: 'files_pictures' }, { num: 3, name: 'memes' }],
        prepareImage: async (blob) => ({ blob, mime: 'image/jpeg' }),
    };
}

beforeEach(() => {
    resetImportJobForTests();
    beta.calls = [];
    failing = new Map();
    completes = 0;
    reads = [];
    api = {
        status: vi.fn(), connect: vi.fn(), checkApp: vi.fn(), forget: vi.fn(), listGuilds: vi.fn(), snapshot: vi.fn(),
        image: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'no' } })), cancel: vi.fn(async () => ({ ok: true })),
        history: vi.fn(async (req: { channel: number }) => { reads.push(req.channel); const f = failing.get(req.channel); return f ? { ok: false, error: f } : channel(5, req.channel === 3); }),
        media: vi.fn(async () => ({ ok: false, error: { code: 'too_large', message: 'This file is too large to bring over.' } })),
        setRunning: vi.fn(async () => ({ ok: true })),
    };
});
afterEach(() => { resetImportJobForTests(); });

const INTERNAL = { code: 'internal', message: 'Cipherline ran into a problem of its own while reading this from Discord (not your connection or Discord). Try again; if it keeps happening, update Cipherline.', step: 'reactions', errorName: 'TypeError' };

describe('issues found: failed channels, Retry per channel, the pill keeps the warning', () => {
    it('lists the failed channels (retryable), the files left out, and the pill says "N channels failed · Retry"', async () => {
        failing.set(1, { code: 'discord_down', message: 'Discord is having trouble right now. Try again in a minute.', step: 'read', status: 503, errorName: 'discord_server' });
        failing.set(2, INTERNAL);
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        const j = getImportJob()!;
        const issues = importJobIssues(j);
        expect(issues.failed.map(r => r.name)).toEqual(['general_chat', 'files_pictures']);
        expect(issues.retryable.map(r => r.name)).toEqual(['general_chat', 'files_pictures']);
        expect(issues.filesSkipped).toBe(1);
        expect(issues.any).toBe(true);
        expect(pillText(j)).toEqual({ label: 'Pixel Farm Co-op 2 channels failed · Retry', tone: 'danger' });
        // The report keeps the specific reason, never the generic text.
        expect(j.hReports!.find(r => r.name === 'files_pictures')!.error).toMatch(/problem of its own/);
        expect(j.hReports!.find(r => r.name === 'files_pictures')!.failure).toEqual({ step: 'reactions', code: 'internal', errorName: 'TypeError' });
    });

    it('Retry #one runs ONLY that channel (same session); fixing the last one turns the pill back to normal', async () => {
        failing.set(1, { code: 'discord_down', message: 'Discord is having trouble right now.' });
        failing.set(2, INTERNAL);
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        failing.clear();
        reads = [];
        retryFailedImportChannels(['ch-2']);
        await until(() => getImportJob()?.phase === 'done' && reads.length === 1);
        expect(reads).toEqual([2]);
        expect(pillText(getImportJob()!)).toEqual({ label: 'Pixel Farm Co-op 1 channel failed · Retry', tone: 'danger' });
        retryFailedImportChannels();
        await until(() => getImportJob()?.phase === 'done' && importJobIssues(getImportJob()).failed.length === 0);
        // The files left out in #memes are still an issue, but nothing to retry: warn, not danger.
        expect(pillText(getImportJob()!)).toEqual({ label: 'Pixel Farm Co-op imported with issues · See report', tone: 'warn' });
        expect(completes).toBe(1);
    });

    it('no issues: the pill and the report are the plain success ones (control)', async () => {
        api.history = vi.fn(async () => channel(3, false));
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        expect(importJobIssues(getImportJob()).any).toBe(false);
        expect(pillText(getImportJob()!)).toEqual({ label: 'Pixel Farm Co-op imported · See report', tone: 'ok' });
    });

    it('finished with nothing on screen: the toast says "Import finished — issues found" (error tone, stays until dismissed)', async () => {
        failing.set(2, INTERNAL);
        const pushed: Array<Record<string, unknown>> = [];
        vi.resetModules();
        vi.doMock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: (t: Record<string, unknown>) => { pushed.push(t); } }) }));
        const bg = await import('./backgroundImport');
        const { DiscordImportHost: Host } = await import('../../components/server/discordImport/DiscordImportHost');
        bg.resetImportJobForTests();
        const el = document.createElement('div');
        document.body.appendChild(el);
        const root = createRoot(el);
        await act(async () => { root.render(React.createElement(Host, { onOpenServer: () => undefined })); });
        bg.startImportJob(input());
        await until(() => bg.getImportJob()?.phase === 'done');
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({ kind: 'error', title: 'Import finished — issues found', durationMs: 0 });
        expect(String(pushed[0].message)).toMatch(/#files_pictures didn’t come over\. 1 file couldn’t be copied\./);
        expect((pushed[0].action as { label: string }).label).toBe('Review and retry');
        // The pill is in its danger state with the retry wording.
        const pill = el.querySelector('[data-testid="import-pill"]');
        expect(pill?.className).toMatch(/is-danger/);
        expect(pill?.getAttribute('aria-label')).toBe('Pixel Farm Co-op 1 channel failed · Retry. Open the import');
        expect(pill?.querySelector('[data-testid="import-pill-tail"]')?.textContent).toBe('Retry');
        await act(async () => { root.unmount(); });
        bg.resetImportJobForTests();
        vi.doUnmock('../../contexts/ToastContext');
        void DiscordImportHost;
    });

    it('dismissing is what lets it go (and closes the session)', async () => {
        failing.set(2, INTERNAL);
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        expect(completes).toBe(0);
        dismissImportJob();
        await until(() => completes === 1);
        expect(getImportJob()).toBeNull();
    });
});

describe('beta diagnostics: import_channel_failed / import_files_skipped (labels and counts only)', () => {
    it('a failed channel and skipped files are reported with step, code, status, class and counts', async () => {
        failing.set(2, INTERNAL);
        failing.set(1, { code: 'discord_down', message: 'x', step: 'read', status: 503, errorName: 'discord_server' });
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        const failed = beta.calls.filter(c => c[0] === 'import_channel_failed').map(c => c[1]);
        expect(failed).toEqual([
            { step: 'read', code: 'discord_down', status: 503, error_name: 'discord_server', retryable: true, partly_posted: false, messages_skipped: 0, job: 'import', retry: false },
            { step: 'reactions', code: 'internal', error_name: 'TypeError', retryable: true, partly_posted: false, messages_skipped: 0, job: 'import', retry: false },
        ]);
        const files = beta.calls.filter(c => c[0] === 'import_files_skipped').map(c => c[1]);
        expect(files).toEqual([{ files: 1, channels: 1, too_large: 1, job: 'import', retry: false }]);
        // Nothing the user wrote, no file / channel / server names, no ids.
        const wire = JSON.stringify(beta.calls);
        for (const s of ['secret words', 'holiday-video', 'files_pictures', 'general_chat', 'Pixel Farm', SID, 'ch-2', '900000000000000000', '700000000000000001']) expect(wire).not.toContain(s);
        // Every detail survives the reporter's sanitizer unchanged (enum strings, numbers, booleans).
        for (const [, d] of beta.calls) expect(sanitizeDetail(d)).toEqual(d);
    });

    it('a retry that succeeds sends nothing; a clean import sends nothing (control)', async () => {
        api.history = vi.fn(async () => channel(3, false));
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        expect(beta.calls).toEqual([]);
    });

    it('partial reads and unreadable messages are counted; a failure without details still reports step/code "unknown"', () => {
        const base: ChannelReport = { channelId: 'c', name: 'n', messages: 1, rows: 1, filesImported: 0, filesSkipped: [], pinsSaved: 0, pinsNoRoom: 0, truncated: false, ceilingHit: false, reactionsSkipped: 0, error: null, savable: [] };
        const ev = importDiagEvents([{ ...base, partial: true, unreadable: 2 }, { ...base, error: 'x', rows: 3 }], { job: 'copy', retry: true });
        expect(ev).toEqual([
            ['import_channel_failed', { step: 'unknown', code: 'unknown', retryable: false, partly_posted: true, messages_skipped: 0, job: 'copy', retry: true }],
            ['import_files_skipped', { files: 0, channels: 0, unreadable: 2, partial: 1, job: 'copy', retry: true }],
        ]);
    });
});

describe('the report\'s file summary', () => {
    it('counts by reason, biggest first, in plain words', () => {
        expect(filesSkippedSummary([{ code: 'too_large' }, { code: 'expired' }, { code: 'too_large' }, {}])).toBe('4 files couldn’t be copied (2 too large to copy, 1 gone from Discord, 1 other problems)');
        expect(filesSkippedSummary([{ code: 'download_failed' }])).toBe('1 file couldn’t be copied (1 download failed)');
    });
});
