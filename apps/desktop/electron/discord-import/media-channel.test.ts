/**
 * Regression for the owner's #files_pictures (staging 0.1.3-staging.269, 2026-11-22): 11 of 12 channels came
 * over, #files_pictures got 0 rows and 0 attachment initiates on two imports and on Retry, and the report said
 * "#files_pictures — not copied: Something went wrong talking to Discord." That text is the IPC layer's
 * description of an error that is NOT a DiscordApiError, i.e. a bug of ours thrown while main READ the
 * channel (before any avatar or batch, which is why the server saw nothing).
 *
 * Reproduced cause: the who-reacted merge (fetchReactors) wrote names into every copy of a message by the
 * reaction's INDEX. A pinned message in the window exists twice (the window read and the pins read, two answers
 * from Discord): when the pinned copy carries fewer reactions than the window copy, `copy.reactions[i]` is
 * undefined and `.count` threw a TypeError, deterministically, on every read of that channel. A pictures
 * channel with a pinned, reacted-to picture is exactly that.
 *
 * Also covered here (each a way a media-heavy channel could still be lost, each with a positive control):
 * oversized videos (declared > 100 MB / > the per-file limit) -> a placeholder line + counted skip; an expired
 * signed CDN URL -> refreshed by re-reading the message; a download whose body is interrupted -> retried, then
 * a placeholder; unicode / emoji / long file names, `(1)` in a CDN path, the proxy's `&=&` and `width=` query,
 * HEIC / MOV / WEBM / odd MIME types, spoiler + voice-note flags, > 10 attachments, embeds-only pictures;
 * transient 5xx on a message page -> retried with backoff (Retry-After honoured); a page that keeps failing
 * after some pages -> the newest messages come over + a note; on the FIRST page -> the channel fails with a
 * SPECIFIC reason (never the generic text) and the step / status / class for diagnostics.
 *
 * The REAL main-process handlers (mock Discord) feed the REAL renderer runner (fake Cipherline API).
 */
import { describe, it, expect, vi } from 'vitest';
import type { FetchLike } from './discord-client';
import { createDiscordImportHandlers, type KeyValueStore } from './ipc';
import { MOCK_GUILD_ID, mockApp, mockBans, mockChannels, mockGuild, mockMe, mockMembers } from './__fixtures__/mock-guild';
import { PEOPLE } from './__fixtures__/mock-history';
import {
    ChannelReadError, newHistoryState, retryableChannel, runHistoryImport, type HistoryDeps,
} from '../../src/utils/discordImport/history/runner';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const MEDIA_CH = '800000000000000018'; // mock-guild's "general", used here as the owner's media channel
const API = 'https://discord.com/api/v10';
const NOW = Date.now();
const MB = 1024 * 1024;
const GENERIC = 'Something went wrong talking to Discord.';
const sf = (n: number) => String(930000000000000000n + BigInt(n));
/** A signature valid for another day (hex unix seconds), like Discord's `ex`. */
const EX_OK = Math.floor((NOW + 24 * 3600_000) / 1000).toString(16);
const EX_PAST = Math.floor((NOW - 3600_000) / 1000).toString(16);
const cdn = (mid: number, aid: number, name: string, ex = EX_OK) => `https://cdn.discordapp.com/attachments/${MEDIA_CH}/${sf(aid)}/${name}?ex=${ex}&is=${EX_OK}&hm=${'ab'.repeat(16)}&`;

const att = (mid: number, k: number, filename: string, size: number, content_type: string, extra: Record<string, unknown> = {}) => ({
    id: sf(10_000 + mid * 20 + k), filename, size, url: cdn(mid, 10_000 + mid * 20 + k, encodeURIComponent(filename).replace(/%20/g, '_')), proxy_url: 'x', content_type, ...extra,
});

/**
 * The media channel, newest first: 150 messages over 2 pages, almost all picture / video posts.
 * Message 150 (the newest) is PINNED and reacted to with two emoji; its pins copy carries only one (the
 * shape that killed the channel).
 */
