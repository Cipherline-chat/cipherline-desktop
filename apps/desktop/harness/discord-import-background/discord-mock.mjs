// Discord import, background pass (copied from discord-import-final, plus two LONG channels so an import takes a
// while: #general 4,000 messages from the last 30 days -> all 4,000; #slow-lane 2,500 messages all older than 30
// days -> the last 1,000 (the window rule). A LOOPBACK mock of what the user's own bot reads from Discord (REST v10 + CDN).
// The REAL Electron main process reaches it because harness/discord-import-background/main-redirect.cjs (NODE_OPTIONS
// --require, harness only) rewrites https://discord.com/api/v10 and https://cdn.discordapp.com to this server.
//   PORT=7992 node harness/discord-import-background/discord-mock.mjs        GET /__calls lists what was read
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.PORT ?? 7992);
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'harness-token-for-the-mock-only-0123456789'].join('.');
const sf = (n) => String(800000000000000000n + BigInt(n));
const G = sf(1);
const bit = (n) => 1 << n;
export const PEOPLE = { sam: '900000000000000001', alex: '900000000000000002', riley: '900000000000000005', spammer: '900000000000000066', bot: sf(900) };

function png(w, h, rgb) {
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const px = [0];
    for (let x = 0; x < w; x++) {
      const inCircle = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (w / 2.3) ** 2;
      px.push(inCircle ? rgb[0] : 250, inCircle ? Math.min(255, rgb[1] + Math.floor(y / 3)) : 250, inCircle ? rgb[2] : 250);
    }
    rows.push(Buffer.from(px));
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const CDN = {
  [`/icons/${G}/fa1234.png`]: png(256, 256, [60, 140, 80]),
  [`/role-icons/${sf(3)}/shield77.png`]: png(64, 64, [220, 60, 60]),
  [`/emojis/${sf(41)}.png`]: png(64, 64, [230, 170, 40]),
  // Guild stickers (media host, stickers/): a PNG and a "GIF" (served as image/gif; PNG bytes so it renders here).
  [`/stickers/${sf(60)}.png`]: png(240, 240, [40, 160, 220]),
  [`/stickers/${sf(62)}.gif`]: png(200, 160, [220, 90, 160]),
  // A sticker from ANOTHER server / Discord's own (not in this guild): attached as a picture.
  [`/stickers/700000000000000001.png`]: png(180, 180, [250, 200, 40]),
};
const GIF_TYPE = new Set([`/stickers/${sf(62)}.gif`]);

const guild = () => ({
  id: G, name: 'Pixel Farm Co-op', description: 'A made-up server for the import check',
  icon: 'fa1234', banner: null, splash: null, discovery_splash: null,
  verification_level: 1, default_message_notifications: 1, explicit_content_filter: 0,
  afk_channel_id: null, afk_timeout: 300, system_channel_id: sf(11), system_channel_flags: 0,
  preferred_locale: 'en-US', features: [], premium_tier: 2, premium_subscription_count: 7, vanity_url_code: null, rules_channel_id: sf(11),
  roles: [
    { id: G, name: '@everyone', permissions: String(bit(10) | bit(11) | bit(16) | bit(20) | bit(21)), position: 0, color: 0, hoist: false, managed: false, mentionable: false },
    // Farmhand: a unicode emoji icon and a gradient.
    { id: sf(2), name: 'Farmhand', permissions: String(bit(10) | bit(11) | bit(6)), position: 1, color: 0x2ecc71, colors: { primary_color: 0x2ecc71, secondary_color: 0x3498db, tertiary_color: null }, hoist: true, managed: false, mentionable: true, icon: null, unicode_emoji: '\u{1F33E}' },
    // Moderator: an icon PICTURE (CDN role-icons/) and a holographic style (three stops -> first two).
    { id: sf(3), name: 'Moderator', permissions: String(bit(1) | bit(13) | bit(28)), position: 3, color: 11127295, colors: { primary_color: 11127295, secondary_color: 16759788, tertiary_color: 16761760 }, hoist: true, managed: false, mentionable: true, icon: 'shield77', unicode_emoji: null },
    { id: sf(4), name: 'Elder', permissions: String(bit(10)), position: 2, color: 0xe67e22, hoist: false, managed: false, mentionable: false },
    { id: sf(5), name: 'Helper Bot', permissions: '8', position: 4, color: 0, hoist: false, managed: true, mentionable: false },
  ],
  emojis: [{ id: sf(41), name: 'Tractor', animated: false, managed: false, available: true }],
  stickers: [{ id: sf(50), name: 'wave' }],
});

const ow = (id, type, allow, deny) => ({ id, type, allow: String(allow), deny: String(deny) });
const channels = () => [
  { id: sf(10), type: 4, name: 'INFO', position: 0, parent_id: null, permission_overwrites: [] },
  { id: sf(11), type: 0, name: 'rules', position: 0, parent_id: sf(10), topic: 'Be kind', nsfw: false, rate_limit_per_user: 10, permission_overwrites: [ow(G, 0, 0, bit(11))] },
  { id: sf(12), type: 0, name: 'general', position: 1, parent_id: sf(10), topic: 'Say hi', nsfw: false, rate_limit_per_user: 0, permission_overwrites: [] },
  { id: sf(13), type: 0, name: 'slow-lane', position: 2, parent_id: sf(10), topic: 'One message a minute', nsfw: false, rate_limit_per_user: 60, permission_overwrites: [] },
  { id: sf(14), type: 0, name: 'after-dark', position: 3, parent_id: sf(10), topic: '18+ only', nsfw: true, rate_limit_per_user: 30, permission_overwrites: [] },
  { id: sf(15), type: 4, name: 'STAFF', position: 1, parent_id: null, permission_overwrites: [ow(G, 0, 0, bit(10)), ow(sf(3), 0, bit(10), 0)] },
  { id: sf(16), type: 0, name: 'mod-chat', position: 0, parent_id: sf(15), permission_overwrites: [ow(G, 0, 0, bit(10)), ow(sf(3), 0, bit(10), 0), ow(PEOPLE.riley, 1, bit(10) | bit(11), 0)] },
  { id: sf(17), type: 2, name: 'Barn', position: 2, parent_id: sf(10), user_limit: 8, permission_overwrites: [] },
];
const members = () => [
  { user: { id: PEOPLE.sam, username: 'samwise.k' }, roles: [sf(3), sf(2)], nick: 'Sammy', joined_at: '2019-04-02T17:20:11.512000+00:00' },
  { user: { id: PEOPLE.alex, username: 'alex_92' }, roles: [sf(2), sf(4)], nick: null, joined_at: '2020-06-15T08:00:00.000000+00:00' },
  { user: { id: PEOPLE.riley, username: 'riley' }, roles: [], nick: null, joined_at: '2016-01-05T12:00:00.000000+00:00' },
  { user: { id: PEOPLE.bot, username: 'Cipherline Importer', bot: true }, roles: [sf(5)], joined_at: '2026-11-21T00:00:00.000000+00:00' },
];
const bans = () => [{ user: { id: PEOPLE.spammer, username: 'spammer' }, reason: 'Spam links' }];
const stickers = () => [
  { id: sf(60), name: 'Wave Hello', description: 'A friendly wave', tags: 'wave', format_type: 1, available: true, guild_id: G },
  { id: sf(62), name: 'Party Time', description: '', tags: 'party,dance', format_type: 4, available: true, guild_id: G },
  { id: sf(63), name: 'Spinny', description: 'Lottie', tags: 'spin', format_type: 3, available: true, guild_id: G },
];
const who = { sam: { id: PEOPLE.sam, username: 'samwise.k', global_name: 'Sam', avatar: null, discriminator: '0' }, alex: { id: PEOPLE.alex, username: 'alex_92', global_name: 'Alex', avatar: null, discriminator: '0' }, riley: { id: PEOPLE.riley, username: 'riley', global_name: 'Riley Q', avatar: null, discriminator: '0' } };
const now = Date.now();
const msg = (n, by, content, minutesAgo, extra = {}) => ({ id: sf(1000 + n), type: 0, content, timestamp: new Date(now - minutesAgo * 60_000).toISOString(), author: who[by], mentions: [], attachments: [], embeds: [], ...extra });
const history = () => [
  msg(5, 'sam', '', 5, { sticker_items: [{ id: sf(63), name: 'Spinny', format_type: 3 }] }),
  msg(4, 'riley', '', 10, { sticker_items: [{ id: '700000000000000001', name: 'Sunny Day', format_type: 1 }] }),
  msg(3, 'alex', 'Party time at the barn!', 15, { sticker_items: [{ id: sf(62), name: 'Party Time', format_type: 4 }] }),
  msg(2, 'sam', '', 20, { sticker_items: [{ id: sf(60), name: 'Wave Hello', format_type: 1 }] }),
  msg(1, 'riley', 'Welcome to the new home of the co-op!', 30),
];

// Long channels, newest first like Discord. Ids grow with time so `before` paging works.
const BIG = Number(process.env.BIG_GENERAL ?? 4000);
const OLD = Number(process.env.OLD_SLOWLANE ?? 2500);
const longChannel = (base, n, newestMinutesAgo, stepMinutes, label) => {
  const out = [];
  const authors = ['sam', 'alex', 'riley'];
  for (let i = 0; i < n; i++) {
    // i = 0 is the NEWEST.
    out.push({ id: sf(base + (n - i)), type: 0, content: `${label} message ${n - i} of ${n}`, timestamp: new Date(now - (newestMinutesAgo + i * stepMinutes) * 60_000).toISOString(), author: who[authors[i % 3]], mentions: [], attachments: [], embeds: [] });
  }
  return out;
};
const GENERAL = [...history(), ...longChannel(2_000_000, BIG, 40, Number(process.env.STEP_MIN ?? 6), 'general')]; // 6 min apart: ~16.7 days for 4,000
const SLOW = longChannel(4_000_000, OLD, 45 * 24 * 60, 30, 'slow-lane');               // all older than 30 days
const page = (all, u) => {
  const before = u.searchParams.get('before');
  const limit = Number(u.searchParams.get('limit') ?? 50);
  const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
  return start <= 0 && before ? [] : all.slice(start, start + limit);
};
const calls = [];
const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === '/__calls') return json(res, 200, calls);
  if (req.method !== 'GET') { calls.push(`${req.method} ${u.pathname} REFUSED`); return json(res, 405, { message: 'mock: GET only' }); }
  if (u.pathname.startsWith('/cdn/')) {
    const p = u.pathname.slice(4);
    calls.push(`CDN ${p}`);
    const b = CDN[p];
    if (!b) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': GIF_TYPE.has(p) ? 'image/gif' : 'image/png', 'content-length': String(b.length) });
    return res.end(b);
  }
  if (!u.pathname.startsWith('/api/v10/')) return json(res, 404, { code: 0 });
  const path = u.pathname.slice('/api/v10'.length);
  calls.push(`GET ${path.replace(/\d{15,25}/g, ':id')}${req.headers.authorization === `Bot ${TOKEN}` ? '' : ' (bad token)'}`);
  if (req.headers.authorization !== `Bot ${TOKEN}`) return json(res, 401, { message: '401: Unauthorized', code: 0 });
  if (path === '/users/@me') return json(res, 200, { id: PEOPLE.bot, username: 'Cipherline Importer', bot: true });
  // Server Members Intent and Message Content Intent on (the _LIMITED flags): the history step runs for #general.
  if (path === '/oauth2/applications/@me') return json(res, 200, { id: PEOPLE.bot, name: 'Cipherline Importer', flags: (1 << 15) | (1 << 19), bot_public: true });
  if (path === '/users/@me/guilds') return json(res, 200, u.searchParams.get('after') ? [] : [{ id: G, name: 'Pixel Farm Co-op', owner: false, icon: 'fa1234', permissions: '8' }]);
  if (path === `/guilds/${G}`) return json(res, 200, guild());
  if (path === `/guilds/${G}/channels`) return json(res, 200, channels());
  if (path === `/guilds/${G}/members`) return json(res, 200, u.searchParams.get('after') === '0' ? members() : []);
  if (path === `/guilds/${G}/bans`) return json(res, 200, u.searchParams.get('after') === '0' ? bans() : []);
  if (path === `/guilds/${G}/stickers`) return json(res, 200, stickers());
  if (path === `/channels/${sf(12)}/messages/pins`) return json(res, 200, { items: [], has_more: false });
  // MOCK_DELAY_MS: a slower Discord (each history page waits), so an import runs long enough to work beside it.
  if (/^\/channels\/\d+\/messages$/.test(path) && Number(process.env.MOCK_DELAY_MS ?? 0) > 0) {
    const all = path === `/channels/${sf(12)}/messages` ? GENERAL : path === `/channels/${sf(13)}/messages` ? SLOW : [];
    return void setTimeout(() => json(res, 200, page(all, u)), Number(process.env.MOCK_DELAY_MS));
  }
  if (path === `/channels/${sf(12)}/messages`) return json(res, 200, page(GENERAL, u));
  if (path === `/channels/${sf(13)}/messages`) return json(res, 200, page(SLOW, u));
  if (/^\/channels\/\d+\/messages(\/pins)?$/.test(path)) return json(res, 200, path.endsWith('/pins') ? { items: [], has_more: false } : []);
  return json(res, 404, { message: 'Unknown', code: 10004 });
}).listen(PORT, '127.0.0.1', () => console.log(`mock discord bot api on http://127.0.0.1:${PORT}`));
