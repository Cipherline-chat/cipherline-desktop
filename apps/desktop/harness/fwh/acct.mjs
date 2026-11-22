// Register one account on the ISOLATED loopback API (launch.sh header): API_LOG=<api log> node acct.mjs <name>
import crypto from 'node:crypto'; import fs from 'node:fs';
const API = 'http://127.0.0.1:13197/v1'; const LOG = process.env.API_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, route, o = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (![200, 201, 204].includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${t.slice(0, 300)}`);
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
const name = process.argv[2];
const email = `${name}@fwh.invalid`;
const password = `Harvest-${crypto.randomBytes(6).toString('hex')}-Moon!7`;
await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
const v = await api('POST', '/auth/verify-email', { body: { email, code: await code(email) } });
const f = await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } });
console.log(JSON.stringify({ name, email, password, token: (f.access_token ?? f.token) ? 'yes' : 'no' }));
