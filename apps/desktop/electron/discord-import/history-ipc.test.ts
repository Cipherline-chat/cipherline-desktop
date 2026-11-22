import { describe, it, expect } from 'vitest';
import type { FetchLike } from './discord-client';
import { createDiscordImportHandlers, type KeyValueStore } from './ipc';
import { MOCK_GUILD_ID, mockApp, mockBans, mockChannels, mockGuild, mockMe, mockMembers } from './__fixtures__/mock-guild';
import { MOCK_TEXT_CHANNEL, mockChannelMessages, mockPins } from './__fixtures__/mock-history';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');

function memStore(): KeyValueStore {
    const m = new Map<string, string>();
    return { status: () => 'ok', get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, delete: k => { m.delete(k); } };
}

function fetchFn(log: string[]): FetchLike {
    return async (url, init) => {
        log.push(`${url} auth=${init.headers.Authorization ? 'yes' : 'no'}`);
        const api = url.replace('https://discord.com/api/v10', '');
        let status = 200; let body: unknown = {};
        let bytes = new Uint8Array(0);
        if (api === '/users/@me') body = mockMe();
        else if (api === '/oauth2/applications/@me') body = mockApp();
        else if (api === `/guilds/${MOCK_GUILD_ID}`) body = mockGuild();
        else if (api === `/guilds/${MOCK_GUILD_ID}/channels`) body = mockChannels();
        else if (api.startsWith(`/guilds/${MOCK_GUILD_ID}/members?`)) body = mockMembers();
        else if (api.startsWith(`/guilds/${MOCK_GUILD_ID}/bans?`)) body = mockBans();
        else if (api.startsWith(`/channels/${MOCK_TEXT_CHANNEL}/messages/pins`)) body = mockPins();
        else if (api.startsWith(`/channels/${MOCK_TEXT_CHANNEL}/messages`)) body = api.includes('before=') ? [] : mockChannelMessages();
        else if (url.startsWith('https://cdn.discordapp.com/')) bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
        else status = 404;
        return {
            status, headers: { get: (n: string) => (n === 'content-type' && bytes.length ? 'image/png' : null) },
            json: async () => body, arrayBuffer: async () => bytes.buffer,
        };
    };
}

async function ready() {
    const log: string[] = [];
    const h = createDiscordImportHandlers({ store: memStore(), clientOptions: { fetchFn: fetchFn(log), sleep: async () => undefined } });
    await h.connect({ token: TOKEN });
    const snap = await h.snapshot({ guildId: MOCK_GUILD_ID });
    expect(snap.ok).toBe(true);
    return { h, log };
}

describe('history + media IPC', () => {
    it('reads a channel by its SNAPSHOT number; the Discord channel id is only in main', async () => {
        const { h } = await ready();
        const r = await h.history({ guildId: MOCK_GUILD_ID, channel: 1 });
        if (!r.ok) throw new Error(r.error.message);
        expect(r.messages.length).toBe(8); // 9 minus the system join
        expect(r.messages[0].ts < r.messages[r.messages.length - 1].ts).toBe(true); // oldest first
        expect(r.pins.length).toBe(3);
        expect(r.names.channels[MOCK_TEXT_CHANNEL]).toBeDefined();
        expect(JSON.stringify(r)).not.toMatch(/cdn\.discordapp\.com|discord\.com\/api/);
    });
    it('refuses malformed requests and a channel number it never handed out', async () => {
        const { h } = await ready();
        for (const bad of [null, {}, { guildId: MOCK_GUILD_ID }, { guildId: MOCK_GUILD_ID, channel: '1' }, { guildId: MOCK_GUILD_ID, channel: -1 }, { guildId: MOCK_GUILD_ID, channel: 1, extra: 1 }]) {
            const r = await h.history(bad);
            expect(r.ok).toBe(false);
        }
        const r = await h.history({ guildId: MOCK_GUILD_ID, channel: 999 });
        expect(r.ok).toBe(false);
    });
    it('media: only refs it handed out; bytes come back, never with the bot token on the CDN request', async () => {
        const { h, log } = await ready();
        const r = await h.history({ guildId: MOCK_GUILD_ID, channel: 1 });
        if (!r.ok) throw new Error('history');
        const ref = r.messages.flatMap(m => m.files).find(f => f.filename === 'pumpkins.png')!.ref;
        const got = await h.media({ ref });
        if (!got.ok) throw new Error(got.error.message);
        expect(got.mime).toBe('image/png');
        expect(got.bytes.length).toBe(10);
        expect(log.filter(l => l.startsWith('https://cdn.discordapp.com')).every(l => l.endsWith('auth=no'))).toBe(true);
        expect((await h.media({ ref: '11111111-1111-4111-8111-111111111111' })).ok).toBe(false);
        expect((await h.media({ ref: 'https://evil.example/x' })).ok).toBe(false);
        expect((await h.media({ url: 'https://cdn.discordapp.com/x' })).ok).toBe(false);
    });
    it('forget clears the file registry', async () => {
        const { h } = await ready();
        const r = await h.history({ guildId: MOCK_GUILD_ID, channel: 1 });
        if (!r.ok) throw new Error('history');
        const ref = r.messages.flatMap(m => m.files)[0].ref;
        await h.forget();
        expect((await h.media({ ref })).ok).toBe(false);
    });
});
