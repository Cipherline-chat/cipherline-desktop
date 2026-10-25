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
 *
 * SCRIPT ATTRIBUTION: where Chromium has the Long Animation Frames API (LoAF —
 * Electron 43 / Chrome 150 does), each row ALSO names the code that ran in the
 * frozen frame: `js:<file>:<function>:c<offset>:<ms>ms` for the longest
 * scripts, `via:<invoker>` (DIV.onkeydown, MessagePort.onmessage …) and the
 * rendering / forced-layout share — see longFrameAttribution.ts for how those
 * are reduced to code identifiers. The same frame is also logged as a
 * `long_frame` event in the call-event ring (callEventLog.ts), which a
 * "Report a problem → Performance" report carries as structured `call_events`.
 */
import { attributeFrame, frameLabels, type LoafEntryLike } from './longFrameAttribution';
import { logCallEvent } from './callEventLog';

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
    onOsResume?: (cb: () => void) => () => void;
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

const timeOrigin = (): number =>
    (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin : Date.now() - nowMs());

/** One observer of every renderer stall this log records (beta diagnostics):
 *  its duration and the static activity labels. Must not throw (isolated). */
type FreezeTap = (ms: number, activity: string) => void;
let freezeTap: FreezeTap | null = null;
export function setFreezeTap(fn: FreezeTap | null): void { freezeTap = fn; }
const tapNow = (ms: number, activity: string) => { if (freezeTap) { try { freezeTap(ms, activity); } catch { /* isolate */ } } };

/**
 * Sleep and hidden-window guard for the beta tap. A task or frame that is open
 * while the machine sleeps, or while Chromium has the hidden window's page
 * frozen, measures all of that idle time, even as `blockingDuration`. Beta
 * reports from 1.0.23-staging.171 (2026-10-20..22) show it: app_freeze of
 * 738 s, 808 s, 896 s and 16,889 s (4.7 h) with only view:* or dm:pull as the
 * phase. The events that tell us (OS resume, visibilitychange, page-lifecycle
 * resume) are dispatched only AFTER the stalled task ends, so the decision
 * waits WAKE_SETTLE_MS and then drops the freeze if any of them landed
 * between its start and that check, or if the window is hidden at that point.
 * The local perf log keeps every row unchanged; only the beta event is filtered.
 */
