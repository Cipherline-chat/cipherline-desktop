/**
 * freeze-monitor — a small, privacy-safe record of "the app stopped
 * responding" moments, for Settings → Advanced → Performance log.
 *
 * WHY: a freeze on the owner's Windows PC left no trace anywhere. There is no
 * log file, DevTools is closed in a packaged build, and by the time anyone
 * looks the app is responsive again. This keeps a bounded, in-memory list of:
 *
 *   - MAIN-process event-loop stalls (this process's own loop could not run a
 *     100 ms timer for over STALL_THRESHOLD_MS). A blocked main process stalls
 *     every IPC reply, window move and input event, so the whole window
 *     freezes even though the renderer is idle.
 *   - RENDERER long tasks the renderer reports up over `perf:record` (see
 *     src/utils/freezeLog.ts).
 *
 * Each entry carries a timestamp, a duration and an ACTIVITY label — which
 * named phases of the app overlapped the stall ("startup:hydrate",
 * "ipc:securekv:open", "resume:rehydrate"). Labels are static strings chosen
 * in code, never derived from data: no message content, ids or names can get
 * in, and a renderer-supplied label is validated against a strict pattern
 * before it is stored.
 *
 * CAUSE vs BYSTANDER: an activity that merely overlapped a stall is often an
 * innocent IPC that ran right after it. So two kinds of label are marked as
 * evidence rather than context:
 *   - `<label>:<N>ms` — a tracked handler whose SYNCHRONOUS part ran for N ms
 *     (≥ SLOW_SYNC_MS). That handler blocked the loop itself. Listed first.
 *   - `gc:<kind>:<N>ms` — V8 garbage collection that overlapped the stall
 *     (fed by main.ts's perf_hooks 'gc' observer via noteGc()). A stall that
 *     reads `gc:major:1400ms` was the collector, not our code.
 *
 * Kept in the MAIN process so the log survives a renderer reload (Ctrl+R, a
 * crash-recovery reload) — the freeze you want to capture is often the one
 * that made you reload. Not written to disk.
 *
 * No `electron` import, so it is unit-testable; main.ts wires it up.
 */

/**
 * 'main' / 'renderer' — a stall (ms = how long the thread was blocked).
 * 'event'   — a lifecycle moment: window shown/minimized/restored, power
 *             suspend/resume, renderer unresponsive, a child process gone,
 *             restore→first frame. ms = a duration when the event has one.
 * 'metrics' — a per-process CPU/memory snapshot (activity holds the summary).
 */
export type FreezeSource = 'main' | 'renderer' | 'event' | 'metrics';

export interface FreezeEntry {
    /** Wall-clock ms (Date.now()) at which the stall STARTED. */
    at: number;
    source: FreezeSource;
    /** How long the thread was blocked, in ms. */
    ms: number;
    /** Overlapping activity labels, most specific first; 'idle' if none. */
    activity: string;
}

/** Only stalls at least this long are worth a row. */
export const STALL_THRESHOLD_MS = 200;
/** Ring-buffer size. A freeze storm is summarised by its worst rows anyway. */
export const MAX_ENTRIES = 300;
/** Separate rings so a chatty event stream can never push stalls out. */
export const MAX_EVENTS = 300;
export const MAX_METRICS = 160;
/**
 * A gap this long is not a stall: the machine slept (Modern Standby on
 * Windows freezes desktop apps without always sending 'suspend'), or the
 * process was stopped. Recorded as an event, and reported via onClockJump.
 */
export const CLOCK_JUMP_MS = 30_000;
/** Stall threshold while a "60-second freeze capture" is running. */
export const CAPTURE_STALL_THRESHOLD_MS = 100;

/** Free-text detail allowed on an event: static words, numbers, units. */
export const DETAIL_RE = /^[a-z0-9 _.:=%,/()+|-]{0,240}$/i;
/** How far back a finished activity is remembered for overlap matching. */
const ACTIVITY_MEMORY_MS = 60_000;
const MAX_ACTIVITY_HISTORY = 400;

