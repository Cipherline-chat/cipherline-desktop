/**
 * previous-session — what was the session that died doing?
 *
 * WHY: an `unclean_exit` crash report (diagnostics.ts) is built at the NEXT
 * launch. Its `perf_log` is the NEW session's, so nothing in it says what the
 * dead session was doing (four such reports arrived from 0.1.0 on launch day).
 * The unclean-exit marker only knows when that session STARTED.
 *
 * WHAT: while this instance is the live one, MAIN keeps a small file
 * (`diag-prev-session.json`, <= MAX_PREV_SESSION_BYTES) holding the newest
 * ~50 perf-log rows (freezeMonitor), a few booleans (call / share / camera /
 * window visible / focused) and a start + last-write time. It is written at
 * most every PREV_SESSION_WRITE_MS (plus on notable events, never closer than
 * PREV_SESSION_MIN_GAP_MS), atomically (tmp + rename), and a write can never
 * throw. At the next launch the file is read, validated and — only when a
 * crash record (leftover marker or freeze record) of THE SAME session exists —
 * attached to that record as `previous_session`. The file is deleted either
 * way.
 *
 * Lifecycle, following the marker (session-lifecycle.ts):
 *   • armed  = this instance is live and no quit was asked for / suspected
 *              (SessionLifecycle.armed). Only then does tick() write;
 *   • a quit asked for stops writing but LEAVES the file: a hung app that gets
 *     SIGTERM then SIGKILL (freeze-evidence.ts) has dropped its marker yet is
 *     exactly the session worth explaining;
 *   • finish() (will-quit: the quit really happened) deletes it. A file left
 *     after a quit that was cut short has no marker and no freeze record to
 *     hang off, so the next launch ignores and deletes it. A clean quit
 *     therefore never produces `previous_session`.
 *
 * PRIVACY: no more revealing than `perf_log`. Rows are the freeze monitor's own
 * (static labels / DETAIL_RE-checked details), re-checked against
 * ROW_ACTIVITY_RE on write AND on read, then passed through the same scrubber
 * the crash records use (mainScrubber: home dir + OS account name); the
 * renderer scrubs the report again with the full term list. Flags are booleans.
 * No ids, names, paths or URLs are ever added here.
 *
 * No `electron` import (fs / clocks / scrubber injected) so it is
 * unit-testable (previous-session.test.ts). Must not import from src/ (the
 * rootDir trap in CLAUDE.md). Never constructed under the smoke test
 * (CLAUDE.md smoke-test trap): main.ts creates it only when
 * SESSION_MARKER_ENABLED.
 */
import type { Scrubber } from './diagnostics-scrub';

export const PREV_SESSION_FILE = 'diag-prev-session.json';
/** Newest perf rows kept. */
export const PREV_SESSION_MAX_ROWS = 50;
/** Periodic write interval. */
export const PREV_SESSION_WRITE_MS = 12_000;
/** A notable event may write early, but never closer than this to the last write. */
export const PREV_SESSION_MIN_GAP_MS = 2_000;
/** Hard cap on what is written (oldest rows are dropped until it fits). */
export const MAX_PREV_SESSION_BYTES = 12 * 1024;
/** A file larger than this is not even parsed. */
export const MAX_PREV_SESSION_READ_BYTES = 16 * 1024;
const ROW_SOURCES = ['main', 'renderer', 'event', 'metrics'] as const;
/** Same alphabet as freeze-monitor's DETAIL_RE (+ the ', ' label join), a little longer: what a row may hold BEFORE scrubbing. */
export const RAW_ACTIVITY_RE = /^[a-z0-9 _.:=%,/()+|-]{0,300}$/i;
/** After scrubbing (and on read) the scrubber's `<name>` / `<path>` placeholders are allowed too. */
export const ROW_ACTIVITY_RE = /^[a-z0-9 _.:=%,/()+|<>-]{0,300}$/i;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const MAX_T = 8.64e15;
/** started_at of the file vs the marker / freeze record it must belong to. */
const SAME_SESSION_TOLERANCE_MS = 1500;

export const PREV_SESSION_STATE_KEYS = ['in_call', 'sharing', 'camera_live', 'window_visible', 'window_focused'] as const;
export type PrevSessionStateKey = typeof PREV_SESSION_STATE_KEYS[number];
export type PrevSessionState = Partial<Record<PrevSessionStateKey, boolean>>;

export interface PrevSessionRow {
    /** Seconds relative to `last_written_at` (<= 0). */
    t_s: number;
    source: typeof ROW_SOURCES[number];
    ms: number;
    activity: string;
}

