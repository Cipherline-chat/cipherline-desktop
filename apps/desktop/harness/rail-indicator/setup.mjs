// Rail indicator, real-app check: API-side setup around the REAL Electron runs.
//   accounts   register alice through the real register flow (email code read from the isolated API's log) and
//              give her 18 servers through the real create-server route, so the rail's server box scrolls
// Loopback only; the isolated DB only.
//   API=http://127.0.0.1:13247/v1 API_LOG=<log> STATE=<json> node setup.mjs accounts
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = process.env.API ?? 'http://127.0.0.1:13247/v1';
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API)) throw new Error(`refusing a non-loopback API: ${API}`);
const LOG = process.env.API_LOG;
const STATE = process.env.STATE;
const psql = (sql) => execFileSync('docker', ['exec', 'cl-ris-pg', 'psql', '-U', 'postgres', '-d', 'clris', '-Atqc', sql], { encoding: 'utf8' }).trim();
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
  const email = `${name}@ris.invalid`;
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
  const alice = await account('alice_ris');
  psql(`UPDATE users SET created_at = now() - interval '30 days', email_verified_at = COALESCE(email_verified_at, now())`);
  const names = ['Cipherline', 'Coffee Club', 'Sunset Crew', 'Tech Explorers', 'Night Owls', 'Arcade', 'Mountain Trail',
    'Book Nook', 'Garden', 'Pixel Art', 'Synthwave', 'Robotics', 'Chess Masters', 'Film Society', 'Hiking', 'Lo-fi Lounge',
    'Speedrun', 'Astronomy'];
  const servers = [];
  for (const name of names) servers.push(await api('POST', '/servers', { token: alice.token, body: { name } }));
  fs.writeFileSync(STATE, JSON.stringify({ alice, servers: servers.map((x) => ({ id: x.server_id ?? x.id, name: x.name })) }, null, 1));
  console.log(`account ready, ${servers.length} servers`);
} else {
  console.error('usage: setup.mjs accounts'); process.exit(2);
}