/** What a label may look like. Static, code-chosen identifiers only. */
export const LABEL_RE = /^[a-z][a-z0-9_.:-]{0,63}$/i;

/** A tracked handler whose synchronous part ran this long is named as a cause. */
export const SLOW_SYNC_MS = 20;
/** GC pauses shorter than this are not remembered individually. */
export const GC_NOTE_MS = 10;
const MAX_GC_NOTES = 200;
/** How long after a stall its GC labels are filled in (the observer is async). */
const GC_RELABEL_DELAY_MS = 50;

export type GcKind = 'major' | 'minor' | 'incremental' | 'weakcb';

interface ActivitySpan { label: string; start: number; end: number | null; syncMs?: number }
interface GcNote { start: number; ms: number; kind: GcKind }

export class FreezeMonitor {
    private entries: FreezeEntry[] = [];
    private events: FreezeEntry[] = [];
    private metricRows: FreezeEntry[] = [];
    private spans: ActivitySpan[] = [];
    private gcNotes: GcNote[] = [];
    private gcTotals = { ms: 0, count: 0, majorMs: 0, majorCount: 0, maxMs: 0 };
    private timer: ReturnType<typeof setInterval> | null = null;
    private paused = false;
    private resetLoopClock = false;
    private captureUntil = 0;
    /** Called with the gap length when the loop "jumped" (see CLOCK_JUMP_MS). */
    onClockJump: ((ms: number) => void) | null = null;
    /** Called after a main stall is recorded (main.ts snapshots metrics). */
    onStall: ((ms: number) => void) | null = null;

    private readonly now: () => number;

    // Plain field + assignment, not a parameter property: the renderer's
    // tsconfig (erasableSyntaxOnly) also type-checks this file via tests.
    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    /** Begin a named activity; call the returned function when it ends. */
    begin(label: string): () => void {
        return this.open(label).end;
    }

    private open(label: string): { span: ActivitySpan; end: () => void } {
        if (!LABEL_RE.test(label)) label = 'unlabelled';
        const span: ActivitySpan = { label, start: this.now(), end: null };
        this.spans.push(span);
        this.pruneSpans();
        let done = false;
        return {
            span,
            end: () => {
                if (done) return;
                done = true;
                span.end = this.now();
            },
        };
    }

