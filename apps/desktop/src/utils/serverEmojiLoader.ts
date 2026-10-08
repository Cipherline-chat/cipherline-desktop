/**
 * Custom server emoji images: memory cache → encrypted disk cache → batched
 * network, with a process-wide concurrency cap.
 *
 * ── Why this is not useEncryptedAvatar any more ───────────────────────────
 * Emojis used to load through the avatar hook, one instance per <img>. That
 * hook is built for "a few avatars on screen": every cold emoji spent its own
 * `GET /attachments/:id/download` (from the account's shared 300/min API
 * budget) plus a media GET, with no concurrency cap, so opening a server with
 * 100 un-cached emojis fired 100 API requests at once — a third of the whole
 * account's minute — and anything that hit a 429 sat on the avatar retry
 * schedule (1.2 s / 4 s / 12 s). With emojis no longer capped at 50 per
 * server, that only gets worse.
 *
 * Here, every emoji requested in the same tick is collected into ONE batch:
 *   1. memory hit            → synchronous (`peekEmojiUrl`), no work at all;
 *   2. encrypted disk cache  → the SAME IndexedDB blob store avatars use
 *      (`attachmentCache.putAvatarBlob`, wrapped with the device blob-cache
 *      key — never plaintext at rest), tagged `kind: 'emoji'` so emojis get
 *      their own prune budget instead of evicting avatars;
 *   3. network               → ONE `POST /attachments/emoji-downloads` per
 *      100 emojis of a server for the presigned URLs, then the media GETs
 *      through a pool sized to the media host's protocol (see
 *      mediaConcurrencyFor), visible requests
 *      ahead of background prefetch.
 * Decrypt runs off the UI thread (utils/crypto → attachmentCryptoWorker).
 *
 * An API that predates the batch route (404/405) falls back to the old
 * per-emoji download route, still through the same bounded pool.
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { importKeyFromBase64, decryptBlob } from './crypto';
import { getAvatarBlob, putAvatarBlob, deleteAvatarBlob } from './attachmentCache';

export interface EmojiImageRef {
    /** Owning server — lets the batch route sign many emojis at once. Null
     *  falls back to the per-emoji route. */
    serverId: string | null;
    attachmentId: string;
    keyB64: string;
    nonceB64: string;
}

export type EmojiPriority = 'visible' | 'prefetch';

/**
 * Media downloads in flight at once, process-wide — ADAPTIVE to the media
 * host's protocol. These are presigned GETs of tiny objects straight from
 * object storage: no API work, no throttle budget.
 *
 *  - HTTP/2 or HTTP/3 (prod: media.cipherline.chat sits behind Cloudflare and
 *    answers HTTP/2) multiplexes every request over one connection, so an app
 *    cap only adds round-trips: the old unbounded path beat a 16-wide pool on
 *    a cold 100-emoji server (195 ms vs 499 ms in the latency model). There
 *    the cap is EMOJI_MULTIPLEXED_CONCURRENCY, which is just a runaway guard
 *    (Cloudflare's own stream limit is 256).
 *  - HTTP/1.1 (plain-http hosts such as dev MinIO, or an https host whose
 *    resource-timing entry says `http/1.1`) — Chromium allows 6 sockets per
 *    host anyway, so the pool matches it; keeping the queue HERE rather than
 *    in the browser is what lets visible emojis jump background prefetch.
 */
export const EMOJI_MULTIPLEXED_CONCURRENCY = 1024;
export const EMOJI_HTTP1_CONCURRENCY = 6;
/** Old-API fallback: one download-URL API request per emoji, so this one IS
 *  throttle-relevant and stays small. */
export const EMOJI_FALLBACK_API_CONCURRENCY = 6;

/** Media protocol learned per origin from the first response's resource-timing
 *  entry. Absent = not learned yet: https is assumed multiplexed (true of
 *  every production host), plain http is always HTTP/1.1 in Chromium. */
const originProtocol = new Map<string, string>();
/** Origins already looked up — the lookup runs once per origin, not per file. */
const protocolProbed = new Set<string>();

