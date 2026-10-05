/**
 * instance-handoff.ts — how a second Cipherline launch gets out of the way.
 *
 * The renderer is served from a FIXED loopback port so its origin is stable
 * across launches (a random port would give a new origin every run, and
 * Chromium keys localStorage + IndexedDB on host+port — auth tokens, keys and
 * caches would be wiped each time). The cost of a fixed port is that a second
 * launch can't bind it.
 *
 * `app.requestSingleInstanceLock()` is supposed to stop a second launch before
 * it gets that far, and usually does. But it's a per-app OS mutex, and when it
 * fails to hold — a previous copy still owning the socket after losing its
 * mutex, a launch through a different app path, a fresh profile the OS didn't
 * grant the mutex on — the old code fell through to the bind, hit EADDRINUSE,
 * and showed the user an error box telling them Cipherline was already running.
 * Which it was. Sitting right there, minimised, where they wanted it.
 *
 * So the port that causes the collision is also the way out of it: the running
 * instance answers a POST on it, raises its window, takes any deep link the new
 * launch was carrying, and the new launch exits without a word.
 */

import * as http from 'http';

/** Path the running instance answers. Deliberately not a real file in dist/,
 *  and matched before the server's SPA fallback (which answers every unknown
 *  path with index.html — hence the signature check below). */
export const FOCUS_ENDPOINT = '/__cipherline/focus';

/** Proof that the thing on the port is us and not some other program that
 *  happens to serve 200s. */
export const HANDOFF_SIGNATURE = 'cipherline';

/** Nothing legitimate posts more than a short deep-link URL. */
export const MAX_HANDOFF_BODY = 4096;

/**
 * Should the local server act on this request?
 *
 * The endpoint is loopback-only, but so is every web page in every browser on
 * the machine. A page can't be stopped from *sending* to loopback, so instead:
 * POST only, and refuse anything carrying the headers a browser attaches to a
 * cross-site request. Our own second instance sends neither.
 *
 * Worth being precise about what's at stake: the capability here is "raise a
 * window and hand over a cipherline:// URL", which any local process already
 * has via the registered protocol handler. This adds no authority that wasn't
 * already there, and an invite delivered this way still lands on a modal the
 * user has to accept.
 */
export function isTrustedHandoffRequest(
    method: string | undefined,
    headers: Record<string, unknown>,
): boolean {
    if (method !== 'POST') return false;
    if (headers['origin']) return false;
    if (headers['sec-fetch-site']) return false;
    return true;
}

/** Body shape both sides agree on. */
export function encodeHandoffBody(deepLink: string | null): string {
    return JSON.stringify({ url: deepLink });
}

/** Pull the deep link back out, tolerating anything malformed. */
export function decodeHandoffBody(body: string): string | null {
    try {
        const url = JSON.parse(body || '{}')?.url;
        return typeof url === 'string' ? url : null;
    } catch {
        return null;
    }
}

/** What the running instance replies with. */
export function handoffResponseBody(): string {
    return JSON.stringify({ ok: true, app: HANDOFF_SIGNATURE });
}

/**
 * Ask an already-running Cipherline to come to the front, handing it whatever
 * deep link this launch was carrying.
 *
 * Resolves true ONLY if something answered with our signature — i.e. the port
 * really is held by Cipherline and the window has been raised. A foreign
 * program on the port, or nothing at all, resolves false, and the caller is
 * expected to say something accurate rather than blame a Cipherline that isn't
 * there.
 */
export function handOffToRunningInstance(
    port: number,
    deepLink: string | null,
    timeoutMs = 1500,
): Promise<boolean> {
    return new Promise((resolve) => {
        const payload = encodeHandoffBody(deepLink);
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: FOCUS_ENDPOINT,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
                timeout: timeoutMs,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => {
                    body += c;
                    if (body.length > MAX_HANDOFF_BODY) { body = ''; res.destroy(); }
                });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)?.app === HANDOFF_SIGNATURE); }
                    catch { resolve(false); }
                });
                res.on('error', () => resolve(false));
            },
        );
        req.on('error',   () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end(payload);
    });
}
