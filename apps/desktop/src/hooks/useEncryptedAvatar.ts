import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { importKeyFromBase64, decryptBlob } from '../utils/crypto';
import { loadAvatarKey, saveAvatarKey, deleteAvatarKey } from '../utils/avatarKeyStore';
import { useHydrationGeneration } from '../contexts/HydrationContext';
import { getAvatarBlob, putAvatarBlob, deleteAvatarBlob } from '../utils/attachmentCache';
import { PrioritySemaphore, TokenBucket } from '../utils/avatarWarmQueue';

// ── Session-level memory cache ─────────────────────────────────────────────
// Survives component mount/unmount cycles for the lifetime of the app session.
// Prevents redundant network+decrypt on every re-render or message arrival.
const avatarMemoryCache = new Map<string, string>();

// ── In-flight request deduplication ───────────────────────────────────────
// When multiple components request the same attachment simultaneously (e.g. the
// same user appears in many messages), only one network+decrypt pass runs; all
// callers share the same Promise and receive the resolved URL together.
const inFlightRequests = new Map<string, Promise<string | null>>();

// Background warm loads are tracked separately — see preloadAvatar for why the
// two lanes must not share one dedup map.
const backgroundInFlight = new Map<string, Promise<string | null>>();

// ── Retry schedule for a load that came back empty ────────────────────────
// A null result is not proof there's no avatar: the key fetch or the blob
// download can fail on a network blip, a cold API pod, or a 5xx — and the
// hook's effect has no reason to re-run afterwards, so that row keeps its
// placeholder for the entire session. This bites hardest on the home deck,
// which is the first screen painted after boot and mounts a dozen-plus
// avatars at once while every other boot request is in flight; the same
// avatars then render fine in the sidebar, which mounts later.
//
// Bounded and cheap: two retries, and only for attachments this viewer is
// already entitled to (the friend gate zeroes `attachmentId` before it ever
// reaches here, so a stranger's avatar costs zero requests, retried or not).
// The last attempt sits past the boot burst on purpose; the two early ones
// used to land inside the very window that caused the first failure.
const RETRY_DELAYS_MS = [1_200, 4_000, 12_000];

// ── Preload scheduling ─────────────────────────────────────────────────────
// The 6-at-a-time cap is now PROCESS-WIDE, not per call. It used to be a local
// worker pool inside preloadAvatars, which bounds one invocation and nothing
// else: Home's deck warm, ChatPane's member warm and the background warmer each
// spun their own six, so the real ceiling was 18+. Foreground preloads (someone
// is looking at the surface that is waiting) jump the queue ahead of background
// warming.
const MAX_CONCURRENT_PRELOADS = 6;
const preloadSemaphore = new PrioritySemaphore(MAX_CONCURRENT_PRELOADS);

// And concurrency is the wrong knob for the thing that actually hurts. Each
// cold avatar spends two requests from the API's `default` bucket — 300 per
// 60 s, per user, FIXED window with a 60 s block — so six workers at ~250 ms an
// avatar (~48 req/s) drain the whole account's API budget in under seven
// seconds and 429 it off everything, not just avatars.
//
// So background warming is rate-limited where the cost is: 6 immediately, then
// one more every 1.6 s (~37 avatars/min => ~75 req/min, a quarter of the
// budget, leaving the rest for messages, presence and the user's own clicks).
// Crucially the gate is claimed only when a load is about to go to the NETWORK
// — a hit in memory or IndexedDB costs nothing and is never paced, so a
// returning user whose avatars are already cached warms at full speed for zero
// requests. Foreground preloads are never paced: they are demand, not a bet.
const WARM_NETWORK_BURST = 6;
const WARM_NETWORK_REFILL_MS = 1_600;
const warmNetworkBudget = new TokenBucket(WARM_NETWORK_BURST, WARM_NETWORK_REFILL_MS);

// ── Boot warm from the PERSISTENT blob cache ───────────────────────────────
// A separate, network-free lane — see warmAvatarsFromDiskCache below for why it
// deliberately does not reuse the machinery above.
/**
 * Cap on one boot warm. Every entry is an AES-GCM unwrap plus a blob URL, and
 * the whole point is to be finished before the user opens anything — so this is
 * sized to "the people you actually see", not to the whole cache. It is
 * deliberately BELOW `pruneAvatarCache`'s 500-entry blob cap: the identity
 * store can legitimately hold 500 ids, and decrypting all of them at boot would
 * spend CPU — and, because every hit becomes a retained object URL, resident
 * memory — on rows that will never mount this session.
 */