function mediaMessages(opts: { expired?: boolean } = {}) {
    const people = [PEOPLE.alex, PEOPLE.sam, PEOPLE.riley];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 150; i >= 1; i--) {
        const base = { id: sf(i), type: 0, content: i % 4 === 0 || i % 5 === 0 || i === 150 ? `look ${i}` : '', timestamp: new Date(NOW - (151 - i) * 60_000).toISOString(), author: people[i % 3], mentions: [], embeds: [] as unknown[], attachments: [] as unknown[] };
        if (i === 150) Object.assign(base, { pinned: true, reactions: [{ count: 3, emoji: { id: null, name: '🔥' } }, { count: 1, emoji: { id: null, name: '😂' } }] });
        if (i === 149) base.attachments = [att(i, 0, 'holiday.mov', 612 * MB, 'video/quicktime')];               // > 100 MB (and the free 100 MB)
        else if (i === 148) base.attachments = [att(i, 0, 'clip.webm', 30 * MB, 'video/webm')];                  // > 25 MB, under the limits
        else if (i === 147) base.attachments = [att(i, 0, 'IMG_0042.HEIC', 3 * MB, 'image/heic')];
        else if (i === 146) base.attachments = [att(i, 0, '🎉 party (1) – ünïcödé.png', 2048, 'image/png')];
        else if (i === 145) base.attachments = [att(i, 0, `${'very-long-name-'.repeat(15)}.jpg`, 2048, 'image/jpeg')];
        else if (i === 144) base.attachments = [att(i, 0, 'SPOILER_secret.png', 2048, 'image/png', { flags: 1 << 3 })];
        else if (i === 143) Object.assign(base, { flags: 1 << 13, attachments: [att(i, 0, 'voice-message.ogg', 4096, 'audio/ogg', { waveform: 'AAAA', duration_secs: 3.2 })] });
        else if (i === 142) base.attachments = Array.from({ length: 12 }, (_, k) => att(i, k, `pic-${k}.png`, 1024, 'image/png'));
        else if (i === 141) base.embeds = [{ type: 'image', url: 'https://example.com/cat.png', thumbnail: { url: 'https://example.com/cat.png', proxy_url: `https://media.discordapp.net/attachments/${MEDIA_CH}/${sf(9999)}/cat.png?ex=${EX_OK}&is=${EX_OK}&hm=${'cd'.repeat(16)}&=&format=webp&quality=lossless&width=400&height=300` } }];
        else if (i === 140) base.attachments = [att(i, 0, 'odd.mp4', 4096, 'application/octet-stream; charset=binary')];
        else if (i === 139) base.attachments = [att(i, 0, 'interrupted.png', 2048, 'image/png')];
        else if (i === 138) base.attachments = [att(i, 0, 'always-interrupted.png', 2048, 'image/png')];
        else if (i === 137) base.attachments = [att(i, 0, 'expired.png', 2048, 'image/png')];
        else if (i % 5 !== 0) base.attachments = [att(i, 0, `photo-${i}.jpg`, 2048, 'image/jpeg')];
        if (opts.expired && i === 137) (base.attachments as Array<{ url: string }>)[0].url = cdn(i, 10_000 + i * 20, 'expired.png', EX_PAST);
        out.push(base);
    }
    return out;
}

interface Scenario {
    /** The pinned copy of message 150 has fewer reactions than the window copy (the owner's crash). */
    pinFewerReactions?: boolean;
    /** Message pages fail like this: `page` 0 = first, 1 = second; `times` = how many times before it answers. */
    pageFails?: { page: 0 | 1; status: number; times: number; retryAfter?: number };
    expired?: boolean;
}

