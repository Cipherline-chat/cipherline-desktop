/**
 * Durable memory of server emoji / sticker REFERENCES, and by-id resolution of
 * the ones a server's current list no longer has.
 *
 * Why (owner 2026-11-26): "custom emojis and stickers should never delete. Once
 * they're sent it should be like a message." A message names its emoji only by
 * id (`<:name:ID>`; a sticker carries `{ id, server_id, name }`), and the id was
 * resolved to an image through the server's CURRENT list - so deleting the emoji,
 * or one failed list fetch, made every old message using it read "unavailable".
 * The API now RETIRES a deleted emoji instead of destroying it (row + blob kept,
 * served by id), and this module is the client half:
 *
 *   1. Every ref that is actually DISPLAYED is remembered on this device
 *      (`noteDisplayed`) in `secureLocalStore` - AES-256-GCM at rest, per-account
 *      key - so an old message still knows which blob and key its emoji is even
 *      when the list has dropped it or the server is unreachable. The decrypted
 *      IMAGE is already kept by serverEmojiLoader's encrypted disk cache.
 *   2. An id the list lacks and the archive does not know is asked for BY ID
 *      (`requestResolve`: POST /servers/:sid/{emojis,stickers}/resolve, batched,
 *      retired rows included). The answer is archived. Only an authoritative
 *      "the server does not have this id" makes it `missing` (= unavailable).
 *
 * A cache miss, an evicted image, a failed request or a restart is NEVER "deleted":
 * each only leads back to a refetch by id. The archive is capped (LRU by last
 * time shown) so it cannot grow without bound; an evicted ref is simply asked
 * for again.
 *
 * Not in encrypted backups, on purpose (see backupRegistry): every ref is
 * rebuilt from the server by id, which keeps retired assets; the archive is a
 * cache of that answer, not a source of truth.
 */
import axios from 'axios';
import { apiUrl } from './apiPath';
import { secureLocalStore } from './secureLocalStore';
import { pendingAssetIds, isAssetResolvePending } from './assetResolvePending';

export type AssetKind = 'emoji' | 'sticker';

/** What the renderer needs to draw one emoji/sticker (a superset of both list rows' image fields). */
export interface AssetRef {
    id: string;
    kind: AssetKind;
    server_id: string;
    name: string;
    attachment_id: string;
    key_b64: string;
    nonce_b64: string;
    animated: boolean;
    /** The server says this was deleted from its list (kept for old messages). */
    retired: boolean;
}

interface Entry { ref: AssetRef; seen: number }

/** Archive size cap; beyond it the least-recently-shown refs are dropped (and re-asked by id when next needed). */
export const ASSET_REF_CAP = 2000;
const STORAGE_KEY = (uid: string) => `cipherline_server_asset_refs_${uid}`;
/** A ref already stored is re-stamped (and the archive re-persisted) at most this often. */
const TOUCH_MS = 12 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 4_000;
/** Ids per resolve request; matches the API's ArrayMaxSize. */
export const RESOLVE_BATCH = 100;
export const RESOLVE_RETRY_DELAYS_MS = [2_000, 8_000, 20_000, 60_000, 120_000];
const MAX_RESOLVE_RETRIES = 8;
const FLUSH_MS = 40;

// ── state ──────────────────────────────────────────────────────────────────
const entries = new Map<string, Entry>();
let boundUser: string | null = null;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Ids the server authoritatively does not have (session only - never persisted). */
const missing = new Set<string>();
/** Ids queued or in flight (so the UI shows a placeholder, never "unavailable"). */
const pending = pendingAssetIds;
const subscribers = new Set<() => void>();
let version = 0;
const notify = () => { version++; for (const cb of [...subscribers]) cb(); };

export function subscribeAssetRefs(cb: () => void): () => void {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
}
/** Changes whenever an archived/pending/missing fact does (useSyncExternalStore snapshot). */
export const assetRefsVersion = (): number => version;

