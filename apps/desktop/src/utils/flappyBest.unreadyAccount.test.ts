import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { KvCrypto } from '../../electron/kv-crypto';
import { firewallBestKey } from './firewallBest';
import type { FlappyApi } from './flappyBest';

/**
 * recordRun() when the account is NOT ready and nothing is on the way to make it
 * ready. It used to re-enter itself from a `.then` on whenAccountReady(), which
 * in this state has already resolved: a pure microtask cycle. Timers, input and
 * paint all wait for the microtask queue to drain, so the renderer froze for good.
 *
 * These run against the REAL secureLocalStore (flappyBest.test.ts uses a double),
 * because how the store reaches that state is the thing being pinned: a load that
 * fails is swallowed, so whenAccountReady() resolves with the account still unready.
 *
 * THE TRIPWIRE. A plain "expect it not to hang" cannot fail here: vitest's own
 * test timeout is a timer, and the spin starves timers, so a regression would wedge
 * the worker with no report at all. Every test therefore counts readiness probes
 * and throws past RUNAWAY, which breaks the cycle and lets the assertions report it.
 */
const RUNAWAY = 1000;
/** Far above what any correct path does, far below what a spin reaches before the tripwire. */
const FEW_PROBES = 20;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

type Store = typeof import('./secureLocalStore').secureLocalStore;
type Flappy = typeof import('./flappyBest');

let store: Store;
let flappy: Flappy;
let probeCount = 0;
/** When set, decides the readiness answer instead of the store. */
let probeAnswer: ((uid: string) => boolean) | null = null;

/** One real macrotask. Reaching the line after this is the proof the event loop is alive. */
const macrotask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** Count (and bound) readiness probes. Installed once per test: re-spying would capture the spy as "real" and recurse. */
function watchProbes(): void {
    const real = store.isAccountReady.bind(store);
    probeCount = 0;
    probeAnswer = null;
    vi.spyOn(store, 'isAccountReady').mockImplementation((uid: string) => {
        if (++probeCount > RUNAWAY) throw new Error(`readiness probed ${probeCount} times: recordRun is spinning`);
        return probeAnswer ? probeAnswer(uid) : real(uid);
    });
}

const signIn = async (uid: string) => { store.setItem('cipherline_user_id', uid); await store.whenAccountReady(); };
const signOut = async () => { store.removeItem('cipherline_user_id'); await store.whenAccountReady(); };
const best = (uid: string) => store.getItem(firewallBestKey(uid));
const syncState = (uid: string) => JSON.parse(store.getItem(flappy.flappySyncKey(uid)) ?? 'null');

/** IndexedDB reads start failing: the one failure onUserChanged() swallows without marking the account ready. */
function breakAccountLoads() {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return vi.spyOn(store as unknown as { readAllRecords: () => Promise<unknown> }, 'readAllRecords')
        .mockRejectedValue(new Error('IndexedDB read failed'));
}

/** A sign-in whose load failed, with `stored` already on disk: the state the renderer used to hang in. */
async function signInWithFailedLoad(uid: string, stored: string) {
    await signIn(uid);
    store.setItem(firewallBestKey(uid), stored);
    await signOut();
    const loads = breakAccountLoads();
    await signIn(uid);
    expect(store.isAccountReady(uid)).toBe(false);
    probeCount = 0;
    return loads;
}

function fakeApi(): FlappyApi {
    return {
        submit: vi.fn(async (score: number) => ({ kind: 'ok' as const, best_score: score })),
        me: vi.fn(async () => ({ best_score: 0, global_opt_in: false, rank: null })),
        board: vi.fn(async () => null),
        setOptIn: vi.fn(async (on: boolean) => on),
    };
}

beforeEach(async () => {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => Buffer.from(KEY_B64, 'base64') });
    (globalThis as unknown as { window: { electronAPI: unknown } }).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: Array<{ k: string; o: string | null; b: Uint8Array }>) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Array<{ k: string; o: string | null; v: string }>) => kv.seal(recs)),
    };
    // Fresh singletons: _resetForTest() leaves readyUserId behind, and that is the field under test.
    // A fresh database too: a flush the previous test's store already started can land after any
    // wipe, and the new store would hydrate that record (it read as a stray best under load).
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    store = (await import('./secureLocalStore')).secureLocalStore;
    flappy = await import('./flappyBest');
    await store.hydrate();
    watchProbes();
});

afterEach(() => {
    flappy.__resetFlappyBest();
    store._resetForTest(); // cancels its pending flush timers
    vi.restoreAllMocks();
});

