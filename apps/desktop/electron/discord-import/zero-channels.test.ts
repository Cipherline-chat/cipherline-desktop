/**
 * Regression for the owner's real import (staging 0.1.3-staging.267, 2026-11-22):
 * every channel came over except the two busiest, which the server never
 * received a single batch or upload for, and the report did not read as a
 * failure. The REAL main-process handler (mock Discord) feeds the REAL renderer
 * runner (fake Cipherline API), the way the wizard wires them.
 *
 * Failure modes covered (each fails on the code before the fix):
 *   1. one who-reacted lookup Discord keeps refusing (outage / long rate limit)
 *      threw away the whole channel read -> 0 rows;
 *   2. the pins read failing did the same;
 *   3. an empty first page (history the bot cannot read) was "0 messages", no error;
 *   4. a failed channel closed the session, so it could not be retried.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FetchLike } from './discord-client';
import { createDiscordImportHandlers, type KeyValueStore } from './ipc';
import { MOCK_GUILD_ID, mockApp, mockBans, mockChannels, mockGuild, mockMe, mockMembers } from './__fixtures__/mock-guild';
import { MOCK_TEXT_CHANNEL, PEOPLE, mockChannelMessages, mockPins } from './__fixtures__/mock-history';
import { newHistoryState, retryableChannel, runHistoryImport, type HistoryDeps } from '../../src/utils/discordImport/history/runner';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const GENERAL = '800000000000000018'; // mock-guild's "general" (the busy channel here)
const API = 'https://discord.com/api/v10';
const NOW = Date.parse('2026-11-20T18:00:00.000Z');
const BUSY = 250;

function memStore(): KeyValueStore {
    const m = new Map<string, string>();
    return { status: () => 'ok', get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, delete: k => { m.delete(k); } };
}

/** 250 messages newest first, every one with a 👍 reaction (a busy, well-liked channel). */
const busy = Array.from({ length: BUSY }, (_, i) => ({
    id: String(910000000000000000n + BigInt(BUSY - i)), type: 0, content: `message ${BUSY - i}`,
    timestamp: new Date(NOW - i * 60_000).toISOString(),
    author: [PEOPLE.alex, PEOPLE.sam, PEOPLE.riley][i % 3], mentions: [], attachments: [], embeds: [],
    reactions: [{ count: 2, emoji: { id: null, name: '👍' } }],
}));

interface Scenario {
    /** Reactor lookups for this message id fail like this, every time. */
    reactorFails?: { id: string; status: number; body?: unknown };
    pinsStatus?: number;
    /** The message list answers [] (history hidden from the bot); the channel's last message answers this. */
    hidden?: { lastStatus: number } | { noLast: true } | { probeStatus: number };
}

function discord(sc: Scenario, log: string[]): FetchLike {
    return async (url) => {
        log.push(url);
        const api = url.replace(API, '');
        const path = api.split('?')[0];
        let status = 200; let body: unknown = {}; let bytes = new Uint8Array(0);
        const headers: Record<string, string> = {};
        if (api === '/users/@me') body = mockMe();
        else if (api === '/oauth2/applications/@me') body = mockApp();
        else if (api === `/guilds/${MOCK_GUILD_ID}`) body = mockGuild();
        else if (api === `/guilds/${MOCK_GUILD_ID}/channels`) body = mockChannels();
        else if (api.startsWith(`/guilds/${MOCK_GUILD_ID}/members?`)) body = mockMembers();
        else if (api.startsWith(`/guilds/${MOCK_GUILD_ID}/bans?`)) body = mockBans();
        // #rules: the ordinary small channel next to it (mock-history).
        else if (path === `/channels/${MOCK_TEXT_CHANNEL}/messages/pins`) body = mockPins();
        else if (path === `/channels/${MOCK_TEXT_CHANNEL}/messages`) body = api.includes('before=') ? [] : mockChannelMessages();
        else if (path.startsWith(`/channels/${MOCK_TEXT_CHANNEL}/messages/`)) body = [];
        else if (path === `/channels/${GENERAL}`) {
            const h = sc.hidden;
            if (h && 'probeStatus' in h) { status = h.probeStatus; body = { message: 'x', code: h.probeStatus === 403 ? 50001 : 10003 }; }
            else body = { id: GENERAL, type: 0, last_message_id: h && 'noLast' in h ? null : busy[0].id };
        }
        else if (path === `/channels/${GENERAL}/messages/pins`) {
            if (sc.pinsStatus) { status = sc.pinsStatus; body = { message: 'boom' }; } else body = { items: [], has_more: false };
        } else if (path === `/channels/${GENERAL}/pins`) {
            if (sc.pinsStatus) { status = sc.pinsStatus; body = { message: 'boom' }; } else body = [];
        } else if (path.startsWith(`/channels/${GENERAL}/messages/`) && path.includes('/reactions/')) {
            const mid = path.split('/')[4];
            if (sc.reactorFails?.id === mid) {
                status = sc.reactorFails.status; body = sc.reactorFails.body ?? { message: 'Discord had a problem' };
                if (status === 429) headers['retry-after'] = '120';
            } else body = [{ id: PEOPLE.sam.id, username: 'samwise.k', global_name: 'Sam' }, { id: PEOPLE.alex.id, username: 'alex_92', global_name: 'Alex' }];
        } else if (path.startsWith(`/channels/${GENERAL}/messages/`)) {
            // the single-message lookup behind historyHiddenFromBot
            const h = sc.hidden;
            status = h && 'lastStatus' in h ? h.lastStatus : 200; body = status === 200 ? busy[0] : { message: 'x', code: status === 403 ? 50001 : 10008 };
        } else if (path === `/channels/${GENERAL}/messages`) {
            if (sc.hidden) body = [];
            else {
                const u = new URL(url);
                const before = u.searchParams.get('before');
                const start = before ? busy.findIndex(m => m.id === before) + 1 : 0;
                body = busy.slice(start, start + Number(u.searchParams.get('limit') ?? 50));
            }
        } else if (url.startsWith('https://cdn.discordapp.com/')) { bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]); headers['content-type'] = 'image/png'; }
        else { status = 404; body = { message: 'Unknown', code: 10003 }; }
        return {
            status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
            json: async () => body, arrayBuffer: async () => bytes.buffer,
        };
    };
}

