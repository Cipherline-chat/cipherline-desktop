/**
 * Google Drive OAuth 2.0 — RFC 8252 loopback redirect flow.
 *
 * No new npm packages: uses only Node.js built-ins (http, https, net) +
 * Electron's shell.openExternal.
 *
 * Client secret note: for Desktop/installed-app OAuth credentials, Google
 * explicitly documents that the client secret is NOT truly secret and may be
 * embedded in the binary. The security model for installed apps relies on the
 * loopback redirect URI binding, not the secret. See:
 * https://developers.google.com/identity/protocols/oauth2/native-app
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { shell } from 'electron';
import { secureStore } from './storage';

// ── Credentials ───────────────────────────────────────────────────────────────
// Official builds inject these via electron-builder extraMetadata (CI secrets
// GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET → package.json). Dev
// builds can set the env vars directly. Forks that set neither get Drive
// backup silently disabled — no hardcoded fallback.
// For Desktop/installed-app OAuth, Google explicitly documents that the client
// secret is NOT truly secret and may be embedded in the binary. The security
// model relies on the loopback redirect URI binding. See:
// https://developers.google.com/identity/protocols/oauth2/native-app
function readDriveCredential(field: 'googleDriveClientId' | 'googleDriveClientSecret', envKey: string): string {
    if (process.env[envKey]) return process.env[envKey]!;
    try {
        const { app } = require('electron') as typeof import('electron');
        const pkg = require(require('path').join(app.getAppPath(), 'package.json'));
        if (pkg && typeof pkg[field] === 'string') return pkg[field];
    } catch {}
    return '';
}
const CLIENT_ID     = readDriveCredential('googleDriveClientId',     'GOOGLE_DRIVE_CLIENT_ID');
const CLIENT_SECRET = readDriveCredential('googleDriveClientSecret', 'GOOGLE_DRIVE_CLIENT_SECRET');
// ── OAuth scopes ──────────────────────────────────────────────────────────────
//
//   drive.file             — read/write ONLY the items this app created (or that
//                            the user explicitly handed us). This is what the
//                            backup itself runs on: creating the folder, writing
//                            <base>.enc, re-uploading it, reading it back on
//                            restore (see driveBackup.ts / driveTransfer.ts).
//                            NEVER remove it — dropping it breaks backups.
//
//   drive.metadata.readonly — read-only access to file/folder METADATA (names,
//                            ids, parents) with NO access to any file CONTENT.
//                            This is the only thing that lets the in-app folder
//                            browser (src/components/DriveFolderPicker.tsx via
//                            src/utils/driveFolders.ts) enumerate the user's own
//                            existing folders so they can pick where backups go.
//                            `drive.file` cannot do that by design: a
//                            `files.list` walk of "'root' in parents" comes back
//                            empty or 403s, which is the SCOPE_MISSING failure
//                            the browser hits without this scope.
//
// ⚠️  ACTION REQUIRED IN GOOGLE CLOUD CONSOLE — READ BEFORE SHIPPING ⚠️
//
// drive.metadata.readonly is NOT a normal scope. Google lists it among Drive's
// **restricted** scopes (alongside drive, drive.readonly, drive.metadata) —
// a tier above "sensitive". An app requesting it must pass Google's **OAuth app
// verification**, and restricted scopes can additionally require an annual
// third-party security assessment (CASA). Confirm the current classification in
// the Cloud Console when adding the scope; it is shown there. Until that
// verification is granted:
//   • up to 100 accounts added under "Test users" in the OAuth consent screen
//     can connect Drive normally;
//   • EVERY OTHER ACCOUNT is hard-blocked at consent with "Access blocked: this
//     app's request is invalid / has not completed the Google verification
//     process" — which means they cannot connect Drive AT ALL, not merely that
//     they lose folder browsing.
// This was the reason the scope was dropped in f86626d9 (2026-06-12) and again
// in 8db34c2f (2026-09-03). Re-added deliberately 2026-09-05 as a product
// decision: the full in-app folder browser is worth the verification process.
// Do not "simplify" this back out without checking with the owner first.
const SCOPE = 'email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';

// ── SecureStore keys ──────────────────────────────────────────────────────────
const KEYS = {
    refreshToken:  'oauth:google:refresh_token',
    accessToken:   'oauth:google:access_token',
    tokenExpiry:   'oauth:google:token_expiry',
    accountEmail:  'oauth:google:account_email',
    accountName:   'oauth:google:account_name',
    folderId:      'oauth:google:folder_id',
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

// findFreePort() was removed (P2-ELEC-17): probing then re-binding has a TOCTOU
// race.  The callback server now binds directly to port 0 and derives its actual
// port from server.address() inside the listen callback.

/**
 * Renders the tiny local HTML page shown in the system browser after the
 * OAuth loopback redirect lands back on us (success, denial, or failure).
 *
 * Root-cause note (mojibake fix): this used to ship as `Content-Type:
 * text/html` with no charset. Node writes string bodies as UTF-8 by default,
 * so the bytes on the wire were always correct — but with no charset in the
 * header, browsers fall back to guessing (usually Latin-1/Windows-1252),
 * which is exactly what turned '✓' (UTF-8 bytes E2 9C 93) into 'âœ"'. The
 * fix is the explicit `charset=utf-8` in the Content-Type set by the caller
 * below, paired with writing the body as an explicit UTF-8 buffer here so
 * the bytes are never left to an implicit default.
 */