function originOf(url: string): string {
    try { return new URL(url).origin; } catch { return ''; }
}

/** Concurrency cap for downloads from `url`'s origin. Exported for tests. */
export function mediaConcurrencyFor(url: string): number {
    const origin = originOf(url);
    const learned = originProtocol.get(origin);
    if (learned) return /^http\/1/i.test(learned) ? EMOJI_HTTP1_CONCURRENCY : EMOJI_MULTIPLEXED_CONCURRENCY;
    return url.startsWith('https:') ? EMOJI_MULTIPLEXED_CONCURRENCY : EMOJI_HTTP1_CONCURRENCY;
}

/** Record the protocol a finished download actually used (cheap: one
 *  resource-timing lookup, once per origin). Cross-origin entries may report
 *  an empty string — that leaves the scheme-based default in place. */
function learnProtocol(url: string): void {
    const origin = originOf(url);
    if (!origin || protocolProbed.has(origin)) return;
    protocolProbed.add(origin);
    try {
        const entries = (globalThis.performance?.getEntriesByName?.(url) ?? []) as PerformanceResourceTiming[];
        const proto = entries[entries.length - 1]?.nextHopProtocol;
        if (proto) originProtocol.set(origin, proto);
    } catch { /* no resource timing — keep the default */ }
}

/** IndexedDB reads + unwraps in flight at once (local, cheap). */
export const EMOJI_DISK_CONCURRENCY = 128;
/** Must match the API's AttachmentsService.MAX_EMOJI_BATCH. */
export const EMOJI_URL_BATCH = 100;
/** Background prefetch per server list — the rest load on demand. */
export const EMOJI_PREFETCH_LIMIT = 200;

// ── State ────────────────────────────────────────────────────────────────
const memory = new Map<string, string>();
/** Byte size behind each cached emoji URL (browser-process Blob bytes).
 *  Diagnostics only (memoryReport.ts). */
const memoryBytes = new Map<string, number>();
const blobUrl = (id: string, blob: Blob): string => { memoryBytes.set(id, blob.size); return URL.createObjectURL(blob); };
/** Session emoji image cache footprint, for the Performance log. */
export function emojiCacheStats(): { entries: number; bytes: number } {
    let bytes = 0;
    for (const [id, b] of memoryBytes) if (memory.has(id)) bytes += b;
    return { entries: memory.size, bytes };
}
const inflight = new Map<string, Promise<string | null>>();
const listeners = new Map<string, Set<(url: string) => void>>();

interface Pending {
    ref: EmojiImageRef;
    priority: EmojiPriority;
    resolve: (url: string | null) => void;
}
let pending: Pending[] = [];
let flushScheduled = false;

// Test hooks / instrumentation ------------------------------------------------
let apiRequests = 0;
let mediaRequests = 0;
/** Exported for tests only. */
export function __emojiLoaderStats() { return { apiRequests, mediaRequests, memory: memory.size }; }
/** Exported for tests only — module state survives between scenarios otherwise. */
export function __resetEmojiLoader(): void {
    for (const url of memory.values()) { try { URL.revokeObjectURL(url); } catch { /* not a blob url */ } }
    memory.clear(); memoryBytes.clear(); inflight.clear(); listeners.clear(); pending = [];
    flushScheduled = false; apiRequests = 0; mediaRequests = 0;
    downloadQueue.visible.length = 0; downloadQueue.prefetch.length = 0; activeDownloads = 0;
    originProtocol.clear();
    protocolProbed.clear();
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Synchronous memory-cache lookup — what a component's first render uses. */
export function peekEmojiUrl(attachmentId: string | null | undefined): string | null {
    return attachmentId ? memory.get(attachmentId) ?? null : null;
}

/** Called whenever `attachmentId` resolves (by anyone). Returns unsubscribe. */
export function subscribeEmojiUrl(attachmentId: string, cb: (url: string) => void): () => void {
    let set = listeners.get(attachmentId);
    if (!set) { set = new Set(); listeners.set(attachmentId, set); }
    set.add(cb);
    return () => {
        const s = listeners.get(attachmentId);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) listeners.delete(attachmentId);
    };
}

