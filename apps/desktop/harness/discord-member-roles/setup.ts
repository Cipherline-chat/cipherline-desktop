/* eslint-disable -- harness, not shipped */
/**
 * Discord import: members' roles, per-member channel permissions, nicknames,
 * bans and reactions, END TO END against an ISOLATED local API (api.sh) and a
 * MOCK Discord, using the REAL desktop code paths (bundled by bundle.mjs):
 *
 *   main process   fetchGuildSnapshot (guild, channels, members, bans),
 *                  fetchChannelWindow / fetchChannelPins / fetchReactors
 *   renderer       runStructureImport (members + bans posted with import-guild),
 *                  runHistoryImport (authors + reactors registered, reactions in
 *                  the encrypted block)
 *   API            the real routes: import-guild, imports/*, invites, Discord
 *                  OAuth link (mock provider), claims
 *
 * Accounts are made through the real register flow (codes read from the API
 * log). Rows are sealed with a harness AES-GCM key (the page opens them with
 * it); the API sees ciphertext only. Prints the page's JSON config.
 *
 *   API=http://127.0.0.1:13117/v1 API_LOG=<log> MOCK=http://127.0.0.1:7998 PG=cl-mr-pg PGDB=clmr node out/setup.cjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DiscordClient, type FetchLike } from '@elec/discord-import/discord-client';
import { fetchGuildSnapshot } from '@elec/discord-import/snapshot';
import { fetchChannelPins, fetchChannelWindow, fetchReactors } from '@elec/discord-import/history';
import { MOCK_GUILD_ID, mockBans, mockChannels, mockGuild, mockMembers } from '@elec/discord-import/__fixtures__/mock-guild';
import { newRunState, runStructureImport } from '@desk/utils/discordImport/runner';
import { newHistoryState, runHistoryImport } from '@desk/utils/discordImport/history/runner';

const API = process.env.API ?? 'http://127.0.0.1:13117/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:7998';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK)) throw new Error('loopback mock only');
const LOG = process.env.API_LOG!;
const PG = process.env.PG ?? 'cl-mr-pg'; const PGDB = process.env.PGDB ?? 'clmr';
if (!/^cl-mr-/.test(PG)) throw new Error('isolated DB only');
const psql = (sql: string) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The Discord people (mock): sam = Moderator + Farmhand, nickname "Sammy", and a member
// overwrite on #mod-chat; alex = Farmhand; riley = posts but has no role; spammer = banned.
const D = { sam: '900000000000000001', alex: '900000000000000002', riley: '900000000000000005', spammer: '900000000000000066' };
const sf = (n: number) => String(800000000000000000n + BigInt(n));
const GENERAL = sf(18);

async function api(method: string, route: string, o: { token?: string; body?: unknown; ok?: number[] } = {}) {
    const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
    const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; }
    if (!(o.ok ?? [200, 201, 204]).includes(r.status)) { const e: any = new Error(`${method} ${route} -> ${r.status} ${t.slice(0, 300)}`); e.response = { status: r.status, data: j }; throw e; }
    return j;
}
async function code(email: string) {
    for (let i = 0; i < 120; i++) {
        const blocks = fs.readFileSync(LOG, 'utf8').split('┌─ Email to ').slice(1).filter(b => b.startsWith(email));
        const m = blocks.length && blocks[blocks.length - 1].match(/\b(\d{6})\b/);
        if (m) return m[1];
        await sleep(500);
    }
    throw new Error(`no code for ${email}`);
}
async function account(name: string) {
    const email = `${name}-x${crypto.randomBytes(3).toString('hex')}@roles.invalid`;
    const password = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + '!7a';
    await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
    const v = await api('POST', '/auth/verify-email', { body: { email, code: await code(email) } });
    const f = await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } });
    const token = f.access_token ?? f.token;
    const me = await api('GET', '/auth/me', { token });
    const u = me.user ?? me;
    const d = await api('POST', '/devices/register', { token, body: { device_name: `${name}-harness`, platform: 'linux' } });
    return { name, user_id: u.user_id ?? u.id, token, device_id: d.device_id ?? d.device?.device_id ?? d.id };
}
/** The REAL link flow over HTTP (start page cookie, mock consent, callback), as in discord-claims-setup.mjs. */
async function linkDiscord(token: string, discordId: string, username: string) {
    await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id: discordId, username }) });
    const { url } = await api('POST', '/discord/link', { token });
    const start = new URL(url);
    const origin = new URL(API).origin;
    const r1 = await fetch(origin + start.pathname + start.search, { redirect: 'manual' });
    const cookie = (r1.headers.get('set-cookie') ?? '').split(';')[0];
    const html = await r1.text();
    const unesc = (s: string) => s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
    const href = unesc(html.match(/href="(http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize[^"]+)"/)![1]);
    const page = await (await fetch(href)).text();
    const approve = unesc(page.match(/id="approve"[^>]*href="([^"]+)"/)![1]);
    const r2 = await fetch(MOCK + approve, { redirect: 'manual' });
    const cb = new URL(r2.headers.get('location')!);
    const r3 = await fetch(origin + cb.pathname + cb.search, { headers: { cookie } });
    if (r3.status !== 200 || !(await r3.text()).includes('Discord linked')) throw new Error(`link failed: ${r3.status}`);
}

