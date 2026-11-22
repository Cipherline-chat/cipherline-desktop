// @vitest-environment jsdom
/**
 * The Discord import as an app-level job (owner 2026-11-22: "do other stuff
 * while servers are importing"). No React, no DOM: the job must run to the end
 * with NO view mounted, one at a time, tell main while it runs (the quit
 * prompt), throttle its progress, and leave the report for whoever opens it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    PROGRESS_EMIT_MS, abortImportJob, attachImportJobViewer, cancelImportJob, dismissImportJob, getImportJob,
    importJobRunning, jobPercent, onImportJobFinished, resetImportJobForTests, retryImportJob, startImportJob,
    stopImportJobHistory, subscribeImportJob, type ImportJobInput,
} from './backgroundImport';
import type { DiscordImportApi, GuildSnapshot, ImportMessage } from './types';
import type { DiscordHistoryHost } from './history/host';

const SNAPSHOT: GuildSnapshot = {
    guild: { id: '800000000000000001', name: 'Pixel Farm Co-op', description: null, hasIcon: false, hasBanner: false },
    body: { name: 'Pixel Farm Co-op', roles: [], channels: [{ id: 1, type: 0, name: 'general', position: 0 }, { id: 2, type: 0, name: 'memes', position: 1 }] },
    emojis: [],
    counts: { roles: 3, categories: 1, channels: 2, emojis: 0 },
    notMapped: [],
};

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const until = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 2));
    }
};

/** A Discord channel of `n` text messages from one author. */
function channel(n: number, prefix: string) {
    const messages: ImportMessage[] = Array.from({ length: n }, (_, i) => ({
        id: String(900000000000000000n + BigInt(i)), ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), edited: false,
        author: { id: '700000000000000001', name: 'Sam', username: 'sam', kind: 'user' as const, avatarRef: null },
        content: `${prefix} ${i}`, mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], poll: null, pinned: false, reactions: [],
    }));
    return { ok: true as const, messages, pins: [], truncated: false, names: { roles: {}, channels: {} } };
}

let api: { [K in keyof DiscordImportApi]-?: ReturnType<typeof vi.fn> };
let posted: number;
let gate: { wait: Promise<void>; open: () => void } | null;
let historyHost: DiscordHistoryHost;
let cancelCalls: Array<{ deletePosted: boolean }>;

function input(extra: Partial<ImportJobInput> = {}): ImportJobInput {
    return {
        api: api as unknown as DiscordImportApi,
        host: {
            importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm Co-op', channel_refs: { 'c:1': 'ch-1', 'c:2': 'ch-2' }, role_refs: {} })),
            listEmojiNames: vi.fn(async () => []),
            createEmoji: vi.fn(async () => undefined),
            upload: vi.fn(async () => ({ attachmentId: 'a', keyB64: 'k', nonceB64: 'n' })),
        },
        history: historyHost,
        guildId: SNAPSHOT.guild.id, snapshot: SNAPSHOT, serverName: 'Pixel Farm Co-op', description: null,
        includeImages: false, includeEmojis: false, includeStickers: false,
        historyChannels: [{ num: 1, name: 'general' }, { num: 2, name: 'memes' }],
        prepareImage: async (blob) => ({ blob, mime: 'image/jpeg' }),
        ...extra,
    };
}

