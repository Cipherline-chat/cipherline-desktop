import { describe, it, expect } from 'vitest';
import { DiscordClient, checkMediaUrl, routeKey, type FetchLike } from './discord-client';
import {
    fetchChannelPins, fetchChannelWindow, fetchMediaByRef, fetchReactors, normalizeMessage, sniffMime,
    type MediaRegistry, type RawMessage,
} from './history';
import { MOCK_IDS, MOCK_TEXT_CHANNEL, PEOPLE, mockChannelMessages, mockPins } from './__fixtures__/mock-history';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
});

function client(fetchFn: FetchLike) {
    return new DiscordClient({ token: TOKEN, fetchFn, sleep: async () => undefined });
}

/** A channel of `n` messages, one per hour going back from `now`. */
function longChannel(n: number, now = Date.parse('2026-11-20T00:00:00Z'), stepMs = 3600_000) {
    return Array.from({ length: n }, (_, i) => ({
        id: String(700000000000000000n + BigInt(n - i)), type: 0, content: `m${n - i}`,
        timestamp: new Date(now - i * stepMs).toISOString(), author: PEOPLE.alex, mentions: [], attachments: [], embeds: [],
    }));
}
function pager(all: Array<{ id: string }>, log: string[] = []): FetchLike {
    return async (url) => {
        log.push(url);
        const u = new URL(url);
        const before = u.searchParams.get('before');
        const start = before ? all.findIndex(m => m.id === before) + 1 : 0;
        return res(200, all.slice(start, start + Number(u.searchParams.get('limit') ?? 50)));
    };
}

describe('the history window: the LARGER of the last 1,000 and the last 30 days (from import time), at most 25,000', () => {
    const NOW = Date.parse('2026-11-22T00:00:00Z');
    const DAY = 86_400_000;
    it('0 messages in the last 30 days, 12,000 in all -> the last 1,000', async () => {
        const all = longChannel(12_000, NOW - 60 * DAY, 60_000); // newest is 60 days old
        const r = await fetchChannelWindow(client(pager(all)), MOCK_TEXT_CHANNEL, new Map(), undefined, { now: NOW });
        expect(r.messages.length).toBe(1000);
        expect(r.truncated).toBe(true);
        expect(r.ceilingHit).toBe(false);
        expect(r.messages[r.messages.length - 1].content).toBe('m12000'); // oldest first, ends at the newest
    });
    it('8,000 in the last 30 days -> all 8,000 (more than the 1,000 floor)', async () => {
        // One every 5 minutes for 8,000 messages = ~27.8 days, then older ones.
        const recent = longChannel(9_000, NOW, 5 * 60_000).slice(0, 8_000);
        const old = longChannel(1_000, NOW - 40 * DAY, 60_000).map(m => ({ ...m, id: String(600000000000000000n + BigInt(m.id) % 100000n) }));
        const r = await fetchChannelWindow(client(pager([...recent, ...old])), MOCK_TEXT_CHANNEL, new Map(), undefined, { now: NOW });
        expect(r.messages.length).toBe(8000);
        expect(r.truncated).toBe(true);
    });
    it('300 in all -> all 300, untruncated', async () => {
        const r = await fetchChannelWindow(client(pager(longChannel(300, NOW - 400 * DAY))), MOCK_TEXT_CHANNEL, new Map(), undefined, { now: NOW });
        expect(r.messages.length).toBe(300);
        expect(r.truncated).toBe(false);
    });
    it('the 25,000 safety ceiling: 30,000 in the last 30 days -> the newest 25,000, flagged, never a page more', async () => {
        const all = longChannel(30_000, NOW, 60_000);
        const log: string[] = [];
        const r = await fetchChannelWindow(client(pager(all, log)), MOCK_TEXT_CHANNEL, new Map(), undefined, { now: NOW });
        expect(r.messages.length).toBe(25_000);
        expect(r.ceilingHit).toBe(true);
        expect(r.truncated).toBe(true);
        expect(log.length).toBe(251); // 250 pages of 100 + a one-message peek, never a page more
        expect(log.filter(u => u.includes('limit=100'))).toHaveLength(250);
    });
    it('POSITIVE CONTROL for the ceiling: exactly 25,000 recent -> all, not flagged as cut', async () => {
        const r = await fetchChannelWindow(client(pager(longChannel(25_000, NOW, 60_000))), MOCK_TEXT_CHANNEL, new Map(), undefined, { now: NOW });
        expect(r.messages.length).toBe(25_000);
        expect(r.ceilingHit).toBe(false);
    });
    it('refuses a non-snowflake channel id before any request', async () => {
        let called = false;
        await expect(fetchChannelWindow(client(async () => { called = true; return res(200, []); }), '../x', new Map())).rejects.toThrow();
        expect(called).toBe(false);
    });
});