/** Resolve one emoji to an object URL (null on failure). Batched with every
 *  other request made in the same tick. */
export function loadEmojiUrl(ref: EmojiImageRef, token: string, priority: EmojiPriority = 'visible'): Promise<string | null> {
    const hit = memory.get(ref.attachmentId);
    if (hit) return Promise.resolve(hit);
    const existing = inflight.get(ref.attachmentId);
    if (existing) {
        // A visible request upgrades a queued prefetch of the same emoji.
        if (priority === 'visible') promoteDownload(ref.attachmentId);
        return existing;
    }
    const p = new Promise<string | null>(resolve => {
        pending.push({ ref, priority, resolve });
    }).finally(() => { inflight.delete(ref.attachmentId); });
    inflight.set(ref.attachmentId, p);
    scheduleFlush(token);
    return p;
}

/** Fire-and-forget batch. */
export function loadEmojiUrls(refs: EmojiImageRef[], token: string, priority: EmojiPriority = 'visible'): Promise<Array<string | null>> {
    return Promise.all(refs.map(r => loadEmojiUrl(r, token, priority)));
}

/**
 * Warm a server's emojis right after its list arrives, so the picker and
 * messages paint from memory. Disk hits cost no requests; misses go to the
 * network at prefetch priority (behind anything visible), capped at
 * EMOJI_PREFETCH_LIMIT per call — the rest load when something shows them.
 */
export function prefetchServerEmojis(
    serverId: string,
    emojis: Array<{ attachment_id: string; key_b64: string; nonce_b64: string }>,
    token: string,
): void {
    const refs = emojis
        .filter(e => !memory.has(e.attachment_id))
        .slice(0, EMOJI_PREFETCH_LIMIT)
        .map(e => ({ serverId, attachmentId: e.attachment_id, keyB64: e.key_b64, nonceB64: e.nonce_b64 }));
    if (refs.length) void loadEmojiUrls(refs, token, 'prefetch');
}

/** Forget an emoji image that failed to decode in <img>, so the next load
 *  refetches instead of re-serving the same bad bytes. */