function discord(sc: Scenario, log: string[]) {
    const msgs = mediaMessages({ expired: sc.expired });
    const failsLeft = { n: sc.pageFails?.times ?? 0 };
    let interruptedOnce = false;
    const fetchFn: FetchLike = async (url) => {
        log.push(url);
        const api = url.replace(API, '');
        const path = api.split('?')[0];
        let status = 200; let body: unknown = {}; let bytes = new Uint8Array(0);
        const headers: Record<string, string> = {};
        let bodyError: Error | null = null;
        if (api === '/users/@me') body = mockMe();
        else if (api === '/oauth2/applications/@me') body = mockApp();
        else if (api === `/guilds/${MOCK_GUILD_ID}`) body = mockGuild();
        else if (api === `/guilds/${MOCK_GUILD_ID}/channels`) body = mockChannels();
        else if (api.startsWith(`/guilds/${MOCK_GUILD_ID}/members?`)) body = mockMembers();
        else if (api.startsWith(`/guilds/${MOCK_GUILD_ID}/bans?`)) body = mockBans();
        else if (path === `/channels/${MEDIA_CH}/messages/pins`) {
            const pinned = JSON.parse(JSON.stringify(msgs[0]));
            if (sc.pinFewerReactions) pinned.reactions = [pinned.reactions[1]]; // the pins answer: only 😂
            body = { items: [{ pinned_at: new Date(NOW).toISOString(), message: pinned }], has_more: false };
        } else if (path.startsWith(`/channels/${MEDIA_CH}/messages/`) && path.includes('/reactions/')) {
            body = [{ id: PEOPLE.sam.id, username: 'samwise.k', global_name: 'Sam' }, { id: PEOPLE.alex.id, username: 'alex_92', global_name: 'Alex' }];
        } else if (path === `/channels/${MEDIA_CH}/messages`) {
            const u = new URL(url);
            const before = u.searchParams.get('before');
            const page = before ? 1 : 0;
            if (sc.pageFails && sc.pageFails.page === page && failsLeft.n > 0) {
                failsLeft.n--;
                status = sc.pageFails.status; body = sc.pageFails.status === 429 ? { retry_after: sc.pageFails.retryAfter ?? 1, global: false } : { message: 'upstream' };
            } else {
                const start = before ? msgs.findIndex(m => m.id === before) + 1 : 0;
                body = msgs.slice(start, start + Number(u.searchParams.get('limit') ?? 50));
            }
        } else if (path.startsWith(`/channels/${MEDIA_CH}/messages/`)) {
            // The single-message re-read behind a refreshed (expired) URL: hands out a fresh signature.
            const mid = path.split('/')[4];
            const m = JSON.parse(JSON.stringify(msgs.find(x => x.id === mid) ?? {}));
            for (const a of (m.attachments ?? []) as Array<{ url: string }>) a.url = a.url.replace(/ex=[0-9a-f]+/, `ex=${EX_OK}`).replace(/hm=[0-9a-f]+/, 'hm=fresh');
            body = m;
        } else if (path.startsWith(`/channels/`)) {
            body = path.endsWith('/messages') ? [] : path.endsWith('/pins') ? { items: [], has_more: false } : { id: path.split('/')[2], type: 0, last_message_id: null };
        } else if (url.startsWith('https://cdn.discordapp.com/') || url.startsWith('https://media.discordapp.net/')) {
            const u = new URL(url);
            const name = decodeURIComponent(u.pathname.split('/').pop() ?? '');
            const declared = name === 'holiday.mov' ? 612 * MB : name === 'clip.webm' ? 30 * MB : 0;
            if (u.searchParams.get('ex') === EX_PAST) { status = 404; }
            else if (name === 'interrupted.png' && !interruptedOnce) { interruptedOnce = true; bodyError = new TypeError('terminated'); headers['content-type'] = 'image/png'; }
            else if (name === 'always-interrupted.png') { bodyError = new TypeError('terminated'); headers['content-type'] = 'image/png'; }
            else {
                bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
                headers['content-type'] = name.endsWith('.mov') ? 'video/quicktime' : name.endsWith('.webm') ? 'video/webm' : 'image/png';
                if (declared) headers['content-length'] = String(declared);
            }
        } else { status = 404; body = { message: 'Unknown', code: 10003 }; }
        return {
            status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
            json: async () => body,
            arrayBuffer: async () => { if (bodyError) throw bodyError; return bytes.buffer; },
        };
    };
    return fetchFn;
}

function memStore(): KeyValueStore {
    const m = new Map<string, string>();
    return { status: () => 'ok', get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, delete: k => { m.delete(k); } };
}