describe('reactions: emoji + count from the message, who reacted from one request per (message, emoji)', () => {
    const raw = (id: string, reactions: unknown) => ({
        id, type: 0, content: 'x', timestamp: '2026-11-20T00:00:00Z', author: PEOPLE.alex, mentions: [], attachments: [], embeds: [], reactions,
    });
    it('normalizeMessage keeps emoji (unicode or custom id+name) and count; junk dropped', () => {
        const m = normalizeMessage(raw('700000000000000001', [
            { count: 3, emoji: { id: null, name: '🎉' } },
            { count: 1, emoji: { id: '800000000000000040', name: 'party_parrot', animated: true } },
            { count: 0, emoji: { id: null, name: '👍' } },
            { count: 2, emoji: { id: '800000000000000041', name: 'bad name!' } },
        ]) as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!;
        expect(m.reactions).toEqual([
            { emoji: { id: null, name: '🎉', animated: false }, count: 3, users: [] },
            { emoji: { id: '800000000000000040', name: 'party_parrot', animated: true }, count: 1, users: [] },
        ]);
    });
    it('fetchReactors: the right route per emoji (URL-encoded), bots as app, and the budget stops it', async () => {
        const log: string[] = [];
        const f: FetchLike = async (url) => {
            log.push(url);
            return res(200, [{ id: PEOPLE.sam.id, username: 'sam', global_name: 'Sam' }, { id: '900000000000000077', username: 'helper', bot: true }]);
        };
        const msgs = [
            normalizeMessage(raw('700000000000000002', [{ count: 5, emoji: { id: null, name: '🎉' } }, { count: 1, emoji: { id: '800000000000000040', name: 'party_parrot' } }]) as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!,
            normalizeMessage(raw('700000000000000001', [{ count: 1, emoji: { id: null, name: '👍' } }]) as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!,
        ];
        const spent = await fetchReactors(client(f), MOCK_TEXT_CHANNEL, msgs, undefined, 2);
        expect(spent).toBe(2);
        expect(log[0]).toContain(`/messages/700000000000000002/reactions/${encodeURIComponent('🎉')}?limit=100&type=0`);
        expect(log[1]).toContain(`/reactions/${encodeURIComponent('party_parrot:800000000000000040')}?limit=100`);
        expect(msgs[0].reactions[0].users).toEqual([{ id: PEOPLE.sam.id, name: 'Sam', kind: 'user' }, { id: '900000000000000077', name: 'helper', kind: 'app' }]);
        expect(msgs[0].reactions[0].count).toBe(5); // Discord's total kept
        expect(msgs[1].reactions[0].users).toEqual([]); // past the budget: emoji + count, no names
    });
});

describe('normalizeMessage', () => {
    const reg: MediaRegistry = new Map();
    const msgs = mockChannelMessages().map(m => normalizeMessage(m as RawMessage, reg, MOCK_TEXT_CHANNEL));
    const byId = (n: number) => msgs.find(m => m?.id === MOCK_IDS.sf(n));
    it('drops system messages (joins, boosts...): only words come over', () => {
        expect(msgs.filter(m => m === null)).toHaveLength(1); // the type-7 join
    });
    it('authors: display name, the new-style handle, kind; app/webhook never get a handle', () => {
        expect(byId(100)?.author).toMatchObject({ id: PEOPLE.alex.id, name: 'Alex', username: 'alex_92', kind: 'user' });
        expect(byId(104)?.author).toMatchObject({ name: 'FarmBot', username: null, kind: 'app' });
        expect(byId(100)?.author.avatarRef).toMatch(/^[0-9a-f-]{36}$/);
        expect(byId(102)?.author.avatarRef).toBeNull();
    });
    it('replies, edits, voice messages, polls, embeds, stickers, pins', () => {
        expect(byId(103)?.replyTo).toBe(MOCK_IDS.sf(102));
        expect(byId(103)?.mentionNames[PEOPLE.sam.id]).toBe('Sam');
        expect(byId(105)?.edited).toBe(true);
        expect(byId(106)?.files[0]).toMatchObject({ voice: true, mime: 'audio/ogg' });
        expect(byId(107)?.poll).toEqual({ question: 'Next crop?', answers: [{ text: 'Corn', votes: 4 }, { text: 'Beans', votes: 2 }] });
        expect(byId(104)?.embeds[0]).toMatchObject({ title: 'Tomorrow', fields: [{ name: 'Wind', value: '8 km/h' }] });
        expect(byId(108)?.stickers).toEqual(['wave']);
        expect(byId(108)?.pinned).toBe(true);
    });
    it('sticker items: a picture sticker gets an opaque ref to media.discordapp.net/stickers/<id>.png|gif; a Lottie one none; no URL reaches the renderer', () => {
        const r: MediaRegistry = new Map();
        const m = normalizeMessage({ ...(mockChannelMessages()[0] as RawMessage), sticker_items: [
            { id: '800000000000000060', name: 'Wave', format_type: 1 }, { id: '800000000000000062', name: 'Party', format_type: 4 }, { id: '800000000000000063', name: 'Spinny', format_type: 3 }, { id: 'nope', name: 'x', format_type: 1 },
        ] } as RawMessage, r, MOCK_TEXT_CHANNEL)!;
        expect(m.stickerItems?.map(x => [x.id, x.name, x.format, x.ref === null ? null : 'ref'])).toEqual([
            ['800000000000000060', 'Wave', 1, 'ref'], ['800000000000000062', 'Party', 4, 'ref'], ['800000000000000063', 'Spinny', 3, null],
        ]);
        expect(r.get(m.stickerItems![0].ref!)?.url).toBe('https://media.discordapp.net/stickers/800000000000000060.png');
        expect(r.get(m.stickerItems![1].ref!)?.url).toBe('https://media.discordapp.net/stickers/800000000000000062.gif');
        expect(JSON.stringify(m)).not.toContain('discordapp');
    });
    it('file URLs never leave main: the renderer gets an opaque ref only', () => {
        const f = byId(102)!.files[0];
        expect(f.ref).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.stringify(msgs)).not.toContain('cdn.discordapp.com');
        expect(reg.get(f.ref)?.url).toContain('/attachments/');
    });
});

describe('pins', () => {
    it('reads the paginated pins route, newest pin first, including pins older than the window', async () => {
        const fetchFn: FetchLike = async (url) => (url.includes('/messages/pins') ? res(200, mockPins()) : res(404, {}));
        const pins = await fetchChannelPins(client(fetchFn), MOCK_TEXT_CHANNEL, new Map());
        expect(pins.map(p => p.id)).toEqual([MOCK_IDS.sf(108), MOCK_IDS.sf(100), MOCK_IDS.sf(50)]);
        expect(pins.every(p => p.pinned)).toBe(true);
    });
    it('falls back to the legacy /pins route', async () => {
        const fetchFn: FetchLike = async (url) => (url.endsWith('/pins') ? res(200, [mockPins().items[2].message]) : res(404, {}));
        const pins = await fetchChannelPins(client(fetchFn), MOCK_TEXT_CHANNEL, new Map());
        expect(pins.map(p => p.id)).toEqual([MOCK_IDS.sf(50)]);
    });
});

describe('media: fixed hosts, signed URLs refreshed once, size cap, magic bytes', () => {
    it('checkMediaUrl allows only https Discord media paths', () => {
        expect(checkMediaUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3')).not.toBeNull();
        expect(checkMediaUrl('https://media.discordapp.net/attachments/1/2/a.png')).not.toBeNull();
        expect(checkMediaUrl('https://cdn.discordapp.com/avatars/1/abc.png?size=128')).not.toBeNull();
        for (const bad of [
            'http://cdn.discordapp.com/attachments/1/2/a.png', 'https://evil.example/attachments/1/a.png',
            'https://cdn.discordapp.com.evil.example/attachments/1/a.png', 'https://user:pw@cdn.discordapp.com/attachments/1/a.png',
            'https://cdn.discordapp.com:8443/attachments/1/a.png', 'https://cdn.discordapp.com/api/v10/users/@me',
            'https://cdn.discordapp.com/attachments/1/a.png?token=x', 'file:///etc/passwd', 'https://169.254.169.254/latest',
        ]) expect(checkMediaUrl(bad)).toBeNull();
    });
    it('never sends the bot token to the media host, never follows redirects', async () => {
        const reg: MediaRegistry = new Map();
        const n = normalizeMessage(mockChannelMessages().find(m => m.id === MOCK_IDS.sf(102)) as RawMessage, reg, MOCK_TEXT_CHANNEL)!;
        const seen: Array<{ url: string; auth?: string; redirect?: string }> = [];
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        const fetchFn: FetchLike = async (url, init) => { seen.push({ url, auth: init.headers.Authorization, redirect: init.redirect }); return res(200, png, { 'content-type': 'image/png' }); };
        const r = await fetchMediaByRef(client(fetchFn), reg, n.files[0].ref);
        expect(r.bytes.length).toBe(png.length);
        // (The fixture's signature is long expired, so the message is re-read first, WITH the token, on discord.com.)
        const media = seen.filter(x => x.url.startsWith('https://cdn.discordapp.com/'));
        expect(media.length).toBeGreaterThan(0);
        for (const m of media) { expect(m.auth).toBeUndefined(); expect(m.redirect).toBe('error'); }
        expect(seen.filter(x => x.auth).every(x => x.url.startsWith('https://discord.com/api/'))).toBe(true);
    });
    it('an expired signed URL is refreshed ONCE by re-reading the message', async () => {
        const reg: MediaRegistry = new Map();
        const raw = mockChannelMessages().find(m => m.id === MOCK_IDS.sf(102)) as RawMessage;
        const n = normalizeMessage(raw, reg, MOCK_TEXT_CHANNEL)!;
        const fresh = JSON.parse(JSON.stringify(raw));
        fresh.attachments[0].url = fresh.attachments[0].url.replace('hm=abc', 'hm=fresh');
        const urls: string[] = [];
        const fetchFn: FetchLike = async (url) => {
            urls.push(url);
            if (url.includes('hm=abc')) return res(403, {});
            if (url.includes('/api/v10/channels/')) return res(200, fresh);
            return res(200, new Uint8Array([1, 2, 3]));
        };
        const r = await fetchMediaByRef(client(fetchFn), reg, n.files[0].ref);
        expect(r.bytes.length).toBe(3);
        expect(urls.filter(u => u.includes('hm=fresh'))).toHaveLength(1);
    });
    it('over the cap -> too_large, without reading the body when the length is declared', async () => {
        const reg: MediaRegistry = new Map([['11111111-1111-4111-8111-111111111111', { url: 'https://cdn.discordapp.com/attachments/1/2/big.bin', kind: 'file' as const, channelId: MOCK_TEXT_CHANNEL, max: 10 }]]);
        const fetchFn: FetchLike = async () => res(200, new Uint8Array(5), { 'content-length': '999' });
        await expect(fetchMediaByRef(client(fetchFn), reg, '11111111-1111-4111-8111-111111111111')).rejects.toThrow('too_large');
    });
    it('sniffMime: magic bytes win over the claimed type; HTML/SVG/script become a download', () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        expect(sniffMime(png, 'image/png')).toBe('image/png');
        expect(sniffMime(png, 'image/jpeg')).toBe('image/png');
        expect(sniffMime(new Uint8Array([1, 2, 3]), 'image/png')).toBe('application/octet-stream');
        expect(sniffMime(new Uint8Array([60, 104]), 'text/html')).toBe('application/octet-stream');
        expect(sniffMime(new Uint8Array([60, 115]), 'image/svg+xml')).toBe('application/octet-stream');
        expect(sniffMime(new Uint8Array([0]), 'application/pdf')).toBe('application/pdf');
    });
    it('routeKey keeps the channel as a major parameter', () => {
        expect(routeKey('GET', `/channels/${MOCK_TEXT_CHANNEL}/messages?limit=100`)).toBe(`GET /channels/${MOCK_TEXT_CHANNEL}/messages`);
        expect(routeKey('GET', '/channels/800000000000000011/messages')).not.toBe(routeKey('GET', '/channels/800000000000000012/messages'));
    });
});

describe('normalizeMessage: forwards and embed pictures', () => {
    const base = { id: MOCK_IDS.sf(900), type: 0, content: '', timestamp: new Date().toISOString(), author: PEOPLE.alex, mentions: [], attachments: [], embeds: [] };
    it('a forward imports its snapshot: words, attachments, embeds, mentions (the forwarder is the author)', () => {
        const reg: MediaRegistry = new Map();
        const n = normalizeMessage({
            ...base, flags: 1 << 14, message_reference: { type: 1, message_id: MOCK_IDS.sf(1) },
            message_snapshots: [{ message: {
                content: 'original <@' + PEOPLE.sam.id + '>', timestamp: '2026-10-01T00:00:00.000Z', mentions: [PEOPLE.sam],
                attachments: [{ id: MOCK_IDS.sf(950), filename: 'a.png', size: 3, url: `https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3`, content_type: 'image/png' }],
                embeds: [{ title: 'T' }],
            } }],
        } as RawMessage, reg, MOCK_TEXT_CHANNEL)!;
        expect(n.forwarded).toEqual({ content: 'original <@' + PEOPLE.sam.id + '>', ts: '2026-10-01T00:00:00.000Z' });
        expect(n.replyTo).toBeNull();
        expect(n.mentionNames[PEOPLE.sam.id]).toBe('Sam');
        expect(n.files).toHaveLength(1);
        expect(n.files[0].ref).toMatch(/^[0-9a-f-]{36}$/);
        expect(n.embeds[0].title).toBe('T');
    });
    it('a non-forward ignores message_snapshots (nothing is read from a field that should not be there)', () => {
        const n = normalizeMessage({ ...base, message_snapshots: [{ message: { content: 'x' } }] } as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!;
        expect(n.forwarded).toBeNull();
    });
    it('embed image / thumbnail become files only on Discord media hosts, at most 10 per message', () => {
        const reg: MediaRegistry = new Map();
        const ok = (i: number) => ({ image: { url: `https://cdn.discordapp.com/attachments/1/${i}/p${i}.png?ex=1&is=2&hm=3` } });
        const embeds = [
            ...Array.from({ length: 10 }, (_, i) => ok(i + 1)),
            { image: { url: 'https://evil.example/x.png', proxy_url: 'https://images-ext-1.discordapp.net/external/abc/x.png' } },
        ];
        const n = normalizeMessage({ ...base, embeds } as RawMessage, reg, MOCK_TEXT_CHANNEL)!;
        expect(n.files.length).toBe(10);
        expect(n.files.every(f => f.embedImage && f.ref)).toBe(true);
        const only = normalizeMessage({ ...base, embeds: [embeds[10], { thumbnail: { url: 'https://cdn.discordapp.com/attachments/1/9/t.jpg' } }] } as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!;
        expect(only.files.map(f => f.filename)).toEqual(['t.jpg']);
    });
    it('POSITIVE CONTROL: an external-host embed picture is never registered (no fetch of an arbitrary URL)', () => {
        const reg: MediaRegistry = new Map();
        normalizeMessage({ ...base, embeds: [{ image: { url: 'https://evil.example/x.png' } }] } as RawMessage, reg, MOCK_TEXT_CHANNEL);
        expect([...reg.values()].some(e => e.url.includes('evil.example'))).toBe(false);
    });
});
