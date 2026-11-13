// Shared helpers for the Linux e2e lab driver (runs on the HOST, drives the containers).
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LAB = path.resolve(HERE, '..');
export const OUT = path.join(LAB, 'out');
export const RESULTS = process.env.LAB_RESULTS || '/tmp/claude-1001/-home-antigravity-Cipherline/985fe53f-c49e-46ba-80fb-a9929bad2f4a/scratchpad/linux-e2e';
export const API = 'http://127.0.0.1:13005/v1';
export const IP = { sharer: '172.29.88.21', viewer: '172.29.88.22' };
const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
export const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...o });
export const dexec = (name, script, o = {}) => sh('docker', ['exec', '-u', 'tester', name, 'bash', '-c', script], o);

// ── accounts (TEST accounts on the LAB API only; passwords live in out/accounts.json, mode 600, gitignored) ──
export const ACCOUNTS_FILE = path.join(OUT, 'accounts.json');
const strongPassword = () => crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + '!7a';

async function api(method, route, { token, body, ok = [200, 201, 204], device } = {}) {
  const r = await fetch(API + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(device ? { 'x-device-id': device } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  if (!ok.includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j).slice(0, 200)}`);
  return j;
}
export { api };

/** The newest 6-digit code the lab API "emailed" to `email` (RESEND_API_KEY is unset: it prints to its log). */
export async function emailedCode(email, { since = 0, tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const txt = sh('docker', ['logs', '--since', String(since || '1h'), 'cle2e-api'], { stdio: ['ignore', 'pipe', 'pipe'] }) ;
    const blocks = txt.split('┌─ Email to ').slice(1).filter((b) => b.startsWith(email));
    const last = blocks[blocks.length - 1];
    const m = last && last.match(/\b(\d{6})\b/);
    if (m) return m[1];
    await sleep(500);
  }
  throw new Error(`no emailed code for ${email}`);
}
const dockerLogsSince = () => Math.floor(Date.now() / 1000) - 1;

async function createAccount(name) {
  const email = `${name}@lab.invalid`, password = strongPassword();
  const t0 = Math.floor(Date.now() / 1000) - 1;
  await api('POST', '/auth/register', { body: { email, username: name, password, dob: '1990-01-01' } });
  const code = await emailedCode(email, { since: t0 });
  const v = await api('POST', '/auth/verify-email', { body: { email, code } });
  const f = await api('POST', '/auth/finalize', { body: { finalize_token: v.finalize_token, tos_accepted: true } });
  const token = f.access_token ?? f.token;
  const me = await api('GET', '/auth/me', { token });
  const u = me.user ?? me;
  return { name, email, password, user_id: u.user_id ?? u.id, discriminator: u.discriminator, token };
}

/** Two test accounts, friends with each other. Idempotent per lab run (accounts.json is wiped by down.sh's tmpfs DB: stale file is ignored). */
export async function ensureAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    const a = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (a.bootAt && a.bootAt === labBootAt()) return a;
  }
  // a previous half-finished run may have left the accounts (passwords unknown): clear them in the lab DB only
  try { sh('docker', ['exec', 'cle2e-pg', 'psql', '-U', 'cle2e', '-d', 'cle2e', '-qc', "DELETE FROM friends; DELETE FROM users WHERE email LIKE '%@lab.invalid'"]); } catch { /* fresh db */ }
  sh('docker', ['exec', 'cle2e-redis', 'redis-cli', 'FLUSHALL']); // lab redis only: clears throttler counters from earlier attempts
  const accts = { bootAt: labBootAt() };
  for (const n of ['labsharer', 'labviewer']) accts[n] = await createAccount(n);
  // friends: sharer requests, viewer accepts (both API calls use the access tokens finalize returned)
  const fr = await api('POST', '/friends/request', { token: accts.labsharer.token, body: { target_username: 'labviewer', target_discriminator: Number(accts.labviewer.discriminator) } });
  await api('POST', '/friends/accept', { token: accts.labviewer.token, body: { friend_id: fr.friend_id ?? fr.friend?.friend_id } });
  // These two accounts share one source address, so the API's per-address trial limiter can withhold a trial (free tier has no
  // video share). The lab pins both to an active trial in ITS OWN throwaway database so video share is allowed.
  sh('docker', ['exec', 'cle2e-pg', 'psql', '-U', 'cle2e', '-d', 'cle2e', '-qc',
    `UPDATE users SET subscription_status='trial', trial_started_at=now(), trial_ends_at=now()+interval '30 days' WHERE email IN ('labsharer@lab.invalid','labviewer@lab.invalid')`]);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accts, null, 1), { mode: 0o600 });
  return accts;
}
export function labBootAt() { return sh('docker', ['inspect', '-f', '{{.State.StartedAt}}', 'cle2e-pg']).trim(); }

// ── containers ──
export function startClient(role, desktop, { cpus = '6', memory = '4g', env = {}, gpu = true } = {}) {
  const labEnv = fs.readFileSync(path.join(OUT, 'lab.env'), 'utf8');
  const electronDist = labEnv.match(/^CLE2E_ELECTRON_DIST=(.*)$/m)[1];
  const nodeDir = labEnv.match(/^CLE2E_NODE_DIR=(.*)$/m)[1];
  const name = `cle2e-${role}`;
  sh('docker', ['rm', '-f', name]);
  const outHost = path.join(OUT, 'run', role); fs.rmSync(outHost, { recursive: true, force: true }); fs.mkdirSync(outHost, { recursive: true, mode: 0o777 }); fs.chmodSync(outHost, 0o777);
  const desktopDir = path.resolve(LAB, '..', '..');
  const renderGid = fs.existsSync('/dev/dri/renderD128') ? String(fs.statSync('/dev/dri/renderD128').gid) : null;
  const args = ['run', '-d', '--init', '--name', name, '--network', 'cle2e-net', '--ip', IP[role], '--user', '1001:1001',
    '--shm-size=1g', `--memory=${memory}`, `--cpus=${cpus}`, '--pids-limit=4096',
    ...(gpu && renderGid ? ['--device', '/dev/dri', '--group-add', renderGid, '--group-add', String(fs.statSync('/dev/dri/card0').gid)] : []),
    '-v', `${nodeDir}:/node:ro`, '-v', `${electronDist}:/electron:ro`, '-v', `${LAB}:/lab:ro`, '-v', '/home/antigravity/Cipherline:/home/antigravity/Cipherline:ro',
    '-v', `${outHost.replace(/\/[^/]+$/, '')}:/out`,
    '-e', `DESKTOP_DIR=${desktopDir}`, '-e', `LAB_GPU=${gpu ? 1 : 0}`, '-e', `LAB_OUT=/out/${role}`, '-e', 'LAB_OUT_BASE=/out',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    process.env.LAB_IMAGE || 'cle2e-desktop', 'bash', '/lab/inside/client.sh', role, desktop];
  sh('docker', args);
  return name;
}
export async function waitReady(role, ms = 120000) {
  const f = path.join(OUT, 'run', role, 'ready'); const t = Date.now();
  while (Date.now() - t < ms) { if (fs.existsSync(f)) { const s = fs.readFileSync(f, 'utf8').trim(); if (s === 'READY') return; throw new Error(`${role}: ${s}`); } await sleep(500); }
  throw new Error(`${role}: not ready after ${ms}ms`);
}
export function stopClients() { for (const r of ['sharer', 'viewer']) try { sh('docker', ['rm', '-f', `cle2e-${r}`]); } catch { /* none */ } }

/** CDP connection to the real Cipherline renderer in a client container. */
export async function connectApp(role, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://${IP[role]}:9223`, { timeout: 5000 });
      const ctx = browser.contexts()[0];
      let page = ctx.pages().find((p) => /127\.0\.0\.1:15174/.test(p.url()));
      if (!page) { await sleep(1000); page = ctx.pages().find((p) => /127\.0\.0\.1:15174/.test(p.url())); }
      if (page) return { browser, ctx, page };
    } catch (e) { last = e; }
    await sleep(1000);
  }
  throw new Error(`cannot attach to ${role}: ${last?.message}`);
}

/** A DM between the two test accounts (requires the friendship made by ensureAccounts). Idempotent. */
export async function ensureDm(accts) {
  // the API wants the calling DEVICE: use the device the app registered for the sharer account when it signed in
  const dev = sh('docker', ['exec', 'cle2e-pg', 'psql', '-U', 'cle2e', '-d', 'cle2e', '-Atc', `SELECT device_id FROM devices WHERE user_id='${accts.labsharer.user_id}' LIMIT 1`]).trim();
  if (!dev) throw new Error('no registered device yet');
  const r = await api('POST', '/conversations/dm', { token: accts.labsharer.token, device: dev, body: { other_user_id: accts.labviewer.user_id }, ok: [200, 201, 409] });
  return r.conversation_id ?? r.id ?? r.conversation?.conversation_id;
}
