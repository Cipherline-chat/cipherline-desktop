import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// An in-memory secureLocalStore with the account-readiness probe, so the "cold namespace" window can be staged.
const h = vi.hoisted(() => {
    const store = new Map<string, string>();
    const state = { ready: new Set<string>(), release: null as null | (() => void), gate: Promise.resolve() };
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        isAccountReady: (uid: string) => state.ready.has(uid),
        whenAccountReady: () => state.gate,
    };
    return { store, state, api };
});
vi.mock('./secureLocalStore', () => ({ default: h.api, secureLocalStore: h.api }));

import {
    __resetFlappyBest, bestFor, bindFlappyAccount, flappySyncKey, onBestChange, reconcile, recordRun, signedInUserId, syncNow, unbindFlappyAccount,
    type FlappyApi, type FlappyMe, type SubmitResult,
} from './flappyBest';
import { firewallBestKey } from './firewallBest';
import { legacyRunMs, minRunMs } from './flappyRules';
import { classifyKvKey } from '../services/backupRegistry';

const A = 'acct-a', B = 'acct-b';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fakeApi(opts: { me?: FlappyMe | null; submit?: (score: number, runMs: number) => SubmitResult } = {}) {
    const submit = vi.fn(async (score: number, runMs: number): Promise<SubmitResult> =>
        opts.submit ? opts.submit(score, runMs) : { kind: 'ok', best_score: score });
    const me = vi.fn(async () => (opts.me === undefined ? { best_score: 0, global_opt_in: false, rank: null } : opts.me));
    const api: FlappyApi = { submit, me, board: vi.fn(async () => null), setOptIn: vi.fn(async (on: boolean) => on) };
    return { api, submit, me };
}
const sync = (uid: string) => JSON.parse(h.store.get(flappySyncKey(uid)) ?? 'null');

beforeEach(() => {
    vi.useFakeTimers();
    h.store.clear();
    h.state.ready = new Set([A, B]);
    h.state.gate = Promise.resolve();
    __resetFlappyBest();
});
afterEach(() => { __resetFlappyBest(); vi.useRealTimers(); });

describe('flappyBest: the personal best persists per account', () => {
    it('a score is saved under the account, immediately (not after a debounce) and survives a "restart"', () => {
        expect(recordRun(A, 12, 40_000)).toBe(12);
        expect(h.store.get(firewallBestKey(A))).toBe('12');
        // restart: all module state gone, only the encrypted store survives
        __resetFlappyBest();
        expect(bestFor(A)).toBe(12);
    });

    it('only a higher score replaces it; a worse run never lowers it', () => {
        recordRun(A, 20, 60_000);
        expect(recordRun(A, 7, 20_000)).toBe(20);
        expect(recordRun(A, 20, 60_000)).toBe(20);
        expect(bestFor(A)).toBe(20);
        expect(recordRun(A, 21, 62_000)).toBe(21);
    });

    it('accounts are isolated: B never sees or overwrites A\'s best', () => {
        recordRun(A, 30, 90_000);
        expect(bestFor(B)).toBe(0);
        recordRun(B, 5, 15_000);
        expect(bestFor(A)).toBe(30);
        expect(bestFor(B)).toBe(5);
        expect(sync(A).pending.score).toBe(30);
        expect(sync(B).pending.score).toBe(5);
    });

    it('no signed-in account: nothing is written (a score without an owner has nowhere to live)', () => {
        expect(recordRun(null, 9, 1000)).toBe(0);
        expect(recordRun(undefined, 9, 1000)).toBe(0);
        expect(h.store.size).toBe(0);
    });

    it('a COLD namespace (right after sign-in) neither reads 0 nor overwrites the real best: it waits for the account', async () => {
        h.store.set(firewallBestKey(A), '40'); // the real stored best, not yet visible
        h.state.ready.delete(A);
        let open!: () => void;
        h.state.gate = new Promise<void>((r) => { open = r; });
        recordRun(A, 5, 10_000); // a bad run lands in the cold window
        await flush();
        expect(h.store.get(firewallBestKey(A))).toBe('40'); // untouched while cold
        h.state.ready.add(A);
        open();
        await flush();
        expect(h.store.get(firewallBestKey(A))).toBe('40'); // 5 < 40: still the real best
    });

    it('a score recorded in the cold window is applied once the account is ready', async () => {
        h.state.ready.delete(A);
        let open!: () => void;
        h.state.gate = new Promise<void>((r) => { open = r; });
        recordRun(A, 9, 25_000);
        expect(h.store.get(firewallBestKey(A))).toBeUndefined();
        h.state.ready.add(A);
        open();
        await flush();
        expect(h.store.get(firewallBestKey(A))).toBe('9');
    });

    it('signedInUserId reads the account from the encrypted store', () => {
        expect(signedInUserId()).toBeNull();
        h.store.set('cipherline_user_id', A);
        expect(signedInUserId()).toBe(A);
    });

    it('the keys are classified for backup (excluded: the server is the backup)', () => {
        expect(classifyKvKey(firewallBestKey(A), A)).toBe('exclude');
        expect(classifyKvKey(flappySyncKey(A), A)).toBe('exclude');
    });
});