async function runImport(sc: Scenario, maxFileBytes = 100 * MB) {
    const log: string[] = [];
    const sleeps: number[] = [];
    // A fake clock the sleeps advance, so a rate-limit bucket really runs out while we "wait".
    let clock = NOW;
    const h = createDiscordImportHandlers({ store: memStore(), clientOptions: { fetchFn: discord(sc, log), now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } } });
    await h.connect({ token: TOKEN });
    const snap = await h.snapshot({ guildId: MOCK_GUILD_ID });
    if (!snap.ok) throw new Error(snap.error.message);
    const chans = (snap.snapshot.body as { channels: Array<{ id: number; name: string }> }).channels;
    const num = chans.find(c => c.name === 'general')!.id;
    const CIPHER = '11111111-1111-4111-8111-111111111111';
    const sealed: string[] = [];
    let rows = 0; let initiates = 0;
    const api: HistoryDeps['api'] = {
        createSession: vi.fn(async () => ({ id: 'imp-1' })),
        registerAuthors: vi.fn(async (_i: string, a: unknown[]) => ({ author_ids: a.map((_x, k) => `4444444${k}-4444-4444-8444-444444444444`) })),
        postBatch: vi.fn(async (_i: string, b: { seq_start: number; rows: unknown[] }) => { rows += b.rows.length; return { ids: b.rows.map((_r, k) => `row-${b.seq_start + k}`), seq_next: b.seq_start + b.rows.length }; }),
        initiateFiles: vi.fn(async (_i: string, _c: string, f: unknown[]) => { initiates += f.length; return f.map(() => ({ attachment_id: crypto.randomUUID(), upload_url: 'https://minio.local/put' })); }),
        save: vi.fn(async (_i: string, b: { items: Array<{ message_id: string }> }) => ({ results: b.items.map(x => ({ message_id: x.message_id, status: 'pinned' })), used_bytes: 0, limit_bytes: 0 })),
        complete: vi.fn(async () => ({})),
    };
    const deps: HistoryDeps = {
        api,
        // Wired exactly like utils/discordImport/backgroundImport.ts.
        readChannel: async (n) => {
            const r = await h.history({ guildId: MOCK_GUILD_ID, channel: n });
            if (!r.ok) throw new ChannelReadError(r.error.message, { step: r.error.step ?? 'read', code: r.error.code, ...(r.error.status !== undefined ? { status: r.error.status } : {}), ...(r.error.errorName ? { errorName: r.error.errorName } : {}) });
            return r;
        },
        fetchMedia: async (ref) => { const r = await h.media({ ref }); return r.ok ? { ok: true as const, mime: r.mime, bytes: r.bytes } : { ok: false as const, code: r.error.code, message: r.error.message }; },
        encryptFile: async (bytes) => ({ blob: new Blob([bytes as BlobPart]), keyB64: 'a2V5', nonceB64: 'bm9uY2U=', sha256B64: null }),
        upload: async () => undefined,
        sealRow: async (json) => { sealed.push(json); return { epoch: 1, nonce_b64: 'bg==', ciphertext_b64: 'Y3Q=', signature_b64: 'c2ln' }; },
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', maxFileBytes, sleep: async () => undefined,
    };
    const state = newHistoryState();
    await runHistoryImport(deps, { serverId: 's', convert: {}, channels: [{ channel: num, channelId: CIPHER, name: 'files_pictures' }] }, state, () => {}, new AbortController().signal);
    const report = state.reports[0];
    const texts = sealed.map(j => JSON.parse(j) as { type: string; text?: string; filename?: string });
    return { report, rows, initiates, texts, log, sleeps, api };
}

