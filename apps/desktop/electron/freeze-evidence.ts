/**
 * freeze-evidence — a freeze must leave a trace that survives a kill.
 *
 * WHY (owner report 6cdf2342, CachyOS / KDE Wayland): "froze in a call, had to
 * kill the application in the taskbar". The report was sent AFTER the relaunch
 * and held nothing about the frozen session. Two gaps:
 *
 *   1. Everything freezeMonitor knows lives in memory, so a hang that ends in a
 *      kill takes its own evidence with it.
 *   2. The unclean-exit marker (session-lifecycle.ts) is dropped the moment a
 *      quit is ASKED FOR. KDE's "force quit" and `kill` send SIGTERM first, and
 *      Chromium turns SIGTERM into a normal quit request: before-quit fires,
 *      the marker is unlinked, and the SIGKILL that follows (the window never
 *      closes: the hung renderer will not answer) leaves a launch that looks
 *      like a clean exit. Hence "no crash record".
 *
 * WHAT: a tiny record file (`diag-freeze.json`, < 1 KiB) that exists exactly
 * while the app is hung, written by a WATCHDOG THREAD:
 *
 *   • a worker_thread watches a shared counter that main bumps every second.
 *     When the counter stops moving for MAIN_STALL_RECORD_MS the MAIN thread
 *     is blocked, and the worker (which has its own event loop) writes the
 *     record itself, naming what main was inside, read from a shared-memory
 *     "in-flight board" that freezeMonitor.track()/begin() keep current;
 *   • main tells the worker when the renderer goes unresponsive / responsive
 *     (webContents events), when call / share state changes, and the recent
 *     activity labels (every 2 s, only when they changed);
 *   • the file is deleted the moment every hang clears, so a hang that
 *     recovered leaves nothing (the in-memory Performance log covers those).
 *
 * Because the file is written while hung, it is on disk whatever kills the
 * process afterwards (SIGTERM-then-SIGKILL, SIGKILL, power button) and whether
 * or not main itself ever runs again. A heartbeat file compared with the quit
 * marker at the next start cannot do this: it cannot tell WHEN a process died,
 * so a healthy SIGKILL and a long hang look the same. Detecting the stall while
 * it happens can.
 *
 * NEXT LAUNCH: crashFromFreezeRecord turns the file into the existing
 * `unclean_exit` crash record (reason `hung-exit`, so no API wire change), which
 * the boot prompt shows as "Cipherline stopped responding last time".
 *
 * PRIVACY (same bar as perf_log): the record holds booleans, durations and
 * static code-chosen labels only (LABEL_RE). No content, ids, names or paths: a
 * label that fails the pattern is dropped on write AND on read, so a hand-
 * edited or corrupt file cannot smuggle text into a report.
 *
 * No `electron` import (worker_threads / fs / SharedArrayBuffer only), so it is
 * unit-testable; main.ts wires it up. Never started under the smoke test (no
 * startup disk writes: CLAUDE.md smoke-test trap) and only for packaged builds.
 */
import type { CrashInfoLike } from './diagnostics';

export const FREEZE_RECORD_FILE = 'diag-freeze.json';
/** Main bumps the counter, the watchdog checks it, this often. */
export const WATCHDOG_TICK_MS = 1000;
/** The counter has not moved for this long: main is blocked. */
export const MAIN_STALL_RECORD_MS = 6000;
/** The file is rewritten at most this often while the SAME hang continues. */
export const FREEZE_WRITE_MIN_GAP_MS = 5000;
/** A watchdog tick this much later than due = the machine slept; not a stall. */
const SLEEP_GAP_FACTOR = 5;
export const INFLIGHT_SLOTS = 8;
export const INFLIGHT_SLOT_BYTES = 64;
export const MAX_ACTIVITY_LABELS = 12;
export const MAX_FREEZE_RECORD_BYTES = 2048;

/** Static, code-chosen identifiers only (same shape as freeze-monitor's LABEL_RE). */
export const FREEZE_LABEL_RE = /^[a-z][a-z0-9_.:-]{0,63}$/i;
/** Call / share state the record may carry: booleans under these names only. */
export const FREEZE_FLAG_NAMES = ['in_call', 'sharing', 'camera_live'] as const;
export type FreezeFlagName = typeof FREEZE_FLAG_NAMES[number];
export type FreezeFlags = Partial<Record<FreezeFlagName, boolean>>;

