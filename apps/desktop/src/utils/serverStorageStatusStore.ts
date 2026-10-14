/**
 * One shared cache for `GET /v1/servers/:id/storage-status`.
 *
 * Three surfaces read the same status — the server banner, Server Settings ->
 * Storage (and the Members tab's Pro highlighting), and the billing cancel
 * confirmation — and the endpoint has its own rate-limit bucket of 10 per 10 s
 * per user. Fetching independently from each would burst past that on an
 * ordinary "open the server, open its settings" path, so they all go through
 * this store:
 *
 *   - in-flight requests are shared (two callers, one GET);
 *   - a fresh-enough result is served from cache (`maxAgeMs`);
 *   - every request is PACED client-side to at most `maxPerWindow` (8) per
 *     `windowMs` (10 s), so even an owner of many servers opening the cancel
 *     dialog never trips the server's 429;
 *   - a `server:storage_status_changed` push (`handlePush`) marks that one
 *     server stale and refetches it only if something is showing it.
 *
 * Display-only: a failed fetch keeps whatever was last shown (and backs off),
 * and a 403/404 (no longer a member) clears it. Nothing here is load-bearing;
 * the API enforces the policy.
 *
 * No React, no axios — the fetcher is injected so this is tested directly.
 */
import type { ServerStorageStatus } from '@cipherline/shared';

/** Window CustomEvent `useRealtime.ts` dispatches for the WS push. `detail` = `{ server_id }`.
 *  useRealtime inlines this literal (it must not import modules that pull in
 *  axios — see its `announcements:changed` comment); a source-scan test pins
 *  the two together. */
export const SERVER_STORAGE_STATUS_WINDOW_EVENT = 'cipherline:server-storage-status-changed';