// ── persistence ────────────────────────────────────────────────────────────
function isRef(x: unknown): x is AssetRef {
    if (!x || typeof x !== 'object') return false;
    const r = x as Record<string, unknown>;
    return typeof r.id === 'string' && (r.kind === 'emoji' || r.kind === 'sticker')
        && typeof r.server_id === 'string' && typeof r.name === 'string'
        && typeof r.attachment_id === 'string' && typeof r.key_b64 === 'string'
        && typeof r.nonce_b64 === 'string' && typeof r.animated === 'boolean' && typeof r.retired === 'boolean';
}

function persistNow(): void {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (!dirty || !boundUser) return;
    dirty = false;
    try {
        secureLocalStore.setItem(STORAGE_KEY(boundUser), JSON.stringify([...entries.values()].map(e => [e.ref, e.seen])));
    } catch { /* store locked / unavailable: the in-memory archive still works this session */ }
}

function schedulePersist(): void {
    dirty = true;
    if (persistTimer || !boundUser) return;
    persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

function evictOverCap(): void {
    if (entries.size <= ASSET_REF_CAP) return;
    const byAge = [...entries.entries()].sort((a, b) => a[1].seen - b[1].seen);
    for (const [id] of byAge.slice(0, entries.size - ASSET_REF_CAP)) entries.delete(id);
}

/**
 * Point the archive at an account (call with the signed-in user id, or null on
 * sign-out). Waits for the secure store to be ready for that account, then
 * loads that account's refs. Safe to call repeatedly.
 */
export async function bindAssetRefAccount(userId: string | null): Promise<void> {
    if (boundUser === userId) return;
    persistNow();
    boundUser = null;
    entries.clear(); missing.clear(); pending.clear();
    if (!userId) { notify(); return; }
    try { await secureLocalStore.whenAccountReady(); } catch { /* proceed with whatever is readable */ }
    let raw: string | null = null;
    try { raw = secureLocalStore.getItem(STORAGE_KEY(userId)); } catch { raw = null; }
    boundUser = userId;
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const row of parsed) {
                    if (!Array.isArray(row) || !isRef(row[0])) continue;
                    entries.set(row[0].id, { ref: row[0], seen: typeof row[1] === 'number' ? row[1] : 0 });
                }
            }
        } catch { /* corrupt blob: start empty, it refills from the server */ }
    }
    notify();
}

/** Test hook: drop everything and any pending timers. */
export function __resetAssetRefs(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null; dirty = false; boundUser = null;
    entries.clear(); missing.clear(); pending.clear(); queues.clear();
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null; version = 0;
}

// ── archive API ────────────────────────────────────────────────────────────
/** The remembered ref for this id (emoji_id / sticker_id), if any. Synchronous. */
export function peekAssetRef(id: string): AssetRef | undefined {
    return entries.get(id)?.ref;
}

export { isAssetResolvePending };
/** True when the server authoritatively does not have this id (this session). */
export function isAssetMissing(id: string): boolean { return missing.has(id); }
export function assetResolvePendingCount(): number { return pending.size; }

/**
 * Remember a ref that was just DISPLAYED (resolved from a live list or by id).
 * Cheap and idempotent: an unchanged ref already stamped recently does nothing.
 * Never notifies subscribers (it is called during render).
 */
export function noteDisplayed(ref: AssetRef, now = Date.now()): void {
    const cur = entries.get(ref.id);
    if (cur) {
        const same = cur.ref.attachment_id === ref.attachment_id && cur.ref.key_b64 === ref.key_b64
            && cur.ref.nonce_b64 === ref.nonce_b64 && cur.ref.name === ref.name
            && cur.ref.retired === ref.retired && cur.ref.server_id === ref.server_id;
        if (same && now - cur.seen < TOUCH_MS) return;
        entries.set(ref.id, { ref, seen: now });
        schedulePersist();
        return; // no notify: this runs during render, and a changed live ref is already on screen
    }
    entries.set(ref.id, { ref, seen: now });
    evictOverCap();
    schedulePersist();
}

