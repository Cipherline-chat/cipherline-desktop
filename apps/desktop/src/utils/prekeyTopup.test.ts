import { describe, it, expect } from 'vitest';
import { isReportableTopupFailure, makeCancellableSleep, runTopupWithRetry, TOPUP_RETRY_SCHEDULE_MS, topupShouldRetry, type TopupDeps } from './prekeyTopup';
import type { KeyStatus, UploadBundleBody } from './keyBundleUpload';

// Shaped like the axios build; axios itself cannot be imported under the test
// setup's bare `window` stub (see networkError.test.ts).
class AxiosError extends Error {
    isAxiosError = true;
    response?: { status: number };
    code?: string;
    constructor(message: string, code?: string, response?: { status: number }) {
        super(message);
        this.name = 'AxiosError';
        this.code = code;
        this.response = response;
    }
}
const netErr = () => new AxiosError('Network Error', 'ERR_NETWORK');
const httpErr = (status: number) => new AxiosError('Request failed', 'ERR_BAD_REQUEST', { status });

const LOW: KeyStatus = { otp_remaining: 5, spk_age_days: 1, needs_rotation: true };
const HEALTHY: KeyStatus = { otp_remaining: 100, spk_age_days: 1, needs_rotation: false };
const body = (n = 1): UploadBundleBody => ({
    device_id: 'd', identity_key_pub_b64: 'i', registration_id: 1, signed_prekey_id: 1,
    signed_prekey_pub_b64: 'p', signed_prekey_sig_b64: 's',
    one_time_prekeys: Array.from({ length: n }, (_, i) => ({ prekey_id: i, prekey_pub_b64: `k${i}` })),
});

function rig(over: Partial<TopupDeps> = {}) {
    const sleeps: number[] = [];
    const posted: UploadBundleBody[] = [];
    let mints = 0;
    let statuses = 0;
    const deps: TopupDeps = {
        fetchStatus: async () => { statuses++; return LOW; },
        mintBundle: async () => { mints++; return body(mints); },
        post: async (b) => { posted.push(b); },
        waitForNetwork: async () => true,
        sleep: async (ms) => { sleeps.push(ms); },
        isCancelled: () => false,
        held: { body: null },
        ...over,
    };
    return { deps, sleeps, posted, get mints() { return mints; }, get statuses() { return statuses; } };
}

