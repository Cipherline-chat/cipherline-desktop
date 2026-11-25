/**
 * Guarded outbound HTTPS for link embeds (main process).
 *
 * Every request a link embed makes leaves from here, so the rules live in one
 * place (docs/plans/embeds.md §2, §5, §6):
 *   - https only, bounded URL length, no userinfo;
 *   - the host is resolved and EVERY address checked against the private /
 *     loopback / link-local ranges (net-guard.ts), and the connection is
 *     pinned to the checked address so a DNS rebind cannot swap it in between;
 *   - the same check on every redirect hop, with a bounded number of hops;
 *   - no cookies (Node's https never had the browser's cookie jar), no
 *     referrer, no auth headers, one generic browser UA;
 *   - a deadline and a byte cap on everything.
 *
 * No `electron` import: the DNS check and the request function are injectable
 * so the policy is unit-tested without a network (pinned-fetch.test.ts).
 */
import * as https from 'https';
import type { IncomingMessage, RequestOptions, ClientRequest } from 'http';
import { assertPublicHttpUrl, pinnedLookup, type ResolvedTarget } from '../net-guard';

/** The one UA embeds send: a stock desktop Chrome, nothing app-identifying.
 *  Some hosts return no OpenGraph tags to a non-browser UA. */
export const EMBED_FETCH_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * The UA a sender's PAGE read for a link preview tries first: the short
 * link-preview UA Signal Desktop sends ("WhatsApp/2"). Big sites serve their
 * OpenGraph head to link-preview crawlers but a JavaScript bot challenge to an
 * unknown "browser" without JavaScript (measured 2026-11-23: amazon.com,
 * imdb.com, linkedin.com and reddit.com answer the Chrome UA with a challenge
 * or a 403 and the preview UA with the real page). Like EMBED_FETCH_UA it
 * names nothing about Cipherline. unfurl.ts falls back to EMBED_FETCH_UA when
 * this one gets nothing.
 */
export const EMBED_PREVIEW_UA = 'WhatsApp/2';

export const MAX_EMBED_URL_LENGTH = 2048;

/** A response that came back with a non-2xx status (the site answered: it is reachable). */
export class HttpStatusError extends Error {
    constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/**
 * A response of a type the caller did not accept (e.g. an image where a page
 * was expected). `contentType` lets the unfurler read it as media instead.
 * The message stays 'Unexpected content type' (callers match on it).
 */
export class UnexpectedContentTypeError extends Error {
    constructor(readonly contentType: string, readonly finalUrl: string) { super('Unexpected content type'); }
}

export type RequestFn = (url: string, options: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;

export interface FetchDeps {
    /** Resolve + validate the host; must throw for a non-public target. */
    resolve?: (url: string) => Promise<ResolvedTarget>;
    /** https.request (injectable for tests). */
    request?: RequestFn;
}

/** Throws unless `raw` is a bounded https URL without credentials. Returns the parsed href. */
export function assertHttpsUrlShape(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_EMBED_URL_LENGTH) throw new Error('Invalid URL');
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
    if (u.protocol !== 'https:') throw new Error('Only https URLs are fetched');
    if (u.username || u.password) throw new Error('Invalid URL');
    if (u.href.length > MAX_EMBED_URL_LENGTH) throw new Error('Invalid URL');
    return u.href;
}

export interface OpenOptions {
    /** Extra request headers (only ones the caller built itself). */
    headers?: Record<string, string>;
    maxRedirects: number;
    /** Time allowed until the response headers arrive (all hops together). */
    headersTimeoutMs: number;
    /** Optional per-hop host policy (e.g. a provider's own page hosts). */
    hostAllowed?: (hostname: string) => boolean;
    /** EMBED_FETCH_UA (default) or EMBED_PREVIEW_UA; never anything app-identifying. */
    userAgent?: typeof EMBED_FETCH_UA | typeof EMBED_PREVIEW_UA;
}

export interface OpenedResponse {
    res: IncomingMessage;
    req: ClientRequest;
    finalUrl: string;
}

/**
 * Opens a GET and follows redirects, validating and pinning every hop.
 * Resolves with the first non-redirect response (any status); the caller
 * reads or destroys it.
 */
export async function openPinned(rawUrl: string, opts: OpenOptions, deps: FetchDeps = {}): Promise<OpenedResponse> {
    const resolve = deps.resolve ?? assertPublicHttpUrl;
    const request: RequestFn = deps.request ?? (https.request as unknown as RequestFn);
    const deadline = Date.now() + opts.headersTimeoutMs;
    let url = assertHttpsUrlShape(rawUrl);
    for (let hop = 0; ; hop++) {
        const host = new URL(url).hostname.toLowerCase();
        if (opts.hostAllowed && !opts.hostAllowed(host)) throw new Error('Host not allowed');
        const target = await resolve(url);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Request timed out');
        const opened = await new Promise<{ res: IncomingMessage; req: ClientRequest }>((ok, fail) => {
            const req = request(url, {
                method: 'GET',
                lookup: pinnedLookup(target) as unknown as RequestOptions['lookup'],
                headers: {
                    ...(opts.headers ?? {}),
                    'User-Agent': opts.userAgent ?? EMBED_FETCH_UA,
                    'Accept-Encoding': 'identity',
                },
            }, (res) => { clearTimeout(timer); ok({ res, req }); });
            const timer = setTimeout(() => req.destroy(new Error('Request timed out')), remaining);
            req.on('error', (e) => { clearTimeout(timer); fail(e); });
            req.end();
        });
        const status = opened.res.statusCode ?? 0;
        const loc = opened.res.headers.location;
        if (status >= 300 && status < 400 && loc) {
            opened.res.resume();
            opened.req.destroy();
            if (hop >= opts.maxRedirects) throw new Error('Too many redirects');
            let next: string;
            try { next = new URL(loc, url).href; } catch { throw new Error('Bad redirect'); }
            url = assertHttpsUrlShape(next);
            continue;
        }
        return { ...opened, finalUrl: url };
    }
}

export interface TextFetchOptions {
    accept: string;
    /** Allowed media types (lower-case, no parameters). */
    allowedTypes: readonly string[];
    maxBytes: number;
    /** Whole-request deadline (headers AND body). */
    timeoutMs: number;
    maxRedirects: number;
    /** When true a body over maxBytes is cut there; otherwise it is an error. */
    truncate: boolean;
    hostAllowed?: (hostname: string) => boolean;
    userAgent?: OpenOptions['userAgent'];
    /**
     * An HTML page read for its metadata: stop as soon as `</head>` has
     * arrived (the rest of a multi-megabyte page is never downloaded), accept
     * a response without a Content-Type when its first bytes are HTML
     * (amazon.com sends none to the preview UA), and when the deadline hits
     * mid-body return what has arrived (truncated) instead of failing.
     */
    htmlHead?: boolean;
    /** With htmlHead: stop at this instead of `</head>` (a page whose picture sits in its body). */
    stopAt?: RegExp;
}

export interface TextResult { text: string; finalUrl: string; truncated: boolean; status: number }

const HEAD_END_RE = /<\/head\s*>/i;
/** The first bytes of a response look like an HTML document. */
export function looksLikeHtml(first: string): boolean {
    return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>]|head[\s>])/i.test(first.slice(0, 2048));
}

