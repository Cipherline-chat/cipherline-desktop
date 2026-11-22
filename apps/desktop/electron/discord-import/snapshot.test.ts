import { describe, it, expect } from 'vitest';
import { DiscordClient, type FetchLike } from './discord-client';
import { buildSnapshot, channelSourceKey, fetchGuildImage, fetchGuildSnapshot, type ImageRefs } from './snapshot';
import {
    MOCK_BANNED, MOCK_GUILD_ID, MOCK_MEMBER_ALEX, MOCK_MEMBER_OVERWRITE, MOCK_MEMBER_SAM, MOCK_ROLE_MOD,
    mockBans, mockChannels, mockGuild, mockMembers,
} from './__fixtures__/mock-guild';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');

describe('buildSnapshot: live guild -> template wire shape', () => {
    const { snapshot, images } = buildSnapshot(mockGuild() as never, mockChannels() as never);
    const body = snapshot.body as { roles: any[]; channels: any[]; [k: string]: unknown };

    it('renumbers ids to small ints; @everyone is 0; no snowflake leaves the machine', () => {
        expect(body.roles[0]).toMatchObject({ id: 0, name: '@everyone' });
        const json = JSON.stringify(body);
        expect(json).not.toMatch(/\d{15,}/); // not a single 15+ digit id (guild, role, channel, member)
        for (const r of body.roles) expect(Number.isInteger(r.id) && r.id < 1000).toBe(true);
        for (const c of body.channels) expect(c.id).toBeLessThan(500);
    });

    it('roles run lowest to highest, managed (bot) roles are dropped and reported', () => {
        expect(body.roles.map(r => r.name)).toEqual(['@everyone', 'Farmhand', 'Moderator', 'Owner']);
        expect(snapshot.notMapped.some(n => /Bot and integration roles \(1\)/.test(n.item))).toBe(true);
    });

    it('keeps permission strings, colours, hoist and mentionable verbatim', () => {
        const mod = body.roles.find(r => r.name === 'Moderator');
        expect(mod).toMatchObject({ color: 15158332, hoist: true, mentionable: true });
        expect(BigInt(mod.permissions) & (1n << 1n)).not.toBe(0n);
    });

    it('overwrites: role targets remapped, bot-role target dropped, member target anonymised', () => {
        const mod = body.channels.find(c => c.name === 'mod-chat');
        const roleTargets = mod.permission_overwrites.filter((o: any) => o.type === 0).map((o: any) => o.id);
        expect(roleTargets.sort()).toEqual([0, 2]); // @everyone + Moderator; helper bot gone
        const member = mod.permission_overwrites.find((o: any) => o.type === 1);
        expect(member.id).toBe(1);
    });

    it('parents and the system/AFK channels follow the new ids', () => {
        const byName = Object.fromEntries(body.channels.map(c => [c.name, c]));
        expect(byName['rules'.padStart(0)] ?? byName['\u{1F4DC}・rules'].parent_id).toBe(byName['INFO'].id);
        expect(body.system_channel_id).toBe(byName['\u{1F4DC}・rules'].id);
        expect(body.afk_channel_id).toBe(byName['AFK'].id);
        expect(byName['general'].parent_id).toBeNull();
    });

    it('counts and emoji list (locked emoji skipped and reported)', () => {
        expect(snapshot.counts).toEqual({ roles: 3, categories: 2, channels: 7, emojis: 2, members: 1, bans: 0 });
        expect(snapshot.emojis.map(e => [e.name, e.animated])).toEqual([['party_parrot', true], ['Tractor', false]]);
        expect(snapshot.notMapped.some(n => /1 unavailable emoji/.test(n.item))).toBe(true);
    });

    it('lists what does not come over', () => {
        const items = snapshot.notMapped.map(n => n.item).join('\n');
        for (const s of ['boosts', 'Integrations', 'AutoMod', 'Welcome screen', 'Vanity', 'Threads', 'Member accounts']) {
            expect(items).toContain(s);
        }
    });

    it('remembers only hashes and ids for later image requests', () => {
        expect(images.iconHash).toBe('a_1234abcd');
        expect(images.bannerHash).toBe('bnr5678');
        expect([...images.emojiIds]).toHaveLength(2);
        expect(snapshot.guild).toMatchObject({ hasIcon: true, hasBanner: true, name: 'Pixel Farm Co-op' });
    });

    it('survives hostile / odd input without throwing', () => {
        const odd = buildSnapshot({ id: MOCK_GUILD_ID, name: 42 as never, roles: 'x' as never, emojis: [null, { id: 'nope' }] as never }, [null, { id: 'bad' }, { id: '800000000000000099', type: 0, permission_overwrites: [{ allow: 1 }, null] }] as never);
        expect(odd.snapshot.guild.name).toBe('Imported server');
        expect(odd.snapshot.counts.channels).toBe(1);
    });

    it('caps at Cipherline limits (250 roles / 500 channels) and says so', () => {
        const g = mockGuild() as any;
        g.roles = [g.roles[0], ...Array.from({ length: 260 }, (_, i) => ({ id: String(810000000000000000 + i), name: `r${i}`, permissions: '0', position: i + 1 }))];
        const chans = Array.from({ length: 510 }, (_, i) => ({ id: String(820000000000000000 + i), type: 0, name: `c${i}`, position: i }));
        const out = buildSnapshot(g, chans as never);
        expect(out.snapshot.counts.roles).toBe(250);
        expect(out.snapshot.counts.channels).toBe(500);
        expect(out.snapshot.notMapped.some(n => /10 roles/.test(n.item))).toBe(true);
        expect(out.snapshot.notMapped.some(n => /10 channels/.test(n.item))).toBe(true);
    });
});