export function sanitizeLabels(raw: unknown, max = MAX_ACTIVITY_LABELS): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const l of raw) {
        if (typeof l === 'string' && FREEZE_LABEL_RE.test(l) && !out.includes(l)) out.push(l);
        if (out.length >= max) break;
    }
    return out;
}

export function sanitizeFlags(raw: unknown): FreezeFlags {
    const out: FreezeFlags = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of FREEZE_FLAG_NAMES) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === 'boolean') out[k] = v;
    }
    return out;
}

/**
 * The watchdog runtime, as source text: ONE implementation that runs inside the
 * worker (where it cannot import this module) and, via `new Function`, in the
 * unit tests and as the in-thread fallback. Plain ES2019, no template literals
 * inside (it lives in one).
 */
export const WATCHDOG_RUNTIME_SOURCE = `
var LABEL_RE = /^[a-z][a-z0-9_.:-]{0,63}$/i;
var FLAGS = ['in_call', 'sharing', 'camera_live'];
function labels(raw, max) {
  var out = [];
  if (!Array.isArray(raw)) return out;
  for (var i = 0; i < raw.length; i++) {
    var l = raw[i];
    if (typeof l === 'string' && LABEL_RE.test(l) && out.indexOf(l) < 0) out.push(l);
    if (out.length >= max) break;
  }
  return out;
}
function decodeBoard(bytes, slots, slotBytes) {
  var out = [];
  for (var s = 0; s < slots; s++) {
    var base = s * slotBytes;
    var len = bytes[base];
    if (!len || len > slotBytes - 1) continue;
    var str = '';
    for (var i = 0; i < len; i++) str += String.fromCharCode(bytes[base + 1 + i]);
    if (LABEL_RE.test(str) && out.indexOf(str) < 0) out.push(str);
  }
  return out;
}
function createWatchdog(d) {
  var st = { renderer: false, rendererSince: 0, quit: false, flags: {}, activity: [] };
  var lastCounter = d.readCounter();
  var lastChange = d.now();
  var lastTick = lastChange;
  var hungSince = 0, wrote = false, lastWrite = 0, lastKey = '';
  function clearFile() {
    if (!wrote) return;
    try { d.fs.unlinkSync(d.file); } catch (e) { /* already gone */ }
    wrote = false; hungSince = 0; lastKey = '';
  }
  function tick() {
    var t = d.now();
    // The machine slept (or this thread was stopped): not a stall.
    if (t - lastTick > d.tickMs * ${SLEEP_GAP_FACTOR}) lastChange = t;
    lastTick = t;
    var c = d.readCounter();
    if (c !== lastCounter) { lastCounter = c; lastChange = t; }
    var mainMs = t - lastChange;
    var mainStalled = mainMs >= d.stallMs;
    var rendererMs = st.renderer ? t - st.rendererSince : 0;
    if (!mainStalled && !st.renderer) { clearFile(); return; }
    if (!hungSince) hungSince = t - Math.max(mainStalled ? mainMs : 0, rendererMs);
    var key = (mainStalled ? 'm' : '') + (st.renderer ? 'r' : '') + (st.quit ? 'q' : '');
    if (wrote && key === lastKey && t - lastWrite < d.minGapMs) return;
    var flags = {};
    for (var i = 0; i < FLAGS.length; i++) if (typeof st.flags[FLAGS[i]] === 'boolean') flags[FLAGS[i]] = st.flags[FLAGS[i]];
    var rec = {
      v: 1, version: d.version, started_at: d.startedAt, written_at: t, hung_since: hungSince,
      main_stalled_ms: mainStalled ? Math.round(mainMs) : 0,
      renderer_unresponsive_ms: Math.round(rendererMs),
      quit_requested: st.quit,
      flags: flags,
      inflight: labels(d.readInflight(), ${INFLIGHT_SLOTS}),
      activity: st.activity
    };
    try {
      d.fs.writeFileSync(d.file, JSON.stringify(rec), { encoding: 'utf8', mode: 384 });
      wrote = true; lastWrite = t; lastKey = key;
    } catch (e) { /* best effort: a full disk must not matter */ }
  }
  function message(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'renderer') {
      var on = m.unresponsive === true;
      if (on && !st.renderer) st.rendererSince = d.now();
      st.renderer = on;
    } else if (m.type === 'quit') {
      st.quit = true;
    } else if (m.type === 'ctx') {
      st.activity = labels(m.activity, ${MAX_ACTIVITY_LABELS});
      var f = m.flags && typeof m.flags === 'object' ? m.flags : {};
      var nf = {};
      for (var i = 0; i < FLAGS.length; i++) if (typeof f[FLAGS[i]] === 'boolean') nf[FLAGS[i]] = f[FLAGS[i]];
      st.flags = nf;
    } else if (m.type === 'resume') {
      lastChange = d.now();
    }
  }
  return { tick: tick, message: message };
}
`;

