// @vitest-environment jsdom
/**
 * 2026-11-22, three things on top of the app-level job (backgroundImport.ts):
 *   1. MERGED RUNNER BEHAVIOUR: the run lives in the job AND channels fail / retry one by one
 *      (claude/discord-import-zero-channels): a failed, nothing-posted channel leaves the session open,
 *      Retry posts it into the SAME session, leaving closes the session.
 *   2. "Copy messages from Discord" into an EXISTING server (startCopyJob): no structure phase, the
 *      admin's mapping, source keys sent, never a key minted over a live channel.
 *   3. Crash recovery: the open-session marker, and ending that session at the next sign-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, string>();
let accountReady: Promise<void> = Promise.resolve();
vi.mock('../secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        whenAccountReady: () => accountReady,
    },
}));

import {
    NO_CHANNEL_KEY_MESSAGE, dismissImportJob, endInterruptedImportSession, getImportJob, importJobRunning, resetImportJobForTests,
    retryFailedImportChannels, retryableImportChannels, startCopyJob, startImportJob, stopImportJobHistory, type CopyJobInput, type ImportJobInput,
} from './backgroundImport';
import { IMPORT_SESSION_MARKER_KEY } from './sessionMarker';
import type { DiscordImportApi, GuildSnapshot, ImportMessage } from './types';
import type { DiscordHistoryHost } from './history/host';

const SID = '5e1e0000-0000-4000-8000-000000000001';
const SNAPSHOT: GuildSnapshot = {
    guild: { id: '800000000000000001', name: 'Pixel Farm Co-op', description: null, hasIcon: false, hasBanner: false },
    body: { name: 'Pixel Farm Co-op', roles: [], channels: [{ id: 1, type: 0, name: 'general_chat', position: 0 }, { id: 2, type: 0, name: 'files_pictures', position: 1 }] },
    emojis: [],
    channelKeys: { 1: 'a1'.repeat(32), 2: 'b2'.repeat(32) },
    counts: { roles: 0, categories: 0, channels: 2, emojis: 0 },
    notMapped: [],
};

const until = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 2));
    }
};

function channel(n: number, prefix: string) {
    const messages: ImportMessage[] = Array.from({ length: n }, (_, i) => ({
        id: String(900000000000000000n + BigInt(i)), ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), edited: false,
        author: { id: '700000000000000001', name: 'Sam', username: 'sam', kind: 'user' as const, avatarRef: null },
        content: `${prefix} ${i}`, mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], poll: null, pinned: false, reactions: [],
    }));
    return { ok: true as const, messages, pins: [], truncated: false, names: { roles: {}, channels: {} } };
}

let api: Record<string, ReturnType<typeof vi.fn>>;
let failing: Set<number>;
let sessions: Array<Record<string, unknown>>;
let postedBy: Map<string, number>;
let completes: number;
let cancels: Array<{ iid: string; deletePosted: boolean }>;
let unloadCancels: number;
let minted: string[];
let missingKeys: Set<string>;
let historyHost: DiscordHistoryHost;

beforeEach(() => {
    resetImportJobForTests();
    store.clear();
    accountReady = Promise.resolve();
    failing = new Set();
    sessions = [];
    postedBy = new Map();
    completes = 0;
    cancels = [];
    unloadCancels = 0;
    minted = [];
    missingKeys = new Set();
    api = {
        status: vi.fn(), connect: vi.fn(), checkApp: vi.fn(), forget: vi.fn(), listGuilds: vi.fn(), snapshot: vi.fn(),
        image: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'no' } })),
        cancel: vi.fn(async () => ({ ok: true })),
        history: vi.fn(async (req: { channel: number }) => failing.has(req.channel)
            ? { ok: false, error: { code: 'history_hidden', message: 'Discord sent no messages for this channel, but it has some: the bot can’t read its history.' } }
            : channel(req.channel === 1 ? 30 : 12, `c${req.channel}`)),
        media: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
        setRunning: vi.fn(async () => ({ ok: true })),
    };
    historyHost = {
        api: () => ({
            createSession: async (body: Record<string, unknown>) => { sessions.push(body); return { id: `imp-${sessions.length}` }; },
            registerAuthors: async (_iid: string, authors: unknown[]) => ({ author_ids: authors.map((_, i) => `ref-${i}`) }),
            postBatch: async (_iid: string, body: { channel_id: string; seq_start: number; rows: unknown[] }) => {
                postedBy.set(body.channel_id, (postedBy.get(body.channel_id) ?? 0) + body.rows.length);
                return { ids: body.rows.map((_, i) => `m-${body.channel_id}-${body.seq_start + i}`), seq_next: body.seq_start + body.rows.length };
            },
            initiateFiles: async () => [],
            save: async () => ({ results: [], used_bytes: 0, limit_bytes: 0 }),
            complete: async () => { completes++; return {}; },
        }),
        prepareChannelKeys: async (_s: string, ids: string[]) => { minted.push(...ids); },
        existingChannelKeys: async (_s: string, ids: string[]) => ids.filter(id => missingKeys.has(id)),
        sealRow: async (json: string) => ({ epoch: 1, nonce_b64: 'n', ciphertext_b64: btoa(json).slice(0, 40), signature_b64: 's' }),
        encryptFile: async () => { throw new Error('no files here'); },
        upload: async () => undefined,
        storage: async () => ({ used_bytes: 0, limit_bytes: 1 }),
        emojiIds: async () => ({}),
        cancel: async (_s: string, iid: string, deletePosted: boolean) => { cancels.push({ iid, deletePosted }); return { deleted: 0 }; },
        cancelOnUnload: () => { unloadCancels++; },
        deviceId: 'dev-1',
        maxFileBytes: 25 * 1024 * 1024,
    } as unknown as DiscordHistoryHost;
});
afterEach(() => { resetImportJobForTests(); });

function importInput(): ImportJobInput {
    return {
        api: api as unknown as DiscordImportApi,
        host: {
            importGuild: vi.fn(async () => ({ server_id: SID, name: 'Pixel Farm Co-op', channel_refs: { 'c:1': 'ch-1', 'c:2': 'ch-2' }, role_refs: {} })),
            listEmojiNames: vi.fn(async () => []), createEmoji: vi.fn(async () => undefined),
            upload: vi.fn(async () => ({ attachmentId: 'a', keyB64: 'k', nonceB64: 'n' })),
        },
        history: historyHost, guildId: SNAPSHOT.guild.id, snapshot: SNAPSHOT, serverName: 'Pixel Farm Co-op', description: null,
        includeImages: false, includeEmojis: false, includeStickers: false,
        historyChannels: [{ num: 1, name: 'general_chat' }, { num: 2, name: 'files_pictures' }],
        prepareImage: async (blob) => ({ blob, mime: 'image/jpeg' }),
    };
}

function copyInput(extra: Partial<CopyJobInput> = {}): CopyJobInput {
    return {
        api: api as unknown as DiscordImportApi, history: historyHost, guildId: SNAPSHOT.guild.id, guildName: 'Pixel Farm Co-op',
        server: { id: SID, name: 'Pixel Farm' },
        channels: [
            { num: 1, name: 'general_chat', channelId: 'old-general', sourceKey: 'a1'.repeat(32) },
            { num: 2, name: 'files_pictures', channelId: 'old-files', sourceKey: 'b2'.repeat(32) },
        ],
        channelRefs: { 'c:1': 'old-general', 'c:2': 'old-files', 'c:3': 'old-rules' },
        ...extra,
    };
}

describe('merged: the run lives in the job AND channels fail / retry one by one', () => {
    it('a failed channel is a failure in the job\'s report; the session stays open; Retry posts it into the SAME session', async () => {
        failing.add(2);
        startImportJob(importInput());
        await until(() => getImportJob()?.phase === 'done');
        let j = getImportJob()!;
        expect(j.hReports?.map(r => [r.name, r.messages, r.error !== null])).toEqual([['general_chat', 30, false], ['files_pictures', 0, true]]);
        expect(completes).toBe(0);                                   // kept open for the retry
        expect(retryableImportChannels(j).map(r => r.name)).toEqual(['files_pictures']);
        expect(store.has(IMPORT_SESSION_MARKER_KEY)).toBe(true);    // an open session survives a crash on the marker
        failing.delete(2);
        retryFailedImportChannels();
        expect(importJobRunning()).toBe(true);                       // the pill shows it again
        await until(() => getImportJob()?.phase === 'done');
        j = getImportJob()!;
        expect(j.hReports?.map(r => [r.name, r.messages, r.error])).toEqual([['general_chat', 30, null], ['files_pictures', 12, null]]);
        expect(sessions).toHaveLength(1);                            // the same session
        expect(postedBy.get('ch-1')).toBe(30);                       // the good channel was not posted again
        expect(postedBy.get('ch-2')).toBe(12);
        expect(completes).toBe(1);
        expect(retryableImportChannels(j)).toEqual([]);
        expect(store.has(IMPORT_SESSION_MARKER_KEY)).toBe(false);
    });

    it('leaving with a failed channel closes the session (dismiss / Open server), and a later Retry is not offered', async () => {
        failing.add(2);
        startImportJob(importInput());
        await until(() => getImportJob()?.phase === 'done');
        expect(completes).toBe(0);
        dismissImportJob();
        await until(() => completes === 1);
        expect(getImportJob()).toBeNull();
        await until(() => !store.has(IMPORT_SESSION_MARKER_KEY));
    });

    it('a page unload while a failed channel waits for Retry ends the session keeping rows (keepalive), once', async () => {
        failing.add(2);
        startImportJob(importInput());
        await until(() => getImportJob()?.phase === 'done');
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('pagehide'));
        expect(unloadCancels).toBe(1);
        expect(retryableImportChannels(getImportJob())).toEqual([]);  // closed: no retry into a dead session
    });

    it('Stop and keep ends the session; nothing is left to close or retry', async () => {
        let release!: () => void;
        const hold = new Promise<void>(r => { release = r; });
        api.history.mockImplementationOnce(async () => { await hold; return channel(5, 'x'); });
        startImportJob(importInput());
        await until(() => getImportJob()?.phase === 'history' && !!getImportJob()?.hProgress);
        const stopping = stopImportJobHistory(false);
        release();
        await stopping;
        expect(getImportJob()?.stopped).toEqual({ deleted: 0 });
        dismissImportJob();
        await new Promise(r => setTimeout(r, 10));
        expect(completes).toBe(0);
    });

    it('a new-server import records each channel\'s source key with the session (the next copy auto-matches)', async () => {
        startImportJob(importInput());
        await until(() => getImportJob()?.phase === 'done');
        expect(sessions[0].channel_sources).toEqual([
            { channel_id: 'ch-1', source_key: 'a1'.repeat(32) },
            { channel_id: 'ch-2', source_key: 'b2'.repeat(32) },
        ]);
        expect(minted).toEqual(['ch-1', 'ch-2']);   // a NEW server's channels are minted, as before
    });
});

describe('"Copy messages from Discord" into an existing server', () => {
    it('only messages, into the mapped existing channels, with their source keys; never mints a key there', async () => {
        const j0 = startCopyJob(copyInput());
        expect(j0).toMatchObject({ kind: 'copy', phase: 'history', serverName: 'Pixel Farm' });
        await until(() => getImportJob()?.phase === 'done');
        const j = getImportJob()!;
        expect(j.hReports?.map(r => [r.channelId, r.messages])).toEqual([['old-general', 30], ['old-files', 12]]);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            channel_ids: ['old-general', 'old-files'],
            channel_sources: [{ channel_id: 'old-general', source_key: 'a1'.repeat(32) }, { channel_id: 'old-files', source_key: 'b2'.repeat(32) }],
        });
        expect(minted).toEqual([]);                                  // POSITIVE CONTROL above: the import path does mint
        expect(completes).toBe(1);
        expect(j.report?.serverId).toBe(SID);
    });

    it('a channel this device holds no current key for fails on its own (nothing posted, retryable); the rest is copied', async () => {
        missingKeys.add('old-files');
        startCopyJob(copyInput());
        await until(() => getImportJob()?.phase === 'done');
        let j = getImportJob()!;
        expect(j.hReports?.map(r => [r.channelId, r.messages, r.error])).toEqual([['old-general', 30, null], ['old-files', 0, NO_CHANNEL_KEY_MESSAGE]]);
        expect(postedBy.has('old-files')).toBe(false);
        expect(retryableImportChannels(j).map(r => r.channelId)).toEqual(['old-files']);
        missingKeys.clear();                                         // the key arrived
        retryFailedImportChannels();
        await until(() => getImportJob()?.phase === 'done' && getImportJob()!.hReports!.every(r => !r.error));
        j = getImportJob()!;
        expect(j.hReports?.map(r => [r.channelId, r.messages])).toEqual([['old-general', 30], ['old-files', 12]]);
        expect(sessions).toHaveLength(1);
    });

    it('one at a time: refused while another import runs', async () => {
        startCopyJob(copyInput());
        expect(() => startCopyJob(copyInput())).toThrow(/already running/);
        expect(() => startImportJob(importInput())).toThrow(/already running/);
        await until(() => getImportJob()?.phase === 'done');
    });

    it('an API refusal (e.g. already copied) shows the API\'s own words and keeps the server untouched', async () => {
        const base = historyHost;
        historyHost = { ...base, api: () => ({ ...(base.api('x')), createSession: async () => { throw Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, data: { code: 'IMPORT_ALREADY_COPIED', message: 'Messages from that Discord channel are already in this server. Copying them again would duplicate them.' } } }); } }) } as DiscordHistoryHost;
        startCopyJob(copyInput({ history: historyHost }));
        await until(() => getImportJob()?.phase === 'history-failed');
        expect(getImportJob()?.hError).toMatch(/already in this server/);
        expect(postedBy.size).toBe(0);
    });
});

describe('crash recovery: the open-session marker', () => {
    it('ends the session a crash left open at the next sign-in, then forgets it', async () => {
        store.set(IMPORT_SESSION_MARKER_KEY, JSON.stringify({ serverId: SID, at: 1 }));
        const end = vi.fn(async () => ({ ended: true, rows_posted: 120 }));
        await expect(endInterruptedImportSession(end)).resolves.toBe('ended');
        expect(end).toHaveBeenCalledWith(SID);
        expect(store.has(IMPORT_SESSION_MARKER_KEY)).toBe(false);
        await expect(endInterruptedImportSession(end)).resolves.toBe('none');
        expect(end).toHaveBeenCalledTimes(1);
    });

    it('offline: keeps the marker for next time; an API answer (403 / 404) clears it', async () => {
        store.set(IMPORT_SESSION_MARKER_KEY, JSON.stringify({ serverId: SID, at: 1 }));
        await expect(endInterruptedImportSession(async () => { throw new Error('Network Error'); })).resolves.toBe('kept');
        expect(store.has(IMPORT_SESSION_MARKER_KEY)).toBe(true);
        await expect(endInterruptedImportSession(async () => { throw Object.assign(new Error('x'), { response: { status: 404 } }); })).resolves.toBe('ended');
        expect(store.has(IMPORT_SESSION_MARKER_KEY)).toBe(false);
    });

    it('waits for the account store, and never touches a session a job of THIS run owns', async () => {
        let ready!: () => void;
        accountReady = new Promise<void>(r => { ready = r; });
        store.set(IMPORT_SESSION_MARKER_KEY, JSON.stringify({ serverId: SID, at: 1 }));
        const end = vi.fn(async () => ({ ended: true, rows_posted: 0 }));
        const p = endInterruptedImportSession(end);
        await new Promise(r => setTimeout(r, 5));
        expect(end).not.toHaveBeenCalled();
        startCopyJob(copyInput());
        ready();
        await expect(p).resolves.toBe('none');
        expect(end).not.toHaveBeenCalled();
        await until(() => getImportJob()?.phase === 'done');
    });

    it('a garbage marker is ignored', async () => {
        store.set(IMPORT_SESSION_MARKER_KEY, '{"serverId":"../../x"}');
        const end = vi.fn();
        await expect(endInterruptedImportSession(end)).resolves.toBe('none');
        expect(end).not.toHaveBeenCalled();
    });
});