/** A small text document (an HTML page head, an oEmbed JSON) under the rules above. */
export async function fetchTextPinned(rawUrl: string, opts: TextFetchOptions, deps: FetchDeps = {}): Promise<TextResult> {
    const started = Date.now();
    const { res, req, finalUrl } = await openPinned(rawUrl, {
        headers: { Accept: opts.accept },
        maxRedirects: opts.maxRedirects,
        headersTimeoutMs: opts.timeoutMs,
        hostAllowed: opts.hostAllowed,
        userAgent: opts.userAgent,
    }, deps);
    const status = res.statusCode ?? 0;
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    // An untyped HTML head is sniffed below (its first bytes must be HTML).
    const untyped = !!opts.htmlHead && type === '';
    if (status < 200 || status >= 300 || (!opts.allowedTypes.includes(type) && !untyped)) {
        res.resume();
        req.destroy();
        if (status < 200 || status >= 300) throw new HttpStatusError(status);
        throw new UnexpectedContentTypeError(type, finalUrl);
    }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (!opts.truncate && declared > opts.maxBytes) { req.destroy(); throw new Error('Response too large'); }
    return await new Promise<TextResult>((ok, fail) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        // Where the `</head>` search resumes (a tag split across chunks is still found).
        let scanFrom = 0;
        const finish = (truncated: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const text = Buffer.concat(chunks).toString('utf8');
            if (untyped && !looksLikeHtml(text)) { fail(new Error('Unexpected content type')); return; }
            ok({ text, finalUrl, truncated, status });
        };
        const timer = setTimeout(() => {
            if (done) return;
            req.destroy();
            // A page head that is still arriving: what is here may already hold the metadata.
            if (opts.htmlHead && total > 0) { finish(true); return; }
            done = true;
            fail(new Error('Request timed out'));
        }, Math.max(0, opts.timeoutMs - (Date.now() - started)));
        res.on('data', (c: Buffer) => {
            if (done) return;
            const room = opts.maxBytes - total;
            if (c.length > room) {
                if (!opts.truncate) { done = true; clearTimeout(timer); req.destroy(); fail(new Error('Response too large')); return; }
                chunks.push(c.subarray(0, room));
                total += room;
                req.destroy();
                finish(true);
                return;
            }
            chunks.push(c);
            total += c.length;
            if (opts.htmlHead) {
                const all = Buffer.concat(chunks);
                const tail = all.subarray(Math.max(0, scanFrom - 256)).toString('latin1');
                scanFrom = all.length;
                if ((opts.stopAt ?? HEAD_END_RE).test(tail)) { req.destroy(); finish(true); }
            }
        });
        res.on('end', () => finish(false));
        res.on('error', (e) => {
            if (done) return;
            if (opts.htmlHead && total > 0) { finish(true); return; }
            done = true; clearTimeout(timer); fail(e);
        });
    });
}