export interface WatchdogDeps {
    fs: { writeFileSync(p: string, data: string, opts: { encoding: 'utf8'; mode: number }): void; unlinkSync(p: string): void };
    file: string;
    now: () => number;
    readCounter: () => number;
    readInflight: () => string[];
    version: string;
    startedAt: number;
    tickMs: number;
    stallMs: number;
    minGapMs: number;
}
export type WatchdogMessage =
    | { type: 'renderer'; unresponsive: boolean }
    | { type: 'quit' }
    | { type: 'resume' }
    | { type: 'ctx'; activity: string[]; flags: FreezeFlags };
export interface WatchdogInstance { tick(): void; message(m: WatchdogMessage): void }

interface Runtime {
    createWatchdog(d: WatchdogDeps): WatchdogInstance;
    decodeBoard(bytes: Uint8Array, slots: number, slotBytes: number): string[];
}
let runtimeCache: Runtime | null = null;
/** The one implementation, instantiated in this thread (tests, fallback, board decoding). */
export function watchdogRuntime(): Runtime {
    // eslint-disable-next-line no-new-func -- compiles OUR constant source (WATCHDOG_RUNTIME_SOURCE), never input
    return (runtimeCache ??= new Function(`"use strict";${WATCHDOG_RUNTIME_SOURCE}; return { createWatchdog: createWatchdog, decodeBoard: decodeBoard };`)() as Runtime);
}

/**
 * The labels of the handlers main is inside right now, in shared memory so the
 * watchdog thread can read them while main is blocked. freezeMonitor calls
 * enter()/leave() from begin()/track(); a full board just skips a label.
 * Layout per slot: byte 0 = length (0 = free), bytes 1.. = ASCII label. The
 * length byte is written LAST on enter and cleared FIRST on leave, so a reader
 * sees either a whole label or nothing (and still validates it).
 */
export class InflightBoard {
    readonly buffer: SharedArrayBuffer;
    private readonly bytes: Uint8Array;

    constructor(buffer?: SharedArrayBuffer) {
        this.buffer = buffer ?? new SharedArrayBuffer(INFLIGHT_SLOTS * INFLIGHT_SLOT_BYTES);
        this.bytes = new Uint8Array(this.buffer);
    }

    /** Claim a slot for `label`; -1 when the label is not a static identifier or the board is full. */
    enter(label: string): number {
        if (!FREEZE_LABEL_RE.test(label)) return -1;
        for (let s = 0; s < INFLIGHT_SLOTS; s++) {
            const base = s * INFLIGHT_SLOT_BYTES;
            if (this.bytes[base] !== 0) continue;
            for (let i = 0; i < label.length; i++) this.bytes[base + 1 + i] = label.charCodeAt(i) & 0x7f;
            this.bytes[base] = label.length;
            return s;
        }
        return -1;
    }

    leave(slot: number): void {
        if (slot >= 0 && slot < INFLIGHT_SLOTS) this.bytes[slot * INFLIGHT_SLOT_BYTES] = 0;
    }

    read(): string[] {
        return watchdogRuntime().decodeBoard(this.bytes, INFLIGHT_SLOTS, INFLIGHT_SLOT_BYTES);
    }
}

// ── The record: parse + the next-launch crash record ────────────────────────