function routedFetch(routes: Record<string, unknown>, log: string[] = []): FetchLike {
    return async (url, init) => {
        log.push(`${url} ${init.headers.Authorization ? 'auth' : 'noauth'}`);
        const path = url.replace('https://discord.com/api/v10', '');
        const hit = routes[path];
        const isBytes = hit instanceof Uint8Array;
        return {
            status: hit === undefined ? 404 : 200,
            headers: { get: (n: string) => (n.toLowerCase() === 'content-type' && isBytes ? 'image/png' : null) },
            json: async () => hit ?? { code: 10004 },
            arrayBuffer: async () => (hit instanceof Uint8Array ? hit : new Uint8Array()).buffer as ArrayBuffer,
        };
    };
}

describe('buildSnapshot: people (roles, member overwrites, nicknames, bans; D5b)', () => {
    const { snapshot } = buildSnapshot(mockGuild() as never, mockChannels() as never, { members: mockMembers() as never, bans: mockBans() as never });
    const byId = new Map(snapshot.members.map(m => [m.id, m]));
    const body = snapshot.body as { roles: any[]; channels: any[] };
    const roleNum = (name: string) => body.roles.find(r => r.name === name).id;

    it('members with roles keep them as snapshot role numbers (@everyone and bot roles never), plus their nickname', () => {
        expect(byId.get(MOCK_MEMBER_SAM)).toMatchObject({ nick: 'Sammy' });
        expect(new Set(byId.get(MOCK_MEMBER_SAM)!.roles)).toEqual(new Set([roleNum('Moderator'), roleNum('Farmhand')]));
        expect(byId.get(MOCK_MEMBER_ALEX)).toMatchObject({ roles: [roleNum('Farmhand')] });
        expect(byId.get(MOCK_MEMBER_ALEX)!.nick).toBeUndefined();
        expect(byId.get('900000000000000003')).toMatchObject({ roles: [], nick: 'Q' });
        expect(byId.has('900000000000000004')).toBe(false); // nothing to carry
    });

    it('a member overwrite in the body names the SAME local number as that member', () => {
        const mod = body.channels.find(c => c.name === 'mod-chat');
        const ow = mod.permission_overwrites.find((o: any) => o.type === 1);
        expect(byId.get(MOCK_MEMBER_OVERWRITE)!.ref).toBe(ow.id);
        expect(JSON.stringify(body)).not.toMatch(/\d{15,}/); // still no Discord id in the body
    });

    it('bots are excluded everywhere: members, bans, overwrites', () => {
        expect(snapshot.members.some(m => m.id === '800000000000000900')).toBe(false);
        expect(snapshot.bans).toEqual([{ id: MOCK_BANNED, reason: 'Spam links' }]);
        const g = mockChannels() as any[];
        g.find(c => c.name === 'mod-chat').permission_overwrites.push({ id: '800000000000000900', type: 1, allow: '1024', deny: '0' });
        const out = buildSnapshot(mockGuild() as never, g as never, { members: mockMembers() as never });
        const ows = (out.snapshot.body as any).channels.find((c: any) => c.name === 'mod-chat').permission_overwrites.filter((o: any) => o.type === 1);
        expect(ows).toHaveLength(1);
    });

    it('counts and reports: people carried, timeouts not', () => {
        expect(snapshot.counts).toMatchObject({ members: 4, bans: 1 });
        expect(snapshot.notMapped.some(n => /Timeouts \(1\)/.test(n.item))).toBe(true);
    });
});