const MAX_DISK_WARM = 200;
/** IndexedDB reads are cheap but not free; keep the boot burst off one core. */
const DISK_WARM_CONCURRENCY = 6;

/** Exported for tests only — the numbers above are the contract. */
export const __preloadTuning = {
    MAX_CONCURRENT_PRELOADS,
    WARM_NETWORK_BURST,
    WARM_NETWORK_REFILL_MS,
    MAX_DISK_WARM,
} as const;

/** Exported for tests only — lets a suite observe the shared semaphore. */
export function __preloadInFlightCount(): number { return preloadSemaphore.activeCount; }

/**
 * Exported for tests only. The session caches are module state, so without this
 * a suite's second scenario silently inherits the first one's warm cache and a
 * "0 requests" assertion passes for the wrong reason.
 */
export function __resetAvatarCaches(): void {
    avatarMemoryCache.clear();
    inFlightRequests.clear();
    backgroundInFlight.clear();
    warmNetworkClaims = 0;
}

// Counts how many times a background load actually reached the point of
// spending requests. Exported so a test can pin WHERE the gate sits: a warm
// that hits memory or IndexedDB must not claim it.
let warmNetworkClaims = 0;
/** Exported for tests only. */
export function __warmNetworkClaims(): number { return warmNetworkClaims; }
function claimWarmNetworkBudget(): Promise<void> {
    warmNetworkClaims++;
    return warmNetworkBudget.take();
}

