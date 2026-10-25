/**
 * networkReady — "is the API actually reachable yet?", for work that must not
 * fire into a network that is still coming back.
 *
 * ── Why (beta diagnostics, 1.0.23-staging.167, 2026-10-17, twice) ───────────
 * Right on resume from sleep the same cluster appeared within ~1 s:
 * `prekeys_low {topup_failed}`, an unhandled `AxiosError: Network Error`,
 * `msg_fetch_gap {stage:'pull', online:false}` and a 1-2 s `app_freeze` in
 * `resume:rehydrate`. The OS wakes, Wi-Fi is still reconnecting, and the app
 * immediately fires its resume work (rehydrate, prekey top-up, message pull) into
 * a dead network: every request fails, and the `resume:rehydrate` activity span
 * stays open through fetchWithRetry's backoff, so any long frame in that window
 * is blamed on it.
 *
 * ── What "ready" means ──────────────────────────────────────────────────────
 * Two signals, both required:
 *   1. `navigator.onLine !== false` — the OS says an interface is up (fast, but
 *      true on a captive portal, a dead router or a VPN still reconnecting);
 *   2. a cheap reachability probe — `GET /v1/health/live`, which is public,
 *      skips attestation / version / throttle and touches no dependency. ANY
 *      HTTP answer counts as reachable (a 503 from an unhealthy origin is still
 *      "the network is up"; retrying into an outage would only add load). Only
 *      a transport failure or the probe's own timeout counts as "not yet".
 * Not ready → wait for the `online` event or the next backoff step, whichever
 * comes first, and try again. This reuses the browser's own online/offline
 * events (the same ones useNetworkStatus / useRealtime already listen to) — it
 * is a gate in front of existing work, not a second connectivity state machine.
 *
 * `ensureNetworkReady` COALESCES concurrent callers onto one wait: a wake fires
 * the rehydrate, the prekey check and the pull at once, and they should share
 * one probe loop rather than each hammering the health endpoint.
 */
import axios from 'axios';
import { API_BASE } from '../constants';

export interface NetworkReadyOptions {
    /** Reachability probe. Resolves true when the API answered at all. Default: GET /health/live. */
    probe?: () => Promise<boolean>;
    /** OS-level online flag. Default: `navigator.onLine !== false`. */
    isOnline?: () => boolean;
    /** Resolve early when the `online` event fires. Default: window 'online'. Returns an unsubscribe. */
    onOnline?: (cb: () => void) => () => void;
    /** Injected for tests. */
    setTimer?: (cb: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    now?: () => number;
    /** Give up (resolve false) after this long. Default 120 s. */
    maxWaitMs?: number;
    /** First backoff step, doubled each retry up to `maxBackoffMs`. Default 500 ms / 8 s. */
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    /** Abort the wait (resolves false). */
    signal?: AbortSignal;
}

export const NETWORK_READY_MAX_WAIT_MS = 120_000;
export const HEALTH_PROBE_TIMEOUT_MS = 4_000;

/** OS-level online flag. `undefined` navigator (tests, SSR) reads as online. */
export function isLikelyOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Default probe: GET /v1/health/live with a short timeout. Resolves true on ANY
 * HTTP response (including 5xx), false on a transport failure or timeout.
 * Never throws.
 */
export async function probeApiReachable(timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS): Promise<boolean> {
    try {
        await axios.get(`${API_BASE}/health/live`, {
            timeout: timeoutMs,
            // Any status is "reachable"; only a transport failure rejects.
            validateStatus: () => true,
        });
        return true;
    } catch {
        return false;
    }
}

/** Backoff before retry `n` (0-based): 500, 1000, 2000, … capped. Exported for tests. */
export function networkBackoffMs(n: number, base = 500, max = 8_000): number {
    return Math.min(max, base * 2 ** n);
}

const windowOnline = (cb: () => void): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('online', cb);
    return () => window.removeEventListener('online', cb);
};

/**
 * Resolves true as soon as the network looks usable (online AND the probe
 * answered), false when `maxWaitMs` elapses or `signal` aborts. Never rejects.
 * Resolves true immediately on the common path (already online, probe answers).
 */
export async function whenNetworkReady(opts: NetworkReadyOptions = {}): Promise<boolean> {
    const probe = opts.probe ?? (() => probeApiReachable());
    const isOnline = opts.isOnline ?? isLikelyOnline;
    const onOnline = opts.onOnline ?? windowOnline;
    const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const now = opts.now ?? Date.now;
    const maxWait = opts.maxWaitMs ?? NETWORK_READY_MAX_WAIT_MS;
    const deadline = now() + maxWait;
    const { signal } = opts;

    // Sleep for `ms`, but wake early on the `online` event or an abort.
    const nap = (ms: number): Promise<void> => new Promise<void>((resolve) => {
        let done = false;
        let off: () => void = () => {};
        const finish = () => {
            if (done) return;
            done = true;
            clearTimer(handle);
            off();
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const handle = setTimer(finish, ms);
        off = onOnline(finish);
        signal?.addEventListener('abort', finish);
    });

    for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) return false;
        if (isOnline()) {
            let reachable = false;
            try { reachable = await probe(); } catch { reachable = false; }
            if (reachable) return true;
            if (signal?.aborted) return false;
        }
        const left = deadline - now();
        if (left <= 0) return false;
        await nap(Math.min(left, networkBackoffMs(attempt, opts.baseBackoffMs, opts.maxBackoffMs)));
    }
}

let shared: Promise<boolean> | null = null;

/**
 * `whenNetworkReady` with one shared wait per burst: callers that arrive while
 * a wait is in progress get the same promise, so a wake that fires the
 * rehydrate, the prekey check and the pull together runs ONE probe loop.
 */
export function ensureNetworkReady(opts: NetworkReadyOptions = {}): Promise<boolean> {
    if (opts.signal) return whenNetworkReady(opts);   // an abortable wait is the caller's own
    if (!shared) {
        shared = whenNetworkReady(opts).finally(() => { shared = null; });
    }
    return shared;
}

/** Test seam. */
export function __resetNetworkReadyForTests(): void {
    shared = null;
}
