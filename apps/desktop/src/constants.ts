// API endpoint resolution.
//
// Default: `https://api.cipherline.chat` / `wss://api.cipherline.chat`. The
// packaged Electron build uses this verbatim; the dev-with-Caddy setup on
// a LAN works because the Windows hosts file maps the subdomain to the dev
// box's IP and the Windows Trusted Root store contains Caddy's local CA.
//
// Override via `VITE_API_HOST` when you want a different target — e.g.
//   VITE_API_HOST=localhost:3005         → http://localhost:3005/v1
//   VITE_API_HOST=192.168.1.27:3005      → http://192.168.1.27:3005/v1
//   VITE_API_HOST=api.staging.example    → https://api.staging.example/v1
//
// We DO NOT infer from window.location.hostname anymore — when Electron dev
// loads from http://<dev-box-IP>:5174 (the Vite server), window.location
// gives us the Vite host, which is NOT the API host under the Caddy setup.
const HOST: string = (import.meta.env.VITE_API_HOST as string | undefined) || 'api.cipherline.chat';

const hasExplicitPort = /:\d+$/.test(HOST);
const isLoopback = HOST.startsWith('localhost') || HOST.startsWith('127.');
// Bare IPv4 without a port is ambiguous (could be LAN dev or a real public
// IP). Treat as plain-http/ws dev by default — a LAN IP has no TLS cert.
const isBareIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(HOST);
const isTlsHost = !hasExplicitPort && !isLoopback && !isBareIpv4;

const httpScheme = isTlsHost ? 'https' : 'http';
const wsScheme = isTlsHost ? 'wss' : 'ws';

// Bare IPv4 with no port falls back to :3005 so we don't accidentally hit
// whatever's on port 80 / 443 of that host.
const hostWithPort = isBareIpv4 && !hasExplicitPort ? `${HOST}:3005` : HOST;

export const API_BASE = `${httpScheme}://${hostWithPort}/v1`;
export const WS_BASE = `${wsScheme}://${hostWithPort}/v1/ws`;

// ── Upload & message limits ─────────────────────────────────────────────
// These must stay in sync with the API DTO validators:
//   - apps/api/src/attachments/dto/attachments.dto.ts  (size_bytes)
//   - apps/api/src/messages/dto/messages.dto.ts         (ciphertext_b64)
/** Maximum individual attachment upload size (paid/trial tier). */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
/** Maximum individual attachment upload size on the free tier. Must stay in
 *  sync with FREE_TIER_LIMITS.maxUploadBytes in apps/api/src/billing/billing.service.ts. */
export const FREE_TIER_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
/** Maximum characters in a single text message before we stop accepting input. */
export const MAX_TEXT_MESSAGE_LENGTH = 100_000;

// Stamped in at build time by vite.config.ts from apps/desktop/package.json.
// Sent on every REST request as `X-Cipherline-Version` and appended to the WS
// URL as `?version=...`. The server's MIN_CLIENT_VERSION gate compares it.
export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string) || '0.0.0';

/**
 * Short git SHA the running bundle was compiled from ('unknown' when the build
 * had no git available; suffixed `-dirty` when the tree had uncommitted tracked
 * changes). Stamped in by vite.config.ts — see the comment there for why.
 *
 * Displayed in Settings → Advanced → This build. Purely diagnostic: it answers
 * "is the app running the code I think it is?", which the dev stack's
 * single-owner Docker bind-mount otherwise makes unanswerable from inside the
 * app. A short commit hash is not sensitive (the client is open-source), so it
 * shows in production builds too — same as any app's build number.
 */
export const BUILD_COMMIT: string = (import.meta.env.VITE_BUILD_COMMIT as string) || 'unknown';
