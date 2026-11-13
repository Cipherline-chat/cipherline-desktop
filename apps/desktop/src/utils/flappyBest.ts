/**
 * flappyBest — the Firewall mini-game's best score: kept per ACCOUNT, encrypted
 * at rest, and mirrored to the server's leaderboard, which wins when it is higher.
 *
 * WHY THIS EXISTS (the "it forgot my score" report). The game's best used to
 * live in three disconnected places: the worker's memory, a DEVICE-global key
 * for the loading/offline screens (loadingGameBest.ts), and a per-account key for
 * the Home overlay (firewallBest.ts). A score set on one screen was invisible to
 * the others; the worker only counted a score at the CRASH, so quitting a good
 * run mid-flight (Esc / close) threw it away; the write was debounced with no
 * flush-on-quit guarantee; and nothing left the machine, so a reinstall or a
 * second device started from zero. Now:
 *
 *   - ONE per-account local best (`cipherline_firewall_best_<uid>`, the key the
 *     Home overlay already used, so existing scores carry over). Every screen
 *     reads and writes it; the loading screen also folds in its old device-global
 *     best so nothing already earned is lost.
 *   - recordRun() is called on every point. It raises the local best at once and
 *     queues the (score, run length) for the server. The queue is persisted
 *     (`cipherline_flappy_sync_<uid>`), so an offline run or a quit is sent next
 *     time, not lost.
 *   - On bind (sign-in / boot) and whenever the panel opens, the server's best is
 *     pulled; if it is higher it replaces the local one (reinstall / new device),
 *     and a local best the server has never seen (it predates the leaderboard) is
 *     backfilled once.
 *
 * No network code here on purpose (same arrangement as eggProgress.ts): the host
 * (components/FlappyScoresHost.tsx) injects the API, so the state machine is
 * testable in vitest's node environment.
 *
 * Both keys are classified in services/backupRegistry.ts (excluded: a game score
 * is not account data worth a backup record; the server is its backup).
 */
import secureLocalStore from './secureLocalStore';
import { readFirewallBest, writeFirewallBest } from './firewallBest';
import { isSubmittableScore, legacyRunMs } from './flappyRules';

export interface FlappyMe { best_score: number; global_opt_in: boolean; rank: number | null }
export interface FlappyEntry { rank: number; username: string; discriminator: number | null; score: number; is_me: boolean }
export interface FlappyBoard { scope: 'friends' | 'global'; entries: FlappyEntry[]; me: FlappyMe }
export type FlappyScope = FlappyBoard['scope'];

/** What a score submission came back as. 'retry' = could not reach / server error; 'refused' = the server will never take it. */
export type SubmitResult = { kind: 'ok'; best_score: number } | { kind: 'refused' } | { kind: 'retry' };

/** The network surface, injected by FlappyScoresHost. Every call resolves; none throws. */
export interface FlappyApi {
    submit(score: number, runMs: number): Promise<SubmitResult>;
    me(): Promise<FlappyMe | null>;
    board(scope: FlappyScope): Promise<FlappyBoard | null>;
    setOptIn(on: boolean): Promise<boolean | null>;
}

export const flappySyncKey = (userId: string) => `cipherline_flappy_sync_${userId}`;

interface SyncState {
    /** The best (score, run length) the server has not acknowledged. */
    pending: { score: number; runMs: number } | null;
    /** The highest score the server has REFUSED: never sent again (a refused backfill must not loop every boot). */
    refused: number;
}

function readSync(userId: string): SyncState {
    try {
        const v = JSON.parse(secureLocalStore.getItem(flappySyncKey(userId)) ?? 'null') as Partial<SyncState> | null;
        const p = v?.pending;
        return {
            pending: p && Number.isFinite(p.score) && Number.isFinite(p.runMs) ? { score: Math.floor(p.score), runMs: Math.floor(p.runMs) } : null,
            refused: Number.isFinite(v?.refused) ? Math.max(0, Math.floor(v!.refused as number)) : 0,
        };
    } catch {
        return { pending: null, refused: 0 };
    }
}
function writeSync(userId: string, s: SyncState): void {
    try { secureLocalStore.setItem(flappySyncKey(userId), JSON.stringify(s)); } catch { /* best-effort */ }
}