    /**
     * Run `fn` as a named activity; works for sync and async functions. The
     * time `fn` spends before it returns (its synchronous part — all of it
     * for a sync handler) is measured, and a slow one is named as a cause.
     */
    track<T>(label: string, fn: () => T): T {
        const { span, end } = this.open(label);
        const t0 = this.now();
        let result: T;
        try {
            result = fn();
        } catch (e) {
            this.noteSync(span, this.now() - t0);
            end();
            throw e;
        }
        this.noteSync(span, this.now() - t0);
        if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
            (result as unknown as Promise<unknown>).then(end, end);
        } else {
            end();
        }
        return result;
    }

    private noteSync(span: ActivitySpan, ms: number): void {
        if (Number.isFinite(ms) && ms >= SLOW_SYNC_MS) span.syncMs = Math.round(ms);
    }

    /**
     * Labels of activities that overlapped [from, to]: handlers that blocked
     * the loop themselves first (`label:Nms`, longest first), then the rest
     * most recent first, then any garbage collection in the window.
     */
    activityDuring(from: number, to: number): string {
        const slow: ActivitySpan[] = [];
        const seen = new Set<string>();
        for (let i = this.spans.length - 1; i >= 0; i--) {
            const s = this.spans[i];
            const end = s.end ?? Number.POSITIVE_INFINITY;
            if (!(s.start <= to && end >= from)) continue;
            if (s.syncMs !== undefined) slow.push(s);
            else if (seen.size < 4) seen.add(s.label);
        }
        const out = new Set<string>();
        for (const s of slow.sort((a, b) => (b.syncMs ?? 0) - (a.syncMs ?? 0)).slice(0, 3)) {
            const suffix = `:${s.syncMs}ms`;
            out.add(`${s.label.slice(0, 64 - suffix.length)}${suffix}`);
        }
        for (const l of seen) { if (out.size >= 4) break; out.add(l); }
        for (const g of this.gcLabels(from, to)) out.add(g);
        return out.size ? [...out].join(', ') : 'idle';
    }

    /**
     * A V8 garbage collection on this process's heap (main.ts feeds this from
     * a perf_hooks 'gc' PerformanceObserver). `start` is wall-clock ms.
     * Totals feed the periodic metrics row; pauses ≥ GC_NOTE_MS are kept so a
     * stall they overlap can name them.
     */
    noteGc(start: number, ms: number, kind: GcKind): void {
        if (!Number.isFinite(start) || !Number.isFinite(ms) || ms < 0) return;
        const t = this.gcTotals;
        t.ms += ms; t.count++;
        if (ms > t.maxMs) t.maxMs = ms;
        if (kind === 'major') { t.majorMs += ms; t.majorCount++; }
        if (ms < GC_NOTE_MS) return;
        this.gcNotes.push({ start, ms, kind });
        if (this.gcNotes.length > MAX_GC_NOTES) this.gcNotes.splice(0, this.gcNotes.length - MAX_GC_NOTES);
    }

    /** GC time since the last call, for the metrics row; resets the counters. */
    takeGcStats(): { ms: number; count: number; majorMs: number; majorCount: number; maxMs: number } {
        const r = { ...this.gcTotals, ms: Math.round(this.gcTotals.ms), majorMs: Math.round(this.gcTotals.majorMs), maxMs: Math.round(this.gcTotals.maxMs) };
        this.gcTotals = { ms: 0, count: 0, majorMs: 0, majorCount: 0, maxMs: 0 };
        return r;
    }

    /** `gc:<kind>:<N>ms` for collections overlapping [from, to], summed per kind (≥ SLOW_SYNC_MS). */
    private gcLabels(from: number, to: number): string[] {
        const sum = new Map<GcKind, number>();
        for (let i = this.gcNotes.length - 1; i >= 0; i--) {
            const g = this.gcNotes[i];
            if (g.start + g.ms < from - 1) break;
            if (g.start <= to) sum.set(g.kind, (sum.get(g.kind) ?? 0) + g.ms);
        }
        return [...sum.entries()]
            .filter(([, ms]) => ms >= SLOW_SYNC_MS)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, ms]) => `gc:${kind}:${Math.round(ms)}ms`);
    }

    record(entry: FreezeEntry): void {
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    /**
     * Accept long-task rows from the renderer. Everything is re-validated
     * here: this is a trust boundary, and a malformed row is dropped rather
     * than coerced. Returns how many rows were stored.
     */
    recordFromRenderer(rows: unknown): number {
        if (!Array.isArray(rows)) return 0;
        let stored = 0;
        for (const r of rows.slice(0, 50)) {
            if (!r || typeof r !== 'object') continue;
            const { at, ms, activity } = r as { at?: unknown; ms?: unknown; activity?: unknown };
            if (typeof at !== 'number' || !Number.isFinite(at)) continue;
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 10 * 60_000) continue;
            if (typeof activity !== 'string' || activity.length > 300) continue;
            const labels = activity.split(', ');
            if (!labels.every(l => l === 'idle' || LABEL_RE.test(l))) continue;
            this.record({ at: Math.round(at), source: 'renderer', ms: Math.round(ms), activity });
            stored++;
        }
        return stored;
    }

    /**
     * A lifecycle event. `name` must be a static label (LABEL_RE) and
     * `detail`, if any, static words/numbers (DETAIL_RE) — e.g. a crash
     * REASON from Electron's fixed enum, never a URL, title or id. A detail
     * that fails the pattern is dropped, not coerced.
     */
    event(name: string, ms = 0, detail?: string): void {
        if (!LABEL_RE.test(name)) return;
        if (detail !== undefined && !DETAIL_RE.test(detail)) detail = undefined;
        if (!Number.isFinite(ms) || ms < 0) ms = 0;
        this.events.push({ at: this.now(), source: 'event', ms: Math.round(ms), activity: detail ? `${name} ${detail}` : name });
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }

    /** A per-process resource summary (built by main.ts from static fields). */
    metrics(summary: string): void {
        if (!DETAIL_RE.test(summary)) return;
        this.metricRows.push({ at: this.now(), source: 'metrics', ms: 0, activity: summary });
        if (this.metricRows.length > MAX_METRICS) this.metricRows.splice(0, this.metricRows.length - MAX_METRICS);
    }

    /** Newest first; stalls, events and metrics interleaved by time. */
    snapshot(): FreezeEntry[] {
        return [...this.entries, ...this.events, ...this.metricRows].sort((a, b) => b.at - a.at);
    }

    clear(): void {
        this.entries = [];
        this.events = [];
        this.metricRows = [];
    }

    /** Stop counting time as stalls (the machine is suspending). */
    pause(): void { this.paused = true; }
    /** Resume counting; the gap since pause() is not a stall. */
    unpause(): void { this.paused = false; this.resetLoopClock = true; }

    /** "Run a 60-second freeze capture": lower the stall threshold for a while. */
    startCapture(ms = 60_000): void {
        this.captureUntil = this.now() + ms;
        this.event('capture:start', ms);
    }
    captureActive(): boolean { return this.now() < this.captureUntil; }

    /**
     * Sample this process's event loop. A 100 ms interval that fires late by
     * more than the threshold means the loop was blocked for that long.
     */
    startLoopMonitor(intervalMs = 100): void {
        if (this.timer) return;
        let last = this.now();
        this.timer = setInterval(() => {
            const t = this.now();
            if (this.paused || this.resetLoopClock) { this.resetLoopClock = false; last = t; return; }
            const lag = t - last - intervalMs;
            const threshold = this.captureActive() ? CAPTURE_STALL_THRESHOLD_MS : STALL_THRESHOLD_MS;
            if (lag >= CLOCK_JUMP_MS) {
                // Sleep (or a stopped process), not a stall: one 8-hour
                // "freeze" row must never bury the real ones.
                this.event('main:loop-gap', lag, 'sleep or suspended process');
                try { this.onClockJump?.(lag); } catch { /* diagnostics only */ }
            } else if (lag >= threshold) {
                const from = last + intervalMs;
                const entry: FreezeEntry = { at: from, source: 'main', ms: Math.round(lag), activity: this.activityDuring(from, t) };
                this.record(entry);
                // The 'gc' observer delivers asynchronously, so a collection
                // inside this stall may not be noted yet: label again shortly.
                const relabel = setTimeout(() => { entry.activity = this.activityDuring(from, t); }, GC_RELABEL_DELAY_MS);
                (relabel as { unref?: () => void }).unref?.();
                try { this.onStall?.(lag); } catch { /* diagnostics only */ }
            }
            last = t;
        }, intervalMs);
        // Never keep the process alive just to watch it.
        (this.timer as { unref?: () => void }).unref?.();
    }

    stopLoopMonitor(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private pruneSpans(): void {
        const cutoff = this.now() - ACTIVITY_MEMORY_MS;
        if (this.spans.length > MAX_ACTIVITY_HISTORY || (this.spans[0] && this.spans[0].end !== null && this.spans[0].end < cutoff)) {
            this.spans = this.spans.filter(s => s.end === null || s.end >= cutoff).slice(-MAX_ACTIVITY_HISTORY);
        }
    }
}

/**
 * The process-wide instance. Shared so modules other than main.ts can label
 * their own synchronous work (e.g. storage.ts's whole-file save) without an
 * import cycle through main.
 */
export const freezeMonitor = new FreezeMonitor();