beforeEach(() => {
    resetImportJobForTests();
    posted = 0;
    gate = null;
    cancelCalls = [];
    api = {
        status: vi.fn(), connect: vi.fn(), checkApp: vi.fn(), forget: vi.fn(async () => ({ ok: true })), listGuilds: vi.fn(), snapshot: vi.fn(),
        image: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'no' } })),
        cancel: vi.fn(async () => ({ ok: true })),
        history: vi.fn(async (req: { channel: number }) => channel(req.channel === 1 ? 250 : 40, `c${req.channel}`)),
        media: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
        setRunning: vi.fn(async () => ({ ok: true })),
    };
    historyHost = {
        api: () => ({
            createSession: async () => ({ id: 'imp-1' }),
            registerAuthors: async (_iid: string, authors: unknown[]) => ({ author_ids: authors.map((_, i) => `ref-${i}`) }),
            postBatch: async (_iid: string, body: { seq_start: number; rows: unknown[] }) => {
                if (gate) await gate.wait;
                posted += body.rows.length;
                return { ids: body.rows.map((_, i) => `m-${body.seq_start + i}`), seq_next: body.seq_start + body.rows.length };
            },
            initiateFiles: async () => [],
            save: async () => ({ results: [], used_bytes: 0, limit_bytes: 0 }),
            complete: async () => ({}),
        }),
        prepareChannelKeys: async () => undefined,
        sealRow: async (json: string) => ({ epoch: 1, nonce_b64: 'n', ciphertext_b64: btoa(json).slice(0, 40), signature_b64: 's' }),
        encryptFile: async () => { throw new Error('no files here'); },
        upload: async () => undefined,
        storage: async () => ({ used_bytes: 0, limit_bytes: 1 }),
        emojiIds: async () => ({}),
        cancel: async (_s: string, _i: string, deletePosted: boolean) => { cancelCalls.push({ deletePosted }); return { deleted: deletePosted ? posted : 0 }; },
        deviceId: 'dev-1',
        maxFileBytes: 25 * 1024 * 1024,
    } as unknown as DiscordHistoryHost;
});
afterEach(() => { resetImportJobForTests(); vi.useRealTimers(); });

function holdPosts() {
    let open!: () => void;
    const wait = new Promise<void>(r => { open = r; });
    gate = { wait, open };
    return gate;
}

describe('runs with no view mounted', () => {
    it('structure then messages, to the end, with nothing on screen; the report is left for whoever opens it', async () => {
        const finished = vi.fn();
        onImportJobFinished(finished);
        startImportJob(input());
        expect(importJobRunning()).toBe(true);
        await until(() => getImportJob()?.phase === 'done');
        const j = getImportJob()!;
        expect(j.report?.serverId).toBe('srv-1');
        expect(j.hReports?.map(r => [r.name, r.messages])).toEqual([['general', 250], ['memes', 40]]);
        expect(posted).toBe(290);
        expect(j.percent).toBe(100);
        expect(j.seen).toBe(false);          // nobody saw it finish: the host shows the "Import finished" toast
        expect(finished).toHaveBeenCalledTimes(1);
        expect(finished.mock.calls[0][0]).toMatchObject({ phase: 'done', seen: false });
        // Opening the report afterwards marks it seen.
        const detach = attachImportJobViewer();
        expect(getImportJob()!.seen).toBe(true);
        expect(getImportJob()!.viewing).toBe(true);
        detach();
        expect(getImportJob()!.viewing).toBe(false);
    });

    it('a view open when it finishes: seen (no toast)', async () => {
        const detach = attachImportJobViewer();
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        expect(getImportJob()!.seen).toBe(true);
        detach();
    });

    it('closing / reopening the view (attach, detach, attach) never restarts or duplicates the import', async () => {
        const g = holdPosts();
        const job = startImportJob(input());
        const d1 = attachImportJobViewer();
        await until(() => getImportJob()?.phase === 'history');
        d1();                                            // the wizard closes
        const d2 = attachImportJobViewer();              // reopened from the pill
        expect(getImportJob()!.id).toBe(job.id);
        g.open();
        await until(() => getImportJob()?.phase === 'done');
        d2();
        expect(posted).toBe(290);                        // every row once
        expect(api.history).toHaveBeenCalledTimes(2);    // each channel read once
    });

    it('tells main while it runs (the quit prompt), and that it stopped', async () => {
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        expect(api.setRunning.mock.calls.map(c => c[0])).toEqual([true, false]);
    });

    it('an older preload without setRunning is fine', async () => {
        delete (api as Partial<typeof api>).setRunning;
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done');
        expect(getImportJob()!.phase).toBe('done');
    });
});

