/**
 * IPC surface of the sender-side unfurler (main process).
 *
 *   embed:unfurl  url → UnfurlResult (unfurl.ts): a draft embed + the preview
 *                 image's bytes, or { ok: false, reason }.
 *
 * Pure of `electron` (ipcMain is injected) so the contract is unit-tested;
 * main.ts wires it. The global sender guard (ipc-guard.ts) wraps
 * `ipcMain.handle`, so the channel is origin-checked by construction. The
 * argument is validated in unfurl.ts (a bounded https URL without
 * credentials); anything else is a quiet `{ ok: false }`.
 *
 * At most UNFURL_CONCURRENCY unfurls run at once (a pasted list of links must
 * not open dozens of connections), the same URL asked twice while in flight
 * shares one run, and a finished result is reused for UNFURL_CACHE_TTL_MS so
 * typing around a link does not refetch it. The renderer only calls this
 * while "Generate link previews" is on (Settings → Privacy).
 *
 *   embed:snapshot         (url, token) → SnapshotResult (page-snapshot.ts):
 *                          a picture of a page that has none of its own. ONLY
 *                          for a URL this unfurler returned `snapshot: true`
 *                          (or `snapshotable: true`, 2026-11-24: a provider
 *                          page whose picture may turn out flat or whose frame
 *                          grab may fail) for in the last
 *                          SNAPSHOT_ELIGIBLE_TTL_MS (never a wall, an error
 *                          status, an unreachable host, a bare media file, or a
 *                          URL the renderer made up).
 *   embed:snapshot-cancel  (token) → boolean: drop a queued / running snapshot
 *                          (the link left the draft).
 *   embed:media-copy       (url, maxBytes) → MediaCopyResult (2026-11-24,
 *                          embeds-media-everywhere): the WHOLE media file of an
 *                          expiring link, for the copy the sender attaches. ONLY
 *                          for a URL this unfurler returned a `copy` offer for in
 *                          the last SNAPSHOT_ELIGIBLE_TTL_MS, only the file the
 *                          offer names, at most min(maxBytes, the cap for its
 *                          type), and its bytes must sniff as the offered type.
 *                          At most COPY_CONCURRENCY at once.
 */
import { copyCapFor, unfurlLink, type CopyOffer, type UnfurlDeps, type UnfurlResult } from './unfurl';
import { fetchMediaCopy } from './media-probe';
import { assertHttpsUrlShape } from '../media-embed/pinned-fetch';
import type { SnapshotQueue, SnapshotResult } from './page-snapshot';

export const UNFURL_CHANNEL = 'embed:unfurl';
export const UNFURL_CONCURRENCY = 3;
export const UNFURL_CACHE_TTL_MS = 2 * 60_000;
const UNFURL_CACHE_MAX = 12;
export const SNAPSHOT_CHANNEL = 'embed:snapshot';
export const SNAPSHOT_CANCEL_CHANNEL = 'embed:snapshot-cancel';
export const SNAPSHOT_ELIGIBLE_TTL_MS = 10 * 60_000;
const SNAPSHOT_ELIGIBLE_MAX = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MEDIA_COPY_CHANNEL = 'embed:media-copy';
export const COPY_CONCURRENCY = 2;