/** What a crash record carries (and what becomes `payload.previous_session`). */
export interface PreviousSession {
    /** ISO. */
    started_at: string;
    /** ISO: the dead session was alive at least until here. */
    last_written_at: string;
    app_version: string;
    state: PrevSessionState;
    rows: PrevSessionRow[];
}

/** The freeze monitor's entries, as far as this module cares. */
export interface PerfEntryLike { at: number; source: string; ms: number; activity: string }

export interface PrevSessionFs {
    readFileSync(p: string, enc: 'utf8'): string;
    writeFileSync(p: string, data: string, opts: { encoding: 'utf8'; mode: number }): void;
    renameSync(from: string, to: string): void;
    unlinkSync(p: string): void;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const asNum = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);

export function sanitizeState(raw: unknown): PrevSessionState {
    const out: PrevSessionState = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of PREV_SESSION_STATE_KEYS) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === 'boolean') out[k] = v;
    }
    return out;
}

/** Rows newest-last, shape-checked; a row that fails is DROPPED, never coerced. */
export function sanitizeRows(raw: unknown, max = PREV_SESSION_MAX_ROWS): PrevSessionRow[] {
    if (!Array.isArray(raw)) return [];
    const out: PrevSessionRow[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const { t_s, source, ms, activity } = r as Record<string, unknown>;
        if (typeof t_s !== 'number' || !Number.isFinite(t_s) || t_s > 0 || t_s < -7 * 24 * 3600) continue;
        if (!(ROW_SOURCES as readonly unknown[]).includes(source)) continue;
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 7 * 24 * 3600_000) continue;
        if (typeof activity !== 'string' || !ROW_ACTIVITY_RE.test(activity)) continue;
        out.push({ t_s: Math.round(t_s * 10) / 10, source: source as PrevSessionRow['source'], ms: Math.round(ms), activity });
    }
    return out.slice(-max);
}

interface FileShape {
    v: 1;
    version: string;
    /** ms. */
    started_at: number;
    /** ms. */
    written_at: number;
    state: PrevSessionState;
    rows: PrevSessionRow[];
}

/**
 * Serialise one snapshot within `maxBytes`: rows are scrubbed (activity text
 * through `scrubber`), re-validated, and the OLDEST are dropped until it fits.
 */
export function buildFileText(
    args: { version: string; startedAt: number; now: number; state: PrevSessionState; entries: readonly PerfEntryLike[]; scrubber: Scrubber },
    maxBytes = MAX_PREV_SESSION_BYTES,
): string {
    // A row whose activity is outside the raw alphabet is DROPPED, not blanked or coerced.
    const sorted = args.entries
        .filter(e => e && Number.isFinite(e.at) && e.at <= args.now + 1000 && typeof e.activity === 'string' && RAW_ACTIVITY_RE.test(e.activity))
        .sort((a, b) => a.at - b.at);
    const candidate = sorted.slice(-PREV_SESSION_MAX_ROWS).map(e => ({
        t_s: Math.min(0, (e.at - args.now) / 1000),
        source: e.source,
        ms: Math.max(0, Math.round(Number(e.ms) || 0)),
        activity: args.scrubber.text(e.activity, 300),
    }));
    let rows = sanitizeRows(candidate);
    const make = (): string => {
        const f: FileShape = { v: 1, version: args.version, started_at: args.startedAt, written_at: args.now, state: sanitizeState(args.state), rows };
        return JSON.stringify(f);
    };
    let text = make();
    while (text.length > maxBytes && rows.length > 0) {
        rows = rows.slice(Math.ceil(rows.length / 4));
        text = make();
    }
    return text;
}

export function parsePreviousSessionFile(text: unknown): FileShape | null {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PREV_SESSION_READ_BYTES) return null;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
    if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) return null;
    const started = asNum(raw.started_at, MAX_T), written = asNum(raw.written_at, MAX_T);
    if (started === null || written === null || written < started) return null;
    return { v: 1, version: raw.version, started_at: started, written_at: written, state: sanitizeState(raw.state), rows: sanitizeRows(raw.rows) };
}

/**
 * The previous session's file → `previous_session`, or null when it must not
 * be attached: unreadable / corrupt / oversized, another app version than the
 * running one (an installer replaced the app in between), not the session the
 * crash record is about (`expectedStartedAt` differs: a leftover from an
 * earlier run), or timestamps in the future. The text is scrubbed again with
 * `scrubber` (a hand-edited file cannot smuggle a path or a name in).
 */
