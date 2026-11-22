/**
 * Unit-level guards for the #files_pictures fix (2026-11-22): each piece that could fail a whole channel
 * read, or describe a failure as the generic "Something went wrong talking to Discord".
 */
import { describe, it, expect } from 'vitest';
import { DiscordApiError, DiscordClient, checkMediaUrl, type FetchLike } from './discord-client';
import { fetchChannelWindow, fetchReactors, signedUrlExpiresAt, type ImportMessage, type MediaRegistry } from './history';
import { describeError, describeReadError, errorClassOf } from './ipc';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const GENERIC = 'Something went wrong talking to Discord.';
const CH = '800000000000000018';

type Body = unknown;
const res = (status: number, body: Body, headers: Record<string, string> = {}, bodyError?: Error) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => { if (bodyError) throw bodyError; return body instanceof Uint8Array ? body.buffer : new ArrayBuffer(0); },
});
const client = (fetchFn: FetchLike) => new DiscordClient({ token: TOKEN, fetchFn, sleep: async () => undefined, random: () => 0 });

const msg = (id: string, reactions: ImportMessage['reactions']): ImportMessage => ({
    id, ts: '2026-11-20T10:00:00.000Z', edited: false, author: { id: '900000000000000001', name: 'A', username: null, kind: 'user', avatarRef: null },
    content: 'x', mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], forwarded: null, poll: null, pinned: false, reactions,
});
const r = (name: string, count: number, id: string | null = null) => ({ emoji: { id, name, animated: false }, count, users: [] });

describe('who reacted: copies of the same message are matched by emoji, never by position', () => {
    it('a pinned copy with FEWER reactions than the window copy no longer throws (the owner\'s TypeError)', async () => {
        const win = msg('910000000000000001', [r('🔥', 3), r('😂', 1)]);
        const pin = { ...msg('910000000000000001', [r('😂', 1)]), pinned: true };
        const users = [{ id: '900000000000000002', username: 'sam', global_name: 'Sam' }];
        const spent = await fetchReactors(client(async () => res(200, users)), CH, [win, pin]);
        expect(spent).toBe(2);
        expect(win.reactions.map(x => x.users.map(u => u.name))).toEqual([['Sam'], ['Sam']]);
        expect(pin.reactions[0].users.map(u => u.name)).toEqual(['Sam']);
    });

    it('a pinned copy with the reactions in ANOTHER order gets each emoji\'s own names', async () => {
        const win = msg('910000000000000001', [r('🔥', 1), r('😂', 1)]);
        const pin = { ...msg('910000000000000001', [r('😂', 1), r('🔥', 1)]), pinned: true };
        const fetchFn: FetchLike = async (url) => res(200, [{ id: url.includes(encodeURIComponent('🔥')) ? '900000000000000002' : '900000000000000003', username: url.includes(encodeURIComponent('🔥')) ? 'fire' : 'laugh' }]);
        await fetchReactors(client(fetchFn), CH, [win, pin]);
        expect(pin.reactions.map(x => `${x.emoji.name}:${x.users[0]?.name}`)).toEqual(['😂:laugh', '🔥:fire']);
    });
});

describe('the window read survives one odd message', () => {
    it('a message Discord shaped unexpectedly is left out and counted; the others come over', async () => {
        const good = (n: number) => ({ id: String(910000000000000000n + BigInt(n)), type: 0, content: `m${n}`, timestamp: new Date().toISOString(), author: { id: '900000000000000001', username: 'a' } });
        const odd = { ...good(2), poll: { question: { text: 'q' }, answers: { not: 'an array' } } };
        const reg: MediaRegistry = new Map();
        const w = await fetchChannelWindow(client(async () => res(200, [good(3), odd, good(1)])), CH, reg);
        expect(w.messages.map(m => m.content)).toEqual(['m1', 'm3']);
        expect(w.unreadable).toBe(1);
    });
});

