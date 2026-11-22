// Discord history import, real-API check: create two TEST accounts on an ISOLATED local API (never the shared dev
// stack, never staging or prod) and print what the harness page needs.
//   API=http://127.0.0.1:13105/v1 API_LOG=<api log file> PG=<pg container> PGDB=<db> node harness/discord-history-setup.mjs > <out.json>
// "importer" (aged 30 days in the THROWAWAY database so the D11 gate passes) and "sam" (a member whose name collides
// with an imported author called Sam). Codes are read from the API log (no mail provider configured).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const API = process.env.API ?? 'http://127.0.0.1:13105/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const LOG = process.env.API_LOG; const PG = process.env.PG ?? 'cl-import-pg'; const PGDB = process.env.PGDB ?? 'clih';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();

async function api(method, route, { token, body, device, ok = [200, 201, 204] } = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(device ? { 'x-device-id': device } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  const email = `${name}-${crypto.randomBytes(3).toString('hex')}@import.invalid`;
  const password = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + '!7a';
  await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
  const v = await api('POST', '/auth/verify-email', { body: { email, code: await code(email) } });
  const f = await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } });
  const token = f.access_token ?? f.token;
  const me = await api('GET', '/auth/me', { token });
  const u = me.user ?? me;
  const d = await api('POST', '/devices/register', { token, body: { device_name: `${name}-harness`, platform: 'linux' } });
  const device_id = d.device_id ?? d.device?.device_id ?? d.id;
  return { name, user_id: u.user_id ?? u.id, token, device_id };
}

const importer = await account('importer');
const sam = await account('sam');
psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now()) WHERE user_id IN ('${importer.user_id}','${sam.user_id}')`);
psql(`UPDATE devices SET is_approved = true WHERE device_id IN ('${importer.device_id}','${sam.device_id}')`);
process.stdout.write(JSON.stringify({ api: API, importer, sam }, null, 1));