export function previousSessionFromFile(
    text: string | null,
    expectedStartedAt: number | null,
    currentVersion: string,
    now: number,
    scrubber: Scrubber,
): PreviousSession | null {
    if (text === null || expectedStartedAt === null || !Number.isFinite(expectedStartedAt)) return null;
    const f = parsePreviousSessionFile(text);
    if (!f) return null;
    if (VERSION_RE.test(currentVersion) && f.version !== currentVersion) return null;
    if (Math.abs(f.started_at - expectedStartedAt) > SAME_SESSION_TOLERANCE_MS) return null;
    if (f.written_at > now + 60_000) return null;
    return {
        started_at: iso(f.started_at),
        last_written_at: iso(f.written_at),
        app_version: f.version,
        state: f.state,
        rows: f.rows.map(r => ({ ...r, activity: scrubber.text(r.activity, 300) })),
    };
}

export interface PrevSessionWriterDeps {
    fs: PrevSessionFs;
    file: string;
    version: string;
    now: () => number;
    /** Newest-last or any order; the writer sorts. */
    entries: () => readonly PerfEntryLike[];
    state: () => PrevSessionState;
    /** SessionLifecycle.armed: this instance is live and no quit was asked for. */
    isArmed: () => boolean;
    /** Lazy + memoised by the caller: building the scrubber reads the OS account name. */
    scrubber: () => Scrubber;
    onLog?: (m: string) => void;
}

/**
 * Throttled, atomic, never-throwing writer. `enabled=false` (smoke test, dev)
 * makes every method a no-op: nothing touches the disk.
 */
export class PrevSessionWriter {
    private startedAt = 0;
    private lastWrite = 0;
    private running = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private wrote = false;
    private warned = false;

    private readonly d: PrevSessionWriterDeps;
    private readonly enabled: boolean;

    constructor(d: PrevSessionWriterDeps, enabled: boolean) {
        this.d = d;
        this.enabled = enabled;
    }

    get isRunning(): boolean { return this.running; }

    /** This instance is THE live one. Writes once immediately, then on `tickMs`. */
    start(tickMs = PREV_SESSION_WRITE_MS): void {
        if (!this.enabled || this.running) return;
        this.running = true;
        this.startedAt = this.d.now();
        this.tick();
        this.timer = setInterval(() => this.tick(), tickMs);
        (this.timer as { unref?: () => void }).unref?.();
    }

    /** Periodic beat: writes when armed and the interval has elapsed. */
    tick(): void {
        if (!this.running) return;
        // A little under the beat, so timer jitter never skips one.
        this.write(PREV_SESSION_WRITE_MS - 1_000);
    }

    /** Something worth recording just happened (call / share change, a stall). Rate-limited. */
    notable(): void {
        if (!this.running) return;
        this.write(PREV_SESSION_MIN_GAP_MS);
    }

    /** The quit really happens (will-quit): stop, and drop the file. */
    finish(): void {
        if (!this.running && !this.wrote) return;
        this.running = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        try { this.d.fs.unlinkSync(this.d.file); } catch { /* already gone */ }
        this.wrote = false;
    }

    private write(minGap: number): void {
        try {
            if (!this.d.isArmed()) return; // quit asked for / suspected: freeze what is on disk
            const t = this.d.now();
            if (this.wrote && t - this.lastWrite < minGap && t >= this.lastWrite) return;
            const text = buildFileText({
                version: this.d.version, startedAt: this.startedAt, now: t,
                state: this.d.state(), entries: this.d.entries(), scrubber: this.d.scrubber(),
            });
            const tmp = `${this.d.file}.tmp`;
            this.d.fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
            this.d.fs.renameSync(tmp, this.d.file);
            this.lastWrite = t;
            this.wrote = true;
        } catch (e) {
            if (!this.warned) { this.warned = true; this.d.onLog?.(`[previous-session] write failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
    }
}

/**
 * Startup, BEFORE this session's writer starts: read and delete the previous
 * session's file (and any half-written `.tmp`) and return the record to attach
 * to the crash record whose session started at `expectedStartedAt`. null when
 * there is no such record, or the file is stale / corrupt / another version.
 * The file is gone afterwards in every case.
 */
export function consumePreviousSessionFile(
    fs: Pick<PrevSessionFs, 'readFileSync' | 'unlinkSync'>,
    file: string,
    expectedStartedAt: number | null,
    currentVersion: string,
    now: number,
    scrubber: () => Scrubber,
): PreviousSession | null {
    let text: string | null = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    try { fs.unlinkSync(`${file}.tmp`); } catch { /* none */ }
    if (text === null || expectedStartedAt === null) return null;
    try { return previousSessionFromFile(text, expectedStartedAt, currentVersion, now, scrubber()); } catch { return null; }
}