export interface IpcMainLike {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface UnfurlIpcDeps extends UnfurlDeps {
    now?: () => number;
    /** Test seam: the unfurl itself. */
    unfurl?: (url: unknown, deps: UnfurlDeps) => Promise<UnfurlResult>;
    /** Dev log line per unfurl (host + outcome, never the full URL). */
    log?: (line: string) => void;
}

export function createUnfurler(deps: UnfurlIpcDeps = {}) {
    const now = deps.now ?? Date.now;
    const run = deps.unfurl ?? unfurlLink;
    const cache = new Map<string, { at: number; result: UnfurlResult }>();
    const inFlight = new Map<string, Promise<UnfurlResult>>();
    let active = 0;
    const waiting: (() => void)[] = [];
    const acquire = () => new Promise<void>((ok) => {
        if (active < UNFURL_CONCURRENCY) { active++; ok(); } else waiting.push(() => { active++; ok(); });
    });
    const release = () => { active--; waiting.shift()?.(); };

    return async function unfurl(url: unknown): Promise<UnfurlResult> {
        if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return { ok: false, reason: 'invalid' };
        const hit = cache.get(url);
        if (hit && now() - hit.at < UNFURL_CACHE_TTL_MS) return hit.result;
        const joined = inFlight.get(url);
        if (joined) return joined;
        const p = (async () => {
            await acquire();
            const t0 = now();
            let result: UnfurlResult;
            try {
                result = await run(url, { fetchDeps: deps.fetchDeps });
            } catch {
                result = { ok: false, reason: 'failed' };
            } finally {
                release();
            }
            if (deps.log) {
                let host = '';
                try { host = new URL(url).hostname; } catch { /* invalid */ }
                deps.log(`[unfurl] ${host} ${result.ok ? `ok ${result.embed.kind}${result.image ? ` image ${result.image.bytes.byteLength}B` : ''}${result.icon ? ' icon' : ''}${result.images?.length ? ` +${result.images.length} pictures` : ''}${result.snapshot ? ' (no picture: snapshot)' : ''}` : result.reason} ${now() - t0}ms`);
            }
            if (result.ok || result.reason !== 'failed') {
                cache.set(url, { at: now(), result });
                while (cache.size > UNFURL_CACHE_MAX) cache.delete(cache.keys().next().value as string);
            }
            return result;
        })();
        inFlight.set(url, p);
        try { return await p; } finally { inFlight.delete(url); }
    };
}

export interface SnapshotIpcDeps {
    snapshotter?: Pick<SnapshotQueue, 'request' | 'cancel'>;
}

/**
 * The snapshot gate: URLs the unfurler marked `snapshot: true`, for a while.
 * Pure (exported for tests).
 */
export function createSnapshotGate(now: () => number = Date.now) {
    const eligible = new Map<string, number>();
    return {
        mark(url: string) {
            eligible.delete(url);
            eligible.set(url, now());
            while (eligible.size > SNAPSHOT_ELIGIBLE_MAX) eligible.delete(eligible.keys().next().value as string);
        },
        allows(url: string): boolean {
            const at = eligible.get(url);
            return at !== undefined && now() - at < SNAPSHOT_ELIGIBLE_TTL_MS;
        },
    };
}

/** The snapshot handlers (exported for tests): argument checks, the gate, then the queue. */
export function createSnapshotHandlers(snapshotter: Pick<SnapshotQueue, 'request' | 'cancel'>, gate: ReturnType<typeof createSnapshotGate>) {
    return {
        async snapshot(url: unknown, token: unknown): Promise<SnapshotResult> {
            if (typeof url !== 'string' || typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, reason: 'invalid' };
            try { assertHttpsUrlShape(url); } catch { return { ok: false, reason: 'invalid' }; }
            if (!gate.allows(url)) return { ok: false, reason: 'not-eligible' };
            const r = await snapshotter.request(url, token);
            // The counters are for the dev log / harness, not the renderer.
            if (r.ok) return { ok: true, bytes: r.bytes, mime: r.mime, width: r.width, height: r.height, ms: r.ms };
            return { ok: false, reason: r.reason };
        },
        cancel(token: unknown): boolean {
            return typeof token === 'string' && TOKEN_RE.test(token) ? snapshotter.cancel(token) : false;
        },
    };
}

export type MediaCopyResult =
    | { ok: true; bytes: Uint8Array; mime: string; width?: number; height?: number; duration_s?: number; has_audio?: boolean; animated?: boolean }
    | { ok: false; reason: string };

/** Copy offers the unfurler made, per link URL, for a while (bounded). Pure (exported for tests). */
export function createCopyGate(now: () => number = Date.now) {
    const offers = new Map<string, { at: number; offer: CopyOffer }>();
    return {
        mark(url: string, offer: CopyOffer) {
            offers.delete(url);
            offers.set(url, { at: now(), offer });
            while (offers.size > SNAPSHOT_ELIGIBLE_MAX) offers.delete(offers.keys().next().value as string);
        },
        offerFor(url: string): CopyOffer | null {
            const hit = offers.get(url);
            return hit && now() - hit.at < SNAPSHOT_ELIGIBLE_TTL_MS ? hit.offer : null;
        },
    };
}

/** The copy handler (exported for tests): argument checks, the gate, the cap, then the download. */
export function createMediaCopyHandler(gate: ReturnType<typeof createCopyGate>, deps: UnfurlDeps & { copy?: typeof fetchMediaCopy } = {}) {
    const fetchCopy = deps.copy ?? fetchMediaCopy;
    let active = 0;
    const waiting: (() => void)[] = [];
    const acquire = () => new Promise<void>((ok) => { if (active < COPY_CONCURRENCY) { active++; ok(); } else waiting.push(() => { active++; ok(); }); });
    const release = () => { active--; waiting.shift()?.(); };
    return async function copy(url: unknown, maxBytes: unknown): Promise<MediaCopyResult> {
        if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return { ok: false, reason: 'invalid' };
        if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0) return { ok: false, reason: 'invalid' };
        const offer = gate.offerFor(url);
        if (!offer) return { ok: false, reason: 'not-eligible' };
        const cap = Math.min(maxBytes, copyCapFor(offer.mime));
        if (offer.bytes !== undefined && offer.bytes > cap) return { ok: false, reason: 'too-large' };
        await acquire();
        try {
            const r = await fetchCopy(offer.mediaUrl, cap, offer.mime, { fetchDeps: deps.fetchDeps });
            if (!r.ok) return { ok: false, reason: r.reason };
            const f = r.facts;
            return {
                ok: true, bytes: r.bytes, mime: f.mime,
                ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
                ...(f.durationS ? { duration_s: f.durationS } : {}),
                ...(f.hasAudio !== undefined ? { has_audio: f.hasAudio } : {}),
                ...(f.animated !== undefined ? { animated: f.animated } : {}),
            };
        } finally {
            release();
        }
    };
}

export function registerUnfurlIpc(ipcMain: IpcMainLike, deps: UnfurlIpcDeps & SnapshotIpcDeps = {}): void {
    const unfurl = createUnfurler(deps);
    const gate = createSnapshotGate(deps.now);
    const copies = createCopyGate(deps.now);
    ipcMain.handle(UNFURL_CHANNEL, async (_e, url) => {
        const r = await unfurl(url);
        if (r.ok && (r.snapshot || r.snapshotable) && typeof url === 'string') gate.mark(url);
        if (r.ok && r.copy && typeof url === 'string') copies.mark(url, r.copy);
        return r;
    });
    const copy = createMediaCopyHandler(copies, { fetchDeps: deps.fetchDeps });
    ipcMain.handle(MEDIA_COPY_CHANNEL, (_e, url, maxBytes) => copy(url, maxBytes));
    if (!deps.snapshotter) return;
    const h = createSnapshotHandlers(deps.snapshotter, gate);
    ipcMain.handle(SNAPSHOT_CHANNEL, (_e, url, token) => h.snapshot(url, token));
    ipcMain.handle(SNAPSHOT_CANCEL_CHANNEL, (_e, token) => h.cancel(token));
}
