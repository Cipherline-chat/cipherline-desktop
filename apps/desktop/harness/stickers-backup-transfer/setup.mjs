// Stickers backup + device transfer, real-app check: API-side setup around the REAL Electron runs.
//   accounts   register alice (the stickers owner) and bob (sends her a sticker) through the real register flow
//              (email codes read from the isolated API's log) and make them friends (DMs need mutual friendship)
// Loopback only; the isolated DB only.
//   API=http://127.0.0.1:13223/v1 API_LOG=<log> STATE=<json> node setup.mjs accounts
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = process.env.API ?? 'http://127.0.0.1:13223/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const LOG = process.env.API_LOG;
const STATE = process.env.STATE;
const psql = (sql) => execFileSync('docker', ['exec', 'cl-sbt-pg', 'psql', '-U', 'postgres', '-d', 'clsbt', '-Atqc', sql], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, route, o = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!(o.ok ?? [200, 201, 204]).includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
}
export async function code(email, after = 0) {
  for (let i = 0; i < 240; i++) {
    const blocks = fs.readFileSync(LOG, 'utf8').split('┌─ Email to ').slice(1).filter((b) => b.startsWith(email));
    const m = blocks.length > after && blocks[blocks.length - 1].match(/\b(\d{6})\b/);
    if (m) return m[1];
    await sleep(500);
  }
  throw new Error(`no code for ${email}`);
}
async function account(name) {
  const email = `${name}@sbt.invalid`;
  const password = `Harvest-${crypto.randomBytes(6).toString('hex')}-Moon!7`;
  await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
  const v = await api('POST', '/auth/verify-email', { body: { email, code: await code(email) } });
  const f = await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } });
  const token = f.access_token ?? f.token;
  const me = await api('GET', '/auth/me', { token });
  const u = me.user ?? me;
  return { name, email, password, user_id: u.user_id ?? u.id, discriminator: u.discriminator, token };
}

const step = process.argv[2];
if (step === 'accounts') {
  const alice = await account('alice_sbt');
  const bob = await account('bob_sbt');
  psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now())`);
  const disc = alice.discriminator ?? Number(psql(`SELECT discriminator FROM users WHERE user_id = '${alice.user_id}'`));
  await api('POST', '/friends/request', { token: bob.token, body: { target_username: alice.name, target_discriminator: Number(disc) } });
  const row = psql(`SELECT friend_id FROM friends WHERE recipient_id = '${alice.user_id}' AND status = 'pending' LIMIT 1`);
  await api('POST', '/friends/accept', { token: alice.token, body: { friend_id: row } });
  fs.writeFileSync(STATE, JSON.stringify({ alice, bob }, null, 1));
  console.log('accounts ready, friends');
} else {
  console.error('usage: setup.mjs accounts'); process.exit(2);
}
