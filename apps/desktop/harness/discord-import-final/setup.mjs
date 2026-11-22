// Discord import final pass, real-app check: API-side steps around the two REAL Electron runs.
//   accounts   register the importer and sam through the real register flow (codes from the API log)
//   join       importer makes an invite; sam joins; sam links his Discord account (real link flow, mock OAuth)
// Loopback only; the isolated DB only.
//   API=http://127.0.0.1:13151/v1 API_LOG=<log> MOCK=http://127.0.0.1:7981 STATE=<json> node setup.mjs accounts|join
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = process.env.API ?? 'http://127.0.0.1:13151/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:7981';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK)) throw new Error('loopback mock only');
const LOG = process.env.API_LOG;
const STATE = process.env.STATE;
const PG = 'cl-dif-pg'; const PGDB = 'clif';
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAM_DISCORD = '900000000000000001';

async function api(method, route, o = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!(o.ok ?? [200, 201, 204]).includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
}
async function code(email) {
  for (let i = 0; i < 120; i++) {
    const blocks = fs.readFileSync(LOG, 'utf8').split('┌─ Email to ').slice(1).filter((b) => b.startsWith(email));
    const m = blocks.length && blocks[blocks.length - 1].match(/\b(\d{6})\b/);
    if (m) return m[1];
    await sleep(500);
  }
  throw new Error(`no code for ${email}`);
}
async function account(name) {
  const email = `${name}@final.invalid`;
  const password = `Harvest-${crypto.randomBytes(6).toString('hex')}-Moon!7`;
  await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
  const v = await api('POST', '/auth/verify-email', { body: { email, code: await code(email) } });
  const f = await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } });
  const token = f.access_token ?? f.token;
  const me = await api('GET', '/auth/me', { token });
  const u = me.user ?? me;
  return { name, email, password, user_id: u.user_id ?? u.id, token };
}
async function linkDiscord(token, discordId, username) {
  await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id: discordId, username }) });
  const { url } = await api('POST', '/discord/link', { token });
  const start = new URL(url);
  const origin = new URL(API).origin;
  const r1 = await fetch(origin + start.pathname + start.search, { redirect: 'manual' });
  const cookie = (r1.headers.get('set-cookie') ?? '').split(';')[0];
  const html = await r1.text();
  const unesc = (s) => s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  const href = unesc(html.match(/href="(http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize[^"]+)"/)[1]);
  const page = await (await fetch(href)).text();
  const approve = unesc(page.match(/id="approve"[^>]*href="([^"]+)"/)[1]);
  const r2 = await fetch(MOCK + approve, { redirect: 'manual' });
  const cb = new URL(r2.headers.get('location'));
  const r3 = await fetch(origin + cb.pathname + cb.search, { headers: { cookie } });
  if (r3.status !== 200 || !(await r3.text()).includes('Discord linked')) throw new Error(`link failed: ${r3.status}`);
}

const step = process.argv[2];
if (step === 'accounts') {
  const importer = await account('importer');
  const sam = await account('samwise');
  const rookie = await account('rookie');
  psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now())`);
  fs.writeFileSync(STATE, JSON.stringify({ importer, sam, rookie }, null, 1));
  console.log('accounts ready');
} else if (step === 'join') {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  // The tokens from registration (a fresh API login would ask for the email code).
  const iTok = st.importer.token;
  const sid = psql(`SELECT server_id FROM servers WHERE owner_user_id = '${st.importer.user_id}' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  if (!sid) throw new Error('no imported server yet');
  const inv = await api('POST', `/servers/${sid}/invites`, { token: iTok, body: {} });
  const sTok = st.sam.token;
  await api('POST', `/invites/${inv.code ?? inv.invite?.code}/accept`, { token: sTok, body: {} });
  await linkDiscord(sTok, SAM_DISCORD, 'samwise.k');
  st.server_id = sid;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`sam joined ${sid} and linked Discord`);
} else if (step === 'rookie') {
  // A plain member (no Manage Messages / Channels: slowmode applies) who joins by invite; the admin gives them
  // Farmhand (emoji icon + gradient) through the normal role route.
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const sid = psql(`SELECT server_id FROM servers WHERE owner_user_id = '${st.importer.user_id}' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  const inv = await api('POST', `/servers/${sid}/invites`, { token: st.importer.token, body: {} });
  await api('POST', `/invites/${inv.code ?? inv.invite?.code}/accept`, { token: st.rookie.token, body: {} });
  const farmhand = psql(`SELECT role_id FROM roles WHERE server_id = '${sid}' AND name = 'Farmhand'`);
  await api('PUT', `/servers/${sid}/members/${st.rookie.user_id}/roles/${farmhand}`, { token: st.importer.token, body: {} });
  st.server_id = sid;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`rookie joined ${sid} with Farmhand`);
} else {
  console.error('usage: setup.mjs accounts|join|rookie'); process.exit(2);
}