describe('fetchGuildSnapshot', () => {
    it('reads the guild, channels, members and bans with bot-authorised requests', async () => {
        const log: string[] = [];
        const client = new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: routedFetch({
            [`/guilds/${MOCK_GUILD_ID}`]: mockGuild(),
            [`/guilds/${MOCK_GUILD_ID}/channels`]: mockChannels(),
            [`/guilds/${MOCK_GUILD_ID}/members?limit=1000&after=0`]: mockMembers(),
            [`/guilds/${MOCK_GUILD_ID}/bans?limit=1000&after=0`]: mockBans(),
        }, log) });
        const { snapshot } = await fetchGuildSnapshot(client, MOCK_GUILD_ID);
        expect(snapshot.counts.channels).toBe(7);
        expect(snapshot.counts.members).toBe(4);
        expect(snapshot.counts.bans).toBe(1);
        expect(log).toHaveLength(5); // + GET /guilds/:id/stickers (404 here: reported, not fatal)
        expect(log.every(l => l.endsWith(' auth'))).toBe(true);
    });

    it('pages the member list 1,000 at a time with after = the last user id', async () => {
        const page1 = Array.from({ length: 1000 }, (_, i) => ({ user: { id: String(910000000000000000n + BigInt(i)) }, roles: ['800000000000000002'] }));
        const page2 = [{ user: { id: '920000000000000000' }, roles: ['800000000000000002'] }];
        const log: string[] = [];
        const client = new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: routedFetch({
            [`/guilds/${MOCK_GUILD_ID}`]: mockGuild(),
            [`/guilds/${MOCK_GUILD_ID}/channels`]: mockChannels(),
            [`/guilds/${MOCK_GUILD_ID}/members?limit=1000&after=0`]: page1,
            [`/guilds/${MOCK_GUILD_ID}/members?limit=1000&after=910000000000000999`]: page2,
            [`/guilds/${MOCK_GUILD_ID}/bans?limit=1000&after=0`]: [],
        }, log) });
        const { snapshot } = await fetchGuildSnapshot(client, MOCK_GUILD_ID);
        expect(snapshot.members.length).toBe(1002); // 1,001 + the overwrite target
    });

    it('Server Members Intent off (403 Missing Access on /members): a clear members_intent error, nothing else read', async () => {
        const log: string[] = [];
        const base = routedFetch({ [`/guilds/${MOCK_GUILD_ID}`]: mockGuild(), [`/guilds/${MOCK_GUILD_ID}/channels`]: mockChannels() }, log);
        const client = new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: async (url, init) => {
            if (url.includes('/members?')) { log.push(url); return { status: 403, headers: { get: () => null }, json: async () => ({ message: 'Missing Access', code: 50001 }), arrayBuffer: async () => new ArrayBuffer(0) }; }
            return base(url, init);
        } });
        await expect(fetchGuildSnapshot(client, MOCK_GUILD_ID)).rejects.toMatchObject({ kind: 'members_intent', discordCode: 50001 });
        expect(log.some(l => l.includes('/bans'))).toBe(false);
        const { describeError } = await import('./ipc');
        const shown = describeError(new (await import('./discord-client')).DiscordApiError('members_intent', 'x'));
        expect(shown.error.code).toBe('members_intent');
        expect(shown.error.message).toMatch(/Server Members Intent/);
    });

    it('a bot that may not read bans: the import goes on and says so', async () => {
        const base = routedFetch({
            [`/guilds/${MOCK_GUILD_ID}`]: mockGuild(), [`/guilds/${MOCK_GUILD_ID}/channels`]: mockChannels(),
            [`/guilds/${MOCK_GUILD_ID}/members?limit=1000&after=0`]: mockMembers(),
        });
        const client = new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: async (url, init) => (
            url.includes('/bans?') ? { status: 403, headers: { get: () => null }, json: async () => ({ code: 50013 }), arrayBuffer: async () => new ArrayBuffer(0) } : base(url, init)) });
        const { snapshot } = await fetchGuildSnapshot(client, MOCK_GUILD_ID);
        expect(snapshot.bans).toEqual([]);
        expect(snapshot.notMapped.some(n => n.item === 'Bans')).toBe(true);
    });

    it('rejects a body for a different guild, and a bad id before any request', async () => {
        const log: string[] = [];
        const client = new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: routedFetch({
            [`/guilds/${MOCK_GUILD_ID}`]: { ...mockGuild(), id: '800000000000000002' },
        }, log) });
        await expect(fetchGuildSnapshot(client, MOCK_GUILD_ID)).rejects.toMatchObject({ kind: 'invalid_response' });
        await expect(fetchGuildSnapshot(client, '../../users/@me')).rejects.toMatchObject({ kind: 'invalid_response' });
        expect(log).toHaveLength(1);
    });
});