function renderCallbackPage(opts: { icon: 'success' | 'error'; heading: string; body: string }): Buffer {
    const { icon, heading, body } = opts;
    const iconMarkup = icon === 'success'
        ? `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
             <circle cx="28" cy="28" r="27" fill="#0E8F7C" fill-opacity="0.18" stroke="#25E0C8" stroke-width="2"/>
             <path d="M17 29L24.5 36.5L39.5 20.5" stroke="#25E0C8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
           </svg>`
        : `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
             <circle cx="28" cy="28" r="27" fill="#B23A30" fill-opacity="0.18" stroke="#FF6B5E" stroke-width="2"/>
             <path d="M20 20L36 36M36 20L20 36" stroke="#FF6B5E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
           </svg>`;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cipherline</title>
<style>
  :root{
    --abyss:#0B0F1E; --deep:#131A30; --surface:#1C2542; --border:#2A3558;
    --text:#F4F7FF; --muted:#A7B3D4;
  }
  *{box-sizing:border-box;}
  html,body{height:100%;}
  body{
    margin:0;
    display:flex;
    align-items:center;
    justify-content:center;
    min-height:100vh;
    background:radial-gradient(circle at 50% 0%, var(--deep), var(--abyss));
    font-family:'Segoe UI', system-ui, -apple-system, 'Nunito', sans-serif;
    color:var(--text);
  }
  .card{
    display:flex;
    flex-direction:column;
    align-items:center;
    text-align:center;
    gap:16px;
    padding:40px 44px;
    max-width:420px;
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:16px;
    box-shadow:0 20px 60px rgba(0,0,0,0.45);
  }
  h1{
    margin:0;
    font-size:20px;
    font-weight:700;
    line-height:1.35;
    letter-spacing:.01em;
  }
  p{
    margin:0;
    font-size:14px;
    line-height:1.5;
    color:var(--muted);
  }
  .brand{
    margin-top:4px;
    font-size:12px;
    letter-spacing:.08em;
    text-transform:uppercase;
    color:var(--muted);
    opacity:.7;
  }
</style>
</head>
<body>
  <div class="card">
    ${iconMarkup}
    <h1>${heading}</h1>
    <p>${body}</p>
    <div class="brand">Cipherline</div>
  </div>
</body>
</html>`;

    return Buffer.from(html, 'utf8');
}

/** POST to a Google endpoint and return parsed JSON. */
function googlePost(path: string, body: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = new URLSearchParams(body).toString();
        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let raw = '';
            res.on('data', (c: Buffer) => { raw += c.toString(); });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch {
                    // Don't put the raw response body in the thrown message — this is
                    // the token-exchange/refresh endpoint, so a malformed response
                    // could echo back partial token material or account data if this
                    // error ever surfaces in logs/telemetry/UI. Status + length is
                    // enough to diagnose a broken proxy or outage without the content.
                    reject(new Error(`Google returned non-JSON response (status ${res.statusCode}, ${raw.length} bytes)`));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/** GET from a Google API endpoint with a Bearer token, return parsed JSON. */
function googleGet(hostname: string, path: string, accessToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            path,
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` },
        }, (res) => {
            let raw = '';
            res.on('data', (c: Buffer) => { raw += c.toString(); });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error(`Google returned non-JSON response (status ${res.statusCode}, ${raw.length} bytes)`)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface LinkedAccount {
    linked: true;
    email: string;
    name: string;
}

export interface UnlinkedAccount {
    linked: false;
}

export type AccountStatus = LinkedAccount | UnlinkedAccount;

/**
 * Start the OAuth flow. Opens the system browser at Google's consent page,
 * spins up a temporary local HTTP server to receive the redirect, exchanges
 * the auth code for tokens, and persists everything in SecureStore.
 *
 * Resolves with the linked account info, or rejects on error / timeout.
 */
/** True when this build carries OAuth credentials (CI-injected or env). */
export function isDriveConfigured(): boolean {
    return !!CLIENT_ID && !!CLIENT_SECRET;
}

export async function startOAuth(): Promise<{ email: string; name: string }> {
    // Without credentials Google would answer 'Missing required parameter:
    // client_id' in the browser. Say it here instead, before anything opens.
    if (!isDriveConfigured()) {
        throw new Error('Google Drive backup is not configured in this build (no OAuth client ID).');
    }
    // HIGH-18: PKCE S256 + random state to prevent auth-code interception and CSRF.
    const codeVerifier  = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const oauthState    = crypto.randomBytes(16).toString('hex');

    // P2-ELEC-17: Bind to port 0 so the OS assigns an ephemeral port atomically —
    // avoids the TOCTOU race of probe-then-bind.  redirectUri is derived inside the
    // listen callback and kept in scope for the token exchange below.
    let redirectUri = '';

    const code = await new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => {
            // P2-ELEC-17: 404 unknown paths (e.g. favicon.ico) instead of leaving
            // the browser socket hanging with no response and the server open forever.
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            if (url.pathname !== '/callback') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
                return;
            }

            const code  = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            const state = url.searchParams.get('state');

            if (error) {
                const page = renderCallbackPage({
                    icon: 'error',
                    heading: 'Authorization denied',
                    body: 'You can close this tab and return to Cipherline.',
                });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
                res.end(page);
                server.close();
                reject(new Error(`OAuth denied: ${error}`));
                return;
            }

            // HIGH-18: Reject state mismatch — indicates CSRF or redirect hijack
            if (code && state !== oauthState) {
                const page = renderCallbackPage({
                    icon: 'error',
                    heading: 'Authorization failed',
                    body: 'Something did not match up. Close this tab and try connecting again from Cipherline.',
                });
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
                res.end(page);
                server.close();
                reject(new Error('OAuth state mismatch — possible CSRF attack'));
                return;
            }

            if (code) {
                const page = renderCallbackPage({
                    icon: 'success',
                    heading: 'Cipherline connected to Google Drive',
                    body: 'You can close this tab and return to Cipherline.',
                });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
                res.end(page);
                server.close();
                resolve(code);
            }
        });

        const timeout = setTimeout(() => {
            server.close();
            reject(new Error('OAuth flow timed out after 10 minutes'));
        }, 10 * 60 * 1000);

        // Bind to port 0 — let the OS pick the port atomically.
        server.listen(0, '127.0.0.1', () => {
            server.on('close', () => clearTimeout(timeout));
            const { port } = server.address() as net.AddressInfo;
            redirectUri = `http://127.0.0.1:${port}/callback`;

            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('client_id', CLIENT_ID);
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('scope', SCOPE);
            authUrl.searchParams.set('access_type', 'offline');
            authUrl.searchParams.set('prompt', 'consent');
            authUrl.searchParams.set('code_challenge', codeChallenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');
            authUrl.searchParams.set('state', oauthState);

            if (authUrl.origin !== 'https://accounts.google.com') throw new Error('Unexpected OAuth origin');
            shell.openExternal(authUrl.toString());
        });
        server.on('error', reject);
    });

    // Exchange code for tokens (include PKCE verifier)
    const tokenResp = await googlePost('/token', {
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
    });

    if (tokenResp.error) {
        throw new Error(`Token exchange failed: ${tokenResp.error_description || tokenResp.error}`);
    }

    const { access_token, refresh_token, expires_in } = tokenResp;
    const expiry = new Date(Date.now() + (expires_in - 60) * 1000).toISOString();

    // Fetch account info
    const userInfo = await googleGet('www.googleapis.com', '/oauth2/v3/userinfo', access_token);
    const email: string = userInfo.email || '';
    const name: string = userInfo.name || email;

    // Persist in SecureStore
    secureStore.set(KEYS.accessToken,  access_token);
    secureStore.set(KEYS.tokenExpiry,  expiry);
    secureStore.set(KEYS.accountEmail, email);
    secureStore.set(KEYS.accountName,  name);
    if (refresh_token) {
        secureStore.set(KEYS.refreshToken, refresh_token);
    }

    return { email, name };
}