/** Shape adapters (list rows -> AssetRef). */
export function refFromEmoji(e: { emoji_id: string; server_id: string; name: string; attachment_id: string; key_b64: string; nonce_b64: string; animated: boolean; retired?: boolean }): AssetRef {
    return { id: e.emoji_id, kind: 'emoji', server_id: e.server_id, name: e.name, attachment_id: e.attachment_id, key_b64: e.key_b64, nonce_b64: e.nonce_b64, animated: !!e.animated, retired: !!e.retired };
}
export function refFromSticker(s: { sticker_id: string; server_id: string; name: string; attachment_id: string; key_b64: string; nonce_b64: string; animated: boolean; retired?: boolean }): AssetRef {
    return { id: s.sticker_id, kind: 'sticker', server_id: s.server_id, name: s.name, attachment_id: s.attachment_id, key_b64: s.key_b64, nonce_b64: s.nonce_b64, animated: !!s.animated, retired: !!s.retired };
}

// ── by-id resolution ───────────────────────────────────────────────────────
interface Queue { kind: AssetKind; serverId: string; token: string; ids: Set<string> }
const queues = new Map<string, Queue>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const retryTimers = new Set<ReturnType<typeof setTimeout>>();

/**
 * Ask the server for `id` unless we already know it, it is already being asked
 * for, or the server already said it has nothing under that id. Batched: every
 * id requested within ~40 ms for one server+kind goes out as one request.
 */
export function requestResolve(kind: AssetKind, serverId: string, id: string, token: string): void {
    if (entries.has(id) || pending.has(id) || missing.has(id)) return;
    pending.add(id);
    const key = `${kind}:${serverId}`;
    let q = queues.get(key);
    if (!q) { q = { kind, serverId, token, ids: new Set() }; queues.set(key, q); }
    q.token = token;
    q.ids.add(id);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    // No notify(): requesting happens during render; the answer notifies.
}

function flush(): void {
    flushTimer = null;
    const work = [...queues.values()];
    queues.clear();
    for (const q of work) {
        const all = [...q.ids];
        for (let i = 0; i < all.length; i += RESOLVE_BATCH) void runResolve(q.kind, q.serverId, q.token, all.slice(i, i + RESOLVE_BATCH), 0);
    }
}

async function runResolve(kind: AssetKind, serverId: string, token: string, ids: string[], attempt: number): Promise<void> {
    try {
        const path = kind === 'emoji' ? apiUrl`/servers/${serverId}/emojis/resolve` : apiUrl`/servers/${serverId}/stickers/resolve`;
        const res = await axios.post<{ emojis?: unknown[]; stickers?: unknown[] }>(path, { ids }, { headers: { Authorization: `Bearer ${token}` } });
        const rows = (kind === 'emoji' ? res.data?.emojis : res.data?.stickers) ?? [];
        const found = new Set<string>();
        for (const row of Array.isArray(rows) ? rows : []) {
            const r = row as Record<string, unknown>;
            const ref = kind === 'emoji'
                ? refFromEmoji(r as Parameters<typeof refFromEmoji>[0])
                : refFromSticker(r as Parameters<typeof refFromSticker>[0]);
            if (!isRef(ref) || !ids.includes(ref.id)) continue;
            found.add(ref.id);
            entries.set(ref.id, { ref, seen: Date.now() });
        }
        evictOverCap();
        for (const id of ids) { pending.delete(id); if (!found.has(id)) missing.add(id); }
        schedulePersist();
        notify();
    } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        // 403 = not a member (now); 404/405 = an API without the route; 400 = bad ids.
        // Authoritative enough to stop asking this session - NOT persisted.
        if (status === 403 || status === 404 || status === 405 || status === 400) {
            for (const id of ids) { pending.delete(id); missing.add(id); }
            notify();
            return;
        }
        // Anything else (network, 429, 5xx, token mid-rotation) is NOT an answer:
        // keep the ids pending (placeholder) and retry with back-off.
        if (attempt >= MAX_RESOLVE_RETRIES) {
            // Give up for now without claiming deletion: forget the pending flag so a
            // later render asks again; it is not marked missing.
            for (const id of ids) pending.delete(id);
            notify();
            return;
        }
        const d = RESOLVE_RETRY_DELAYS_MS[Math.min(attempt, RESOLVE_RETRY_DELAYS_MS.length - 1)];
        const t = setTimeout(() => { retryTimers.delete(t); void runResolve(kind, serverId, token, ids, attempt + 1); }, d);
        retryTimers.add(t);
    }
}

/** Flush pending writes now (sign-out, window close). */
export function flushAssetRefs(): void { persistNow(); }