export const WAKE_SETTLE_MS = 10_000;
/** Longer than any freeze the app could survive; beyond this it is idle time, never a block. */
export const MAX_PLAUSIBLE_FREEZE_MS = 5 * 60_000;
let idleMarks: number[] = [];
export function noteIdleBoundary(at: number = nowMs()): void {
    idleMarks.push(at);
    if (idleMarks.length > 32) idleMarks = idleMarks.slice(-32);
}
const isHidden = () => { try { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch { return false; } };
function tapFreeze(ms: number, activity: string, start: number): void {
    if (!freezeTap || ms > MAX_PLAUSIBLE_FREEZE_MS) return;
    if (isHidden()) return;
    setTimeout(() => {
        if (isHidden() || idleMarks.some(t => t >= start)) return;
        tapNow(ms, activity);
    }, WAKE_SETTLE_MS);
}

/** Record a long task (exported for the fallback sampler and for tests). */
export function recordLongTask(startTime: number, duration: number): void {
    if (duration < LONG_TASK_MS) return;
    const activity = activityDuring(startTime, startTime + duration);
    queue({ at: Math.round(timeOrigin() + startTime), ms: Math.round(duration), activity });
    tapFreeze(Math.round(duration), activity, startTime);
}

/** Main drops a row whose activity is longer than this (freeze-monitor.ts). */
const MAX_ACTIVITY_CHARS = 300;
/** At most this many `long_frame` call events per minute, so a boot or a
 *  freeze storm cannot push the call engine's own events out of the ring. */
const MAX_FRAME_EVENTS_PER_MIN = 20;
let frameEventWindow = { start: 0, count: 0 };

function ownOrigin(): string | null {
    try { return typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : null; } catch { return null; }
}

/**
 * Record a long animation frame (LoAF) with script attribution. Exported for
 * tests.
 *
 * Recorded only when the MAIN THREAD was blocked — `blockingDuration` (long
 * tasks minus 50 ms each, plus rendering) of at least LONG_TASK_MS − 50, the
 * same bar a 200 ms long task clears. A frame can be long while this thread is
 * idle (waiting on the compositor / GPU for its next frame): measured in the
 * idle-return harness, dozens of 200–565 ms frames with blockingDuration 0
 * and no scripts after the window came back. Those are not freezes of this
 * thread and must not read as one.
 */
export function recordLongFrame(entry: LoafEntryLike): void {
    if (!entry || !(entry.duration >= LONG_TASK_MS)) return;
    const blocking = typeof entry.blockingDuration === 'number' ? entry.blockingDuration : entry.duration - 50;
    if (!(blocking >= LONG_TASK_MS - 50)) return;
    const a = attributeFrame(entry, ownOrigin());
    const context = activityDuring(entry.startTime, entry.startTime + entry.duration);
    const labels = context === 'idle' ? [] : context.split(', ');
    const extra = frameLabels(a);
    // Context first (it is what the log always had); attribution after, and
    // dropped from the end if the row would exceed what main accepts.
    while (extra.length && [...labels, ...extra].join(', ').length > MAX_ACTIVITY_CHARS) extra.pop();
    const activity = [...labels, ...extra].join(', ') || 'idle';
    queue({ at: Math.round(timeOrigin() + entry.startTime), ms: a.ms, activity });
    // The beta `app_freeze` gets the time this thread was BLOCKED, not the
    // frame's wall span: a frame that is open across idle time — the window
    // hidden with no rendering opportunity, or the machine asleep — spans all
    // of it. Prod (1.0.23-staging.169, 2026-10-20): app_freeze ms=6077366
    // phase=resume:wake, i.e. a 101-minute sleep reported as a freeze.
    tapFreeze(Math.round(Math.min(entry.duration, blocking)), context, entry.startTime);

    const t = nowMs();
    if (t - frameEventWindow.start > 60_000) frameEventWindow = { start: t, count: 0 };
    if (frameEventWindow.count >= MAX_FRAME_EVENTS_PER_MIN) return;
    frameEventWindow.count++;
    const top = a.scripts[0];
    logCallEvent('long_frame', {
        ms: a.ms,
        blocking_ms: a.blockingMs,
        render_ms: a.renderMs,
        layout_ms: a.layoutMs,
        script_ms: a.scriptMs,
        scripts: a.scriptCount,
        file: top ? top.file : 'none',
        fn: top ? top.fn : 'none',
        char: top ? top.char : -1,
        invoker: top ? top.invoker : 'none',
        invoker_type: top ? top.invokerType : 'none',
    });
}

/** Does this Chromium deliver 'long-animation-frame' entries? */
function supportsLoaf(): boolean {
    try {
        const types = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
        return Array.isArray(types) && types.includes('long-animation-frame');
    } catch {
        return false;
    }
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
        // Idle boundaries for the beta tap's sleep / hidden-window guard.
        const mark = () => noteIdleBoundary();
        document.addEventListener('visibilitychange', mark);
        document.addEventListener('resume', mark);
        bridge()?.onOsResume?.(mark);
    } catch { /* no DOM (tests) */ }
    // LoAF when available: it reports every long task too (a task with no
    // rendering is its own frame), so observing both would log each freeze
    // twice. Long tasks remain the fallback, then the timer sampler.
    try {
        if (supportsLoaf()) {
            const po = new PerformanceObserver(list => {
                for (const e of list.getEntries()) {
                    try { recordLongFrame(e as unknown as LoafEntryLike); } catch { /* diagnostics only */ }
                }
            });
            po.observe({ type: 'long-animation-frame', buffered: true });
            return endBoot;
        }
    } catch { /* fall through to long tasks */ }
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
export function formatFreezeReport(entries: FreezeEntry[], meta: { version: string; platform: string; commit?: string; memory?: string }): string {
    const stalls = entries.filter(isStall);
    const head = `Cipherline performance log — ${meta.version}${meta.commit ? ` (${meta.commit})` : ''} on ${meta.platform}\n`
        + (meta.memory ? `${meta.memory}\n` : '')
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
    frameEventWindow = { start: 0, count: 0 };
    idleMarks = [];
}
