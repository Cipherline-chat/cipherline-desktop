// Discord CLAIMS real-app check, data setup against an ISOLATED local API (never the shared dev stack, staging or prod).
//   API=http://127.0.0.1:13105/v1 API_LOG=<api log> PG=<pg container> PGDB=<db> MOCK=http://127.0.0.1:7999 \
//     node harness/discord-claims-setup.mjs > <out.json>
// Creates three TEST accounts (importer, sam, alex), a server with #general and #announcements, and posts
// imported history through the REAL import routes (authors Alex, Sam, Riley; rows sealed with a harness AES-GCM key
// that the page uses to decrypt; the API only ever sees ciphertext). Then "alex" links Discord through the REAL
// OAuth flow (mock provider, cookie binding, PKCE) and a SECOND import auto-claims his messages (D28).
// "sam" is left unlinked: the harness page drives his link + claim through the UI.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const API = process.env.API ?? 'http://127.0.0.1:13105/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:7999';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK)) throw new Error('loopback mock only');
const LOG = process.env.API_LOG; const PG = process.env.PG ?? 'cl-claims-pg'; const PGDB = process.env.PGDB ?? 'clclaims';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
const DISCORD = { alex: '900000000000000001', sam: '900000000000000002', riley: '900000000000000003' };

async function api(method, route, { token, body, ok = [200, 201, 204] } = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!ok.includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
}
async function code(email) {
  for (let i = 0; i < 60; i++) {
    const blocks = fs.readFileSync(LOG, 'utf8').split('┌─ Email to ').slice(1).filter((b) => b.startsWith(email));
    const m = blocks.length && blocks[blocks.length - 1].match(/\b(\d{6})\b/);
    if (m) return m[1];
    await sleep(500);
  }
  throw new Error(`no code for ${email}`);
}
async function account(name) {
  const email = `${name}-x${crypto.randomBytes(3).toString("hex")}@claims.invalid`; // "x": a hex suffix of six digits would read as the code
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

const key = crypto.getRandomValues(new Uint8Array(32));
const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
async function seal(content) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(content))));
  return { nonce_b64: Buffer.from(iv).toString('base64'), ciphertext_b64: Buffer.from(ct).toString('base64'), signature_b64: crypto.randomBytes(64).toString('base64') };
}

/** One import of `rows` ([who, text, minutesAgo]) into channel `cid` through the REAL routes. */
async function runImport(importer, sid, cid, rows) {
  const s = await api('POST', `/servers/${sid}/imports`, { token: importer.token, body: { source: 'discord', consent_version: '2026-11-21', channel_ids: [cid], declared_rows: rows.length, declared_attachment_bytes: 0 } });
  const people = [...new Set(rows.map((r) => r[0]))];
  const { author_ids } = await api('POST', `/servers/${sid}/imports/${s.id}/authors`, { token: importer.token, body: { authors: people.map((p) => ({ discord_user_id: DISCORD[p], kind: 'user' })) } });
  const ref = Object.fromEntries(people.map((p, i) => [p, author_ids[i]]));
  const NAMES = { alex: ['Alex', 'alex_92'], sam: ['Sam', 'samwise.k'], riley: ['Riley Q', 'riley'] };
  const sealed = [];
  for (const [who, text, ago] of rows) {
    const content = { client_msg_id: crypto.randomUUID(), type: 'text', text,
      imported_from: { v: 1, source: 'discord', author_ref: ref[who], kind: 'user', name: NAMES[who][0], username: NAMES[who][1], original_ts: new Date(Date.now() - ago * 60_000).toISOString() } };
    sealed.push({ ...(await seal(content)), author_ref: ref[who] });
  }
  await api('POST', `/servers/${sid}/imports/${s.id}/messages`, { token: importer.token, body: { channel_id: cid, sender_device_id: importer.device_id, epoch: 1, seq_start: 0, rows: sealed } });
  await api('POST', `/servers/${sid}/imports/${s.id}/complete`, { token: importer.token });
  return { import_id: s.id, refs: ref };
}