/** A fake Cipherline import API that keeps what it ACCEPTED, per channel (like import_session_channels). */
function fakeApi() {
    const accepted = new Map<string, number>();
    const uploads = new Map<string, number>();
    let open = true;
    const api: HistoryDeps['api'] = {
        createSession: vi.fn(async () => ({ id: 'imp-1' })),
        registerAuthors: vi.fn(async (_i: string, a: unknown[]) => ({ author_ids: a.map((_x, k) => `4444444${k}-4444-4444-8444-444444444444`) })),
        postBatch: vi.fn(async (_i: string, b: { channel_id: string; seq_start: number; rows: unknown[] }) => {
            if (!open) throw Object.assign(new Error('closed'), { response: { status: 409, data: { message: 'This import is not active.' } } });
            const next = accepted.get(b.channel_id) ?? 0;
            accepted.set(b.channel_id, next + b.rows.length);
            return { ids: b.rows.map((_r, k) => `${b.channel_id}-row-${next + k}`), seq_next: next + b.rows.length };
        }),
        initiateFiles: vi.fn(async (_i: string, c: string, f: unknown[]) => { uploads.set(c, (uploads.get(c) ?? 0) + f.length); return f.map(() => ({ attachment_id: crypto.randomUUID(), upload_url: 'https://minio.local/put' })); }),
        save: vi.fn(async (_i: string, b: { items: Array<{ message_id: string }> }) => ({ results: b.items.map(x => ({ message_id: x.message_id, status: 'pinned' })), used_bytes: 0, limit_bytes: 0 })),
        complete: vi.fn(async () => { open = false; return {}; }),
    };
    return { api, accepted, uploads };
}

async function runImport(sc: Scenario) {
    const log: string[] = [];
    const h = createDiscordImportHandlers({ store: memStore(), clientOptions: { fetchFn: discord(sc, log), sleep: async () => undefined } });
    await h.connect({ token: TOKEN });
    const snap = await h.snapshot({ guildId: MOCK_GUILD_ID });
    if (!snap.ok) throw new Error(snap.error.message);
    const chans = (snap.snapshot.body as { channels: Array<{ id: number; name: string; type: number }> }).channels;
    const num = (name: string) => chans.find(c => c.name === name)!.id;
    const CIPHER_GENERAL = '11111111-1111-4111-8111-111111111111';
    const CIPHER_RULES = '22222222-2222-4222-8222-222222222222';
    const { api, accepted, uploads } = fakeApi();
    const deps: HistoryDeps = {
        api,
        readChannel: async (n) => { const r = await h.history({ guildId: MOCK_GUILD_ID, channel: n }); if (!r.ok) throw new Error(r.error.message); return r; },
        fetchMedia: async (ref) => { const r = await h.media({ ref }); return r.ok ? { ok: true as const, mime: r.mime, bytes: r.bytes } : { ok: false as const, code: r.error.code, message: r.error.message }; },
        encryptFile: async (bytes) => ({ blob: new Blob([bytes as BlobPart]), keyB64: 'a2V5', nonceB64: 'bm9uY2U=', sha256B64: null }),
        upload: async () => undefined,
        sealRow: async (json) => ({ epoch: 1, nonce_b64: 'bg==', ciphertext_b64: btoa(unescape(encodeURIComponent(json))).slice(0, 40), signature_b64: 'c2ln' }),
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', maxFileBytes: 100 * 1024 * 1024, sleep: async () => undefined,
    };
    const state = newHistoryState();
    const input = {
        serverId: 's', convert: {},
        channels: [{ channel: num('general'), channelId: CIPHER_GENERAL, name: 'general' }, { channel: num('\u{1F4DC}・rules'), channelId: CIPHER_RULES, name: 'rules' }],
    };
    await runHistoryImport(deps, input, state, () => {}, new AbortController().signal);
    const general = state.reports.find(r => r.name === 'general')!;
    return { state, general, accepted: accepted.get(CIPHER_GENERAL) ?? 0, uploads: uploads.get(CIPHER_GENERAL) ?? 0, rulesRows: accepted.get(CIPHER_RULES) ?? 0, api, deps, input, log };
}