export function evictEmoji(attachmentId: string): void {
    const url = memory.get(attachmentId);
    if (url) { memory.delete(attachmentId); memoryBytes.delete(attachmentId); try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
    deleteAvatarBlob(attachmentId).catch(() => {});
}

// ── Pipeline ───────────────────────────────────────────────────────────────

function scheduleFlush(token: string): void {
    if (flushScheduled) return;
    flushScheduled = true;
    // A microtask: React runs every passive effect of one commit in a single
    // synchronous pass, so all EmojiImages mounted together have queued their
    // requests before this runs — one batch, with no timer delay added to
    // the critical path (a setTimeout(0) cost ~4-10 ms here under load).
    queueMicrotask(() => {
        flushScheduled = false;
        const batch = pending;
        pending = [];
        void processBatch(batch, token);
    });
}

function settle(p: Pending, url: string | null): void {
    if (url) {
        memory.set(p.ref.attachmentId, url);
        const subs = listeners.get(p.ref.attachmentId);
        if (subs) for (const cb of [...subs]) { try { cb(url); } catch { /* listener bug, not ours */ } }
    }
    p.resolve(url);
}

async function runPool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

async function processBatch(batch: Pending[], token: string): Promise<void> {
    // 1. Encrypted disk cache.
    const misses: Pending[] = [];
    await runPool(batch, EMOJI_DISK_CONCURRENCY, async (p) => {
        try {
            const blob = await getAvatarBlob(p.ref.attachmentId);
            if (blob) { settle(p, blobUrl(p.ref.attachmentId, blob)); return; }
        } catch { /* unreadable entry — treat as a miss */ }
        misses.push(p);
    });
    if (!misses.length) return;

    // 2. Presigned URLs — one request per server per 100 emojis.
    const byServer = new Map<string | null, Pending[]>();
    for (const p of misses) {
        const k = p.ref.serverId;
        const list = byServer.get(k) ?? [];
        list.push(p);
        byServer.set(k, list);
    }
    const perIdFallback: Pending[] = [];
    await Promise.all([...byServer.entries()].map(async ([serverId, list]) => {
        if (!serverId) { perIdFallback.push(...list); return; }
        // Chunks go out IN PARALLEL — each is one request, and serializing
        // them made a 300-emoji server wait three API round-trips before its
        // last downloads could start. Downloads start per chunk as it lands.
        const chunks: Pending[][] = [];
        for (let i = 0; i < list.length; i += EMOJI_URL_BATCH) chunks.push(list.slice(i, i + EMOJI_URL_BATCH));
        await Promise.all(chunks.map(async (chunk) => {
            try {
                apiRequests++;
                const res = await axios.post<{ urls: Array<{ attachment_id: string; download_url: string; mime_type: string }> }>(
                    `${API_BASE}/attachments/emoji-downloads`,
                    { server_id: serverId, attachment_ids: chunk.map(p => p.ref.attachmentId) },
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                const urls = new Map((res.data?.urls ?? []).map(u => [u.attachment_id, u]));
                for (const p of chunk) {
                    const u = urls.get(p.ref.attachmentId);
                    // Omitted = not this server's live emoji (deleted, or we
                    // are no longer a member). Nothing to retry.
                    if (u) enqueueDownload(p, u.download_url, u.mime_type);
                    else settle(p, null);
                }
            } catch (err: unknown) {
                const status = axios.isAxiosError(err) ? err.response?.status : undefined;
                if (status === 404 || status === 405) {
                    // API predates the batch route — per-emoji route instead.
                    perIdFallback.push(...chunk);
                } else {
                    for (const p of chunk) settle(p, null);
                }
            }
        }));
    }));

    // 2b. Old-API / no-server fallback: one download-URL request per emoji,
    // still through the bounded pool rather than all at once.
    if (perIdFallback.length) {
        await runPool(perIdFallback, EMOJI_FALLBACK_API_CONCURRENCY, async (p) => {
            try {
                apiRequests++;
                const res = await axios.get(`${API_BASE}/attachments/${p.ref.attachmentId}/download`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                enqueueDownload(p, res.data.download_url, res.data.mime_type);
            } catch {
                settle(p, null);
            }
        });
    }
}

// 3. Media download + decrypt, one shared bounded pool, visible before prefetch.
interface DownloadJob { p: Pending; url: string; mime: string }
const downloadQueue = { visible: [] as DownloadJob[], prefetch: [] as DownloadJob[] };
let activeDownloads = 0;

function enqueueDownload(p: Pending, url: string, mime: string): void {
    downloadQueue[p.priority].push({ p, url, mime });
    pumpDownloads();
}

function promoteDownload(attachmentId: string): void {
    const i = downloadQueue.prefetch.findIndex(j => j.p.ref.attachmentId === attachmentId);
    if (i >= 0) downloadQueue.visible.push(...downloadQueue.prefetch.splice(i, 1));
}

function pumpDownloads(): void {
    for (;;) {
        const head = downloadQueue.visible[0] ?? downloadQueue.prefetch[0];
        if (!head || activeDownloads >= mediaConcurrencyFor(head.url)) return;
        const job = downloadQueue.visible.shift() ?? downloadQueue.prefetch.shift();
        if (!job) return;
        activeDownloads++;
        void runDownload(job).finally(() => { activeDownloads--; pumpDownloads(); });
    }
}

async function runDownload({ p, url, mime }: DownloadJob): Promise<void> {
    try {
        mediaRequests++;
        const blobRes = await axios.get(url, { responseType: 'blob' });
        learnProtocol(url);
        const key = await importKeyFromBase64(p.ref.keyB64);
        const plain = await decryptBlob(blobRes.data, key, p.ref.nonceB64, mime);
        putAvatarBlob(p.ref.attachmentId, plain, { kind: 'emoji' }).catch(e =>
            console.warn('[serverEmojiLoader] IndexedDB persist failed', e),
        );
        settle(p, blobUrl(p.ref.attachmentId, plain));
    } catch {
        settle(p, null);
    }
}
