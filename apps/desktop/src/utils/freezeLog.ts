/**
 * Renderer half of the freeze diagnostic (Settings → Advanced → Performance
 * log). The main-process half is electron/freeze-monitor.ts, which holds the
 * log so it survives a renderer reload.
 *
 * What gets recorded: every renderer task that blocked this thread for
 * LONG_TASK_MS or more — the "stops responding, then comes back" moments —
 * with a timestamp, its duration, and the ACTIVITY labels that overlapped it.
 * Activities are named phases that code opts into with `trackActivity` /
 * `beginActivity` ("startup:hydrate", "dm:pull", "resume:rehydrate").
 *
 * PRIVACY: labels must be static, code-chosen identifiers (see LABEL_RE). Never
 * build one from data — no message text, user/conversation/channel ids or
 * names. A label that fails the pattern is replaced with 'unlabelled' here and
 * dropped again by main, which re-validates everything it is sent.
 */

export const LONG_TASK_MS = 200;
export const LABEL_RE = /^[a-z][a-z0-9_.:-]{0,63}$/i;

export interface FreezeEntry {
    at: number;
    /** 'main'/'renderer' = a stall; 'event' = a window/power/process moment
     *  (ms = its duration, when it has one); 'metrics' = per-process CPU and
     *  memory (activity holds the summary). See electron/freeze-monitor.ts. */
    source: 'main' | 'renderer' | 'event' | 'metrics';
    ms: number;
    activity: string;
}

/** A row that is a freeze (as opposed to an event or a resource snapshot). */
export const isStall = (e: FreezeEntry): boolean => e.source === 'main' || e.source === 'renderer';

interface Span { label: string; start: number; end: number | null }

const MAX_SPANS = 400;
const SPAN_MEMORY_MS = 60_000;
let spans: Span[] = [];

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Mark the start of a named phase; call the returned function when it ends.
 *  `startAt` (performance.now() time) back-dates the start, e.g. to 0 for a
 *  phase that began at navigation. */
export function beginActivity(label: string, startAt?: number): () => void {
    const span: Span = { label: LABEL_RE.test(label) ? label : 'unlabelled', start: startAt ?? nowMs(), end: null };
    spans.push(span);
    if (spans.length > MAX_SPANS) {
        const cutoff = nowMs() - SPAN_MEMORY_MS;
        spans = spans.filter(s => s.end === null || s.end >= cutoff).slice(-MAX_SPANS);
    }
    let done = false;
    return () => {
        if (done) return;
        done = true;
        span.end = nowMs();
    };
}

/** Run `fn` inside a named phase. Works for sync and async functions. */
export function trackActivity<T>(label: string, fn: () => T): T {
    const end = beginActivity(label);
    let result: T;
    try {
        result = fn();
    } catch (e) {
        end();
        throw e;
    }
    if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
        (result as unknown as Promise<unknown>).then(end, end);
    } else {
        end();
    }
    return result;
}

/**
 * Coarse context for rows no phase covers — most renderer freezes are a React
 * render after a click, which no background activity explains. Both are
 * static labels: which top-level VIEW is showing ('home', 'dms', 'server', …;
 * never which conversation or channel) and whether the user had just clicked
 * or typed.
 */
let currentView: string | null = null;
export function setFreezeLogView(view: string): void {
    currentView = LABEL_RE.test(view) ? view : null;
}
let lastInput: { at: number; kind: 'pointer' | 'key' } | null = null;
const INPUT_WINDOW_MS = 1000;

/** Labels overlapping [from, to] (performance.now() time), newest first. */
export function activityDuring(from: number, to: number): string {
    const seen = new Set<string>();
    for (let i = spans.length - 1; i >= 0; i--) {
        const s = spans[i];
        const end = s.end ?? Number.POSITIVE_INFINITY;
        if (s.start <= to && end >= from) seen.add(s.label);
        if (seen.size >= 4) break;
    }
    if (lastInput && lastInput.at <= to && from - lastInput.at <= INPUT_WINDOW_MS) seen.add(`input:${lastInput.kind}`);
    if (currentView) seen.add(`view:${currentView}`);
    return seen.size ? [...seen].join(', ') : 'idle';
}

type Bridge = {
    perfRecord?: (rows: Array<{ at: number; ms: number; activity: string }>) => Promise<unknown>;
    perfGetLog?: () => Promise<FreezeEntry[]>;
    perfClear?: () => Promise<unknown>;
};
const bridge = (): Bridge | null =>
    (typeof window !== 'undefined' ? ((window as unknown as { electronAPI?: Bridge }).electronAPI ?? null) : null);

