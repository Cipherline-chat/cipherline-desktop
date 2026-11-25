/**
 * Reading a media link on the SENDER (main; 2026-11-24, embeds-media-everywhere).
 *
 *   probeMedia(url)        a RANGED GET of the first PROBE_BYTES (Range:
 *                          bytes=0-…) and media-sniff.ts on them: what the file
 *                          really is (by its bytes, whatever its extension or
 *                          Content-Type says), its size, animation, duration,
 *                          tracks, and its total length (Content-Range /
 *                          Content-Length). A server that ignores Range (Tenor
 *                          sends a whole 9.5 MB GIF) is cut off at PROBE_BYTES.
 *   fetchMediaCopy(url)    the WHOLE file, for the copy a sender attaches when
 *                          the link expires (a Discord CDN attachment): refused
 *                          up front when its declared length is over the cap,
 *                          cut off the moment it passes it, and its bytes must
 *                          sniff as the media type the probe found.
 *
 * Same fetch rules as every unfurl request (pinned-fetch.ts): https only,
 * every redirect hop re-checked, every DNS answer checked against private
 * ranges and pinned, no cookies / auth / referrer, a generic UA.
 */
import { openPinned, EMBED_FETCH_UA, type FetchDeps } from '../media-embed/pinned-fetch';
import { sniffMedia, type MediaFacts } from './media-sniff';

/** The first bytes read to tell what a file is (an mp4's index, when it is at the front, is usually within this). */
export const PROBE_BYTES = 256 * 1024;
export const PROBE_TIMEOUT_MS = 4000;
/** A copy download may take this long in all (a 25 MB file at ~7 Mbit/s). */
export const COPY_TIMEOUT_MS = 30_000;

export type ProbeResult =
    | {
        ok: true;
        status: number;
        finalUrl: string;
        /** The Content-Type the server declared (lower-case, no parameters). */
        contentType: string;
        /** The file's whole length, when the server said. */
        total?: number;
        /** What the bytes are; null when they are not media (an HTML page, a JSON error). */
        facts: MediaFacts | null;
        /** The bytes read (at most PROBE_BYTES). `whole`: that is the entire file. */
        head: Uint8Array;
        whole: boolean;
    }
    | { ok: false; status?: number; reason: 'http' | 'network' };

export interface ProbeOptions { maxBytes?: number; timeoutMs?: number; userAgent?: typeof EMBED_FETCH_UA }

function totalOf(status: number, headers: Record<string, unknown>): number | undefined {
    const range = String(headers['content-range'] ?? '');
    const m = /\/(\d{1,15})\s*$/.exec(range);
    if (status === 206 && m) return Number(m[1]);
    const len = Number(headers['content-length'] ?? NaN);
    return status === 200 && Number.isFinite(len) && len >= 0 ? len : undefined;
}

/** Read at most `max` bytes of `res`, then stop the request. */
function readCapped(res: import('http').IncomingMessage, req: import('http').ClientRequest, max: number, deadlineMs: number, overflow: 'cut' | 'fail'): Promise<{ bytes: Uint8Array; ended: boolean }> {
    return new Promise((ok, fail) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = (ended: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!ended) req.destroy();
            const buf = Buffer.concat(chunks).subarray(0, max);
            ok({ bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), ended });
        };
        const stop = (e: Error) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); fail(e); };
        const timer = setTimeout(() => (overflow === 'cut' ? finish(false) : stop(new Error('Request timed out'))), Math.max(0, deadlineMs));
        res.on('data', (c: Buffer) => {
            if (done) return;
            total += c.length;
            chunks.push(c);
            if (overflow === 'fail') { if (total > max) stop(new Error('Too large')); } else if (total >= max) finish(false);
        });
        res.on('end', () => finish(true));
        res.on('error', (e) => stop(e));
    });
}

/** The first bytes of a link and what they are. Never throws. */
export async function probeMedia(url: string, deps: { fetchDeps?: FetchDeps } = {}, opts: ProbeOptions = {}): Promise<ProbeResult> {
    const max = opts.maxBytes ?? PROBE_BYTES;
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    const started = Date.now();
    try {
        const { res, req, finalUrl } = await openPinned(url, {
            headers: { Accept: 'image/avif,image/webp,image/*,video/*;q=0.9,*/*;q=0.5', Range: `bytes=0-${max - 1}` },
            maxRedirects: 5,
            headersTimeoutMs: timeoutMs,
            userAgent: opts.userAgent,
        }, deps.fetchDeps);
        const status = res.statusCode ?? 0;
        if (status !== 200 && status !== 206) {
            res.resume();
            req.destroy();
            return { ok: false, status, reason: 'http' };
        }
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const total = totalOf(status, res.headers as Record<string, unknown>);
        const { bytes, ended } = await readCapped(res, req, max, timeoutMs - (Date.now() - started), 'cut');
        const whole = (total !== undefined && bytes.byteLength >= total) || (ended && status === 200);
        return { ok: true, status, finalUrl, contentType, ...(total !== undefined ? { total } : {}), facts: sniffMedia(bytes), head: bytes, whole };
    } catch {
        return { ok: false, reason: 'network' };
    }
}

export type CopyResult = { ok: true; bytes: Uint8Array; facts: MediaFacts } | { ok: false; reason: 'too-large' | 'http' | 'not-media' | 'mismatch' | 'failed' };

/**
 * The whole file, at most `maxBytes`, whose bytes must sniff as `expectMime`
 * (the probe's finding: a link that changed into something else is refused).
 * Never throws.
 */
export async function fetchMediaCopy(url: string, maxBytes: number, expectMime: string, deps: { fetchDeps?: FetchDeps } = {}, timeoutMs = COPY_TIMEOUT_MS): Promise<CopyResult> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) return { ok: false, reason: 'too-large' };
    const started = Date.now();
    try {
        const { res, req } = await openPinned(url, {
            headers: { Accept: 'image/*,video/*;q=0.9,*/*;q=0.5' },
            maxRedirects: 5,
            headersTimeoutMs: Math.min(timeoutMs, PROBE_TIMEOUT_MS * 2),
        }, deps.fetchDeps);
        const status = res.statusCode ?? 0;
        if (status !== 200) { res.resume(); req.destroy(); return { ok: false, reason: 'http' }; }
        const declared = Number(res.headers['content-length'] ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) { req.destroy(); return { ok: false, reason: 'too-large' }; }
        let got: { bytes: Uint8Array; ended: boolean };
        try {
            got = await readCapped(res, req, maxBytes, timeoutMs - (Date.now() - started), 'fail');
        } catch (e) {
            return { ok: false, reason: e instanceof Error && e.message === 'Too large' ? 'too-large' : 'failed' };
        }
        if (!got.ended) return { ok: false, reason: 'too-large' };
        const facts = sniffMedia(got.bytes);
        if (!facts) return { ok: false, reason: 'not-media' };
        if (facts.mime !== expectMime) return { ok: false, reason: 'mismatch' };
        return { ok: true, bytes: got.bytes, facts };
    } catch {
        return { ok: false, reason: 'failed' };
    }
}