/** The REAL link flow over HTTP, as a browser would do it (start page cookie, mock consent, callback). */
async function linkDiscord(user, discordId, discordName) {
  await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id: discordId, username: discordName }) });
  const { url } = await api('POST', '/discord/link', { token: user.token });
  const start = new URL(url); // https://127.0.0.1:<tls>/... ; talk to the API directly over loopback http
  const apiOrigin = new URL(API).origin;
  const r1 = await fetch(apiOrigin + start.pathname + start.search, { redirect: 'manual' });
  const cookie = (r1.headers.get('set-cookie') ?? '').split(';')[0];
  const html = await r1.text();
  const unesc = (s) => s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  const href = unesc(html.match(/href="(http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize[^"]+)"/)[1]);
  const page = await (await fetch(href)).text();
  const approve = unesc(page.match(/id="approve"[^>]*href="([^"]+)"/)[1]);
  const r2 = await fetch(MOCK + approve, { redirect: 'manual' });
  const cb = new URL(r2.headers.get('location'));
  const r3 = await fetch(apiOrigin + cb.pathname + cb.search, { headers: { cookie } });
  const text = await r3.text();
  if (r3.status !== 200 || !text.includes('Discord linked')) throw new Error(`link failed: ${r3.status}`);
}

const importer = await account('importer');
const sam = await account('sam');
const alex = await account('alex');
psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now()) WHERE user_id IN ('${importer.user_id}','${sam.user_id}','${alex.user_id}')`);
psql(`UPDATE devices SET is_approved = true WHERE device_id IN ('${importer.device_id}','${sam.device_id}','${alex.device_id}')`);

const srv = await api('POST', '/servers', { token: importer.token, body: { name: 'Pixel Farm Co-op' } });
const sid = srv.server_id ?? srv.id ?? srv.server?.server_id;
const chans = await api('GET', `/servers/${sid}/channels`, { token: importer.token });
const list = Array.isArray(chans) ? chans : (chans.channels ?? []);
let general = list.find((c) => c.kind === 'text');
if (!general) general = await api('POST', `/servers/${sid}/channels`, { token: importer.token, body: { name: 'general', kind: 'text' } });
const ann = await api('POST', `/servers/${sid}/channels`, { token: importer.token, body: { name: 'announcements', kind: 'text' } });
const gid = general.channel_id; const aid = ann.channel_id ?? ann.channel?.channel_id;
for (const cid of [gid, aid]) await api('POST', `/channels/${cid}/epoch`, { token: importer.token, body: { epoch: 1, rotation_reason: 'create' } });
const inv = await api('POST', `/servers/${sid}/invites`, { token: importer.token, body: {} });
for (const u of [sam, alex]) await api('POST', `/invites/${inv.code ?? inv.invite?.code}/accept`, { token: u.token, body: {} });

const first = await runImport(importer, sid, gid, [
  ['alex', 'Welcome to the co-op! Be kind, share seeds.', 60 * 24 * 3],
  ['sam', 'Harvest went great this year, really great.', 60 * 24 * 2],
  ['riley', 'Nice! Those pumpkins are huge.', 60 * 24 * 2 - 10],
  ['sam', 'Thanks! Bringing some to the market on Saturday.', 60 * 24 * 2 - 20],
  ['alex', 'See you all at the market.', 60],
  ['sam', 'Count me in for the seed swap too.', 30],
]);
// alex proves his Discord account BEFORE the next import: it then auto-claims him (D28).
await linkDiscord(alex, DISCORD.alex, 'alex_92');
const second = await runImport(importer, sid, aid, [
  ['alex', 'Market moves to the barn next week.', 60 * 24],
  ['riley', 'Noted, thanks Alex.', 60 * 24 - 5],
]);
await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id: DISCORD.sam, username: 'samwise.k' }) });
process.stdout.write(JSON.stringify({
  api: API, key_b64: Buffer.from(key).toString('base64'), server_id: sid, server_name: 'Pixel Farm Co-op',
  channels: { general: gid, announcements: aid }, importer, sam, alex, imports: [first, second],
}, null, 1));