export interface FreezeRecord {
    v: 1;
    version: string;
    started_at: number;
    written_at: number;
    hung_since: number;
    main_stalled_ms: number;
    renderer_unresponsive_ms: number;
    quit_requested: boolean;
    flags: FreezeFlags;
    inflight: string[];
    activity: string[];
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const num = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null;

/** Strict: anything malformed, oversized or from a bad version string is null (never coerced). */
export function parseFreezeRecord(text: unknown): FreezeRecord | null {
    if (typeof text !== 'string' || text.length > MAX_FREEZE_RECORD_BYTES) return null;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
    if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) return null;
    const MAX_T = 8.64e15;
    const started = num(raw.started_at, MAX_T), written = num(raw.written_at, MAX_T), since = num(raw.hung_since, MAX_T);
    const mainMs = num(raw.main_stalled_ms, 7 * 24 * 3600_000), rendMs = num(raw.renderer_unresponsive_ms, 7 * 24 * 3600_000);
    if (started === null || written === null || since === null || mainMs === null || rendMs === null) return null;
    if (mainMs === 0 && rendMs === 0) return null; // not a hang
    return {
        v: 1, version: raw.version, started_at: started, written_at: written, hung_since: since,
        main_stalled_ms: mainMs, renderer_unresponsive_ms: rendMs,
        quit_requested: raw.quit_requested === true,
        flags: sanitizeFlags(raw.flags),
        inflight: sanitizeLabels(raw.inflight, INFLIGHT_SLOTS),
        activity: sanitizeLabels(raw.activity),
    };
}

/** `kill` reason carried in CrashInfoLike.reason: the UI says "stopped responding". */
export const HUNG_EXIT_REASON = 'hung-exit';

/**
 * The previous session's freeze file → an `unclean_exit` crash record with
 * reason `hung-exit`. A record from a DIFFERENT app version is dropped (an
 * installer replaced the app: same rule as the quit marker). The message is
 * built from validated fields only.
 */
export function crashFromFreezeRecord(text: string | null, now: number, currentVersion: string): CrashInfoLike | null {
    if (text === null) return null;
    const r = parseFreezeRecord(text);
    if (!r) return null;
    if (VERSION_RE.test(currentVersion) && r.version !== currentVersion) return null;
    const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
    const flags = FREEZE_FLAG_NAMES.filter(k => r.flags[k] === true);
    const parts = [
        'The previous session ended while the app was not responding.',
        `main_blocked=${secs(r.main_stalled_ms)}`,
        `renderer_unresponsive=${secs(r.renderer_unresponsive_ms)}`,
        `quit_requested=${r.quit_requested ? 1 : 0}`,
        `state=${flags.length ? flags.join(',') : 'idle'}`,
        `in_flight=${r.inflight.length ? r.inflight.join(',') : 'none'}`,
        `recent=${r.activity.length ? r.activity.join(',') : 'none'}`,
    ];
    return {
        kind: 'unclean_exit',
        process_type: 'browser',
        reason: HUNG_EXIT_REASON,
        message: parts.join(' '),
        occurred_at: new Date(Math.min(r.hung_since || now, now)).toISOString(),
        app_version_at_crash: r.version,
    };
}

// ── Main-thread controller ──────────────────────────────────────────────────

export interface WorkerLike {
    postMessage(m: unknown): void;
    terminate(): unknown;
    on(ev: 'error' | 'exit', cb: (...a: unknown[]) => void): unknown;
    unref?(): void;
}
export type WorkerFactory = (source: string, data: Record<string, unknown>) => WorkerLike;

export interface MainWatchdogDeps {
    fs: WatchdogDeps['fs'];
    file: string;
    version: string;
    now?: () => number;
    tickMs?: number;
    stallMs?: number;
    minGapMs?: number;
    /** Default: a real `worker_threads` Worker (eval). Injected in tests. */
    makeWorker?: WorkerFactory;
    onLog?: (m: string) => void;
}

/**
 * Starts the watchdog. `enabled=false` (smoke test, dev) makes everything a
 * no-op, including the in-flight board, so nothing touches the disk.
 */
export class MainWatchdog {
    readonly board = new InflightBoard();
    private counter: Int32Array;
    private worker: WorkerLike | null = null;
    private local: WatchdogInstance | null = null;
    private timers: Array<ReturnType<typeof setInterval>> = [];
    private lastCtxKey = '';
    private started = false;
    private readonly now: () => number;

    constructor(private readonly d: MainWatchdogDeps, private readonly enabled: boolean) {
        this.counter = new Int32Array(new SharedArrayBuffer(4));
        this.now = d.now ?? (() => Date.now());
    }

    get running(): boolean { return this.started; }
    /** 'worker' (detects a blocked main) | 'in-thread' (fallback: renderer hangs only) | 'off'. */
    get mode(): 'worker' | 'in-thread' | 'off' { return !this.started ? 'off' : this.worker ? 'worker' : 'in-thread'; }