// ── Core download/decrypt pipeline ────────────────────────────────────────
// Shared by the hook and the standalone preload utilities. Handles all three
// cache tiers and stores results in avatarMemoryCache on success.
/** Exported for tests only - the hook and the preloaders are the callers. */
export async function loadAvatarToCache(
    attachmentId: string,
    token: string,
    inlineKey?: { keyB64: string; nonceB64: string } | null,
    opts?: {
        skipLocalKey?: boolean;
        /** Awaited immediately before the first REQUEST-SPENDING step, i.e. only
         *  once both caches have missed. Background warming passes the rate
         *  gate here so a cached avatar is never paced. */
        beforeNetwork?: () => Promise<void>;
    },
): Promise<string | null> {
    // Tier 2: IndexedDB persistent cache — fast path across sessions.
    try {
        const cachedBlob = await getAvatarBlob(attachmentId);
        if (cachedBlob) {
            const objectUrl = URL.createObjectURL(cachedBlob);
            avatarMemoryCache.set(attachmentId, objectUrl);
            return objectUrl;
        }
    } catch {
        // IDB unavailable or corrupt entry — fall through to network.
    }

    // Tier 3: network download + client-side decrypt.
    //
    // Everything below this line spends at least one request from the account's
    // shared `default` throttle budget (the download; two when the key also has
    // to be fetched), so this is where a background warm asks permission. A hit
    // above never reaches it.
    if (opts?.beforeNetwork) await opts.beforeNetwork();

    // 1. Resolve the decryption key.
    let keyData: { keyB64: string; nonceB64: string } | null = null;
    let keyFromLocalCache = false;
    if (inlineKey?.keyB64 && inlineKey?.nonceB64) {
        keyData = { keyB64: inlineKey.keyB64, nonceB64: inlineKey.nonceB64 };
    } else {
        if (!opts?.skipLocalKey) {
            try { keyData = await loadAvatarKey(attachmentId); } catch { /* ignore */ }
            keyFromLocalCache = !!keyData;
        }
        if (!keyData) {
            try {
                const keyRes = await axios.get(
                    `${API_BASE}/attachments/${attachmentId}/key`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                keyData = {
                    keyB64:   keyRes.data.file_key_b64,
                    nonceB64: keyRes.data.file_nonce_b64,
                };
                await saveAvatarKey(attachmentId, keyData.keyB64, keyData.nonceB64);
            } catch {
                // 403 / 404 — no avatar to render; fallback applies upstream.
                return null;
            }
        }
    }

    // 2. Fetch presigned download URL + download + decrypt.
    try {
        const urlRes = await axios.get(
            `${API_BASE}/attachments/${attachmentId}/download`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const blobRes = await axios.get(urlRes.data.download_url, { responseType: 'blob' });
        const cryptoKey = await importKeyFromBase64(keyData.keyB64);
        const decryptedBlob = await decryptBlob(
            blobRes.data, cryptoKey, keyData.nonceB64, urlRes.data.mime_type,
        );
        putAvatarBlob(attachmentId, decryptedBlob).catch(e =>
            console.warn('[useEncryptedAvatar] IndexedDB persist failed', e),
        );
        const objectUrl = URL.createObjectURL(decryptedBlob);
        avatarMemoryCache.set(attachmentId, objectUrl);
        return objectUrl;
    } catch {
        // A stale or corrupt LOCALLY cached key fails decrypt every time, and
        // every retry used to reuse it - a permanent blank. Purge it and go
        // once more with the key the server holds.
        if (keyFromLocalCache) {
            await deleteAvatarKey(attachmentId).catch(() => {});
            deleteAvatarBlob(attachmentId).catch(() => {});
            return loadAvatarToCache(attachmentId, token, inlineKey, { ...opts, skipLocalKey: true });
        }
        return null;
    }
}

/**
 * Forget a cached avatar that turned out to be unusable (the <img> failed to
 * decode it). Drops the session URL and the persisted blob so the next load
 * goes back to the network instead of re-serving the same bad bytes.
 */
export function evictAvatar(attachmentId: string): void {
    const url = avatarMemoryCache.get(attachmentId);
    if (url) { avatarMemoryCache.delete(attachmentId); try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    deleteAvatarBlob(attachmentId).catch(() => {});
}

export interface PreloadOptions {
    /** Background warming: yields its slot to foreground work and, when the
     *  load actually has to go to the network, waits for the rate budget. */
    background?: boolean;
}

/**
 * Pre-warm the session-level avatar memory cache for a single attachment.
 * Resolves once the avatar is cached (or silently on failure).
 *
 * ── Why background loads get their OWN in-flight map ────────────────────────
 * `inFlightRequests` is what the hook joins when an avatar mounts, and joining
 * is normally free. It is not free across the priority boundary: a background
 * warm can be parked inside the rate budget for seconds by design, so letting
 * a just-mounted avatar join one would hand a visible element the background
 * lane's latency — a priority inversion, and precisely the multi-second stall
 * this whole change exists to delete.
 *
 * So: background work joins a foreground load (strictly better — sooner, and
 * already paid for), but foreground work never joins a background one. The
 * cost is that an avatar the user opens WHILE it is being warmed can be
 * fetched twice, ~2 extra requests, once. That is the right way round.
 */
export async function preloadAvatar(
    attachmentId: string,
    token: string,
    opts?: PreloadOptions,
): Promise<void> {
    if (!attachmentId || !token) return;
    if (
        attachmentId.startsWith('http') ||
        attachmentId.startsWith('data:') ||
        attachmentId.startsWith('blob:')
    ) return;
    if (avatarMemoryCache.has(attachmentId)) return;

    const background = opts?.background === true;

    // Foreground work in flight is always the best thing to join.
    const foreground = inFlightRequests.get(attachmentId);
    if (foreground) { await foreground; return; }

    if (background) {
        const queued = backgroundInFlight.get(attachmentId);
        if (queued) { await queued; return; }
        const started = preloadSemaphore
            .run(true, async () => {
                // A foreground load may have landed this while we waited for a
                // slot; re-check rather than spend the requests again.
                if (avatarMemoryCache.has(attachmentId)) return null;
                return loadAvatarToCache(attachmentId, token, undefined, {
                    beforeNetwork: claimWarmNetworkBudget,
                });
            })
            .catch(() => null)
            .finally(() => { backgroundInFlight.delete(attachmentId); });
        backgroundInFlight.set(attachmentId, started);
        await started;
        return;
    }

    const promise = preloadSemaphore
        .run(false, () => loadAvatarToCache(attachmentId, token))
        .catch(() => null)
        .finally(() => { inFlightRequests.delete(attachmentId); });
    inFlightRequests.set(attachmentId, promise);
    await promise;
}

/**
 * Re-fill the session memory cache from the PERSISTENT blob cache, and from
 * nowhere else.
 *
 * ── Why this is separate from preloadAvatar ────────────────────────────────
 * This function makes NO network request, under any condition, by construction
 * rather than by scheduling: it calls `getAvatarBlob` directly instead of going
 * through `loadAvatarToCache`, so there is no branch in it that can reach the
 * key fetch or the presigned download. That matters for three reasons. It
 * cannot spend the account's shared 300-req/min budget, so it needs no rate
 * pacing and can run immediately at boot instead of waiting for idle. It cannot
 * widen the friend gate, because a gate that already let this device DECRYPT
 * and cache the blob has nothing left to decide. And a miss here is simply a
 * miss — the row's own `useEncryptedAvatar` will fetch it later, gated and
 * paced exactly as it is today.
 *
 * This is the second half of surviving a restart. The persisted identity cache
 * tells a freshly-mounted row WHICH attachment to ask for; this is what makes
 * the answer available synchronously, so `useEncryptedAvatar`'s `useState`
 * initialiser hits a warm cache on the first render and the avatar paints solid
 * instead of cross-fading in. `restartFirstPaint.test.ts` pins both halves
 * apart, because the id alone measurably does not do it.
 *
 * @returns how many avatars were actually restored from disk.
 */
export async function warmAvatarsFromDiskCache(attachmentIds: string[]): Promise<number> {
    const queue = [...new Set(attachmentIds.filter(Boolean))]
        .filter(id => !avatarMemoryCache.has(id) && !id.startsWith('http') && !id.startsWith('data:') && !id.startsWith('blob:'))
        .slice(0, MAX_DISK_WARM);
    if (!queue.length) return 0;

    let next = 0;
    let restored = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= queue.length) return;
            const id = queue[i];
            try {
                // A foreground load may have landed this while we queued.
                if (avatarMemoryCache.has(id)) continue;
                const blob = await getAvatarBlob(id);
                if (!blob) continue;
                if (avatarMemoryCache.has(id)) continue;
                avatarMemoryCache.set(id, URL.createObjectURL(blob));
                restored++;
            } catch {
                // Unreadable record (keystore locked, corrupt entry) — a miss,
                // handled by the normal load path. Never fatal at boot.
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(DISK_WARM_CONCURRENCY, queue.length) }, worker),
    );
    return restored;
}

