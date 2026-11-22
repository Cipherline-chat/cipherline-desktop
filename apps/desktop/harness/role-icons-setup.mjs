// ROLE ICONS real-app check, data setup against an ISOLATED local API (never the shared dev stack, staging or prod).
//   API=http://127.0.0.1:13931/v1 API_LOG=<api log> PG=<pg container> PGDB=<db> node harness/role-icons-setup.mjs > <out.json>
// Creates TEST accounts (maya = owner, riley, ari, sam, jules), a server, and roles through the REAL routes:
//   Moderators  gradient (teal -> blurple) + an UPLOADED image icon (encrypted client-side, PUT to MinIO, then
//               PUT /roles/:rid/icon: the API decrypts, resizes to 128px, re-encrypts under a fresh key)
//   Artists     gradient (gold -> pink) + emoji icon via PATCH { icon_emoji }
//   VIP         solid purple + emoji icon set at CREATE (the field the Discord importer will use)
// Then a handful of live negative checks (hierarchy / validation / foreign upload) and a DB read-back.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API ?? 'http://127.0.0.1:13931/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const LOG = process.env.API_LOG; const PG = process.env.PG ?? 'cl-ricon-pg'; const PGDB = process.env.PGDB ?? 'ricon';
const PGUSER = process.env.PGUSER ?? 'ricon';
const here = path.dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(path.resolve(here, '../../api/package.json'))('sharp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', PGUSER, '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); if (!ok) process.stderr.write(`CHECK FAILED: ${name} ${detail}\n`); };

async function api(method, route, { token, body, ok = [200, 201, 204] } = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!ok.includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${t.slice(0, 300)}`);
  return { status: r.status, body: j };
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
  const email = `${name}-x${crypto.randomBytes(3).toString('hex')}@roleicons.invalid`;
  const password = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + '!7a';
  await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
  const v = (await api('POST', '/auth/verify-email', { body: { email, code: await code(email) } })).body;
  const f = (await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } })).body;
  const token = f.access_token ?? f.token;
  const me = (await api('GET', '/auth/me', { token })).body;
  const u = me.user ?? me;
  const d = (await api('POST', '/devices/register', { token, body: { device_name: `${name}-harness`, platform: 'linux' } })).body;
  return { name, user_id: u.user_id ?? u.id, token, device_id: d.device_id ?? d.device?.device_id ?? d.id };
}

/** A role-icon image the way the desktop uploads one: AES-256-GCM client-side, then the presigned PUT. */
async function uploadIcon(token, sid, png) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, png));
  const init = (await api('POST', '/attachments/initiate', { token, body: { server_id: sid, purpose: 'role_icon', size_bytes: ct.length, mime_type: 'image/png' } })).body;
  const put = await fetch(init.upload_url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: ct });
  if (!put.ok) throw new Error(`MinIO PUT ${put.status}`);
  return { attachment_id: init.attachment_id, key_b64: Buffer.from(key).toString('base64'), nonce_b64: Buffer.from(iv).toString('base64') };
}

// A 512px shield, so the API's resize to 128px is real work.
const shieldSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#25e0c8"/><stop offset="1" stop-color="#5865f2"/></linearGradient></defs>
  <path d="M32 4 L56 12 V30 C56 45 45 56 32 60 C19 56 8 45 8 30 V12 Z" fill="url(#g)"/>
  <path d="M22 32 l7 7 l14 -15" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const shieldPng = new Uint8Array(await sharp(Buffer.from(shieldSvg)).png().toBuffer());

const maya = await account('maya');
const riley = await account('riley');
const ari = await account('ari');
const sam = await account('sam');
const jules = await account('jules');
const everyone = [maya, riley, ari, sam, jules];
psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now()) WHERE user_id IN (${everyone.map((u) => `'${u.user_id}'`).join(',')})`);
psql(`UPDATE devices SET is_approved = true WHERE device_id IN (${everyone.map((u) => `'${u.device_id}'`).join(',')})`);

const srv = (await api('POST', '/servers', { token: maya.token, body: { name: 'Maker Collective' } })).body;
const sid = srv.server_id ?? srv.id ?? srv.server?.server_id;
const chans = (await api('GET', `/servers/${sid}/channels`, { token: maya.token })).body;
const general = (Array.isArray(chans) ? chans : (chans.channels ?? [])).find((c) => c.kind === 'text');
const inv = (await api('POST', `/servers/${sid}/invites`, { token: maya.token, body: {} })).body;
for (const u of [riley, ari, sam, jules]) await api('POST', `/invites/${inv.code ?? inv.invite?.code}/accept`, { token: u.token, body: {} });

const create = async (body) => (await api('POST', `/servers/${sid}/roles`, { token: maya.token, body })).body;
const vip = await create({ name: 'VIP', color: 0xa855f7, icon_emoji: '💎', hoisted: false });
const artists = await create({ name: 'Artists', color: 0xf5a623, hoisted: true });
const mods = await create({ name: 'Moderators', color: 0x25e0c8, secondary_color: 0x5865f2, hoisted: true, permissions: '8' /* MANAGE_ROLES */ });
// The owner creates every role at the same default position; set an explicit hierarchy.
for (const [r, pos] of [[mods, 3000], [artists, 2000], [vip, 1000]]) await api('PATCH', `/servers/${sid}/roles/${r.role_id}`, { token: maya.token, body: { position: pos } });
check('create carries icon_emoji (importer field)', vip.icon_emoji === '💎', JSON.stringify(vip));
check('create carries secondary_color', mods.secondary_color === 0x5865f2);

// Artists: gradient + emoji through PATCH (what the role editor sends).
const art2 = (await api('PATCH', `/servers/${sid}/roles/${artists.role_id}`, { token: maya.token, body: { secondary_color: 0xec4899, icon_emoji: '🎨' } })).body;
check('PATCH sets secondary_color + icon_emoji', art2.secondary_color === 0xec4899 && art2.icon_emoji === '🎨');

// Moderators: the uploaded image icon through the real processing route.
const up = await uploadIcon(maya.token, sid, shieldPng);
const modsIcon = (await api('PUT', `/servers/${sid}/roles/${mods.role_id}/icon`, { token: maya.token, body: up })).body;
check('PUT icon stores the attachment', modsIcon.icon_attachment_id === up.attachment_id && modsIcon.icon_emoji === null);
check('PUT icon stores a FRESH server key, never the client upload key', !!modsIcon.icon_key_b64 && modsIcon.icon_key_b64 !== up.key_b64);
const att = psql(`SELECT object_key || '|' || size_bytes || '|' || mime_type FROM attachments WHERE attachment_id = '${up.attachment_id}'`);
check('processed object is under role_icons/<sid>/ and shrank', att.startsWith(`role_icons/${sid}/${up.attachment_id}|`) && Number(att.split('|')[1]) < shieldPng.length + 16, att);

// The member-facing batch download route signs it for a plain member (not for a stranger).
const dl = (await api('POST', '/attachments/emoji-downloads', { token: jules.token, body: { server_id: sid, attachment_ids: [up.attachment_id] } })).body;
check('a member can get the icon download URL', dl.urls?.length === 1);
const blob = new Uint8Array(await (await fetch(dl.urls[0].download_url)).arrayBuffer());
const k2 = await crypto.subtle.importKey('raw', Buffer.from(modsIcon.icon_key_b64, 'base64'), 'AES-GCM', false, ['decrypt']);
const plain = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(modsIcon.icon_nonce_b64, 'base64') }, k2, blob));
const meta = await sharp(plain).metadata();
check('stored icon decrypts with the row key and is 128x128', meta.width === 128 && meta.height === 128, `${meta.format} ${meta.width}x${meta.height}`);