/**
 * Returns a valid access token, silently refreshing if it's within 5 minutes
 * of expiry. Throws if no refresh token is stored AND the cached access token
 * is also expired or missing.
 */
export async function getAccessToken(): Promise<string> {
    await secureStore.initialize();
    const expiry    = secureStore.get(KEYS.tokenExpiry);
    const cached    = secureStore.get(KEYS.accessToken);
    const refreshTk = secureStore.get(KEYS.refreshToken);

    const needsRefresh = !cached || !expiry
        || Date.now() > new Date(expiry).getTime() - 5 * 60 * 1000;

    // If we have no refresh token, serve the cached access token while it's
    // still valid. This covers the case where the user connected within the
    // last ~hour but the refresh token was not stored.
    if (!refreshTk) {
        if (!needsRefresh && cached) return cached;
        throw new Error('Google Drive not linked');
    }

    if (!needsRefresh && cached) return cached;

    // Refresh
    const resp = await googlePost('/token', {
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshTk,
        grant_type:    'refresh_token',
    });

    if (resp.error) {
        const errCode = resp.error as string;
        // P2-ELEC-6: Only unlink on permanent revocation errors. Transient errors
        // (rate-limit, network, server-side 500s) should not destroy the link.
        if (errCode === 'invalid_grant' || errCode === 'unauthorized_client') {
            await revokeTokens().catch(() => {});
            throw new Error(`Google Drive token revoked — please re-link: ${resp.error_description || errCode}`);
        }
        throw new Error(`Google Drive token refresh failed: ${resp.error_description || errCode}`);
    }

    const { access_token, expires_in } = resp;
    const expiry2 = new Date(Date.now() + (expires_in - 60) * 1000).toISOString();
    secureStore.set(KEYS.accessToken, access_token);
    secureStore.set(KEYS.tokenExpiry, expiry2);
    return access_token;
}