// ── The mock Discord REST (what the user's own bot would read) ───────────
const user = (id: string, username: string, global_name: string) => ({ id, username, global_name, avatar: null, discriminator: '0' });
const PEOPLE = { sam: user(D.sam, 'samwise.k', 'Sam'), alex: user(D.alex, 'alex_92', 'Alex'), riley: user(D.riley, 'riley', 'Riley Q') };
const channels = mockChannels() as any[];
channels.find(c => c.name === 'mod-chat').permission_overwrites.push({ id: D.sam, type: 1, allow: String(1 << 11), deny: '0' }); // sam may post in #mod-chat
const members = [
    { user: { id: D.sam, username: 'samwise.k' }, roles: [sf(3), sf(2)], nick: 'Sammy' },
    { user: { id: D.alex, username: 'alex_92' }, roles: [sf(2)] },
    ...mockMembers().filter(m => ![D.sam, D.alex].includes(m.user.id)),
];
const bans = [...mockBans()];
const now = Date.now();
const msg = (n: number, who: keyof typeof PEOPLE, text: string, minutesAgo: number, reactions?: unknown) => ({
    id: sf(1000 + n), type: 0, content: text, timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    author: PEOPLE[who], mentions: [], attachments: [], embeds: [], ...(reactions ? { reactions } : {}),
});
const history = [
    msg(5, 'sam', 'Seed swap is on for Saturday, bring labels!', 30, [{ count: 2, emoji: { id: null, name: '🎉' } }, { count: 1, emoji: { id: sf(40), name: 'party_parrot', animated: true } }]),
    msg(4, 'riley', 'Can someone hold a table for me?', 50, [{ count: 7, emoji: { id: null, name: '👍' } }]),
    msg(3, 'alex', 'Welcome everyone to the new home of the co-op.', 120),
];
const reactors: Record<string, any[]> = {
    [`${sf(1005)}|🎉`]: [PEOPLE.alex, PEOPLE.sam],
    [`${sf(1005)}|party_parrot:${sf(40)}`]: [PEOPLE.riley],
    [`${sf(1004)}|👍`]: [PEOPLE.sam, PEOPLE.alex],
};
const discordCalls: string[] = [];
const discordFetch: FetchLike = async (url) => {
    const path = decodeURIComponent(url.replace('https://discord.com/api/v10', ''));
    discordCalls.push(path.split('?')[0].replace(/\d{15,25}/g, ':id'));
    let body: unknown = null; let status = 200;
    if (path === `/guilds/${MOCK_GUILD_ID}`) body = mockGuild();
    else if (path === `/guilds/${MOCK_GUILD_ID}/channels`) body = channels;
    else if (path.startsWith(`/guilds/${MOCK_GUILD_ID}/members?`)) body = path.includes('after=0') ? members : [];
    else if (path.startsWith(`/guilds/${MOCK_GUILD_ID}/bans?`)) body = path.includes('after=0') ? bans : [];
    else if (path.startsWith(`/channels/${GENERAL}/messages/pins`)) body = { items: [], has_more: false };
    else if (path.startsWith(`/channels/${GENERAL}/messages/`) && path.includes('/reactions/')) {
        const m = path.match(/messages\/(\d+)\/reactions\/([^?]+)/)!;
        body = reactors[`${m[1]}|${m[2]}`] ?? [];
    } else if (path.startsWith(`/channels/${GENERAL}/messages`)) body = path.includes('before=') ? [] : history;
    else status = 404;
    return { status, headers: { get: () => null }, json: async () => body ?? { code: 10004 }, arrayBuffer: async () => new ArrayBuffer(0) };
};
const discord = new DiscordClient({ token: ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'), fetchFn: discordFetch, sleep: async () => undefined });

// ── Run ──────────────────────────────────────────────────────────────────
const importer = await account('importer');
const sam = await account('sam');
const alex = await account('alex');
const spammer = await account('spammer');
psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now())`);
psql(`UPDATE devices SET is_approved = true`);

// alex links BEFORE the import (auto-claim on): the import claims him; not a member yet -> nothing given until he joins.
await linkDiscord(alex.token, D.alex, 'alex_92');

// 1. The REAL snapshot (members + bans) and the REAL structure runner -> import-guild.
const { snapshot, images } = await fetchGuildSnapshot(discord, MOCK_GUILD_ID);
const report = await runStructureImport({
    fetchImage: async () => ({ ok: false, message: 'not in this harness' }),
    prepareImage: async (b) => ({ blob: b, mime: 'image/png' }),
    upload: async () => { throw new Error('no uploads in this harness'); },
    importGuild: (req) => api('POST', '/server-templates/discord/import-guild', { token: importer.token, body: req }),
    listEmojiNames: async () => [],
    createEmoji: async () => undefined,
}, { snapshot, serverName: 'Pixel Farm Co-op', description: null, includeImages: false, includeEmojis: false }, newRunState(), () => {}, new AbortController().signal);
const sid = report.serverId;

// 2. Channel keys (epoch 1) for the text channels, then the REAL history runner for #general.
const chans: any[] = await api('GET', `/servers/${sid}/channels`, { token: importer.token }).then((r: any) => Array.isArray(r) ? r : r.channels ?? []);
for (const c of chans.filter(c => c.kind === 'text')) await api('POST', `/channels/${c.channel_id}/epoch`, { token: importer.token, body: { epoch: 1, rotation_reason: 'create' } });
const generalId = chans.find(c => c.name === 'general')!.channel_id;
const modChatId = chans.find(c => c.name === 'mod-chat')?.channel_id ?? null;
const key = crypto.getRandomValues(new Uint8Array(32));
const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
const media = new Map();
const generalNum = [...(images.channels ?? new Map())].find(([, v]) => v.id === GENERAL)![0];
let reactionRequests = 0;
const hist = await runHistoryImport({
    api: {
        createSession: (b) => api('POST', `/servers/${sid}/imports`, { token: importer.token, body: b }),
        registerAuthors: (iid, authors) => api('POST', `/servers/${sid}/imports/${iid}/authors`, { token: importer.token, body: { authors } }),
        postBatch: (iid, b) => api('POST', `/servers/${sid}/imports/${iid}/messages`, { token: importer.token, body: b }),
        initiateFiles: async () => [],
        save: (iid, b) => api('POST', `/servers/${sid}/imports/${iid}/save`, { token: importer.token, body: b }),
        complete: (iid) => api('POST', `/servers/${sid}/imports/${iid}/complete`, { token: importer.token }),
    },
    readChannel: async (n) => {
        if (n !== generalNum) throw new Error('only #general in this harness');
        const win = await fetchChannelWindow(discord, GENERAL, media);
        const pins = await fetchChannelPins(discord, GENERAL, media);
        reactionRequests = await fetchReactors(discord, GENERAL, [...win.messages, ...pins]);
        return { messages: win.messages, pins, truncated: win.truncated, ceilingHit: win.ceilingHit, reactionRequests, names: { roles: {}, channels: {} } };
    },
    fetchMedia: async () => ({ ok: false, code: 'none', message: 'none' }),
    encryptFile: async () => { throw new Error('no files'); },
    upload: async () => undefined,
    sealRow: async (json) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(json)));
        return { epoch: 1, nonce_b64: Buffer.from(iv).toString('base64'), ciphertext_b64: Buffer.from(ct).toString('base64'), signature_b64: crypto.randomBytes(64).toString('base64') };
    },
    deviceId: importer.device_id, maxFileBytes: 25 * 1024 * 1024,
}, { serverId: sid, channels: [{ channel: generalNum, channelId: generalId, name: 'general' }], convert: { emojiIds: {} } }, newHistoryState(), () => {}, new AbortController().signal);

// 3. Invite. alex joins (gets Farmhand on JOIN). sam joins, then links (claims in the UI). spammer links, then is refused.
const inv = await api('POST', `/servers/${sid}/invites`, { token: importer.token, body: {} });
const invCode = inv.code ?? inv.invite?.code;
await api('POST', `/invites/${invCode}/accept`, { token: alex.token, body: {} });
await api('POST', `/invites/${invCode}/accept`, { token: sam.token, body: {} });
await linkDiscord(sam.token, D.sam, 'samwise.k');
await linkDiscord(spammer.token, D.spammer, 'spammer');
let spammerJoin = 'joined';
try { await api('POST', `/invites/${invCode}/accept`, { token: spammer.token, body: {} }); } catch (e: any) { spammerJoin = `refused ${e.response?.status}: ${e.response?.data?.message ?? ''}`; }
await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id: D.sam, username: 'samwise.k' }) });

process.stdout.write(JSON.stringify({
    api: API, key_b64: Buffer.from(key).toString('base64'), server_id: sid, server_name: 'Pixel Farm Co-op',
    channels: { general: generalId, mod_chat: modChatId }, import_id: hist.importId,
    importer, sam, alex, spammer, spammerJoin, report: { notes: report.notes, people: report.people },
    history: { messages: hist.reports[0]?.messages, rows: hist.reports[0]?.rows, reactionsSkipped: hist.reports[0]?.reactionsSkipped, error: hist.reports[0]?.error },
    snapshotCounts: snapshot.counts, reactionRequests, discordCalls: [...new Set(discordCalls)],
}, null, 1));