describe('flappyBest: sync to the server', () => {
    it('a new best is queued and sent after a short quiet beat, then the queue is cleared', async () => {
        const { api, submit } = fakeApi();
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 15, 50_000);
        expect(submit).not.toHaveBeenCalled(); // debounced: a run scores many points
        recordRun(A, 16, 53_000);
        await vi.advanceTimersByTimeAsync(1600);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledWith(16, 53_000); // the latest, with ITS run length
        expect(sync(A).pending).toBeNull();
    });

    it('syncNow (the overlay closing mid-run) sends at once', async () => {
        const { api, submit } = fakeApi();
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 6, 20_000);
        await syncNow();
        expect(submit).toHaveBeenCalledWith(6, 20_000);
    });

    it('offline: the score is kept, retried later, and survives a restart in the persisted queue', async () => {
        let up = false;
        const { api, submit } = fakeApi({ submit: (s) => (up ? { kind: 'ok', best_score: s } : { kind: 'retry' }) });
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 18, 60_000);
        await vi.advanceTimersByTimeAsync(1600);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(sync(A).pending).toEqual({ score: 18, runMs: 60_000 }); // not lost
        // app quit and reopened, network back
        unbindFlappyAccount();
        up = true;
        bindFlappyAccount(A, api);
        await vi.advanceTimersByTimeAsync(10);
        await flush();
        expect(submit).toHaveBeenLastCalledWith(18, 60_000);
        expect(sync(A).pending).toBeNull();
    });

    it('a failing network backs off (30 s) and stops after a few tries instead of hammering', async () => {
        const { api, submit } = fakeApi({ submit: () => ({ kind: 'retry' }) });
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 8, 25_000);
        await vi.advanceTimersByTimeAsync(1600);
        expect(submit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(submit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(submit).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(submit.mock.calls.length).toBeLessThanOrEqual(7); // 1 + MAX_RETRIES + the in-flight margin
    });

    it('a score the server refuses (implausible) is dropped and never sent again', async () => {
        const { api, submit } = fakeApi({ submit: () => ({ kind: 'refused' }) });
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 50, 2_000);
        await vi.advanceTimersByTimeAsync(1600);
        expect(sync(A)).toEqual({ pending: null, refused: 50 });
        // another sign-in / boot: the local best (50) is NOT re-queued as a "legacy backfill"
        unbindFlappyAccount();
        bindFlappyAccount(A, fakeApi({ me: { best_score: 0, global_opt_in: false, rank: null } }).api);
        await flush();
        expect(sync(A).pending).toBeNull();
        expect(submit).toHaveBeenCalledTimes(1);
        // but a genuinely higher later score is still sent
        recordRun(A, 51, 200_000);
        expect(sync(A).pending).toEqual({ score: 51, runMs: 200_000 });
    });

    it('scores the server could never take (over the cap) are not queued at all', async () => {
        const { api, submit } = fakeApi();
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 999999, 60_000);
        await vi.advanceTimersByTimeAsync(5000);
        expect(submit).not.toHaveBeenCalled();
    });

    it('signing out mid-flight never writes the reply into the next account', async () => {
        let finish!: (r: SubmitResult) => void;
        const { api } = fakeApi({ submit: () => ({ kind: 'retry' }) });
        api.submit = vi.fn(() => new Promise<SubmitResult>((r) => { finish = r; }));
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 10, 30_000);
        const p = syncNow();
        unbindFlappyAccount();
        bindFlappyAccount(B, fakeApi().api);
        finish({ kind: 'ok', best_score: 77 });
        await p;
        expect(bestFor(B)).toBe(0);
        expect(bestFor(A)).toBe(10);
    });
});