describe('one at a time', () => {
    it('a second start while one runs is refused; after it finishes, a new one replaces it', async () => {
        const g = holdPosts();
        startImportJob(input());
        expect(() => startImportJob(input({ serverName: 'Second' }))).toThrow(/already running/);
        g.open();
        await until(() => getImportJob()?.phase === 'done');
        const second = startImportJob(input({ serverName: 'Second', historyChannels: [] }));
        expect(getImportJob()!.id).toBe(second.id);
        await until(() => getImportJob()?.phase === 'done');
        expect(getImportJob()!.serverName).toBe('Pixel Farm Co-op'); // the API's name for the new server
    });

    it('dismiss never drops a running job; a finished one goes away', async () => {
        const g = holdPosts();
        startImportJob(input());
        dismissImportJob();
        expect(getImportJob()).not.toBeNull();
        g.open();
        await until(() => getImportJob()?.phase === 'done');
        dismissImportJob();
        expect(getImportJob()).toBeNull();
    });
});

describe('progress reaches subscribers throttled', () => {
    it('hundreds of per-message reports become a handful of notifications', async () => {
        const seen = vi.fn();
        subscribeImportJob(seen);
        const t0 = Date.now();
        startImportJob(input({ historyChannels: [{ num: 1, name: 'general' }] }));
        await until(() => getImportJob()?.phase === 'done');
        const elapsed = Date.now() - t0;
        // 250 messages report ~250 times; subscribers hear phase changes plus at most one per PROGRESS_EMIT_MS.
        expect(seen.mock.calls.length).toBeLessThan(12 + Math.ceil(elapsed / PROGRESS_EMIT_MS));
        expect(seen.mock.calls.length).toBeLessThan(60);
    });

    it('percent: structure is the first 10% when messages follow, then by channel', () => {
        const base = { withHistory: true, hProgress: null };
        expect(jobPercent({ ...base, phase: 'structure', progress: { step: 'server', done: 1, total: 2, label: '' } })).toBe(5);
        expect(jobPercent({ ...base, phase: 'history', progress: null, hProgress: { channelIndex: 1, channels: 2, channelName: 'x', phase: 'posting', done: 50, total: 100 } })).toBe(78);
        expect(jobPercent({ withHistory: false, hProgress: null, phase: 'structure', progress: { step: 'server', done: 1, total: 2, label: '' } })).toBe(50);
        expect(jobPercent({ ...base, phase: 'done', progress: null })).toBe(100);
    });
});