describe('fetchGuildImage', () => {
    const refs: ImageRefs = { iconHash: 'a_1234abcd', bannerHash: null, emojiIds: new Set(['800000000000000040', '800000000000000041']), animatedEmoji: new Set(['800000000000000040']) };
    const png = new Uint8Array([137, 80, 78, 71]);
    const cdn = (routes: Record<string, unknown>, log: string[] = []) => {
        const f = routedFetch({}, log);
        return new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: async (url, init) => {
            log.push(`${url} ${init.headers.Authorization ? 'auth' : 'noauth'}`);
            const hit = routes[url.replace(/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)/, '')];
            if (hit === 'big') return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/gif' : n.toLowerCase() === 'content-length' ? '99999999' : null) }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
            void f;
            return { status: hit ? 200 : 404, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) }, json: async () => ({}), arrayBuffer: async () => (hit as Uint8Array ?? new Uint8Array()).buffer as ArrayBuffer };
        } });
    };

    it('icon: PNG endpoint (still frame of an animated icon), no auth to the CDN', async () => {
        const log: string[] = [];
        const r = await fetchGuildImage(cdn({ [`/icons/${MOCK_GUILD_ID}/a_1234abcd.png?size=512`]: png }, log), MOCK_GUILD_ID, refs, { kind: 'icon' });
        expect(r.mime).toBe('image/png');
        expect(log[0]).toMatch(/noauth$/);
    });

    it('a guild without a banner has nothing to fetch', async () => {
        await expect(fetchGuildImage(cdn({}), MOCK_GUILD_ID, refs, { kind: 'banner' })).rejects.toMatchObject({ kind: 'not_found' });
    });

    it('emoji: only ids from the snapshot; renderer text never becomes a path', async () => {
        await expect(fetchGuildImage(cdn({}), MOCK_GUILD_ID, refs, { kind: 'emoji', emojiId: '999999999999999999' })).rejects.toMatchObject({ kind: 'not_found' });
        const r = await fetchGuildImage(cdn({ '/emojis/800000000000000041.png?size=128': png }), MOCK_GUILD_ID, refs, { kind: 'emoji', emojiId: '800000000000000041' });
        expect(r.bytes.byteLength).toBe(4);
    });

    it('animated emoji: GIF first, falls back to a still PNG when the GIF is over the cap', async () => {
        const log: string[] = [];
        const r = await fetchGuildImage(cdn({ '/emojis/800000000000000040.gif?size=128': 'big', '/emojis/800000000000000040.png?size=128': png }, log), MOCK_GUILD_ID, refs, { kind: 'emoji', emojiId: '800000000000000040' });
        expect(r.note).toMatch(/animation dropped/);
        expect(log).toHaveLength(2);
    });

    it('role icon: CDN role-icons/<role id>/<hash>.png from what the read remembered, by snapshot role number only', async () => {
        const withIcons: ImageRefs = { ...refs, roleIcons: new Map([[2, { id: '800000000000000003', hash: 'abc123' }]]) };
        const log: string[] = [];
        const r = await fetchGuildImage(cdn({ '/role-icons/800000000000000003/abc123.png?size=128': png }, log), MOCK_GUILD_ID, withIcons, { kind: 'role_icon', role: 2 });
        expect(r.mime).toBe('image/png');
        expect(log).toEqual(['https://cdn.discordapp.com/role-icons/800000000000000003/abc123.png?size=128 noauth']);
        await expect(fetchGuildImage(cdn({}), MOCK_GUILD_ID, withIcons, { kind: 'role_icon', role: 1 })).rejects.toMatchObject({ kind: 'not_found' });
        await expect(fetchGuildImage(cdn({}), MOCK_GUILD_ID, refs, { kind: 'role_icon', role: 2 })).rejects.toMatchObject({ kind: 'not_found' });
    });

    it('sticker: media.discordapp.net/stickers/<id>.png or .gif (the media path), only for a sticker this guild\'s read kept', async () => {
        const withStickers: ImageRefs = { ...refs, stickers: new Map([['800000000000000060', 'png'], ['800000000000000062', 'gif']]) };
        const log: string[] = [];
        await fetchGuildImage(cdn({ '/stickers/800000000000000060.png': png, '/stickers/800000000000000062.gif': png }, log), MOCK_GUILD_ID, withStickers, { kind: 'sticker', stickerId: '800000000000000060' });
        await fetchGuildImage(cdn({ '/stickers/800000000000000060.png': png, '/stickers/800000000000000062.gif': png }, log), MOCK_GUILD_ID, withStickers, { kind: 'sticker', stickerId: '800000000000000062' });
        expect(log).toEqual(['https://media.discordapp.net/stickers/800000000000000060.png noauth', 'https://media.discordapp.net/stickers/800000000000000062.gif noauth']);
        await expect(fetchGuildImage(cdn({}), MOCK_GUILD_ID, withStickers, { kind: 'sticker', stickerId: '800000000000000063' })).rejects.toMatchObject({ kind: 'not_found' });
    });
});

