import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from './discord-client';
import {
    createDiscordImportHandlers, DISCORD_BOT_STORE_KEY, DISCORD_IMPORT_CHANNELS, registerDiscordImportIpc,
    type KeyValueStore,
} from './ipc';
import { normalizeBotToken, redactText, isSnowflake } from './redact';
import { MOCK_GUILD_ID, mockApp, mockBans, mockChannels, mockGuild, mockGuildList, mockMe, mockMembers } from './__fixtures__/mock-guild';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const APP = { id: mockApp().id, name: 'Cipherline Importer', intents: { messageContent: true, members: true } };

function memStore(status = 'ok') {
    const m = new Map<string, string>();
    const store: KeyValueStore & { m: Map<string, string> } = {
        m, status: () => status,
        get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, delete: k => { m.delete(k); },
    };
    return store;
}

function discordFetch(opts: { me?: unknown; app?: unknown; guilds?: unknown; status?: number; code?: number; log?: string[] } = {}): FetchLike {
    return async (url, init) => {
        opts.log?.push(`${init.method} ${url}`);
        const path = url.replace('https://discord.com/api/v10', '');
        let status = 200; let body: unknown = {};
        if (opts.status) { status = opts.status; body = opts.code !== undefined ? { code: opts.code, message: 'x' } : {}; }
        else if (path === '/users/@me') body = opts.me ?? mockMe();
        else if (path === '/oauth2/applications/@me') body = opts.app ?? mockApp();
        else if (path.startsWith('/users/@me/guilds')) body = opts.guilds ?? mockGuildList();
        else if (path === `/guilds/${MOCK_GUILD_ID}`) body = mockGuild();
        else if (path === `/guilds/${MOCK_GUILD_ID}/channels`) body = mockChannels();
        else if (path.startsWith(`/guilds/${MOCK_GUILD_ID}/members?`)) body = path.includes('after=0') ? mockMembers() : [];
        else if (path.startsWith(`/guilds/${MOCK_GUILD_ID}/bans?`)) body = path.includes('after=0') ? mockBans() : [];
        else status = 404;
        return { status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
    };
}

const make = (o: Parameters<typeof discordFetch>[0] = {}, store = memStore()) => ({
    store, h: createDiscordImportHandlers({ store, clientOptions: { fetchFn: discordFetch(o), sleep: async () => undefined } }),
});

describe('token handling', () => {
    it('connect validates with /users/@me, stores it, and never returns it', async () => {
        const { h, store } = make();
        const r = await h.connect({ token: TOKEN });
        expect(r).toEqual({ ok: true, bot: { id: mockMe().id, name: 'Cipherline Importer' }, app: APP });
        expect(JSON.stringify(r)).not.toContain(TOKEN);
        expect(JSON.parse(store.m.get(DISCORD_BOT_STORE_KEY)!).token).toBe(TOKEN);
        const s = await h.status();
        expect(s).toEqual({ ok: true, hasToken: true, bot: { id: mockMe().id, name: 'Cipherline Importer' }, app: APP, storageReady: true });
        expect(JSON.stringify(s)).not.toContain(TOKEN);
    });

    it('accepts a pasted "Bot <token>" and surrounding whitespace', async () => {
        const { h } = make();
        expect((await h.connect({ token: `  Bot ${TOKEN}\n` })).ok).toBe(true);
    });

    it('a rejected token is NOT stored, and the message never contains it', async () => {
        const { h, store } = make({ status: 401 });
        const r = await h.connect({ token: TOKEN });
        expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
        expect(JSON.stringify(r)).not.toContain(TOKEN);
        expect(store.m.size).toBe(0);
    });

    it('refuses a USER account token (me.bot !== true): never stored', async () => {
        const { h, store } = make({ me: { id: '800000000000000900', username: 'someone' } });
        expect(await h.connect({ token: TOKEN })).toMatchObject({ ok: false, error: { code: 'not_a_bot' } });
        expect(store.m.size).toBe(0);
    });

    it('does not even contact Discord for malformed input or a locked store', async () => {
        const log: string[] = [];
        const { h } = make({ log });
        for (const bad of [undefined, null, 5, {}, { token: 5 }, { token: 'short' }, { token: `${TOKEN} `.repeat(2) }, { token: TOKEN, extra: 1 }, [TOKEN], { token: 'a b '.repeat(10) }]) {
            expect(await h.connect(bad)).toMatchObject({ ok: false, error: { code: 'bad_token' } });
        }
        const locked = make({ log }, memStore('locked'));
        expect(await locked.h.connect({ token: TOKEN })).toMatchObject({ ok: false, error: { code: 'storage_locked' } });
        expect(log).toHaveLength(0);
    });

    it('forget deletes the token and clears image refs; status then says none', async () => {
        const { h, store } = make();
        await h.connect({ token: TOKEN });
        await h.snapshot({ guildId: MOCK_GUILD_ID });
        expect(await h.forget()).toEqual({ ok: true });
        expect(store.m.size).toBe(0);
        expect(await h.status()).toMatchObject({ hasToken: false, bot: null });
        expect(await h.image({ guildId: MOCK_GUILD_ID, kind: 'icon' })).toMatchObject({ ok: false });
        expect(await h.listGuilds()).toMatchObject({ ok: false, error: { code: 'no_token' } });
    });

    it('a corrupt stored value is treated as "no token", not a crash', async () => {
        const store = memStore();
        store.set(DISCORD_BOT_STORE_KEY, '{not json');
        const { h } = make({}, store);
        expect(await h.status()).toMatchObject({ hasToken: false });
    });
});

describe('the application comes FROM the token (root cause of "bot is not in any server")', () => {
    it('connect reads GET /oauth2/applications/@me: its id (not the bot user id) is what the invite uses', async () => {
        const log: string[] = [];
        const { h } = make({ log, me: { id: '600000000000000999', username: 'Old Importer', bot: true }, app: { id: '600000000000000123', name: 'Old Importer', flags: 0 } });
        const r = await h.connect({ token: TOKEN });
        expect(r).toMatchObject({ ok: true, bot: { id: '600000000000000999' }, app: { id: '600000000000000123', intents: { messageContent: false, members: false } } });
        expect(log).toContain('GET https://discord.com/api/v10/oauth2/applications/@me');
    });

    it('intents are read from the application flags (verified and unverified variants)', async () => {
        const { intentsFromFlags, APP_FLAGS } = await import('./ipc');
        expect(intentsFromFlags(0)).toEqual({ messageContent: false, members: false });
        expect(intentsFromFlags(APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED)).toEqual({ messageContent: true, members: false });
        expect(intentsFromFlags(APP_FLAGS.GATEWAY_MESSAGE_CONTENT | APP_FLAGS.GATEWAY_GUILD_MEMBERS)).toEqual({ messageContent: true, members: true });
        expect(intentsFromFlags(APP_FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED)).toEqual({ messageContent: false, members: true });
        for (const junk of [undefined, null, '262144', -1, 1.5]) expect(intentsFromFlags(junk)).toEqual({ messageContent: false, members: false });
        expect([APP_FLAGS.GATEWAY_GUILD_MEMBERS, APP_FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED, APP_FLAGS.GATEWAY_MESSAGE_CONTENT, APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED]).toEqual([16384, 32768, 262144, 524288]);
    });

    it('an unreadable application answer refuses the token (nothing saved), never falls back to a guess', async () => {
        const { h, store } = make({ app: { id: 'nope' } });
        expect(await h.connect({ token: TOKEN })).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
        expect(store.m.size).toBe(0);
    });

    it('checkApp re-reads the flags (the user just switched an intent on) and updates what is saved', async () => {
        const store = memStore();
        store.set(DISCORD_BOT_STORE_KEY, JSON.stringify({ token: TOKEN, botId: mockMe().id, botName: 'x' })); // saved by the old version: no app
        const { h } = make({}, store);
        expect(await h.status()).toMatchObject({ hasToken: true, app: null });
        expect(await h.checkApp()).toEqual({ ok: true, app: APP });
        expect(await h.status()).toMatchObject({ app: APP });
        const none = make();
        expect(await none.h.checkApp()).toMatchObject({ ok: false, error: { code: 'no_token' } });
    });
});

describe('guild list', () => {
    it('reports whether the bot holds Administrator in each server', async () => {
        const { h } = make({ guilds: [
            { id: MOCK_GUILD_ID, name: 'A', owner: false, icon: null, permissions: '8' },
            { id: '800000000000000777', name: 'B', owner: false, icon: null, permissions: '66560' },
            { id: '800000000000000778', name: 'C', owner: false, icon: null },
            { id: '800000000000000779', name: 'D', owner: false, icon: null, permissions: '2251799813685247' },
        ] });
        await h.connect({ token: TOKEN });
        const r = await h.listGuilds();
        expect(r.ok && r.guilds.map(g => g.admin)).toEqual([true, false, null, true]);
    });

    it('a server without a readable name is still listed (dropping rows can say "no server" for a bot that is in one)', async () => {
        const { h } = make({ guilds: [{ id: MOCK_GUILD_ID, owner: false, icon: null, permissions: '8' }, { id: 'bad' }] });
        await h.connect({ token: TOKEN });
        const r = await h.listGuilds();
        expect(r.ok && r.guilds.map(g => [g.id, g.name])).toEqual([[MOCK_GUILD_ID, 'Unnamed server']]);
    });

    it('Missing Access (50001) explains Administrator and re-inviting, not a generic error', async () => {
        const store = memStore();
        store.set(DISCORD_BOT_STORE_KEY, JSON.stringify({ token: TOKEN, botId: mockMe().id, botName: 'x' }));
        const { h } = make({ status: 403, code: 50001 }, store);
        const r = await h.snapshot({ guildId: MOCK_GUILD_ID });
        expect(r).toMatchObject({ ok: false, error: { code: 'missing_access' } });
        expect(!r.ok && r.error.message).toMatch(/Missing Access.*Administrator.*invite link again/);
    });
});

describe('Message Content Intent off', () => {
    const msg = (o: Partial<Record<string, unknown>> = {}) => ({ content: '', files: [], embeds: [], stickers: [], poll: null, ...o }) as never;
    it('two or more messages that are ALL blank (no text, file, embed, sticker, poll) = intent off', async () => {
        const { looksLikeNoMessageContent } = await import('./ipc');
        expect(looksLikeNoMessageContent([msg(), msg(), msg()])).toBe(true);
        expect(looksLikeNoMessageContent([msg(), msg({ content: 'hi' })])).toBe(false);
        expect(looksLikeNoMessageContent([msg(), msg({ files: [{}] })])).toBe(false);
        expect(looksLikeNoMessageContent([msg(), msg({ embeds: [{}] })])).toBe(false);
        expect(looksLikeNoMessageContent([msg()])).toBe(false);
        expect(looksLikeNoMessageContent([])).toBe(false);
    });
});

describe('guilds, snapshot, images', () => {
    it('lists guilds (paginated endpoint) without icon hashes', async () => {
        const { h } = make();
        await h.connect({ token: TOKEN });
        const r = await h.listGuilds();
        expect(r).toMatchObject({ ok: true });
        if (r.ok) expect(r.guilds.map(g => g.name)).toEqual(['Pixel Farm Co-op', 'Second Guild']);
    });

    it('snapshot needs a valid snowflake and a saved token', async () => {
        const { h } = make();
        expect(await h.snapshot({ guildId: '1' })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
        expect(await h.snapshot({ guildId: MOCK_GUILD_ID })).toMatchObject({ ok: false, error: { code: 'no_token' } });
        await h.connect({ token: TOKEN });
        const r = await h.snapshot({ guildId: MOCK_GUILD_ID });
        expect(r.ok && r.snapshot.counts.channels).toBe(7);
    });

    it('image: strict payload; unknown keys, bad kinds and other guilds are refused', async () => {
        const { h } = make();
        await h.connect({ token: TOKEN });
        await h.snapshot({ guildId: MOCK_GUILD_ID });
        for (const bad of [null, {}, { guildId: MOCK_GUILD_ID }, { guildId: MOCK_GUILD_ID, kind: 'url', url: 'https://evil' },
            { guildId: MOCK_GUILD_ID, kind: 'emoji' }, { guildId: MOCK_GUILD_ID, kind: 'emoji', emojiId: '../x' },
            { guildId: MOCK_GUILD_ID, kind: 'icon', emojiId: '800000000000000041' }, { guildId: MOCK_GUILD_ID, kind: 'icon', path: '/x' },
            { guildId: MOCK_GUILD_ID, kind: 'role_icon' }, { guildId: MOCK_GUILD_ID, kind: 'role_icon', role: '2' },
            { guildId: MOCK_GUILD_ID, kind: 'role_icon', role: 0 }, { guildId: MOCK_GUILD_ID, kind: 'role_icon', role: 1.5 },
            { guildId: MOCK_GUILD_ID, kind: 'role_icon', role: 2, emojiId: '800000000000000041' },
            { guildId: MOCK_GUILD_ID, kind: 'icon', role: 2 }, { guildId: MOCK_GUILD_ID, kind: 'emoji', emojiId: '800000000000000041', role: 2 },
            { guildId: MOCK_GUILD_ID, kind: 'sticker' }, { guildId: MOCK_GUILD_ID, kind: 'sticker', stickerId: '../x' },
            { guildId: MOCK_GUILD_ID, kind: 'sticker', stickerId: '800000000000000060', role: 2 }, { guildId: MOCK_GUILD_ID, kind: 'icon', stickerId: '800000000000000060' }]) {
            expect(await h.image(bad)).toMatchObject({ ok: false, error: { code: 'bad_request' } });
        }
        // a guild that was never read cannot have images fetched
        expect(await h.image({ guildId: '800000000000000555', kind: 'icon' })).toMatchObject({ ok: false });
    });

    it('error mapping gives plain words, never Discord free text or the token', async () => {
        const { h } = make({ status: 403 });
        await h.connect({ token: TOKEN }); // 403 on /users/@me => not stored
        const store = memStore();
        store.set(DISCORD_BOT_STORE_KEY, JSON.stringify({ token: TOKEN, botId: '800000000000000900', botName: 'x' }));
        const forbidden = make({ status: 403 }, store);
        const r = await forbidden.h.snapshot({ guildId: MOCK_GUILD_ID });
        expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
});

describe('registerDiscordImportIpc', () => {
    it('registers exactly the declared channels (incl. check-app)', () => {
        const names: string[] = [];
        registerDiscordImportIpc({ handle: (c) => { names.push(c); } }, { store: memStore() });
        expect(names.sort()).toEqual(Object.values(DISCORD_IMPORT_CHANNELS).sort());
    });
});

describe('redaction helpers', () => {
    it('redactText removes the token, its parts and token-shaped strings', () => {
        const [a, b, c] = TOKEN.split('.');
        for (const t of [`oops ${TOKEN}`, `Authorization: Bot ${TOKEN}`, `part ${a}`, `${b}.${c}`, 'other ' + ['MTk4NjIyNDgzNDcxOTI1MjQ4', 'Cn-Wsg', 'dQw4w9WgXcQ_abcdefghijklmnopq'].join('.')]) {
            const out = redactText(t, TOKEN);
            expect(out).not.toContain(a);
            expect(out).not.toContain(c);
            expect(out).not.toMatch(/Cn-Wsg/);
        }
    });
    it('normalizeBotToken is strict', () => {
        expect(normalizeBotToken(TOKEN)).toBe(TOKEN);
        expect(normalizeBotToken('')).toBeNull();
        expect(normalizeBotToken('has space.in.it_xxxxxxxxxxxxxxxxxxxxxxx')).toBeNull();
        expect(normalizeBotToken('x'.repeat(201))).toBeNull();
        expect(normalizeBotToken(123)).toBeNull();
    });
    it('isSnowflake', () => {
        expect(isSnowflake('800000000000000001')).toBe(true);
        for (const v of ['', '1', '12345678901234x', Number.MAX_SAFE_INTEGER as unknown, null, '../1234567890123456']) expect(isSnowflake(v)).toBe(false);
    });
});

describe('source invariants (token safety)', () => {
    const dir = join(process.cwd(), 'electron', 'discord-import');
    const sources = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => [f, readFileSync(join(dir, f), 'utf8')] as const);

    it('the module never logs anything (a token could ride along in any log line)', () => {
        for (const [f, text] of sources) expect(text, f).not.toMatch(/console\.(log|warn|error|info|debug)|\blog\(|logger/);
    });

    it('never imports from src/ (electron rootDir rule) or touches renderer storage', () => {
        for (const [f, text] of sources) {
            expect(text, f).not.toMatch(/from\s+['"](\.\.\/)+src\//);
            expect(text, f).not.toMatch(/localStorage|sessionStorage|document\./);
        }
    });

    it('only talks to discord.com and its CDN, and the token header exists in exactly one place', () => {
        const all = sources.map(([, t]) => t).join('\n');
        const hosts = new Set([...all.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1].toLowerCase()));
        // media.discordapp.net: Discord's media host (DISCORD_MEDIA_HOSTS), where sticker pictures live (GIF stickers only there).
        expect([...hosts].sort()).toEqual(['cdn.discordapp.com', 'discord.com', 'media.discordapp.net']);
        expect(sources.filter(([, t]) => /Authorization:\s*`Bot/.test(t)).map(([f]) => f)).toEqual(['discord-client.ts']);
    });

    it('READ ONLY even with Administrator: the only HTTP method in the module is GET', () => {
        const all = sources.map(([, t]) => t).join('\n');
        const uses = [...all.matchAll(/method:\s*([^,\n}]+)/g)].map(m => m[1].trim());
        // The literal value sent is GET, and every other `method:` is the FetchLike type annotation, never a variable.
        expect(uses.filter(u => !/^string;?$/.test(u))).toEqual(["'GET'"]);
        expect(all).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]/);
    });

    it('READ ONLY at runtime: every request of connect / checkApp / listGuilds / snapshot / image is a GET', async () => {
        const log: string[] = [];
        const { h } = make({ log });
        await h.connect({ token: TOKEN });
        await h.checkApp();
        await h.listGuilds();
        await h.snapshot({ guildId: MOCK_GUILD_ID });
        await h.image({ guildId: MOCK_GUILD_ID, kind: 'icon' });
        expect(log.length).toBeGreaterThanOrEqual(6);
        expect(log.filter(l => !l.startsWith('GET '))).toEqual([]);
    });

    it('stores and forgets exactly the one backup-excluded key', () => {
        expect(DISCORD_BOT_STORE_KEY).toBe('discordImport.bot');
    });
});
