/**
 * Where `net:stream-upload` may send a file.
 *
 * The handler streams a local `cl-enc-*` temp file to a presigned PUT URL from
 * the MAIN process, so it is outside the renderer CSP. The renderer chooses
 * the URL, and so far the only check was "a public http(s) host" - which let a
 * compromised renderer author a `cl-enc-*` file (the chunk-encrypt handlers
 * return its path) and PUT it to any server on the internet: an exfiltration
 * channel that CSP connect-src does not bound.
 *
 * The URL the app really uploads to is an S3 presigned URL minted by the API
 * against `MINIO_PUBLIC_ENDPOINT`, which is `https://media.cipherline.chat` in
 * prod AND staging (deploy/k8s/configmap.yaml, apps/api/.env.example) and in
 * the dev compose default (docker-compose.yml). So:
 *
 *   packaged build:   https only, host exactly media.cipherline.chat, default
 *                     port (443), no userinfo.
 *   unpackaged + a dev server (the Tier-1 Windows setup): the same, plus the
 *                     dev box. In dev the API can fall back to
 *                     `http://<request host>:9000`, where the host is the dev
 *                     server's own host or a loopback name, so exactly those
 *                     hostnames (any port) are added. Never in a packaged
 *                     build: `allowDev` comes from `!app.isPackaged &&
 *                     DEV_SERVER_URL`, which no environment variable can
 *                     select in a shipped install (main.ts, MED-3).
 *
 * Free of any `electron` import so it is unit-testable.
 */

/** The media/attachments upload host(s). One host today; a list so adding a region is one line. */
export const MEDIA_UPLOAD_HOSTS: readonly string[] = ['media.cipherline.chat'];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_URL_LENGTH = 4096;

export type UploadUrlVerdict =
    | { ok: true; url: URL }
    | { ok: false; reason: 'malformed' | 'scheme' | 'userinfo' | 'host' | 'port' };

export interface UploadHostOptions {
    /** True only for an unpackaged build running against a dev server. */
    allowDev: boolean;
    /** Extra hostnames accepted in dev (the dev server's host, the API host override's host). */
    devHosts?: readonly string[];
}

export function checkUploadUrl(raw: unknown, opts: UploadHostOptions): UploadUrlVerdict {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'malformed' };
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, reason: 'malformed' }; }
    if (url.username || url.password) return { ok: false, reason: 'userinfo' };

    const host = url.hostname.toLowerCase();
    if (MEDIA_UPLOAD_HOSTS.includes(host)) {
        if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
        if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'port' };
        return { ok: true, url };
    }

    if (opts.allowDev) {
        const devHosts = new Set([...LOOPBACK, ...(opts.devHosts ?? []).map(h => h.toLowerCase())]);
        if (devHosts.has(host)) {
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme' };
            return { ok: true, url };
        }
    }
    return { ok: false, reason: 'host' };
}

/** Hostnames the dev build may upload to besides media.* (see the module doc). */
export function devUploadHosts(devServerUrl: string | undefined, apiHostOverride: string | undefined): string[] {
    const out: string[] = [];
    if (devServerUrl) { try { out.push(new URL(devServerUrl).hostname); } catch { /* ignore */ } }
    if (apiHostOverride) {
        try { out.push(new URL(`http://${apiHostOverride}`).hostname); } catch { /* ignore */ }
    }
    return out;
}