/**
 * Revokes the refresh token and deletes all stored credentials.
 * Best-effort: even if revocation fails, local credentials are cleared.
 */
export async function revokeTokens(): Promise<void> {
    await secureStore.initialize();
    const token = secureStore.get(KEYS.refreshToken) || secureStore.get(KEYS.accessToken);
    if (token) {
        // Fire-and-forget revoke — ignore errors (token may already be gone)
        await new Promise<void>((resolve) => {
            const req = https.request({
                hostname: 'oauth2.googleapis.com',
                path: `/revoke?token=${encodeURIComponent(token)}`,
                method: 'POST',
            }, () => resolve());
            req.on('error', () => resolve());
            req.end();
        });
    }
    for (const key of Object.values(KEYS)) {
        secureStore.delete(key);
    }
}

/**
 * Returns current link status without making any network calls.
 *
 * Considers the account linked if EITHER:
 *   - A refresh token is stored (normal persistent case), OR
 *   - A cached access token exists and has not yet expired (handles the case
 *     where the user connected in this session but the refresh token wasn't
 *     returned/stored — the access token is still good for up to 1 hour).
 */
export async function getLinkedAccount(): Promise<AccountStatus> {
    await secureStore.initialize();
    const email      = secureStore.get(KEYS.accountEmail);
    const name       = secureStore.get(KEYS.accountName);
    const refreshTk  = secureStore.get(KEYS.refreshToken);
    const accessTk   = secureStore.get(KEYS.accessToken);
    const expiry     = secureStore.get(KEYS.tokenExpiry);

    const hasRefresh = !!refreshTk;
    const hasValidAccess = !!(accessTk && expiry && Date.now() < new Date(expiry).getTime());

    if (!hasRefresh && !hasValidAccess) return { linked: false };
    return { linked: true, email: email || '', name: name || email || 'Google Account' };
}

/**
 * Returns the cached Drive folder ID for the given userId, or null if not
 * yet resolved. The driver calls ensureUserFolder() which sets this.
 */
export function getCachedFolderId(): string | null {
    return secureStore.get(KEYS.folderId);
}

export function setCachedFolderId(id: string): void {
    secureStore.set(KEYS.folderId, id);
}