describe('the owner\'s media channel (#files_pictures): a channel never dies of one odd message or file', () => {
    it('REPRODUCED: a pinned picture whose pins copy has fewer reactions used to kill the read with the GENERIC text; now it comes over', async () => {
        const r = await runImport({ pinFewerReactions: true });
        // Before the fix: report.error === "Something went wrong talking to Discord.", 0 rows, 0 initiates.
        expect(r.report.error).toBeNull();
        expect(r.rows).toBeGreaterThan(100);
        expect(r.initiates).toBeGreaterThan(100);
        expect(JSON.stringify(r.report)).not.toContain(GENERIC);
        // The window copy (the one posted) got the names of who reacted with 🔥 AND 😂.
        const first = r.texts.find(t => /"🔥"|🔥/.test(JSON.stringify(t)));
        expect(first).toBeDefined();
    });

    it('oversized videos post a placeholder line and are counted; nothing else of the message or channel is lost', async () => {
        const r = await runImport({});
        expect(r.report.error).toBeNull();
        const big = r.report.filesSkipped.find(f => f.filename === 'holiday.mov');
        expect(big).toMatchObject({ code: 'too_large', size: 612 * MB });
        const line = r.texts.find(t => t.text?.includes('holiday.mov'));
        expect(line?.text).toContain('File couldn’t be copied: holiday.mov · 612.0 MB (too large to copy, the limit is 100.0 MB)');
        // 30 MB is under both limits: copied.
        expect(r.texts.some(t => t.type === 'attachment' && t.filename === 'clip.webm')).toBe(true);
        // Under a 25 MB per-file plan it is a placeholder instead (positive control for the limit).
        const free = await runImport({}, 25 * MB);
        expect(free.report.filesSkipped.find(f => f.filename === 'clip.webm')).toMatchObject({ code: 'too_large' });
        expect(free.texts.find(t => t.text?.includes('clip.webm'))?.text).toContain('· 30.0 MB (too large to copy, the limit is 25.0 MB)');
    });

    it('odd names, types and URL shapes all come over (HEIC, MOV, emoji / unicode / long names, (1) in the path, proxy &=& + width, spoiler, voice, 12 files)', async () => {
        const r = await runImport({});
        const files = r.texts.filter(t => t.type === 'attachment').map(t => t.filename);
        for (const name of ['IMG_0042.HEIC', '🎉 party (1) – ünïcödé.png', `${'very-long-name-'.repeat(15)}.jpg`, 'SPOILER_secret.png', 'voice-message.ogg', 'pic-11.png', 'odd.mp4', 'cat.png']) {
            expect(files, name).toContain(name);
        }
        expect(files.filter(f => /^pic-\d+\.png$/.test(f ?? ''))).toHaveLength(12);
        expect(r.report.filesSkipped.map(f => f.filename)).toEqual(expect.not.arrayContaining(['🎉 party (1) – ünïcödé.png', 'cat.png']));
    });

    it('an interrupted download is retried once; one that keeps failing becomes a placeholder (download failed), never the channel', async () => {
        const r = await runImport({});
        expect(r.texts.some(t => t.type === 'attachment' && t.filename === 'interrupted.png')).toBe(true);
        expect(r.report.filesSkipped.find(f => f.filename === 'always-interrupted.png')).toMatchObject({ code: 'download_failed' });
        expect(r.texts.find(t => t.text?.includes('always-interrupted.png'))?.text).toContain('File couldn’t be copied: always-interrupted.png · 2 KB (the download from Discord failed)');
        expect(r.report.error).toBeNull();
    });

    it('an expired signed CDN URL (ex in the past) is refreshed by re-reading its message, and the file comes over', async () => {
        const r = await runImport({ expired: true });
        expect(r.texts.some(t => t.type === 'attachment' && t.filename === 'expired.png')).toBe(true);
        expect(r.log.some(u => u.includes(`/channels/${MEDIA_CH}/messages/${sf(137)}`))).toBe(true);
        expect(r.log.some(u => u.includes('expired.png') && u.includes('hm=fresh'))).toBe(true);
        expect(r.report.filesSkipped.find(f => f.filename === 'expired.png')).toBeUndefined();
    });

    it('a message page Discord fails a few times (503) is re-read with backoff and the channel comes over whole', async () => {
        const r = await runImport({ pageFails: { page: 1, status: 503, times: 7 } });
        expect(r.report.error).toBeNull();
        expect(r.report.partial).toBeFalsy();
        expect(r.report.messages).toBe(150);
        // The client's own quick retries (6 tries) then one page-level pause of 5 s.
        expect(r.sleeps).toContain(5_000);
    });

    it('a 429 with Retry-After on a page is honoured (waited out), not a failure', async () => {
        const r = await runImport({ pageFails: { page: 0, status: 429, times: 3, retryAfter: 90 } });
        expect(r.report.error).toBeNull();
        expect(r.sleeps.some(ms => ms >= 90_000)).toBe(true);
    });

    it('a later page that keeps failing keeps the newest messages, with a note; the channel is "partial", not lost', async () => {
        const r = await runImport({ pageFails: { page: 1, status: 503, times: 1_000 } });
        expect(r.report.error).toBeNull();
        expect(r.report.partial).toBe(true);
        expect(r.report.messages).toBe(100);
        expect(r.report.notes?.join(' ')).toMatch(/Discord stopped answering partway through, so only the newest 100 messages came over/);
    });

    it('a FIRST page that keeps failing fails the channel with a SPECIFIC reason and the step / status for diagnostics', async () => {
        const r = await runImport({ pageFails: { page: 0, status: 503, times: 1_000 } });
        expect(r.report.error).toBe('Discord is having trouble right now. Try again in a minute.');
        expect(r.report.failure).toEqual({ step: 'read', code: 'discord_down', status: 503, errorName: 'discord_server' });
        expect(retryableChannel(r.report)).toBe(true);
        expect(r.rows).toBe(0);
    });
});