describe('media URLs Discord really hands out', () => {
    it('accepts () ! ~ + , \' and percent-encoded unicode in the path, and the proxy\'s &=& / width / height', () => {
        for (const u of [
            'https://cdn.discordapp.com/attachments/1/2/party_(1)!~+,\'.png?ex=6744&is=6743&hm=ab&',
            'https://cdn.discordapp.com/attachments/1/2/%F0%9F%8E%89.png?ex=6744&is=6743&hm=ab&',
            'https://media.discordapp.net/attachments/1/2/cat.png?ex=6744&is=6743&hm=ab&=&format=webp&quality=lossless&width=400&height=300',
        ]) expect(checkMediaUrl(u), u).not.toBeNull();
    });
    it('still refuses other hosts, http, credentials, ports, other paths, .. and unknown query keys', () => {
        for (const u of [
            'https://evil.example/attachments/1/2/a.png', 'http://cdn.discordapp.com/attachments/1/2/a.png',
            'https://user:pw@cdn.discordapp.com/attachments/1/2/a.png', 'https://cdn.discordapp.com:8443/attachments/1/2/a.png',
            'https://cdn.discordapp.com/external/abc/a.png', 'https://cdn.discordapp.com/attachments/1/../../x',
            'https://cdn.discordapp.com/attachments/1/2/a.png?token=1', 'https://cdn.discordapp.com/attachments/1/2/a.png?x=',
        ]) expect(checkMediaUrl(u), u).toBeNull();
    });
    it('reads the signature expiry (hex seconds) from ex', () => {
        expect(signedUrlExpiresAt('https://cdn.discordapp.com/attachments/1/2/a.png?ex=6744a1b0&is=1&hm=2')).toBe(0x6744a1b0 * 1000);
        expect(signedUrlExpiresAt('https://cdn.discordapp.com/avatars/1/abc.png?size=128')).toBeNull();
    });
});

describe('a file download never escapes as a non-Discord error', () => {
    it('an interrupted body (undici "terminated") becomes a network DiscordApiError', async () => {
        const c = client(async () => res(200, new Uint8Array([1]), { 'content-type': 'image/png' }, new TypeError('terminated')));
        await expect(c.getMedia('https://cdn.discordapp.com/attachments/1/2/a.png', 100)).rejects.toMatchObject({ name: 'DiscordApiError', kind: 'network' });
    });
    it('over the cap is its own kind (too_large), declared or real', async () => {
        const c = client(async () => res(200, new Uint8Array(5), { 'content-length': '999' }));
        await expect(c.getMedia('https://cdn.discordapp.com/attachments/1/2/a.png', 10)).rejects.toMatchObject({ kind: 'too_large', message: 'too_large' });
        const c2 = client(async () => res(200, new Uint8Array(50)));
        await expect(c2.getMedia('https://cdn.discordapp.com/attachments/1/2/a.png', 10)).rejects.toMatchObject({ kind: 'too_large' });
    });
});

describe('failure words: never the generic text', () => {
    it('a non-Discord error (a bug of ours) says so plainly, code internal', () => {
        const f = describeError(new TypeError('Cannot read properties of undefined (reading \'count\')'), TOKEN);
        expect(f.error.code).toBe('internal');
        expect(f.error.message).not.toBe(GENERIC);
        expect(f.error.message).toMatch(/Cipherline ran into a problem of its own/);
        expect(f.error.message).not.toMatch(/count|undefined/); // never the error's own text
    });
    it('a channel read failure carries the step, Discord\'s status and the error class (labels only)', () => {
        expect(describeReadError(new DiscordApiError('server', 'x', 503), 'read', TOKEN).error).toMatchObject({ code: 'discord_down', step: 'read', status: 503, errorName: 'discord_server' });
        expect(describeReadError(new RangeError('boom'), 'reactions', TOKEN).error).toMatchObject({ code: 'internal', step: 'reactions', errorName: 'RangeError' });
        expect(errorClassOf({ name: 'has spaces and a token MTIz' })).toBe('Error');
    });
});