/** Extract the server id from the push's `detail`, or null for anything malformed. */
export function storageStatusPushServerId(detail: unknown): string | null {
    if (!detail || typeof detail !== 'object') return null;
    const id = (detail as { server_id?: unknown }).server_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

export class StorageStatusHttpError extends Error {
    readonly status: number;
    constructor(status: number) {
        super(`storage-status HTTP ${status}`);
        this.status = status;
    }
}

export type StorageStatusFetcher = (serverId: string, token: string) => Promise<ServerStorageStatus>;

interface Entry {
    status: ServerStorageStatus | null;
    fetchedAt: number;
    /** Forced stale by a push. */
    stale: boolean;
    failedAt: number | null;
}

export interface ServerStorageStatusStore {
    /** Cached status: undefined = never fetched, null = nothing to show / not visible to us. */
    get(serverId: string): ServerStorageStatus | null | undefined;
    subscribe(serverId: string, listener: () => void): () => void;
    /** Fetch unless a result younger than `maxAgeMs` is cached (or a fetch is in flight). */
    ensure(serverId: string, token: string, maxAgeMs?: number): Promise<ServerStorageStatus | null>;
    /** Fetch now (still shares an in-flight request, still paced). */
    refresh(serverId: string, token: string): Promise<ServerStorageStatus | null>;
    /** The WS push: mark stale; refetch only if something is subscribed. */
    handlePush(serverId: string, token: string | null): void;
    /** Forget everything (account switch / sign-out). */
    reset(): void;
}

export const DEFAULT_STATUS_MAX_AGE_MS = 5 * 60_000;
/** After a failed fetch, don't retry the same server for this long (unless pushed). */
export const STATUS_FAILURE_BACKOFF_MS = 30_000;

export function createServerStorageStatusStore(opts: {
    fetcher: StorageStatusFetcher;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    maxPerWindow?: number;
    windowMs?: number;
}): ServerStorageStatusStore {
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const maxPerWindow = Math.max(1, opts.maxPerWindow ?? 8);
    const windowMs = opts.windowMs ?? 10_000;

    const entries = new Map<string, Entry>();
    const inFlight = new Map<string, Promise<ServerStorageStatus | null>>();
    const listeners = new Map<string, Set<() => void>>();
    /** Start times of recent requests, for the pacing window. */
    let starts: number[] = [];
    /** Pushes that arrived while that server's fetch was already in flight
     *  (its answer may predate the change): refetch once it lands. */
    const pushedDuringFlight = new Map<string, string>();
    /** Bumped by reset() so a request from a previous account cannot write into the new one. */
    let generation = 0;

    const emit = (serverId: string) => {
        for (const l of listeners.get(serverId) ?? []) {
            try { l(); } catch { /* a listener's bug is not ours */ }
        }
    };

    /** Wait for a slot in the pacing window, then claim it. */
    async function acquireSlot(): Promise<void> {
        for (;;) {
            const t = now();
            starts = starts.filter(s => t - s < windowMs);
            if (starts.length < maxPerWindow) {
                starts.push(t);
                return;
            }
            await sleep(Math.max(1, starts[0] + windowMs - t));
        }
    }

    function doFetch(serverId: string, token: string): Promise<ServerStorageStatus | null> {
        const existing = inFlight.get(serverId);
        if (existing) return existing;
        const gen = generation;
        // The promise is compared inside its own `finally`, so it is published
        // through a holder rather than read before its declaration completes.
        const self: { p?: Promise<ServerStorageStatus | null> } = {};
        const p = (async () => {
            await acquireSlot();
            try {
                const status = await opts.fetcher(serverId, token);
                if (gen !== generation) return status;
                entries.set(serverId, { status, fetchedAt: now(), stale: false, failedAt: null });
                emit(serverId);
                return status;
            } catch (err) {
                if (gen !== generation) return null;
                const code = err instanceof StorageStatusHttpError ? err.status : 0;
                const prev = entries.get(serverId);
                if (code === 403 || code === 404) {
                    // Not (or no longer) a member — nothing to show.
                    entries.set(serverId, { status: null, fetchedAt: now(), stale: false, failedAt: null });
                    emit(serverId);
                    return null;
                }
                // 429 / network / 5xx: keep what we had, back off.
                entries.set(serverId, {
                    status: prev?.status ?? null,
                    fetchedAt: prev?.fetchedAt ?? 0,
                    stale: prev?.stale ?? false,
                    failedAt: now(),
                });
                if (!prev) emit(serverId);
                return prev?.status ?? null;
            } finally {
                if (inFlight.get(serverId) === self.p) inFlight.delete(serverId);
                const again = pushedDuringFlight.get(serverId);
                if (again !== undefined && gen === generation) {
                    pushedDuringFlight.delete(serverId);
                    if ((listeners.get(serverId)?.size ?? 0) > 0) void doFetch(serverId, again);
                }
            }
        })();
        self.p = p;
        inFlight.set(serverId, p);
        return p;
    }

    return {
        get(serverId) {
            const e = entries.get(serverId);
            return e ? e.status : undefined;
        },
        subscribe(serverId, listener) {
            let set = listeners.get(serverId);
            if (!set) { set = new Set(); listeners.set(serverId, set); }
            set.add(listener);
            return () => {
                set!.delete(listener);
                if (set!.size === 0) listeners.delete(serverId);
            };
        },
        ensure(serverId, token, maxAgeMs = DEFAULT_STATUS_MAX_AGE_MS) {
            const e = entries.get(serverId);
            const t = now();
            if (e && !e.stale) {
                if (e.failedAt !== null && t - e.failedAt < STATUS_FAILURE_BACKOFF_MS) return Promise.resolve(e.status);
                if (e.failedAt === null && t - e.fetchedAt < maxAgeMs) return Promise.resolve(e.status);
            }
            return doFetch(serverId, token);
        },
        refresh(serverId, token) {
            return doFetch(serverId, token);
        },
        handlePush(serverId, token) {
            const e = entries.get(serverId);
            if (e) e.stale = true;
            if (!token || (listeners.get(serverId)?.size ?? 0) === 0) return;
            if (inFlight.has(serverId)) pushedDuringFlight.set(serverId, token);
            else void doFetch(serverId, token);
        },
        reset() {
            generation += 1;
            entries.clear();
            inFlight.clear();
            pushedDuringFlight.clear();
            // Pacing history is kept: the server's bucket does not reset on an
            // account switch either, and it is per user anyway.
            for (const id of [...listeners.keys()]) emit(id);
        },
    };
}
