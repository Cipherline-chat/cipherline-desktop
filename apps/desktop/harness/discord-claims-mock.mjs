// Discord CLAIMS real-app harness, network half. Two LOOPBACK servers, nothing else:
//   1. a MOCK Discord OAuth2 provider on http://127.0.0.1:${MOCK_PORT} (authorize page, token exchange with PKCE S256
//      checking, /users/@me, revoke). The isolated API reaches it only because its DISCORD_OAUTH_ORIGIN is loopback
//      and DISCORD_OAUTH_TEST_BASE points here (discord-oauth.ts honours that pair ONLY on loopback);
//   2. a TLS front for the isolated API on https://127.0.0.1:${TLS_PORT} (self-signed), because the desktop only ever
//      opens an https start page (utils/discordClaims.ts isOurDiscordStartUrl + the https-only external opener).
//   MOCK_PORT=7999 TLS_PORT=13443 API=http://127.0.0.1:13105 CERT_DIR=<dir with key.pem cert.pem> node harness/discord-claims-mock.mjs
// The Discord user /users/@me answers with is set by POST /__control {"id": "..."}; GET /__calls lists what was called.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 7999);
const TLS_PORT = Number(process.env.TLS_PORT ?? 13443);
const API = new URL(process.env.API ?? 'http://127.0.0.1:13105');
if (API.hostname !== '127.0.0.1') throw new Error('loopback API only');
const CERT_DIR = process.env.CERT_DIR;
const CLIENT_ID = process.env.CLIENT_ID ?? '123456789012345678';
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? 'harness-client-secret-0123456789';

let currentUser = { id: '900000000000000002', username: 'samwise.k' };
const codes = new Map();
const tokens = new Map();
const calls = [];
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const basicOk = (h) => h === `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  const raw = (await body(req)).toString('utf8');
  calls.push({ method: req.method, path: u.pathname, auth: req.headers.authorization ? req.headers.authorization.split(' ')[0] : null, form: Object.fromEntries(new URLSearchParams(raw)) });
  if (u.pathname === '/__control' && req.method === 'POST') { currentUser = { ...currentUser, ...JSON.parse(raw) }; return json(res, 200, currentUser); }
  if (u.pathname === '/__calls') return json(res, 200, calls.map((c) => ({ ...c, form: Object.keys(c.form) })));
  if (u.pathname === '/oauth2/authorize') {
    const q = u.searchParams;
    if (q.get('client_id') !== CLIENT_ID || q.get('scope') !== 'identify' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('mock discord: bad authorize request');
    }
    const deny = `${q.get('redirect_uri')}?error=access_denied&state=${encodeURIComponent(q.get('state') ?? '')}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Mock sign-in</title><body style="font:15px system-ui;background:#2b2d31;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<main style="background:#313338;padding:28px 32px;border-radius:12px;max-width:420px"><h1 style="font-size:18px">MOCK identity provider (test only)</h1>
<p>An application wants to know your account number (<b>identify</b> only). Signed in as <b>${esc(currentUser.username)}</b>.</p>
<p><a id="approve" style="color:#fff;background:#5865f2;padding:8px 14px;border-radius:6px;text-decoration:none" href="/__approve?${esc(u.searchParams.toString())}">Authorize</a>
&nbsp; <a id="deny" style="color:#ccc" href="${esc(deny)}">Cancel</a></p></main></body>`);
  }
  if (u.pathname === '/__approve') {
    const q = u.searchParams;
    const code = crypto.randomBytes(15).toString('base64url');
    codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), used: false });
    res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state') ?? '')}` });
    return res.end();
  }
  if (u.pathname === '/api/oauth2/token/revoke') {
    if (!basicOk(req.headers.authorization)) return json(res, 401, { error: 'invalid_client' });
    const t = tokens.get(new URLSearchParams(raw).get('token') ?? '');
    if (t) t.revoked = true;
    return json(res, 200, {});
  }
  if (u.pathname === '/api/oauth2/token') {
    if (!basicOk(req.headers.authorization)) return json(res, 401, { error: 'invalid_client' });
    const p = new URLSearchParams(raw);
    const c = codes.get(p.get('code') ?? '');
    if (!c || c.used || p.get('grant_type') !== 'authorization_code') return json(res, 400, { error: 'invalid_grant' });
    c.used = true;
    if (p.get('redirect_uri') !== c.redirect) return json(res, 400, { error: 'invalid_grant' });
    const ch = crypto.createHash('sha256').update(p.get('code_verifier') ?? '', 'ascii').digest('base64url');
    if (ch !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
    const access = crypto.randomBytes(24).toString('base64url');
    tokens.set(access, { revoked: false, user: { ...currentUser } });
    return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 604800, refresh_token: 'r', scope: 'identify' });
  }
  if (u.pathname === '/api/v10/users/@me') {
    const t = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!t || t.revoked) return json(res, 401, { message: '401: Unauthorized' });
    return json(res, 200, { id: t.user.id, username: t.user.username, avatar: null, discriminator: '0' });
  }
  return json(res, 404, { message: 'not found' });
}).listen(MOCK_PORT, '127.0.0.1', () => console.log(`mock discord on http://127.0.0.1:${MOCK_PORT}`));

https.createServer({ key: fs.readFileSync(`${CERT_DIR}/key.pem`), cert: fs.readFileSync(`${CERT_DIR}/cert.pem`) }, (req, res) => {
  const up = http.request({ host: API.hostname, port: API.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${API.hostname}:${API.port}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('api down'); });
  req.pipe(up);
}).listen(TLS_PORT, '127.0.0.1', () => console.log(`tls front on https://127.0.0.1:${TLS_PORT} -> ${API.href}`));