/**
 * Pre-warm the avatar cache for a batch of attachment IDs.
 * Hard-capped at `timeoutMs` so a slow network never stalls a caller.
 * Failures are swallowed individually — one bad avatar won't block the rest.
 *
 * Foreground lane: the caller is about to paint these. Still bounded to 6
 * concurrent loads, but by the process-wide semaphore rather than a private
 * worker pool, so two of these running at once is six in flight, not twelve.
 */
export async function preloadAvatars(
    attachmentIds: string[],
    token: string,
    timeoutMs = 5000,
): Promise<void> {
    const unique = [...new Set(attachmentIds.filter(Boolean))];
    if (!unique.length) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            Promise.allSettled(unique.map(id => preloadAvatar(id, token))),
            new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Background lane: a bet on what the user will open next, not something on
 * screen. Yields to foreground preloads and, for the ones that miss both
 * caches, spends the rate budget described at WARM_NETWORK_BURST.
 *
 * Deliberately has NO timeout. `preloadAvatars`' 5 s cap exists because a
 * caller was blocking a render on it; nothing blocks on this one, and cutting
 * it short would just abandon the queue the pacing spread out on purpose.
 * Resolves when the batch is done; callers fire and forget.
 */
export async function preloadAvatarsBackground(
    attachmentIds: string[],
    token: string,
): Promise<void> {
    const unique = [...new Set(attachmentIds.filter(Boolean))];
    if (!unique.length) return;
    await Promise.allSettled(unique.map(id => preloadAvatar(id, token, { background: true })));
}

/**
 * Decrypts an encrypted-attachment image and returns a blob URL for <img>.
 *
 * Three-tier caching strategy:
 *   1. **Memory cache** — within-session, instant (Map lookup).
 *   2. **IndexedDB cache** — across sessions; stores the decrypted blob
 *      re-wrapped with the OS master key (DPAPI / Keychain / libsecret).
 *      On hit: unwrap → createObjectURL, no network call needed.
 *   3. **Network** — presigned MinIO download + client-side AES-256-GCM
 *      decrypt.  Result is stored in both caches for future use.
 *
 * Two key-source modes:
 *   1. **Local-cache + server-fallback** (default): looks up the key via
 *      `loadAvatarKey()` then falls back to `GET /attachments/:id/key`. This
 *      is the original path used by user / group avatars whose keys are
 *      either E2EE-broadcast to friends or stored against the attachment
 *      record.
 *   2. **Inline key** (pass `inlineKey={{ keyB64, nonceB64 }}`): skips both
 *      lookups and uses the provided key directly. Used by server icons,
 *      whose keys live on the Server row itself (icons are public-by-design;
 *      see Server entity for the privacy rationale).
 */
export function useEncryptedAvatar(
    attachmentId: string | null | undefined,
    token: string | null,
    inlineKey?: { keyB64: string; nonceB64: string } | null,
) {
    // Retry signal. A failed avatar load used to be permanent: the effect below
    // is keyed on [attachmentId, token], so one bad request during the
    // cold-start window (API not up yet, token mid-refresh, no network after a
    // wake) left that avatar blank for the rest of the session and the only
    // cure was a manual refresh. Re-hydration bumps this number, the effect
    // re-runs, and the blank ones get another go. Successful loads short-
    // circuit on avatarMemoryCache below, so a bump costs them nothing.
    const hydrationGeneration = useHydrationGeneration();

    const [avatarUrl, setAvatarUrl] = useState<string | null>(() =>
        attachmentId ? (avatarMemoryCache.get(attachmentId) ?? null) : null
    );

    useEffect(() => {
        if (!attachmentId || !token) {
            setAvatarUrl(null);
            return;
        }

        // Legacy: base64 data URI or local blob — use directly.
        if (attachmentId.startsWith('data:') || attachmentId.startsWith('blob:')) {
            setAvatarUrl(attachmentId);
            return;
        }
        // Legacy: plain HTTP URLs are rejected — insecure and a zero-click IP beacon.
        if (attachmentId.startsWith('http:')) return;
        // Legacy: remote HTTPS URL — proxy through the main-process SSRF guard
        // (net:fetch-binary) instead of a direct <img> src, which would auto-fetch
        // and reveal the user's IP to the third-party host on every render.
        if (attachmentId.startsWith('https:')) {
            let cancelled = false;
            window.electronAPI?.fetchBinary(attachmentId).then(res => {
                if (!cancelled && res) setAvatarUrl(`data:${res.mimeType};base64,${res.b64}`);
            }).catch(() => {});
            return () => { cancelled = true; };
        }

        // Tier 1: memory cache hit — synchronous, no async gap.
        const memCached = avatarMemoryCache.get(attachmentId);
        if (memCached) {
            setAvatarUrl(memCached);
            return;
        }

        let isMounted = true;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;

        const load = () => {
            // Deduplicate: reuse an in-flight promise if one already exists for this
            // attachment ID (e.g. same avatar in a long message list all mounting at once).
            let promise = inFlightRequests.get(attachmentId);
            if (!promise) {
                promise = loadAvatarToCache(attachmentId, token, inlineKey)
                    .catch(err => {
                        console.error(`[useEncryptedAvatar] failed to load ${attachmentId}`, err);
                        return null;
                    })
                    .finally(() => {
                        inFlightRequests.delete(attachmentId);
                    });
                inFlightRequests.set(attachmentId, promise);
            }

            promise.then(url => {
                if (!isMounted) return;
                if (url) { setAvatarUrl(url); return; }
                // Empty result — retry on the schedule above before settling for
                // the placeholder. See RETRY_DELAYS_MS for why.
                if (attempt < RETRY_DELAYS_MS.length) {
                    retryTimer = setTimeout(load, RETRY_DELAYS_MS[attempt++]);
                    return;
                }
                setAvatarUrl(null);
            });
        };
        load();

        return () => {
            isMounted = false;
            if (retryTimer) clearTimeout(retryTimer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attachmentId, token, inlineKey?.keyB64, inlineKey?.nonceB64, hydrationGeneration]);

    return avatarUrl;
}