describe('Discord import: a busy channel never comes over as 0 rows that read like success', () => {
    it('control: a healthy busy channel posts every message and its reactor names', async () => {
        const r = await runImport({});
        expect(r.general).toMatchObject({ error: null, messages: BUSY, rows: BUSY });
        expect(r.accepted).toBe(BUSY);
        expect(r.rulesRows).toBeGreaterThan(0);
    });

    it('a who-reacted lookup Discord keeps failing (5xx) costs only the names, never the channel', async () => {
        const r = await runImport({ reactorFails: { id: busy[3].id, status: 502 } });
        // Before the fix: 0 accepted, 0 uploads, error "Discord is having trouble right now", the rest came over.
        expect(r.accepted).toBe(BUSY);
        expect(r.uploads).toBeGreaterThan(0); // avatars, as for every channel
        expect(r.general).toMatchObject({ error: null, messages: BUSY, rows: BUSY });
        expect(r.general.notes?.join(' ')).toMatch(/who reacted/);
        expect(r.rulesRows).toBeGreaterThan(0);
    });

    it('a who-reacted lookup rate-limited for longer than we wait (429, retry 120 s) costs only the names', async () => {
        const r = await runImport({ reactorFails: { id: busy[0].id, status: 429, body: { retry_after: 120, global: false } } });
        expect(r.accepted).toBe(BUSY);
        expect(r.general.error).toBeNull();
        expect(r.general.notes?.join(' ')).toMatch(/who reacted/);
    });

    it('a pins read Discord keeps failing costs only the pins, never the channel', async () => {
        const r = await runImport({ pinsStatus: 503 });
        expect(r.accepted).toBe(BUSY);
        expect(r.general.error).toBeNull();
        expect(r.general.notes?.join(' ')).toMatch(/Pinned messages could not be read/);
    });

    it('history the bot cannot read (Discord answers []) is a FAILED channel with the reason, not "0 messages"', async () => {
        for (const hidden of [{ lastStatus: 200 }, { lastStatus: 403 }, { probeStatus: 403 }]) {
            const r = await runImport({ hidden });
            expect(r.accepted).toBe(0);
            expect(r.general.error).toMatch(/can’t read its history/);
            expect(retryableChannel(r.general)).toBe(true);
        }
    });

    it('a really empty channel (no last message, or it was deleted) is still just 0 messages', async () => {
        for (const sc of [{ hidden: { noLast: true as const } }, { hidden: { lastStatus: 404 } }, { hidden: { probeStatus: 404 } }, { hidden: { probeStatus: 500 } }]) {
            const r = await runImport(sc);
            expect(r.general).toMatchObject({ error: null, messages: 0, rows: 0 });
        }
    });

    it('a failed channel leaves the session open, and "Retry" posts it into the same session, then closes it', async () => {
        const r = await runImport({ hidden: { lastStatus: 403 } });
        expect(r.api.complete).not.toHaveBeenCalled();
        expect(r.state.completed).toBeFalsy();
        // Discord is fixed (the bot was given access) and the person presses Retry: only the failed channel runs.
        const log: string[] = [];
        const h2 = createDiscordImportHandlers({ store: memStore(), clientOptions: { fetchFn: discord({}, log), sleep: async () => undefined } });
        await h2.connect({ token: TOKEN });
        await h2.snapshot({ guildId: MOCK_GUILD_ID });
        const deps2: HistoryDeps = { ...r.deps, readChannel: async (n) => { const x = await h2.history({ guildId: MOCK_GUILD_ID, channel: n }); if (!x.ok) throw new Error(x.error.message); return x; },
            fetchMedia: async (ref) => { const x = await h2.media({ ref }); return x.ok ? { ok: true as const, mime: x.mime, bytes: x.bytes } : { ok: false as const, code: x.error.code, message: x.error.message }; } };
        const failed = r.state.reports.filter(retryableChannel).map(x => x.channelId);
        await runHistoryImport(deps2, { ...r.input, channels: r.input.channels.filter(c => failed.includes(c.channelId)) }, r.state, () => {}, new AbortController().signal);
        expect(r.api.createSession).toHaveBeenCalledTimes(1);
        expect(r.state.reports.filter(x => x.name === 'general')).toHaveLength(1); // replaced, not duplicated
        expect(r.state.reports.find(x => x.name === 'general')).toMatchObject({ error: null, rows: BUSY });
        expect(r.api.complete).toHaveBeenCalledTimes(1);
        expect(r.state.completed).toBe(true);
    });
});