let pending: Array<{ at: number; ms: number; activity: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Kept locally too, so the log still works with no bridge (tests, website). */
const local: FreezeEntry[] = [];

function queue(row: { at: number; ms: number; activity: string }): void {
    local.push({ ...row, source: 'renderer' });
    if (local.length > 300) local.shift();
    pending.push(row);
    if (flushTimer) return;
    // Sent a beat later, and batched: reporting a freeze must never add work
    // to the moment right after one.
    flushTimer = setTimeout(() => {
        flushTimer = null;
        const rows = pending;
        pending = [];
        void bridge()?.perfRecord?.(rows)?.catch?.(() => { /* diagnostics only */ });
    }, 1000);
}

/** Record a long task (exported for the fallback sampler and for tests). */
export function recordLongTask(startTime: number, duration: number): void {
    if (duration < LONG_TASK_MS) return;
    const timeOrigin = typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin : Date.now() - nowMs();
    queue({ at: Math.round(timeOrigin + startTime), ms: Math.round(duration), activity: activityDuring(startTime, startTime + duration) });
}

let started = false;
/** Start observing long tasks. Idempotent. Call once, as early as possible.
 *  Returns the end function of the 'startup:boot' phase, which is back-dated
 *  to navigation so the bundle's own evaluation is labelled too. */
export function startFreezeLog(): () => void {
    if (started || typeof window === 'undefined') return () => {};
    started = true;
    const endBoot = beginActivity('startup:boot', 0);
    try {
        const onPointer = () => { lastInput = { at: nowMs(), kind: 'pointer' }; };
        const onKey = () => { lastInput = { at: nowMs(), kind: 'key' }; };
        window.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
        window.addEventListener('keydown', onKey, { capture: true, passive: true });
    } catch { /* no DOM (tests) */ }
    try {
        const po = new PerformanceObserver(list => {
            for (const e of list.getEntries()) recordLongTask(e.startTime, e.duration);
        });
        po.observe({ type: 'longtask', buffered: true });
        return endBoot;
    } catch { /* no longtask support — fall through to the sampler */ }
    let last = nowMs();
    setInterval(() => {
        const t = nowMs();
        const lag = t - last - 100;
        if (lag >= LONG_TASK_MS) recordLongTask(last + 100, lag);
        last = t;
    }, 100);
    return endBoot;
}

/** Main's combined log (main stalls + renderer long tasks), newest first. */
export async function fetchFreezeLog(): Promise<FreezeEntry[]> {
    const b = bridge();
    if (b?.perfGetLog) {
        try {
            const rows = await b.perfGetLog();
            if (Array.isArray(rows)) return rows;
        } catch { /* fall back to what this renderer saw */ }
    }
    return [...local].reverse();
}

export async function clearFreezeLog(): Promise<void> {
    local.length = 0;
    pending = [];
    await bridge()?.perfClear?.()?.catch?.(() => {});
}

/** Plain-text report for the Copy button. No content, ids or names. */
export function formatFreezeReport(entries: FreezeEntry[], meta: { version: string; platform: string; commit?: string }): string {
    const stalls = entries.filter(isStall);
    const head = `Cipherline performance log — ${meta.version}${meta.commit ? ` (${meta.commit})` : ''} on ${meta.platform}\n`
        + `Freezes of ${LONG_TASK_MS} ms or more this session, newest first. ${stalls.length} entr${stalls.length === 1 ? 'y' : 'ies'}.`
        + (entries.length > stalls.length ? ` Plus ${entries.length - stalls.length} window/power/process event and resource rows.` : '');
    if (entries.length === 0) return `${head}\n\nNo freezes recorded.`;
    const lines = entries.map(e => {
        // Events without a duration and resource rows print no "ms" column value.
        const ms = isStall(e) || e.ms > 0 ? `${String(e.ms).padStart(6)} ms` : '         ';
        return `${new Date(e.at).toISOString()}  ${e.source.padEnd(8)}  ${ms}  ${e.activity}`;
    });
    return `${head}\n\n${stalls.length === 0 ? 'No freezes recorded.\n\n' : ''}${lines.join('\n')}`;
}

/** Test hook. */
export function __resetFreezeLogForTests(): void {
    spans = [];
    currentView = null;
    lastInput = null;
    pending = [];
    local.length = 0;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    started = false;
}