describe('runTopupWithRetry - a failed prekey top-up retries and eventually succeeds', () => {
    it('first attempt works: one status read, one mint, one POST', async () => {
        const r = rig();
        const res = await runTopupWithRetry(r.deps);
        expect(res).toMatchObject({ outcome: 'ok', attempts: 1 });
        expect(r.posted).toHaveLength(1);
        expect(r.deps.held.body).toBeNull();
    });

    it('the wake case: network errors on the first attempts, then success - retried on the backoff schedule', async () => {
        let n = 0;
        const r = rig({ fetchStatus: async () => { if (++n <= 3) throw netErr(); return LOW; } });
        const res = await runTopupWithRetry(r.deps);
        expect(res).toMatchObject({ outcome: 'ok', attempts: 4 });
        expect(r.sleeps).toEqual(TOPUP_RETRY_SCHEDULE_MS.slice(0, 3));    // 5 s, 15 s, 45 s
        expect(r.posted).toHaveLength(1);                                  // the top-up really happened
    });

    it('waits for the network before EVERY attempt, and does not count the wait as an attempt', async () => {
        const log: string[] = [];
        let up = false;
        const r = rig({
            waitForNetwork: async () => { log.push('wait'); const was = up; up = true; return was || (log.length > 1); },
            fetchStatus: async () => { log.push('status'); return LOW; },
        });
        // 1st wait -> false (network never came inside its window): gave_up with 0 attempts, nothing fired.
        const first = await runTopupWithRetry(r.deps);
        expect(first).toMatchObject({ outcome: 'gave_up', attempts: 0 });
        expect(log).toEqual(['wait']);
        // The caller stays owed and a later trigger runs again, now with the network up.
        const second = await runTopupWithRetry(r.deps);
        expect(second.outcome).toBe('ok');
    });

    it('a 5xx / 429 / 408 is retried; a settled 400 / 403 is NOT (reported as rejected, one attempt)', async () => {
        for (const status of [500, 502, 503, 408, 429]) {
            let n = 0;
            const r = rig({ post: async (b) => { if (++n === 1) throw httpErr(status); r.posted.push(b); } });
            expect((await runTopupWithRetry(r.deps)).outcome).toBe('ok');
        }
        for (const status of [400, 403, 404]) {
            const r = rig({ post: async () => { throw httpErr(status); } });
            const res = await runTopupWithRetry(r.deps);
            expect(res).toMatchObject({ outcome: 'rejected', attempts: 1 });
            expect(r.sleeps).toEqual([]);
        }
    });

    it('our own code throwing (main-process mint) is not retried five times', async () => {
        const r = rig({ mintBundle: async () => { throw new Error('keystore locked'); } });
        const res = await runTopupWithRetry(r.deps);
        expect(res).toMatchObject({ outcome: 'rejected', attempts: 1 });
    });

    it('keeps failing: gives up after the whole schedule, with the last error, and leaves the caller owed', async () => {
        const r = rig({ fetchStatus: async () => { throw netErr(); } });
        const res = await runTopupWithRetry(r.deps);
        expect(res.outcome).toBe('gave_up');
        expect(res.attempts).toBe(TOPUP_RETRY_SCHEDULE_MS.length + 1);
        expect(r.sleeps).toEqual([...TOPUP_RETRY_SCHEDULE_MS]);
        expect(res.error).toBeInstanceOf(AxiosError);
    });

    it('never throws - even when every dependency does (no unhandled rejection from a fire-and-forget caller)', async () => {
        const r = rig({ fetchStatus: async () => { throw netErr(); }, waitForNetwork: async () => true });
        await expect(runTopupWithRetry(r.deps)).resolves.toBeDefined();
    });

    it('a healthy pool needs no upload (not_needed), so nothing is minted', async () => {
        const r = rig({ fetchStatus: async () => HEALTHY });
        const res = await runTopupWithRetry(r.deps);
        expect(res.outcome).toBe('not_needed');
        expect(r.mints).toBe(0);
        expect(r.posted).toHaveLength(0);
    });

    it('main answers "nothing to mint" (null): not_needed, no POST', async () => {
        const r = rig({ mintBundle: async () => null });
        expect((await runTopupWithRetry(r.deps)).outcome).toBe('not_needed');
        expect(r.posted).toHaveLength(0);
    });

    // ── the money-safety property of forward secrecy: do not orphan prekeys ──
    it('a minted bundle whose POST failed is RE-POSTED as-is - the retry never mints a second batch', async () => {
        let n = 0;
        const r = rig({ post: async (b) => { if (++n <= 2) throw netErr(); r.posted.push(b); } });
        const res = await runTopupWithRetry(r.deps);
        expect(res.outcome).toBe('ok');
        expect(r.mints).toBe(1);                           // minted ONCE across three POST attempts
        expect(r.posted).toHaveLength(1);
        expect(r.posted[0].one_time_prekeys).toHaveLength(1);
        expect(r.statuses).toBe(1);                         // and not even re-read
    });

    it('a held bundle survives a give-up and is posted first by the NEXT run', async () => {
        const held: { body: UploadBundleBody | null } = { body: null };
        const down = rig({ held, post: async () => { throw netErr(); }, schedule: [1] });
        expect((await runTopupWithRetry(down.deps)).outcome).toBe('gave_up');
        expect(held.body).not.toBeNull();
        const up = rig({ held, fetchStatus: async () => { throw new Error('must not be read'); } });
        const res = await runTopupWithRetry(up.deps);
        expect(res.outcome).toBe('ok');
        expect(up.posted).toHaveLength(1);
        expect(up.mints).toBe(0);
        expect(held.body).toBeNull();
    });

    it('cancelled mid-run stops retrying; a bundle minted before the cancel is kept, not dropped', async () => {
        let cancelled = false;
        const r = rig({
            isCancelled: () => cancelled,
            mintBundle: async () => { cancelled = true; return body(); },
        });
        const res = await runTopupWithRetry(r.deps);
        expect(res.outcome).toBe('cancelled');
        expect(r.posted).toHaveLength(0);
        expect(r.deps.held.body).not.toBeNull();

        const c2 = rig({ isCancelled: () => true });
        expect((await runTopupWithRetry(c2.deps)).outcome).toBe('cancelled');
        expect(c2.statuses).toBe(0);
    });

    it('negative control: with retries disabled (empty schedule) the first transient failure is final', async () => {
        let n = 0;
        const r = rig({ schedule: [], fetchStatus: async () => { if (++n === 1) throw netErr(); return LOW; } });
        expect((await runTopupWithRetry(r.deps)).outcome).toBe('gave_up');
        expect(r.posted).toHaveLength(0);                   // the pool would have stayed low
    });
});

describe('isReportableTopupFailure - only a run that tried and failed is a failure', () => {
    it('a run that never had a network (gave_up, 0 attempts) is not reported', () => {
        expect(isReportableTopupFailure({ outcome: 'gave_up', attempts: 0, error: new Error('network unavailable') })).toBe(false);
    });
    it('gave_up after real attempts, and a settled refusal, are reported (positive controls)', () => {
        expect(isReportableTopupFailure({ outcome: 'gave_up', attempts: 6 })).toBe(true);
        expect(isReportableTopupFailure({ outcome: 'rejected', attempts: 1 })).toBe(true);
    });
    it('success / nothing to do / cancelled are never failures', () => {
        for (const outcome of ['ok', 'not_needed', 'cancelled'] as const) {
            expect(isReportableTopupFailure({ outcome, attempts: 1 })).toBe(false);
        }
    });
});

describe('topupShouldRetry', () => {
    it('retries transport failures and retryable statuses, not settled refusals or local errors', () => {
        expect(topupShouldRetry(netErr())).toBe(true);
        expect(topupShouldRetry(httpErr(503))).toBe(true);
        expect(topupShouldRetry(httpErr(429))).toBe(true);
        expect(topupShouldRetry(httpErr(400))).toBe(false);
        expect(topupShouldRetry(httpErr(403))).toBe(false);
        expect(topupShouldRetry(new Error('boom'))).toBe(false);
        expect(topupShouldRetry(undefined)).toBe(false);
    });
});

describe('makeCancellableSleep', () => {
    it('cancelAll ends a pending sleep immediately', async () => {
        const { sleep, cancelAll } = makeCancellableSleep();
        const t0 = Date.now();
        const p = sleep(60_000);
        cancelAll();
        await p;
        expect(Date.now() - t0).toBeLessThan(1_000);
    });
});