describe('flappyBest: the server is the source of truth when it is higher', () => {
    it('a reinstall / new device: the server\'s best replaces an empty local one', async () => {
        const seen: number[] = [];
        onBestChange((b) => seen.push(b));
        bindFlappyAccount(A, fakeApi({ me: { best_score: 42, global_opt_in: true, rank: 3 } }).api);
        await flush();
        expect(bestFor(A)).toBe(42);
        expect(seen).toEqual([42]);
    });

    it('a higher server best beats a lower local one; a higher local one is kept and backfilled', async () => {
        h.store.set(firewallBestKey(A), '10');
        bindFlappyAccount(A, fakeApi({ me: { best_score: 25, global_opt_in: false, rank: null } }).api);
        await flush();
        expect(bestFor(A)).toBe(25);
        unbindFlappyAccount();

        h.store.set(firewallBestKey(B), '30');
        const { api, submit } = fakeApi({ me: { best_score: 12, global_opt_in: false, rank: null } });
        bindFlappyAccount(B, api);
        await flush();
        expect(bestFor(B)).toBe(30); // never lowered by a stale server value
        // a best that predates the leaderboard has no recorded run length: sent with the shortest the server accepts
        expect(submit).toHaveBeenCalledWith(30, legacyRunMs(30));
        expect(legacyRunMs(30)).toBeGreaterThanOrEqual(minRunMs(30));
    });

    it('an offline server (me = null) changes nothing', async () => {
        h.store.set(firewallBestKey(A), '11');
        const { api, submit } = fakeApi({ me: null });
        bindFlappyAccount(A, api);
        await flush();
        expect(bestFor(A)).toBe(11);
        expect(submit).not.toHaveBeenCalled();
    });

    it('reconcile with nothing bound is a no-op', async () => {
        expect(await reconcile()).toBeNull();
    });

    it('a server reply that raises the best (another device scored higher) updates the local best', async () => {
        const { api } = fakeApi({ submit: () => ({ kind: 'ok', best_score: 60 }) });
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 14, 45_000);
        await syncNow();
        expect(bestFor(A)).toBe(60);
    });

    it('a run queued while another was in flight is not cleared by the first one\'s reply', async () => {
        const resolvers: Array<() => void> = [];
        const { api } = fakeApi();
        api.submit = vi.fn((s: number) => new Promise<SubmitResult>((r) => { resolvers.push(() => r({ kind: 'ok', best_score: s })); }));
        bindFlappyAccount(A, api);
        await flush();
        recordRun(A, 10, 30_000);
        const p = syncNow();
        recordRun(A, 11, 33_000); // a better run lands while the first is in flight
        resolvers[0]();
        await p;
        expect(sync(A).pending).toEqual({ score: 11, runMs: 33_000 });
    });
});
