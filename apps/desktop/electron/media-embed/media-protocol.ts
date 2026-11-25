/**
 * clmedia:// — streams a remote media file to the renderer with HTTP Range
 * support, so an inline video starts in about a second and seeks without
 * downloading the whole file (docs/plans/embeds.md §6).
 *
 * Why a protocol and not a fetch-to-blob: a 40-80 MB clip would have to be
 * downloaded in full (and held in memory) before the first frame. The
 * renderer CSP keeps `media-src` to `'self' blob: clmedia:` instead of
 * opening it to the internet, and clmedia only reaches URLs the renderer
 * registered for an embed it is showing (media-registry.ts).
 *
 * Every request:
 *   - names a registered token, or it is a 404 with no network request;
 *   - goes out through openPinned (pinned-fetch.ts): https only, every hop's
 *     addresses checked against private/loopback/link-local ranges and pinned,
 *     ≤ 5 redirects, no cookies, no referrer, generic UA;
 *   - forwards ONLY a single well-formed `Range: bytes=a-b` header;
 *   - must come back as an allowed image/* or video/* type (a CDN's
 *     octet-stream is accepted only for a path with a video/image extension,
 *     and re-labelled from that extension), under a size cap, with a deadline
 *     for the headers and an idle timeout while streaming.
 *
 * No `electron` import: main.ts registers the scheme and hands Electron's
 * `protocol.handle` the function `createClmediaHandler` returns.
 * Logging (dev only) carries the token prefix, status and range, never the URL.
 */
import { openPinned, type FetchDeps } from './pinned-fetch';
import type { MediaEntry, MediaRegistry } from './media-registry';

export const VIDEO_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
export const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const EXT_TYPES: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
};
const OCTET = new Set(['application/octet-stream', 'binary/octet-stream']);

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 GiB per file
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const HEADERS_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const RANGE_RE = /^bytes=(\d{1,15})-(\d{0,15})$/;
const CONTENT_RANGE_RE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/;

export interface ClmediaDeps extends FetchDeps {
    log?: (line: string) => void;
    idleTimeoutMs?: number;
    /**
     * The app's own renderer origin(s) (2026-11-24, embeds-always-thumb). A
     * request from one gets `Access-Control-Allow-Origin` for it, so the
     * SENDER's frame grab (a `crossOrigin = 'anonymous'` <video>) can draw a
     * frame onto a canvas and re-encode it without tainting the canvas. Any
     * other origin (a player iframe, a page) gets no CORS header: it can still
     * not read a single pixel, and still has no token to name a file.
     */
    allowOrigin?: (origin: string) => boolean;
}

/** A single, well-formed byte range, or null (anything else is not forwarded). */
export function forwardableRange(raw: string | null): string | null {
    if (!raw) return null;
    const v = raw.trim();
    const m = RANGE_RE.exec(v);
    if (!m) return null;
    if (m[2] !== '' && Number(m[2]) < Number(m[1])) return null;
    return v;
}

/** The type to serve for an upstream response, or null to refuse it. */
export function servedType(entry: MediaEntry, upstreamType: string, finalUrl: string): string | null {
    const t = upstreamType.split(';')[0].trim().toLowerCase();
    const allowed = entry.kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
    if (allowed.has(t)) return t === 'video/x-m4v' ? 'video/mp4' : t;
    if (OCTET.has(t) || t === '') {
        let ext = '';
        try { ext = (/\.([a-z0-9]{2,5})$/i.exec(new URL(finalUrl).pathname)?.[1] ?? '').toLowerCase(); } catch { return null; }
        const byExt = EXT_TYPES[ext];
        return byExt && allowed.has(byExt) ? byExt : null;
    }
    return null;
}

function empty(status: number, extra: Record<string, string> = {}): Response {
    return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
}