// ── bound account ────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 1500;
const RETRY_MS = 30_000;
const MAX_RETRIES = 5;

let bound: { userId: string; api: FlappyApi } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(best: number) => void>();

/** The best this account has, locally (0 when unknown or the store is cold). */
export function bestFor(userId: string | null | undefined): number {
    return readFirewallBest(userId);
}

/** The signed-in account, from the encrypted store (the loading screen has no React auth context). */
export function signedInUserId(): string | null {
    try {
        const id = secureLocalStore.getItem('cipherline_user_id');
        return id && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

/** Is this account's encrypted namespace decrypted and bound? (A store without the probe, e.g. a test double, counts as ready.) */
function accountReady(userId: string): boolean {
    return typeof secureLocalStore.isAccountReady === 'function' ? secureLocalStore.isAccountReady(userId) : true;
}

/** Be told when the local best changes (a server best arrived). Returns the unsubscribe. */
export function onBestChange(fn: (best: number) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
const emit = (best: number) => listeners.forEach((fn) => { try { fn(best); } catch { /* a listener must not break the sync */ } });

/**
 * A point was scored (or the run ended): raise the local best and queue the
 * score for the server. Safe to call on every point; idempotent for a score
 * that does not beat the best. `runMs` is the game-clock length of the run.
 * Returns the best on record afterwards.
 */
export function recordRun(userId: string | null | undefined, score: number, runMs: number): number {
    if (!userId || !Number.isFinite(score)) return 0;
    const s = Math.floor(score);
    // The account's namespace can be cold right after a sign-in: a read would say
    // 0 and a write would overwrite the real best. Hold the score until it is warm.
    if (!accountReady(userId)) {
        holdRun(userId, s, runMs);
        return readFirewallBest(userId);
    }
    applyHeldRun(userId);
    return commitRun(userId, s, runMs);
}

/**
 * Scores waiting for their account's namespace, one per account (the highest).
 * In memory only: while the account is cold there is nowhere safe to write them,
 * so a score held when the app quits is lost. A real best on disk never is.
 */
const heldRuns = new Map<string, { score: number; runMs: number }>();
/** Accounts with an awaitAccountLoad() running, so a run's many points share one. */
const awaitingLoad = new Set<string>();

/** Only a burst of account switches gets near this; past it the score stays held. */
const MAX_ACCOUNT_LOADS = 8;

function holdRun(userId: string, score: number, runMs: number): void {
    const held = heldRuns.get(userId);
    if (!held || score > held.score) heldRuns.set(userId, { score, runMs });
    if (awaitingLoad.has(userId)) return;
    awaitingLoad.add(userId);
    void awaitAccountLoad(userId).finally(() => { awaitingLoad.delete(userId); });
}

/**
 * Wait for the store's load to finish, and apply the held score if that made the
 * account ready. A finished load does NOT promise that: the store swallows a load
 * that failed, and the load may have been for another account, or for a sign-out.
 * So this only waits again when a NEWER load has started; with none, nothing is on
 * the way, and it stops. Re-checking regardless is a microtask cycle on a promise
 * that has already resolved, which starves timers, input and paint: it hung the
 * renderer. The score stays held for the next point or bind to apply.
 */
async function awaitAccountLoad(userId: string): Promise<void> {
    for (let i = 0; i < MAX_ACCOUNT_LOADS; i++) {
        const load = secureLocalStore.whenAccountReady?.();
        await Promise.resolve(load).catch(() => undefined);
        if (accountReady(userId)) { applyHeldRun(userId); return; }
        if (secureLocalStore.whenAccountReady?.() === load) return;
    }
}

function applyHeldRun(userId: string): void {
    const held = heldRuns.get(userId);
    if (!held) return;
    heldRuns.delete(userId);
    commitRun(userId, held.score, held.runMs);
}

/** Raise the best and queue it for the server. The account must be ready. */
function commitRun(userId: string, s: number, runMs: number): number {
    const before = readFirewallBest(userId);
    if (s <= before) return before;
    const after = writeFirewallBest(userId, s);
    if (isSubmittableScore(s)) {
        const st = readSync(userId);
        if (s > st.refused && (!st.pending || s > st.pending.score)) {
            writeSync(userId, { ...st, pending: { score: s, runMs: Math.max(0, Math.floor(runMs)) } });
        }
    }
    if (bound?.userId === userId) schedule(DEBOUNCE_MS);
    return after;
}

function schedule(ms: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void syncNow(); }, ms);
}

/** Send what the server has not acknowledged. Resolves once the attempt is over. */
export function syncNow(): Promise<void> {
    if (inFlight) return inFlight;
    const b = bound;
    if (!b) return Promise.resolve();
    const run = async () => {
        const st = readSync(b.userId);
        const p = st.pending;
        if (!p) return;
        if (p.score <= st.refused || !isSubmittableScore(p.score)) { writeSync(b.userId, { ...st, pending: null }); return; }
        const res = await b.api.submit(p.score, p.runMs);
        if (bound?.userId !== b.userId) return; // signed out / switched while it was in flight
        const now = readSync(b.userId);
        if (res.kind === 'ok') {
            // Clear only what was sent: a better run may have been queued meanwhile.
            writeSync(b.userId, { ...now, pending: now.pending && now.pending.score > p.score ? now.pending : null });
            retries = 0;
            if (res.best_score > readFirewallBest(b.userId)) { writeFirewallBest(b.userId, res.best_score); emit(res.best_score); }
            if (readSync(b.userId).pending) schedule(DEBOUNCE_MS);
        } else if (res.kind === 'refused') {
            writeSync(b.userId, { pending: now.pending && now.pending.score > p.score ? now.pending : null, refused: Math.max(now.refused, p.score) });
            if (readSync(b.userId).pending) schedule(DEBOUNCE_MS);
        } else if (retries < MAX_RETRIES) {
            retries++;
            schedule(RETRY_MS);
        }
    };
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
}

/**
 * Pull the server's standing and reconcile: a higher server best replaces the
 * local one; a local best the server has not seen is queued. Returns the server's `me`.
 */
export async function reconcile(): Promise<FlappyMe | null> {
    const b = bound;
    if (!b) return null;
    const me = await b.api.me();
    if (!me || bound?.userId !== b.userId) return me;
    let local = readFirewallBest(b.userId);
    if (me.best_score > local) {
        local = writeFirewallBest(b.userId, me.best_score);
        emit(local);
    }
    const st = readSync(b.userId);
    if (local > me.best_score && !st.pending && local > st.refused && isSubmittableScore(local)) {
        // A best set before the leaderboard existed (or while offline with the queue lost): its run was never timed.
        writeSync(b.userId, { ...st, pending: { score: local, runMs: legacyRunMs(local) } });
    }
    if (readSync(b.userId).pending) void syncNow();
    return me;
}

/** Bind the signed-in account and its network surface; reconciles at once. */
export function bindFlappyAccount(userId: string, api: FlappyApi): void {
    unbindFlappyAccount();
    bound = { userId, api };
    retries = 0;
    if (accountReady(userId)) applyHeldRun(userId); // held through a failed load: this sign-in's load worked
    void reconcile();
}

export function unbindFlappyAccount(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    bound = null;
    inFlight = null;
}

/** The bound API, for the leaderboard panel (null while signed out). */
export function flappyApi(): FlappyApi | null {
    return bound?.api ?? null;
}

/** Test hook: forget all module state. */
export function __resetFlappyBest(): void {
    unbindFlappyAccount();
    listeners.clear();
    heldRuns.clear();
    awaitingLoad.clear();
    retries = 0;
}