// Assignments: riley = Moderators + VIP, ari = Artists + VIP, sam = Moderators, jules = none.
const assign = (u, r) => api('PUT', `/servers/${sid}/members/${u.user_id}/roles/${r.role_id}`, { token: maya.token });
await assign(riley, mods); await assign(riley, vip); await assign(ari, artists); await assign(ari, vip); await assign(sam, mods);

// Live negatives.
const neg = async (label, method, route, token, body, want) => {
  const r = await api(method, route, { token, body, ok: [want, 200, 201, 204, 400, 403, 404, 429] });
  check(label, r.status === want, `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
};
await neg('no MANAGE_ROLES -> 403 on PATCH icon_emoji', 'PATCH', `/servers/${sid}/roles/${vip.role_id}`, jules.token, { icon_emoji: '🔥' }, 403);
await neg('no MANAGE_ROLES -> 403 on DELETE icon', 'DELETE', `/servers/${sid}/roles/${vip.role_id}/icon`, jules.token, undefined, 403);
// sam holds Moderators (MANAGE_ROLES) but cannot touch Moderators itself (hierarchy).
await neg('hierarchy: a mod cannot set the icon of their own top role', 'PATCH', `/servers/${sid}/roles/${mods.role_id}`, sam.token, { icon_emoji: '🔥' }, 403);
await neg('two emojis -> 400', 'PATCH', `/servers/${sid}/roles/${vip.role_id}`, maya.token, { icon_emoji: '🔥🔥' }, 400);
await neg('text -> 400', 'PATCH', `/servers/${sid}/roles/${vip.role_id}`, maya.token, { icon_emoji: 'ab' }, 400);
await neg('secondary_color out of range -> 400', 'PATCH', `/servers/${sid}/roles/${vip.role_id}`, maya.token, { secondary_color: 0x1000000 }, 400);
await neg('re-using a live icon upload -> 400', 'PUT', `/servers/${sid}/roles/${vip.role_id}/icon`, maya.token, up, 400);
await neg('role_icon upload without MANAGE_ROLES -> 403', 'POST', '/attachments/initiate', jules.token, { server_id: sid, purpose: 'role_icon', size_bytes: 100, mime_type: 'image/png' }, 403);
const everyoneRole = (await api('GET', `/servers/${sid}/roles`, { token: maya.token })).body.find((r) => r.is_everyone);
await neg('@everyone cannot have an icon', 'PATCH', `/servers/${sid}/roles/${everyoneRole.role_id}`, maya.token, { icon_emoji: '🔥' }, 400);
const audit = psql(`SELECT count(*) FROM audit_log_entries WHERE server_id = '${sid}' AND action = 'role.update' AND data_jsonb::text LIKE '%icon%'`);
check('icon changes are in the audit log', Number(audit) >= 2, `rows=${audit}`);

process.stdout.write(JSON.stringify({
  api: API, server_id: sid, server_name: 'Maker Collective', channels: { general: general?.channel_id },
  roles: { mods: mods.role_id, artists: artists.role_id, vip: vip.role_id }, icon_attachment_id: up.attachment_id,
  maya, riley, ari, sam, jules, checks,
}, null, 1));