describe('stop, cancel, retry, sign-out', () => {
    it('Stop and keep: the copy stops, the server call keeps what was posted, the report says so', async () => {
        const g = holdPosts();
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'history' && getImportJob()!.importId !== null || posted > 0 || !!getImportJob()?.hProgress && getImportJob()!.hProgress!.phase === 'posting');
        const stopping = stopImportJobHistory(false);
        g.open();
        await stopping;
        const j = getImportJob()!;
        expect(j.phase).toBe('done');
        expect(j.stopped).toEqual({ deleted: 0 });
        expect(cancelCalls).toEqual([{ deletePosted: false }]);
        // The channel being copied when Stop was pressed is in the report (the stop waits for the runner to notice).
        expect(j.hReports?.map(r => r.name)).toContain('general');
        expect(api.cancel).toHaveBeenCalled();           // main's Discord reads stop too
        expect(api.setRunning.mock.calls.at(-1)![0]).toBe(false);
        await tick();
        expect(getImportJob()!.phase).toBe('done');      // the aborted runner never overwrites the stop
    });

    it('Stop and delete: the server call deletes what was posted', async () => {
        // The first batch (100 rows) lands, the second waits: stop in between.
        let g: ReturnType<typeof holdPosts> | null = null;
        const realApi = historyHost.api;
        historyHost.api = (sid: string) => {
            const a = realApi(sid);
            return { ...a, postBatch: async (iid, body) => { const r = await a.postBatch(iid, body); if (!g) g = holdPosts(); return r; } };
        };
        startImportJob(input());
        await until(() => posted > 0 && !!gate);
        await stopImportJobHistory(true);
        g!.open();
        expect(cancelCalls).toEqual([{ deletePosted: true }]);
        expect(getImportJob()!.stopped!.deleted).toBeGreaterThan(0);
    });

    it('Cancel before the server exists (reading the icon): nothing created, phase cancelled', async () => {
        const i = input({ includeImages: true, snapshot: { ...SNAPSHOT, guild: { ...SNAPSHOT.guild, hasIcon: true } } });
        let release!: () => void;
        api.image.mockImplementationOnce(() => new Promise(r => { release = () => r({ ok: false, error: { code: 'x', message: 'cancelled' } }); }));
        startImportJob(i);
        await tick();
        cancelImportJob();
        release();
        await until(() => getImportJob()?.phase !== 'structure');
        expect(getImportJob()!.phase).toBe('cancelled');
        expect(getImportJob()!.error).toBe('Cancelled. Nothing was created.');
        expect(i.host.importGuild).not.toHaveBeenCalled();
        expect(api.cancel).toHaveBeenCalled();
        expect(importJobRunning()).toBe(false);
        expect(api.setRunning.mock.calls.map(c => c[0])).toEqual([true, false]);
    });

    it('a failed create: Try again resumes on the SAME job and never makes a second server', async () => {
        const i = input({ historyChannels: [] });
        const ig = i.host.importGuild as ReturnType<typeof vi.fn>;
        ig.mockRejectedValueOnce({ response: { status: 500 } });
        const job = startImportJob(i);
        await until(() => getImportJob()?.phase === 'structure-failed');
        expect(getImportJob()!.error).toMatch(/went wrong/);
        retryImportJob();
        await until(() => getImportJob()?.phase === 'done');
        expect(getImportJob()!.id).toBe(job.id);
        expect(ig).toHaveBeenCalledTimes(2);
    });

    it('messages stopped by an error: kept, reported, finish listeners told', async () => {
        const finished = vi.fn();
        onImportJobFinished(finished);
        api.history.mockImplementation(async (req: { channel: number }) => (req.channel === 1 ? channel(10, 'c1') : { ok: false, error: { code: 'x', message: 'Discord said no' } }));
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'done' || getImportJob()?.phase === 'history-failed');
        // A per-channel failure is reported on that channel; the import completes.
        const j = getImportJob()!;
        expect(j.hReports?.find(r => r.name === 'memes')?.error).toMatch(/Discord said no/);
        expect(finished).toHaveBeenCalledTimes(1);
    });

    it('the page going away mid-copy (Quit anyway, reload) ends the API session KEEPING what was posted; not after it finished', async () => {
        const unload = vi.fn();
        (historyHost as { cancelOnUnload?: unknown }).cancelOnUnload = unload;
        const g = holdPosts();
        startImportJob(input());
        await until(() => getImportJob()?.importId !== null && getImportJob()?.importId !== undefined || getImportJob()?.hProgress?.phase === 'posting');
        window.dispatchEvent(new Event('pagehide'));
        expect(unload).toHaveBeenCalledWith('srv-1', 'imp-1');
        g.open();
        await until(() => getImportJob()?.phase === 'done');
        window.dispatchEvent(new Event('pagehide'));
        expect(unload).toHaveBeenCalledTimes(1);
    });

    it('a refusal shows the API\'s own words (e.g. another import still active for this account)', async () => {
        const realApi = historyHost.api;
        historyHost.api = (sid: string) => ({ ...realApi(sid), createSession: async () => { throw { response: { status: 409, data: { code: 'IMPORT_ALREADY_ACTIVE', message: 'An import is already running for this server or this account.' } }, message: 'Request failed with status code 409' }; } });
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'history-failed');
        expect(getImportJob()!.hError).toBe('An import is already running for this server or this account.');
    });

    it('signing out aborts it quietly and forgets it', async () => {
        const g = holdPosts();
        startImportJob(input());
        await until(() => getImportJob()?.phase === 'history');
        abortImportJob();
        expect(getImportJob()).toBeNull();
        expect(importJobRunning()).toBe(false);
        expect(api.setRunning.mock.calls.at(-1)![0]).toBe(false);
        g.open();
        await tick(40);
        expect(getImportJob()).toBeNull();               // the aborted run never resurrects it
    });
});