    start(): void {
        if (!this.enabled || this.started) return;
        this.started = true;
        const tickMs = this.d.tickMs ?? WATCHDOG_TICK_MS;
        const startedAt = this.now();
        const common = {
            file: this.d.file, version: this.d.version, startedAt, tickMs,
            stallMs: this.d.stallMs ?? MAIN_STALL_RECORD_MS, minGapMs: this.d.minGapMs ?? FREEZE_WRITE_MIN_GAP_MS,
        };
        try {
            const make = this.d.makeWorker ?? defaultWorkerFactory;
            this.worker = make(WORKER_BOOT_SOURCE, { ...common, counter: this.counter.buffer, board: this.board.buffer });
            this.worker.on('error', (e) => { this.d.onLog?.(`[freeze-evidence] watchdog worker error: ${e instanceof Error ? e.message : String(e)}`); this.fallBack(common); });
            this.worker.unref?.();
        } catch (e) {
            this.d.onLog?.(`[freeze-evidence] no watchdog worker (${e instanceof Error ? e.message : String(e)}); renderer hangs only`);
            this.worker = null;
            this.fallBack(common);
        }
        const beat = setInterval(() => { Atomics.add(this.counter, 0, 1); }, tickMs);
        (beat as { unref?: () => void }).unref?.();
        this.timers.push(beat);
    }

    private fallBack(common: Omit<WatchdogDeps, 'fs' | 'now' | 'readCounter' | 'readInflight'>): void {
        if (this.local) return;
        this.worker = null;
        this.local = watchdogRuntime().createWatchdog({
            ...common, fs: this.d.fs, now: this.now,
            readCounter: () => Atomics.load(this.counter, 0),
            readInflight: () => this.board.read(),
        });
        const t = setInterval(() => this.local?.tick(), common.tickMs);
        (t as { unref?: () => void }).unref?.();
        this.timers.push(t);
    }

    private send(m: WatchdogMessage): void {
        if (!this.started) return;
        try {
            if (this.worker) this.worker.postMessage(m);
            else this.local?.message(m);
        } catch { /* a dead worker must never throw into main */ }
    }

    setRendererUnresponsive(unresponsive: boolean): void { this.send({ type: 'renderer', unresponsive }); }
    /** The machine woke / the monitor was unpaused: the gap is not a stall. */
    resume(): void { Atomics.add(this.counter, 0, 1); this.send({ type: 'resume' }); }
    /** A quit was asked for: noted in the record (the hang may still be live). */
    noteQuit(): void { this.send({ type: 'quit' }); }

    /** Call every ~2 s; sends only when the labels or flags changed. Inputs are re-validated here. */
    setContext(activity: unknown, flags: unknown): void {
        const msg: WatchdogMessage = { type: 'ctx', activity: sanitizeLabels(activity), flags: sanitizeFlags(flags) };
        const key = JSON.stringify(msg);
        if (key === this.lastCtxKey) return;
        this.lastCtxKey = key;
        this.send(msg);
    }

    stop(): void {
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
        try { this.worker?.terminate(); } catch { /* gone */ }
        this.worker = null;
        this.local = null;
        this.started = false;
    }
}

/** Bootstrap run inside the worker: the shared runtime + a tick timer + the message pipe. */
export const WORKER_BOOT_SOURCE = `
${WATCHDOG_RUNTIME_SOURCE}
var wt = require('worker_threads');
var nodeFs = require('fs');
var data = wt.workerData;
var counter = new Int32Array(data.counter);
var board = new Uint8Array(data.board);
var wd = createWatchdog({
  fs: nodeFs, file: data.file, now: Date.now, version: data.version, startedAt: data.startedAt,
  tickMs: data.tickMs, stallMs: data.stallMs, minGapMs: data.minGapMs,
  readCounter: function () { return Atomics.load(counter, 0); },
  readInflight: function () { return decodeBoard(board, ${INFLIGHT_SLOTS}, ${INFLIGHT_SLOT_BYTES}); }
});
setInterval(wd.tick, data.tickMs);
wt.parentPort.on('message', wd.message);
`;

function defaultWorkerFactory(source: string, data: Record<string, unknown>): WorkerLike {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node built-in, loaded only when the watchdog starts
    const { Worker } = require('worker_threads') as typeof import('worker_threads');
    return new Worker(source, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 16 } }) as unknown as WorkerLike;
}