describe('buildSnapshot: final mapping pass (member since, role icons, gradients, slowmode, age-restricted)', () => {
    const guild = () => {
        const g = mockGuild() as any;
        const mod = g.roles.find((r: any) => r.name === 'Moderator');
        Object.assign(mod, { icon: 'abc123', colors: { primary_color: 15158332, secondary_color: 3447003, tertiary_color: null } });
        Object.assign(g.roles.find((r: any) => r.name === 'Farmhand'), { unicode_emoji: '\u{1F33E}' });
        Object.assign(g.roles.find((r: any) => r.name === 'Owner'), { icon: '../evil' });
        return g;
    };
    const members = () => [
        ...(mockMembers() as any[]).map((m, i) => ({ ...m, joined_at: i === 0 ? '2019-04-02T10:11:12.123000+00:00' : undefined })),
        { user: { id: '900000000000000020', username: 'old-timer' }, roles: [], joined_at: '2016-01-05T00:00:00+00:00' },
        { user: { id: '900000000000000021', username: 'future' }, roles: [], joined_at: '2999-01-01T00:00:00+00:00' },
        { user: { id: '900000000000000022', username: 'pre-discord' }, roles: [], joined_at: '2010-01-01T00:00:00+00:00' },
    ];
    const { snapshot, images } = buildSnapshot(guild() as never, mockChannels() as never, { members: members() as never });
    const byId = new Map(snapshot.members.map(m => [m.id, m]));
    const body = snapshot.body as { roles: any[]; channels: any[] };
    const roleNum = (name: string) => body.roles.find(r => r.name === name).id;

    it('every member with a plausible Discord join day comes over with it (the UTC day), even with no role', () => {
        expect(byId.get(MOCK_MEMBER_SAM)).toMatchObject({ joined_at: '2019-04-02', nick: 'Sammy' });
        expect(byId.get('900000000000000020')).toEqual({ id: '900000000000000020', ref: expect.any(Number), roles: [], joined_at: '2016-01-05' });
        // Future / before Discord existed: no day, and nothing else to carry, so not sent at all.
        expect(byId.has('900000000000000021')).toBe(false);
        expect(byId.has('900000000000000022')).toBe(false);
        // Still no Discord id in the body.
        expect(JSON.stringify(body)).not.toMatch(/\d{15,}/);
    });

    it('role icons: pictures are remembered by snapshot role number (hash checked), emoji icons ride in the body', () => {
        expect(snapshot.roleIcons).toEqual([roleNum('Moderator')]);
        expect(images.roleIcons?.get(roleNum('Moderator'))).toEqual({ id: MOCK_ROLE_MOD, hash: 'abc123' });
        expect(images.roleIcons?.has(roleNum('Owner'))).toBe(false); // '../evil' is not a CDN hash
        expect(body.roles.find(r => r.name === 'Farmhand')).toMatchObject({ unicode_emoji: '\u{1F33E}' });
        expect(body.roles.find(r => r.name === 'Moderator')).toMatchObject({ colors: { primary_color: 15158332, secondary_color: 3447003 } });
    });

    it('stickers: PNG / APNG / GIF come over with Cipherline names (unique), description, tags; Lottie and locked ones are counted, never fetched', () => {
        const out = buildSnapshot(guild() as never, mockChannels() as never, { stickers: [
            { id: '800000000000000060', name: 'Wave Hello!', description: 'Hi there', tags: 'wave, Hello', format_type: 1 },
            { id: '800000000000000061', name: 'wave hello', tags: '👋', format_type: 2 },
            { id: '800000000000000062', name: 'Party', format_type: 4 },
            { id: '800000000000000063', name: 'Spinny', format_type: 3 },
            { id: '800000000000000064', name: 'Locked', format_type: 1, available: false },
            { id: 'not-an-id', name: 'x', format_type: 1 },
        ] as never });
        expect(out.snapshot.stickers).toEqual([
            { id: '800000000000000060', name: 'wave_hello', description: 'Hi there', tags: ['wave', 'hello'], animated: false },
            { id: '800000000000000061', name: 'wave_hello_2', tags: [], animated: true },
            { id: '800000000000000062', name: 'party', tags: [], animated: true },
        ]);
        expect([...out.images.stickers!]).toEqual([['800000000000000060', 'png'], ['800000000000000061', 'png'], ['800000000000000062', 'gif']]);
        const nm = out.snapshot.notMapped.map(n => n.item).join('\n');
        expect(nm).toMatch(/Stickers \(1 Lottie\)/);
        expect(nm).toMatch(/1 unavailable sticker/);
        expect(nm).not.toMatch(/Cipherline has no server stickers/);
        // An unreadable sticker list (403) is said, not fatal.
        expect(buildSnapshot(guild() as never, mockChannels() as never, { stickers: null }).snapshot.notMapped.some(n => /could not read the server's stickers/.test(n.reason))).toBe(true);
    });

    it('slowmode and age-restricted travel in the body for the API mapper', () => {
        const rules = body.channels.find(c => c.name === '\u{1F4DC}・rules');
        expect(rules).toMatchObject({ rate_limit_per_user: 10, nsfw: false });
    });

    it('over the people cap: role / nickname / overwrite people first, then the longest-standing members', () => {
        const many = Array.from({ length: 10_005 }, (_, i) => ({
            user: { id: String(910000000000000000n + BigInt(i)), username: `m${i}` }, roles: [], joined_at: `20${String(17 + (i % 9)).padStart(2, '0')}-01-01T00:00:00Z`,
        }));
        const out = buildSnapshot(guild() as never, mockChannels() as never, { members: [...many, ...(mockMembers() as never[])] as never });
        expect(out.snapshot.members).toHaveLength(10_000);
        const ids = new Set(out.snapshot.members.map(m => m.id));
        expect(ids.has(MOCK_MEMBER_SAM)).toBe(true);
        expect(ids.has(MOCK_MEMBER_ALEX)).toBe(true);
        expect(ids.has(MOCK_MEMBER_OVERWRITE)).toBe(true);
        const dropped = many.filter(m => !ids.has(m.user.id));
        expect(dropped.length).toBeGreaterThan(0);
        expect(dropped.every(m => m.joined_at >= '2025')).toBe(true); // the newest went
        expect(out.snapshot.notMapped.some(n => /member since/.test(n.item))).toBe(true);
    });
});

describe('channel source keys ("Copy messages from Discord" into an existing server)', () => {
    const read = async (guildId = MOCK_GUILD_ID) => {
        const client = new DiscordClient({ token: TOKEN, sleep: async () => undefined, fetchFn: routedFetch({
            [`/guilds/${guildId}`]: { ...mockGuild(), id: guildId },
            [`/guilds/${guildId}/channels`]: mockChannels(),
            [`/guilds/${guildId}/members?limit=1000&after=0`]: mockMembers(),
            [`/guilds/${guildId}/bans?limit=1000&after=0`]: mockBans(),
        }) });
        return (await fetchGuildSnapshot(client, guildId)).snapshot;
    };

    it('one per MESSAGE channel (text / announcement), hex SHA-256, stable across reads, never the Discord id', async () => {
        const a = await read();
        const b = await read();
        const body = a.body as { channels: Array<{ id: number; type: number }> };
        const messageNums = body.channels.filter(c => c.type === 0 || c.type === 5).map(c => c.id).sort((x, y) => x - y);
        expect(Object.keys(a.channelKeys).map(Number).sort((x, y) => x - y)).toEqual(messageNums);
        expect(messageNums.length).toBeGreaterThan(0);
        for (const k of Object.values(a.channelKeys)) expect(k).toMatch(/^[0-9a-f]{64}$/);
        expect(a.channelKeys).toEqual(b.channelKeys);
        const raw = mockChannels() as Array<{ id: string }>;
        const dump = JSON.stringify(a.channelKeys);
        for (const c of raw) expect(dump).not.toContain(c.id);
        expect(new Set(Object.values(a.channelKeys)).size).toBe(messageNums.length);
    });

    it('domain-separated per guild + channel (the same channel id in another guild is another key)', () => {
        expect(channelSourceKey('800000000000000001', '800000000000000010')).not.toBe(channelSourceKey('800000000000000002', '800000000000000010'));
        expect(channelSourceKey('800000000000000001', '800000000000000010')).toBe(channelSourceKey('800000000000000001', '800000000000000010'));
    });
});
