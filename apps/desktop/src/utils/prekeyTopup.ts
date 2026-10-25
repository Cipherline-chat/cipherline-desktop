/**
 * prekeyTopup — one one-time-prekey top-up run, with retry.
 *
 * ── Why a retry loop (beta diagnostics, 1.0.23-staging.167, twice on resume) ─
 * `prekeys_low {topup_failed:true}` fired right on wake: the 15-minute timer
 * (overdue after a sleep, so it fires the instant the machine wakes) ran
 * `GET /keys/status` into a network that was still reconnecting. The check's
 * only recovery was "the next tick retries" - up to 15 minutes later, and
 * only if that tick found the network up. One-time prekeys are what give each
 * inbound DM per-message forward secrecy: while the pool is empty every sender
 * falls back to signed-prekey-only ECDH (see prekeyHealth.ts), so a top-up that
 * failed for a transient reason should be retried within seconds, not a quarter
 * of an hour.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *   - The run waits for connectivity before each attempt (networkReady).
 *   - A TRANSIENT failure (no HTTP answer, 408/429/5xx - see
 *     fetchWithRetry.defaultShouldRetry) is retried on TOPUP_RETRY_SCHEDULE_MS.
 *     A settled refusal (400/403/404) is not: repeating it only adds load, and
 *     it is reported as a real failure.
 *   - A bundle that was MINTED but not yet POSTED is held and re-posted as-is.
 *     Re-running the mint would generate a second batch of 100 private prekeys
 *     that the first never published, orphaning them on the device for good
 *     (the very growth keyBundleUpload.ts documents). POST /keys/upload_bundle
 *     replaces the server's pool, so re-sending the identical body is safe.
 *   - The caller owns the "owed" flag: it stays set until this returns 'ok' or
 *     'not_needed', so a later trigger (the `online` event, a WS reconnect, the
 *     15-minute poll) keeps trying after a run gives up.
 *   - It never throws. A failure is a RESULT, so nothing can leak out of a
 *     fire-and-forget caller as an unhandled rejection.
 */
import { defaultShouldRetry } from './fetchWithRetry';
import { isNetworkClassError } from './networkError';
import { shouldUploadBundle } from './prekeyHealth';
import type { KeyStatus, UploadBundleBody } from './keyBundleUpload';

/** Wait before retry n (0-based) after a transient failure. Total ~8 min. */
export const TOPUP_RETRY_SCHEDULE_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000, 300_000];

export type TopupOutcome =
    | 'ok'            // a bundle was posted
    | 'not_needed'    // the pool is healthy, or there was nothing to mint
    | 'cancelled'     // the hook unmounted / the account changed
    | 'rejected'      // a settled refusal (4xx): retrying will not help
    | 'gave_up';      // transient failures outlasted the schedule - still owed

/**
 * Retry a connectivity failure or a retryable HTTP status; never a failure of
 * our own code. fetchWithRetry's rule treats "no response" as retryable, but
 * here a no-response error that is NOT an axios transport failure is the
 * main-process bundle mint throwing - repeating that five times is just noise.
 */
export function topupShouldRetry(err: unknown): boolean {
    const hasResponse = (err as { response?: unknown } | null | undefined)?.response != null;
    if (!hasResponse) return isNetworkClassError(err);
    return defaultShouldRetry(err);
}

export interface TopupResult {
    outcome: TopupOutcome;
    /** Attempts made (>= 1 unless cancelled before the first). */
    attempts: number;
    /** The last error, for 'rejected' / 'gave_up'. */
    error?: unknown;
}

export interface TopupDeps {
    fetchStatus: () => Promise<KeyStatus>;
    /** Mint the bundle for this status, or null when nothing should be uploaded. */
    mintBundle: (status: KeyStatus) => Promise<UploadBundleBody | null>;
    post: (body: UploadBundleBody) => Promise<void>;
    /** networkReady.ensureNetworkReady - false = never came back inside its window. */
    waitForNetwork: () => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    isCancelled: () => boolean;
    /** Survives across attempts AND runs: a minted bundle not yet accepted by the server. */
    held: { body: UploadBundleBody | null };
    /** Seen on every successful status read (the hook reports `prekeys_low` from it). */
    onStatus?: (status: KeyStatus) => void;
    shouldRetry?: (err: unknown) => boolean;
    schedule?: readonly number[];
}

export async function runTopupWithRetry(deps: TopupDeps): Promise<TopupResult> {
    const schedule = deps.schedule ?? TOPUP_RETRY_SCHEDULE_MS;
    const shouldRetry = deps.shouldRetry ?? topupShouldRetry;
    let attempts = 0;
    let lastError: unknown;

    for (let i = 0; ; i++) {
        if (deps.isCancelled()) return { outcome: 'cancelled', attempts };
        // An unreachable network is not an attempt: the wait is bounded, and
        // when it expires the run ends as 'gave_up' so the caller stays owed.
        if (!(await deps.waitForNetwork())) {
            return { outcome: 'gave_up', attempts, error: lastError ?? new Error('network unavailable') };
        }
        if (deps.isCancelled()) return { outcome: 'cancelled', attempts };
        attempts++;
        try {
            if (deps.held.body) {
                await deps.post(deps.held.body);
                deps.held.body = null;
                return { outcome: 'ok', attempts };
            }
            const status = await deps.fetchStatus();
            deps.onStatus?.(status);
            if (deps.isCancelled()) return { outcome: 'cancelled', attempts };
            if (!shouldUploadBundle(status)) return { outcome: 'not_needed', attempts };
            const body = await deps.mintBundle(status);
            if (!body) return { outcome: 'not_needed', attempts };
            if (deps.isCancelled()) {
                // Minted but never posted: keep it for the next run, do not drop it.
                deps.held.body = body;
                return { outcome: 'cancelled', attempts };
            }
            deps.held.body = body;
            await deps.post(body);
            deps.held.body = null;
            return { outcome: 'ok', attempts };
        } catch (err) {
            lastError = err;
            if (!shouldRetry(err)) return { outcome: 'rejected', attempts, error: err };
            if (i >= schedule.length) return { outcome: 'gave_up', attempts, error: err };
            await deps.sleep(schedule[i]);
        }
    }
}

/**
 * Should this run's result be REPORTED as a failed top-up (`prekeys_low
 * {topup_failed}`)? Only a run that actually tried and failed: 'rejected', or
 * 'gave_up' after at least one request. A run that never got a network back
 * (gave_up with attempts 0) failed nothing — no request was made, the top-up
 * stays owed and the `online` event / WS reconnect / poll retries it. Beta
 * diagnostics on 1.0.23-staging.168/.169 (2026-10-20) showed exactly that on
 * wake from sleep, mislabelled cause 'local' (the synthetic
 * "network unavailable" error is not an axios error).
 */
export function isReportableTopupFailure(result: TopupResult): boolean {
    if (result.outcome === 'rejected') return true;
    return result.outcome === 'gave_up' && result.attempts > 0;
}

/**
 * A sleep that `cancelAll()` ends immediately, so unmounting the hook never
 * leaves a multi-minute retry wait dangling. Resolves (never rejects).
 */
export function makeCancellableSleep(): { sleep: (ms: number) => Promise<void>; cancelAll: () => void } {
    const wakers = new Set<() => void>();
    return {
        sleep: (ms) => new Promise<void>((resolve) => {
            const done = () => { clearTimeout(t); wakers.delete(done); resolve(); };
            const t = setTimeout(done, ms);
            wakers.add(done);
        }),
        cancelAll: () => { for (const w of [...wakers]) w(); },
    };
}
