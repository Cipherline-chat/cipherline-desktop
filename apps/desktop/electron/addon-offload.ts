/**
 * addon-offload — keep the PipeWire addon's blocking calls off the main thread.
 *
 * WHY: on Linux `audio_capture.node` runs two calls SYNCHRONOUSLY in whatever
 * thread JS calls them from, and both wait on the PipeWire daemon:
 *
 *   • isSupported() → ProbePipeWire: connects to the daemon and waits up to
 *     2 × 1 s for the registry sync (cached 10 s for a "yes", 3 s for a "no").
 *     It was called from five main-thread IPC paths — including every
 *     screen-share start (`desktop-capturer-resolve`) and the renderer's
 *     capability probe. A daemon that is wedged (a stuck NVIDIA / portal
 *     session is enough) costs the UI thread 2 s per uncached call, every 3–10 s.
 *   • listApps(pid) → CollectApps: a full session (connect, registry, up to
 *     3 × 1 s of waiting, teardown) for the Wayland window-share picker.
 *
 * The user's report (froze in a call, KDE Wayland + PipeWire) is exactly the
 * place a wedged PipeWire hurts. Neither call needs the main thread: they only
 * read the graph, share no state with a running capture, and are thread-safe in
 * the addon (own Session, mutex-guarded cache). So they run in a worker thread
 * that loads the same addon, with a hard deadline here: a call that does not
 * answer in time is abandoned, the worker (stuck in native code) is terminated
 * and replaced lazily, and after repeated timeouts a circuit breaker answers
 * "not available" immediately for a while instead of trying again.
 *
 * start/stopCapture stay on main (they hand over a ThreadSafeFunction callback
 * and need the running Session); they are only reached after an `isSupported`
 * answer, and the capture path is event-driven (the PipeWire loop has its own
 * thread; the napi callback is non-blocking).
 *
 * If the addon cannot be loaded in a worker at all, `usable` turns false and
 * main falls back to the old direct calls — no regression, just no isolation.
 *
 * No `electron` import: unit-tested with fake workers (addon-offload.test.ts).
 */
export type OffloadFn = 'isSupported' | 'listApps';
const ALLOWED: ReadonlySet<string> = new Set<OffloadFn>(['isSupported', 'listApps']);

export interface OffloadWorker {
    postMessage(m: unknown): void;
    terminate(): unknown;
    on(ev: 'message' | 'error' | 'exit', cb: (...a: unknown[]) => void): unknown;
    unref?(): void;
}
export type OffloadWorkerFactory = (source: string, data: { addonPath: string }) => OffloadWorker;

export type OffloadResult<T = unknown> =
    | { ok: true; value: T }
    | { ok: false; reason: 'timeout' | 'breaker' | 'no-worker' | 'error' };

export interface OffloadDeps {
    addonPath: string;
    makeWorker: OffloadWorkerFactory;
    now?: () => number;
    /** A call that has not answered by then is abandoned. */
    timeoutMs?: number;
    /** This many timeouts in a row open the breaker. */
    breakerAfter?: number;
    breakerMs?: number;
    onEvent?: (e: string) => void;
}

export const OFFLOAD_TIMEOUT_MS = 2500;
export const OFFLOAD_BREAKER_AFTER = 3;
export const OFFLOAD_BREAKER_MS = 60_000;
/** A "yes" is trusted this long, a "no" a shorter while (mirrors the addon's own cache). */
export const SUPPORT_TTL_YES_MS = 10_000;
export const SUPPORT_TTL_NO_MS = 3_000;
/** A list of audio apps younger than this is reused (the picker polls). */
export const LIST_REUSE_MS = 1_000;

export const OFFLOAD_WORKER_SOURCE = `
var wt = require('worker_threads');
var addon = null;
try { addon = require(wt.workerData.addonPath); }
catch (e) { wt.parentPort.postMessage({ boot: 'fail' }); }
if (addon) wt.parentPort.postMessage({ boot: 'ok' });
wt.parentPort.on('message', function (m) {
  var id = m && m.id;
  try {
    var f = addon && (m.fn === 'isSupported' || m.fn === 'listApps') ? addon[m.fn] : null;
    if (typeof f !== 'function') { wt.parentPort.postMessage({ id: id, error: 'nofn' }); return; }
    wt.parentPort.postMessage({ id: id, result: f.apply(addon, Array.isArray(m.args) ? m.args : []) });
  } catch (e) { wt.parentPort.postMessage({ id: id, error: 'threw' }); }
});
`;

interface Pending { resolve: (r: OffloadResult) => void; timer: ReturnType<typeof setTimeout> }

export class AddonOffload {
    private worker: OffloadWorker | null = null;
    private pending = new Map<number, Pending>();
    private nextId = 1;
    private timeouts = 0;
    private breakerUntil = 0;
    private bootFailed = false;
    private supported: { value: boolean; at: number } | null = null;
    private supportedInFlight: Promise<boolean> | null = null;
    private listCache: { at: number; value: unknown } | null = null;
    private listInFlight: Promise<OffloadResult> | null = null;
    private readonly now: () => number;
    private readonly timeoutMs: number;

    constructor(private readonly d: OffloadDeps) {
        this.now = d.now ?? (() => Date.now());
        this.timeoutMs = d.timeoutMs ?? OFFLOAD_TIMEOUT_MS;
    }