describe('recordRun: an account that never becomes ready cannot hang the page', () => {
    it('no account was ever bound (hydrated, nobody signed in)', async () => {
        expect(flappy.recordRun(A, 5, 15_000)).toBe(0);
        await macrotask();
        expect(probeCount).toBeLessThan(FEW_PROBES);
        expect(best(A)).toBeNull();
    });

    it('the sign-in load failed: the store says resolved, the account stays unready', async () => {
        await signInWithFailedLoad(A, '40');
        expect(flappy.recordRun(A, 50, 150_000)).toBe(0);
        await macrotask();
        expect(probeCount).toBeLessThan(FEW_PROBES);
        expect(best(A)).toBeNull(); // cold: a write here would overwrite the real 40
    });

    it('stays bounded across every point of a run, not just the first', async () => {
        await signInWithFailedLoad(A, '40');
        for (let score = 1; score <= 10; score++) {
            flappy.recordRun(A, score, score * 3_000);
            await macrotask();
        }
        expect(probeCount).toBeLessThan(FEW_PROBES * 2);
    });

    it('signed out while a point was on its way (the overlay still holds the old account)', async () => {
        await signIn(A);
        store.setItem(firewallBestKey(A), '40');
        store.removeItem('cipherline_user_id'); // logout(): the account is gone before React unmounts the game
        flappy.recordRun(A, 50, 150_000);
        await store.whenAccountReady();
        await macrotask();
        expect(probeCount).toBeLessThan(FEW_PROBES);
        expect(best(A)).toBeNull();
    });

    it('a store that hands out a new resolved promise on every call cannot keep it waiting', async () => {
        const when = vi.spyOn(store, 'whenAccountReady').mockImplementation(() => Promise.resolve());
        flappy.recordRun(A, 5, 15_000);
        await macrotask();
        expect(probeCount).toBeLessThan(FEW_PROBES);
        expect(when.mock.calls.length).toBeLessThan(FEW_PROBES * 2);
    });
});

describe('recordRun: the score still lands once the account is ready', () => {
    it('a sign-in in flight: applied as soon as the load finishes, with no further point', async () => {
        store.setItem('cipherline_user_id', A);
        expect(store.isAccountReady(A)).toBe(false);
        flappy.recordRun(A, 50, 150_000);
        await store.whenAccountReady();
        await macrotask();
        expect(best(A)).toBe('50');
        expect(syncState(A).pending).toEqual({ score: 50, runMs: 150_000 });
    });

    it('a bad run in that window does not overwrite the real best', async () => {
        await signIn(A);
        store.setItem(firewallBestKey(A), '40');
        await signOut();
        store.setItem('cipherline_user_id', A);
        flappy.recordRun(A, 5, 15_000);
        await store.whenAccountReady();
        await macrotask();
        expect(best(A)).toBe('40');
    });

    it('several points in the window keep the highest, with that run\'s own length', async () => {
        store.setItem('cipherline_user_id', A);
        flappy.recordRun(A, 7, 21_000);
        flappy.recordRun(A, 9, 27_000);
        flappy.recordRun(A, 8, 24_000);
        await store.whenAccountReady();
        await macrotask();
        expect(best(A)).toBe('9');
        expect(syncState(A).pending).toEqual({ score: 9, runMs: 27_000 });
    });

    it('follows a newer load when the one it awaited was replaced', async () => {
        let ready = false;
        probeAnswer = () => ready;
        const release: Array<() => void> = [];
        const gate = () => new Promise<void>((resolve) => { release.push(resolve); });
        let current = gate();
        vi.spyOn(store, 'whenAccountReady').mockImplementation(() => current);

        flappy.recordRun(A, 50, 150_000);
        current = gate(); // an account switch started another load before the first finished
        release[0]();
        await macrotask();
        expect(best(A)).toBeNull(); // the first load was not for this account: still waiting

        ready = true;
        release[1]();
        await macrotask();
        expect(best(A)).toBe('50');
    });

    it('a failed load, then a good sign-in: binding applies the held score', async () => {
        const loads = await signInWithFailedLoad(A, '40');
        flappy.recordRun(A, 50, 150_000);
        await macrotask();

        loads.mockRestore();
        await signOut();
        await signIn(A);
        expect(best(A)).toBe('40'); // nothing was written over it while the account was cold

        flappy.bindFlappyAccount(A, fakeApi());
        expect(best(A)).toBe('50');
        expect(syncState(A).pending).toEqual({ score: 50, runMs: 150_000 });
    });

    it('a failed load, then a good sign-in: the next point applies the held score too (no host on the loading screen)', async () => {
        const loads = await signInWithFailedLoad(A, '40');
        flappy.recordRun(A, 50, 150_000);
        await macrotask();

        loads.mockRestore();
        await signOut();
        await signIn(A);

        expect(flappy.recordRun(A, 3, 9_000)).toBe(50); // a worse point must not lose the better held one
        expect(best(A)).toBe('50');
    });

    it('binding while the account is still cold writes nothing and keeps the score held', async () => {
        const loads = await signInWithFailedLoad(A, '40');
        flappy.recordRun(A, 50, 150_000);
        await macrotask();

        flappy.bindFlappyAccount(A, fakeApi());
        expect(best(A)).toBeNull();

        loads.mockRestore();
        await signOut();
        await signIn(A);
        flappy.bindFlappyAccount(A, fakeApi());
        expect(best(A)).toBe('50');
    });

    it('a held score only ever lands on its own account', async () => {
        const loads = await signInWithFailedLoad(A, '40');
        flappy.recordRun(A, 50, 150_000);
        await macrotask();

        loads.mockRestore();
        await signOut();
        await signIn(B);
        flappy.bindFlappyAccount(B, fakeApi());
        expect(flappy.recordRun(B, 3, 9_000)).toBe(3);
        expect(best(B)).toBe('3');
    });
});