/** CORS for the app's own renderer only (see ClmediaDeps.allowOrigin). */
export function corsHeaders(req: Request, allowOrigin?: (origin: string) => boolean): Record<string, string> {
    const origin = req.headers.get('origin');
    if (!origin || !allowOrigin || origin === 'null' || !allowOrigin(origin)) return {};
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

export function createClmediaHandler(registry: MediaRegistry, deps: ClmediaDeps = {}): (req: Request) => Promise<Response> {
    const log = deps.log;
    const idleMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    return async (req: Request): Promise<Response> => {
        const tag = (() => { try { return new URL(req.url).pathname.slice(1, 9); } catch { return '?'; } })();
        if (req.method !== 'GET' && req.method !== 'HEAD') return empty(405);
        const cors = corsHeaders(req, deps.allowOrigin);
        const entry = registry.lookup(req.url);
        if (!entry) { log?.(`[clmedia] ${tag} 404 unregistered`); return empty(404, cors); }
        // A frame grab's byte budget is spent: no more requests for it.
        if (entry.budget && entry.budget.left <= 0) { log?.(`[clmedia] ${tag} 429 budget spent`); return empty(429, cors); }
        const range = forwardableRange(req.headers.get('range'));

        let opened;
        try {
            opened = await openPinned(entry.url, {
                headers: {
                    Accept: entry.kind === 'video' ? 'video/*;q=1,*/*;q=0.5' : 'image/*;q=1,*/*;q=0.5',
                    ...(range ? { Range: range } : {}),
                },
                maxRedirects: MAX_REDIRECTS,
                headersTimeoutMs: HEADERS_TIMEOUT_MS,
            }, deps);
        } catch (e) {
            log?.(`[clmedia] ${tag} 502 ${(e as Error).message}`);
            return empty(502, cors);
        }
        const { res, req: upstream, finalUrl } = opened;
        const status = res.statusCode ?? 0;
        const drop = (code: number, why: string) => {
            res.resume();
            upstream.destroy();
            log?.(`[clmedia] ${tag} ${code} ${why}`);
            return empty(code, cors);
        };
        if (status === 416) {
            const cr = String(res.headers['content-range'] ?? '');
            res.resume();
            upstream.destroy();
            return new Response(null, { status: 416, headers: { ...cors, ...(CONTENT_RANGE_RE.test(cr) || /^bytes \*\/\d{1,15}$/.test(cr) ? { 'Content-Range': cr } : {}) } });
        }
        if (status !== 200 && status !== 206) return drop(502, `upstream ${status}`);

        const type = servedType(entry, String(res.headers['content-type'] ?? ''), finalUrl);
        if (!type) return drop(415, 'refused content type');

        const cap = entry.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        const lengthRaw = String(res.headers['content-length'] ?? '');
        const length = /^\d{1,15}$/.test(lengthRaw) ? Number(lengthRaw) : null;
        const crRaw = String(res.headers['content-range'] ?? '');
        const cr = CONTENT_RANGE_RE.exec(crRaw);
        if (status === 206 && !cr) return drop(502, 'bad content-range');
        const total = cr ? (cr[3] === '*' ? null : Number(cr[3])) : length;
        if ((total !== null && total > cap) || (length !== null && length > cap)) return drop(413, 'too large');

        const headers: Record<string, string> = {
            'Content-Type': type,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...cors,
        };
        if (length !== null) headers['Content-Length'] = String(length);
        if (cr) headers['Content-Range'] = crRaw;
        if (status === 206 || String(res.headers['accept-ranges'] ?? '').toLowerCase() === 'bytes') headers['Accept-Ranges'] = 'bytes';
        log?.(`[clmedia] ${tag} ${status} range=${range ?? '-'} ${cr ? crRaw : `len=${length ?? '?'}`}${entry.budget ? ` budget=${entry.budget.left}` : ''}`);

        if (req.method === 'HEAD') { res.resume(); upstream.destroy(); return new Response(null, { status, headers }); }

        const limit = length ?? cap;
        let sent = 0;
        // The idle timer runs only while we are WAITING on the host; while the
        // player has enough buffered (back-pressure, upstream paused) it is off.
        let idle: ReturnType<typeof setTimeout> | null = null;
        let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
        const disarm = () => { if (idle) { clearTimeout(idle); idle = null; } };
        // A frame grab's stream: how much it really took (dev log; never the URL).
        let reported = false;
        const report = (how: string) => { if (entry.budget && !reported) { reported = true; log?.(`[clmedia] ${tag} grab ${how} sent=${sent}`); } };
        const arm = () => {
            disarm();
            idle = setTimeout(() => { upstream.destroy(); try { ctl?.error(new Error('idle timeout')); } catch { /* closed */ } }, idleMs);
        };
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                ctl = controller;
                arm();
                res.on('data', (chunk: Buffer) => {
                    sent += chunk.length;
                    if (entry.budget) entry.budget.left -= chunk.length;
                    if (sent > limit || (entry.budget && entry.budget.left < 0)) {
                        disarm();
                        report('cut');
                        upstream.destroy();
                        controller.error(new Error('size cap'));
                        return;
                    }
                    controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    if ((controller.desiredSize ?? 1) <= 0) { res.pause(); disarm(); } else arm();
                });
                res.on('end', () => { disarm(); report('end'); try { controller.close(); } catch { /* already errored */ } });
                res.on('error', (e) => { disarm(); try { controller.error(e); } catch { /* already closed */ } });
            },
            pull() { if (res.isPaused()) { res.resume(); arm(); } },
            cancel() { disarm(); report('cancelled'); upstream.destroy(); },
        }, { highWaterMark: 2 * 1024 * 1024, size: (c) => c.byteLength });
        return new Response(body, { status, headers });
    };
}