    /** False once the addon proved unloadable in a worker: callers go back to direct calls. */
    get usable(): boolean { return !this.bootFailed; }
    get breakerOpen(): boolean { return this.now() < this.breakerUntil; }

    private ensureWorker(): OffloadWorker | null {
        if (this.bootFailed) return null;
        if (this.worker) return this.worker;
        let w: OffloadWorker;
        try { w = this.d.makeWorker(OFFLOAD_WORKER_SOURCE, { addonPath: this.d.addonPath }); }
        catch { this.bootFailed = true; this.d.onEvent?.('worker-unavailable'); return null; }
        w.on('message', (raw) => {
            const m = raw as { boot?: string; id?: number; result?: unknown; error?: string };
            if (m?.boot === 'fail') {
                // The addon does not load off the main thread: stop trying, answer direct.
                this.bootFailed = true;
                this.d.onEvent?.('addon-not-loadable-in-worker');
                this.dropWorker(w);
                return;
            }
            if (typeof m?.id !== 'number') return;
            const p = this.pending.get(m.id);
            if (!p) return; // answered too late: the call was already abandoned
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            this.timeouts = 0;
            p.resolve(m.error ? { ok: false, reason: 'error' } : { ok: true, value: m.result });
        });
        w.on('error', () => { this.d.onEvent?.('worker-error'); this.dropWorker(w); });
        w.on('exit', () => { this.dropWorker(w); });
        w.unref?.();
        this.worker = w;
        return w;
    }

    /** Forget a worker and answer everything waiting on it. */
    private dropWorker(w: OffloadWorker): void {
        if (this.worker === w) this.worker = null;
        try { w.terminate(); } catch { /* already gone */ }
        for (const [id, p] of this.pending) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.resolve({ ok: false, reason: this.bootFailed ? 'no-worker' : 'error' });
        }
    }

    /** One call with a deadline. Never throws, never blocks the caller's thread. */
    call(fn: OffloadFn, args: unknown[] = []): Promise<OffloadResult> {
        if (!ALLOWED.has(fn)) return Promise.resolve({ ok: false, reason: 'error' });
        if (this.breakerOpen) return Promise.resolve({ ok: false, reason: 'breaker' });
        const w = this.ensureWorker();
        if (!w) return Promise.resolve({ ok: false, reason: 'no-worker' });
        const id = this.nextId++;
        return new Promise<OffloadResult>((resolve) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(id)) return;
                this.timeouts++;
                this.d.onEvent?.(`timeout ${fn} (${this.timeouts})`);
                // The worker is stuck inside native code: replace it, do not wait for it.
                this.dropWorker(w);
                if (this.timeouts >= (this.d.breakerAfter ?? OFFLOAD_BREAKER_AFTER)) {
                    this.breakerUntil = this.now() + (this.d.breakerMs ?? OFFLOAD_BREAKER_MS);
                    this.timeouts = 0;
                    this.d.onEvent?.('breaker-open');
                }
                resolve({ ok: false, reason: 'timeout' });
            }, this.timeoutMs);
            (timer as { unref?: () => void }).unref?.();
            this.pending.set(id, { resolve, timer });
            try { w.postMessage({ id, fn, args }); }
            catch { this.pending.delete(id); clearTimeout(timer); resolve({ ok: false, reason: 'error' }); }
        });
    }

    /** The last answer, without waiting (null = never answered). Kicks a refresh when stale. */
    supportedNow(): boolean | null {
        const s = this.supported;
        if (!s || this.now() - s.at >= (s.value ? SUPPORT_TTL_YES_MS : SUPPORT_TTL_NO_MS)) void this.refreshSupported();
        return s ? s.value : null;
    }

    /** Fresh-enough answer, awaiting a probe only when the cache is stale. A probe that fails is "no". */
    async isSupported(): Promise<boolean> {
        const s = this.supported;
        if (s && this.now() - s.at < (s.value ? SUPPORT_TTL_YES_MS : SUPPORT_TTL_NO_MS)) return s.value;
        return this.refreshSupported();
    }

    private refreshSupported(): Promise<boolean> {
        return (this.supportedInFlight ??= this.call('isSupported').then((r) => {
            const value = r.ok && r.value === true;
            // A timeout / breaker / error is not an answer about the daemon: keep the
            // previous yes for one TTL rather than flapping a working share to "no".
            if (r.ok || (!this.supported && r.reason !== 'no-worker')) this.supported = { value, at: this.now() };
            return this.supported ? this.supported.value : false;
        }).finally(() => { this.supportedInFlight = null; }));
    }

    /** The addon's app list, or null when it could not be had in time. Coalesced; reused for LIST_REUSE_MS. */
    async listApps(ownPid: number): Promise<unknown | null> {
        const c = this.listCache;
        if (c && this.now() - c.at < LIST_REUSE_MS) return c.value;
        const r = await (this.listInFlight ??= this.call('listApps', [ownPid]).finally(() => { this.listInFlight = null; }));
        if (!r.ok) return null;
        this.listCache = { at: this.now(), value: r.value };
        return r.value;
    }

    dispose(): void {
        const w = this.worker;
        if (w) this.dropWorker(w);
    }
}
