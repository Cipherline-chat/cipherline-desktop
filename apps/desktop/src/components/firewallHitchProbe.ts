/**
 * DEV AND STAGING BUILDS ONLY: names what the app was doing when the Firewall
 * game drops a frame.
 *
 * The game draws in a worker (workers/loadingScreen.worker.ts), so a hitch is
 * invisible to the main thread unless the worker says so. With `probe: true` at
 * init it reports each late frame and each pillar's entry
 * onto the screen. This file records, over the same stretch, the main thread's
 * Long Animation Frames (with their per-script attribution and blockingDuration)
 * and network responses, and lays each worker hitch against them:
 *
 *   [fw-probe] 41ms frame (2.5 frames) · pillar #6 even +212ms · score 5
 *      main: LoAF 63ms @-30ms: 44ms ChatPane.tsx poll (setInterval) · style/layout 9ms
 *      net:  calls/status (xmlhttprequest) done -12ms
 *
 * A hitch with nothing on the main thread points at the GPU / compositor side. So
 * does a hitch whose long frame has NO blocking time (`fw:block:0`): a LoAF also
 * counts the time the main thread spent WAITING for its next frame, so a 70 ms
 * "tasks" frame with no script can be an idle main thread under a stalled frame
 * pipeline rather than a 70 ms task (measured in the real renderer, worklog
 * 2026-11-22-firewall-hitch).
 *
 * The probe adds NO per-frame main-thread work. It used to run its own
 * requestAnimationFrame loop for the whole run (main-thread frame gaps and heap
 * samples), which made the window's main thread render a frame at the display's
 * rate (165 a second on a 165 Hz monitor) for nothing while the game, which draws
 * in its worker, needed none. The display rate now comes from the worker (`iv`),
 * heap samples from a 4 Hz timer (full probe only).
 *
 * report() is the summary (how evenly the hitches are spaced, odd vs even pillars,
 * how many hitches had main-thread work under them, the scripts seen most). The
 * game-over "Copy hitch report" button was removed (owner 2026-11-13) and a packaged
 * build closes DevTools as soon as it opens (electron/main.ts), so on close the run
 * goes into the Performance log as label-only rows (probeRows), which "Report a
 * problem → Performance" sends. Dev builds also log each hitch to the console and
 * leave the full text summary in `window.__fwHitchReport` on close.
 *
 * Runs on EVERY channel (a stable user's "still freezing" report had no probe rows,
 * 2026-11-19), in two sizes: dev and staging builds (hitchProbeEnabled(): version
 * `x.y.z-staging.N`) get the full probe; stable gets the light one (long frames and
 * the worker's late-frame messages only: no heap
 * sampling, no resource observer, no console output). Both write only label rows
 * into the Performance log, which leaves the device only inside a report the user
 * chooses to send after seeing the preview. It records timings, script file /
 * function names and API paths (ids replaced) only: nothing a user typed or received.
 */
import type { ProbeMsg } from '../workers/loadingScreenProtocol';
import { parseSystemInfoReply } from '../utils/diagnostics/ipc';
import { rateLine, type RunRate } from '../utils/firewallRate';
import { recordTimingRow } from '../utils/freezeLog';
import type { SystemInfo } from '../utils/diagnostics/reportTypes';

interface Span { at: number; end: number }
/** Where a long frame's time went, in ms: tasks+script, then rAF/ResizeObserver callbacks, then style/layout/paint/commit. */
export interface LoafPhases { tasks: number; raf: number; render: number }
interface Loaf extends Span {
    dur: number; block: number; layout: number; scripts: { src: string; ms: number }[];
    phases: LoafPhases | null; firstUI: number | null;
}
interface HeapSample { at: number; used: number }
interface Where { x: number; y: number; w: number; h: number; dpr: number }
interface Net { at: number; name: string; kind: string }
interface Hitch { at: number; gap: number; frames: number; js: number; score: number; pillar: number; sincePillar: number; loafs: Loaf[]; net: Net[]; heap: string; where: Where }

interface LoafScript { duration: number; sourceURL?: string; sourceFunctionName?: string; invoker?: string; invokerType?: string }
interface LoafEntry extends PerformanceEntry { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; firstUIEventTimestamp?: number; scripts?: LoafScript[] }

/** The FULL probe: dev builds, and staging builds by their version (the same test as utils/stagingLock.ts). Every other build runs the light one. */
export function hitchProbeEnabled(version: string = import.meta.env.VITE_APP_VERSION ?? '', dev: boolean = !!import.meta.env.DEV): boolean {
    return dev || /^\d+\.\d+\.\d+-staging(?:\.|$)/.test(version);
}

const KEEP_MS = 12_000;
/** Heap samples for the GC hint (full probe): a timer, so the probe never asks the main thread for a frame. */
const HEAP_SAMPLE_MS = 250;
const T0 = () => performance.timeOrigin;

/**
 * Splits a Long Animation Frame at its two marks. A frame whose `tasks` is big but has no
 * script attributed is timers / GC / decode IF its blockingDuration is large too; with no
 * blocking time it is the main thread idling until its frame came (BLOCKED_MS); a big `raf` is the rAF + ResizeObserver
 * callbacks; a big `render` is style, layout, paint and the commit to the compositor
 * (which can include waiting on the GPU process). Null when the browser gave no marks.
 */
export function loafPhases(startTime: number, renderStart: number | undefined, styleAndLayoutStart: number | undefined, duration: number): LoafPhases | null {
    if (!renderStart || renderStart < startTime) return null;
    const style = styleAndLayoutStart && styleAndLayoutStart >= renderStart ? styleAndLayoutStart : renderStart;
    const end = startTime + duration;
    return { tasks: renderStart - startTime, raf: style - renderStart, render: Math.max(0, end - style) };
}

/** The JS heap over a window: a drop means a collection ran (GC hint); `delta` is last minus first. */
export function heapHint(samples: HeapSample[], from: number, to: number): string {
    const w = samples.filter(x => x.at >= from && x.at <= to);
    if (w.length < 2) return 'n/a';
    let maxDrop = 0, peak = w[0].used;
    for (const x of w) { peak = Math.max(peak, x.used); maxDrop = Math.max(maxDrop, peak - x.used); }
    const mb = (b: number) => (b / 1048576).toFixed(1);
    const delta = w[w.length - 1].used - w[0].used;
    return `${delta >= 0 ? '+' : ''}${mb(delta)}MB${maxDrop > 262144 ? ` (dropped ${mb(maxDrop)}MB: GC ran)` : ''}`;
}

/** One line each for the GPUs, compositing state and displays, from diag:get-system-info. */
export function describeSystem(sys: SystemInfo, hz: { displayFrequency: number; isPrimary: boolean }[] = []): string[] {
    const gpus = sys.gpu.devices.map(d => `${d.vendor_id}:${d.device_id}${d.active ? '*' : ''}${d.driver_version ? ` ${d.driver_version}` : ''}`).join(', ') || 'unknown';
    const fs = sys.gpu.feature_status;
    const feat = ['gpu_compositing', 'webgl', 'webgl2', 'canvas_oop_rasterization', 'rasterization'].filter(k => fs[k]).map(k => `${k}=${fs[k]}`).join(' ') || 'no feature status';
    const disp = sys.displays.map((d, i) => `${d.width}x${d.height}@${hz[i]?.displayFrequency || d.refresh_hz}${d.primary ? 'p' : ''}${d.scale_factor !== 1 ? `x${d.scale_factor}` : ''}`).join(', ') || 'unknown';
    return [`GPUs (* = in use): ${gpus} · hw accel ${sys.hardware_acceleration ? 'on' : 'OFF'}`, `GPU features: ${feat}`, `Displays: ${disp}`];
}

const median = (sorted: number[]): number => {
    const n = sorted.length, m = n >> 1;
    return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

/** How evenly a run's hitches are spaced: the median gap between them and its spread (median absolute deviation). */
export interface Cadence { gaps: number; medianMs: number; madMs: number; steady: boolean }

/**
 * Hitches on a CLOCK (evenly spaced while the pillars speed up) come from something
 * periodic in the app, not from the game: the 2026-11-12 report's six hitches were
 * 3.07-3.09 s apart while the pillars went from 1.73 s to 1.47 s apart, which players
 * read as "every other pillar". Needs three hitches (two gaps). `at` in ms, ascending.
 */
export function hitchCadence(at: number[]): Cadence | null {
    if (at.length < 3) return null;
    const iv = at.slice(1).map((t, i) => t - at[i]).sort((a, b) => a - b);
    const med = median(iv);
    const mad = median(iv.map(x => Math.abs(x - med)).sort((a, b) => a - b));
    return { gaps: iv.length, medianMs: Math.round(med), madMs: Math.round(mad), steady: mad <= Math.max(40, med * 0.05) };
}

/** The GL renderer string, reduced to its vendor (a label-safe word for the perf log). */
export function glClass(gl: string): string {
    if (!gl) return 'unknown';
    if (/swiftshader/i.test(gl)) return 'swiftshader';
    if (/microsoft basic|warp/i.test(gl)) return 'warp';
    if (/nvidia|geforce|quadro|rtx/i.test(gl)) return 'nvidia';
    if (/amd|radeon|ati/i.test(gl)) return 'amd';
    if (/intel/i.test(gl)) return 'intel';
    if (/apple/i.test(gl)) return 'apple';
    return 'other';
}

/** The displays as the perf-log rows need them: every refresh rate (Hz, rounded), and the one the window is on. */
export interface DisplayTopology { hz: number[]; onHz: number | null }

/**
 * From diag display list (electron `display:get-refresh-rates`; `hostsWindow` marks the
 * display the app window is mostly on). Mixed refresh rates across monitors are a known
 * source of periodic compositor stutter on Windows, so the rows say how many there are,
 * what each runs at, and which one the window is on.
 */
export function displayTopology(list: { displayFrequency: number; isPrimary?: boolean; hostsWindow?: boolean }[]): DisplayTopology | null {
    if (!Array.isArray(list) || !list.length) return null;
    const hz = list.map(d => Math.round(Number(d.displayFrequency) || 0));
    const host = list.find(d => d.hostsWindow);
    return { hz, onHz: host ? Math.round(Number(host.displayFrequency) || 0) : null };
}

/** One hitch, as far as the perf-log rows need it. */
export interface HitchLite {
    gap: number; pillar: number; score: number;
    /** The game's own work in the frame before the gap, ms (the worker's draw: a GPU stall that fills its command buffer lands here). */
    js?: number;
    /** `block`: the long frame's blockingDuration (its long tasks' time over 50 ms each). 0 = the main thread was NOT busy: it was waiting for the frame. */
    loafs: { dur: number; phases: LoafPhases | null; scripts: number; block?: number }[];
}

/**
 * A long animation frame whose blockingDuration is at least this was really held up by a
 * long task on the main thread. Below it, the frame was long because the main thread was
 * WAITING (for the compositor's BeginMainFrame, or with nothing to run): the LoAF's `tasks`
 * phase then counts idle time between tasks, so `fw:split:tasks` with no script attributed
 * says nothing about main-thread work on its own (measured, docs/worklog 2026-11-22).
 */
export const BLOCKED_MS = 20;
/** The largest blockingDuration among a hitch's long frames (0 without any). */
export const hitchBlock = (h: HitchLite): number => h.loafs.reduce((m, l) => Math.max(m, l.block ?? 0), 0);

const MAX_HITCH_ROWS = 12;
const n0 = (x: number) => Math.max(0, Math.round(x));

/**
 * The run's summary as Performance-log rows (utils/freezeLog.ts recordTimingRow), so a
 * staging tester's "Report a problem → Performance" carries it: the game-over copy button
 * is gone (owner 2026-11-13) and a packaged build has no DevTools. Every label is a static
 * word plus numbers (main drops anything failing freezeLog's LABEL_RE): timings, counts and
 * a GPU vendor word only, nothing a user typed or received, no names or paths.
 */
export function probeRows(hitches: HitchLite[], at: number[], rate: { r: RunRate; gl: string } | null, displayHz: number, withMain: number, disp: DisplayTopology | null = null, full = true): { activity: string; ms: number }[] {
    const c = hitchCadence(at);
    const split = { tasks: 0, raf: 0, render: 0 };
    for (const h of hitches) for (const l of h.loafs) if (l.phases) { split.tasks += l.phases.tasks; split.raf += l.phases.raf; split.render += l.phases.render; }
    const top = split.tasks + split.raf + split.render > 0 ? (Object.keys(split) as (keyof typeof split)[]).sort((a, b) => split[b] - split[a])[0] : 'none';
    const summary = [
        'firewall:probe', `fw:late:${hitches.length}`, `fw:hz:${n0(displayHz)}`,
        `fw:fps:${rate ? n0(rate.r.fps) : 0}`, `fw:worst:${rate ? n0(rate.r.maxGapMs) : 0}`, `fw:gl:${glClass(rate?.gl ?? '')}`,
        `fw:main-busy:${withMain}`, `fw:main-blocked:${hitches.filter(h => hitchBlock(h) >= BLOCKED_MS).length}`, `fw:split:${top}`,
        c ? `fw:cadence:${c.medianMs}` : 'fw:cadence:none', c ? `fw:cadence-mad:${c.madMs}` : 'fw:cadence-mad:none',
        `fw:build:${full ? 'full' : 'light'}`,
    ];
    if (disp) {
        summary.push(`fw:disp:${disp.hz.length}`, `fw:disp-hz:${disp.hz.join('-')}`, `fw:mixed-hz:${new Set(disp.hz).size > 1 ? 1 : 0}`);
        if (disp.onHz !== null) summary.push(`fw:on-hz:${disp.onHz}`);
    }
    const rows = [{ activity: summary.join(', '), ms: hitches.reduce((m, h) => Math.max(m, n0(h.gap)), 0) }];
    for (const h of hitches.slice(-MAX_HITCH_ROWS)) {
        const l = h.loafs.slice().sort((a, b) => b.dur - a.dur)[0];
        const labels = ['firewall:hitch', `fw:p:${h.pillar}`, `fw:score:${h.score}`];
        if (l) {
            labels.push(`fw:loaf:${n0(l.dur)}`, `fw:scripts:${l.scripts}`);
            if (l.phases) labels.push(`fw:tasks:${n0(l.phases.tasks)}`, `fw:raf:${n0(l.phases.raf)}`, `fw:render:${n0(l.phases.render)}`);
            labels.push(`fw:block:${n0(hitchBlock(h))}`);
        } else labels.push('fw:loaf:none');
        if (h.js !== undefined) labels.push(`fw:js:${n0(h.js)}`);
        rows.push({ activity: labels.join(', '), ms: n0(h.gap) });
    }
    return rows;
}

const phaseText = (l: Loaf): string => {
    const p = l.phases;
    return (p ? `tasks ${p.tasks.toFixed(0)} · rAF/RO ${p.raf.toFixed(0)} · render ${p.render.toFixed(0)}` : 'no phase marks')
        + ` · blocking ${l.block.toFixed(0)}${l.firstUI != null ? ` · input ${l.firstUI.toFixed(0)}ms in` : ''}`;
};
/** Over every hitch's long frames: the summed time in each phase, and which one dominates. */
const splitLine = (hitches: Hitch[]): string => {
    const t = { tasks: 0, raf: 0, render: 0 };
    let n = 0;
    for (const h of hitches) for (const l of h.loafs) if (l.phases) { n++; t.tasks += l.phases.tasks; t.raf += l.phases.raf; t.render += l.phases.render; }
    if (!n) return 'Where the long frames\' time went: no phase marks';
    const top = (Object.keys(t) as (keyof typeof t)[]).sort((a, b) => t[b] - t[a])[0];
    const hint = { tasks: 'before rendering: tasks/GC/decode if blocked, else waiting for the frame (see "really BLOCKED" below)', raf: 'rAF / ResizeObserver callbacks', render: 'style/layout/paint/commit (compositor or GPU wait)' }[top];
    return `Where the long frames' time went (${n} frames): tasks ${t.tasks.toFixed(0)} ms, rAF/RO ${t.raf.toFixed(0)} ms, render ${t.render.toFixed(0)} ms -> mostly ${hint}`;
};
/** Steady hitches against the pillars' own rhythm: a clock that only LOOKS like "every other pillar". */
const cadenceLine = (c: Cadence | null, pillarAt: number[]): string => {
    if (!c) return 'Hitch spacing: fewer than 3 hitches';
    const pc = hitchCadence(pillarAt);
    const pillars = pc ? ` (pillars came every ${(pc.medianMs / 1000).toFixed(2)} s)` : '';
    return `Hitch spacing: every ${(c.medianMs / 1000).toFixed(2)} s ±${c.madMs} ms over ${c.gaps} gaps${pillars} -> `
        + (c.steady ? 'a steady clock: something periodic in the app or the GPU, not the pillars' : 'irregular');
};
const whereText = (w: Where): string => `@${w.x},${w.y} on ${w.w}x${w.h} ${w.dpr}x`;

const shortSrc = (s: LoafScript): string => {
    const url = (s.sourceURL || '').split('?')[0];
    const file = url ? url.slice(url.lastIndexOf('/') + 1) : '(no source)';
    const fn = s.sourceFunctionName ? ` ${s.sourceFunctionName}` : '';
    const via = s.invokerType ? ` (${s.invokerType}${s.invoker ? `: ${s.invoker}` : ''})` : '';
    return `${file}${fn}${via}`;
};
const shortName = (n: string): string => {
    try { const u = new URL(n); return u.pathname.replace(/^\/v1\//, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'); } catch { return n.slice(0, 60); }
};

export interface HitchProbe {
    onWorker(m: ProbeMsg): void;
    /** The summary so far, or null when nothing has been recorded yet. */
    report(): string | null;
    stop(): void;
}

export function startHitchProbe(full: boolean = hitchProbeEnabled()): HitchProbe {
    const loafs: Loaf[] = [], net: Net[] = [], hitches: Hitch[] = [];
    const pillars: { at: number; k: number }[] = [];
    let frameIv = 1000 / 60;
    // Every main-thread long frame of the run, hitch or not: a busy main thread under a smooth game clears it.
    let loafCount = 0, loafMs = 0, loafBlocked = 0;
    const runScripts = new Map<string, { n: number; ms: number }>();
    const prune = (list: { at: number }[]) => {
        const cut = Date.now() - KEEP_MS;
        while (list.length && list[0].at < cut) list.shift();
    };
    const observers: PerformanceObserver[] = [];
    const types = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
    const observe = (type: string, fn: (e: PerformanceEntry) => void) => {
        if (!types.includes(type)) return false;
        const o = new PerformanceObserver(list => { for (const e of list.getEntries()) fn(e); });
        o.observe({ type, buffered: false });
        observers.push(o);
        return true;
    };
    const hasLoaf = observe('long-animation-frame', e => {
        const l = e as LoafEntry, at = T0() + l.startTime;
        loafCount++; loafMs += l.duration;
        if ((l.blockingDuration ?? 0) >= BLOCKED_MS) loafBlocked++;
        loafs.push({
            at, end: at + l.duration, dur: l.duration, block: l.blockingDuration ?? 0,
            layout: l.styleAndLayoutStart ? l.startTime + l.duration - l.styleAndLayoutStart : 0,
            phases: loafPhases(l.startTime, l.renderStart, l.styleAndLayoutStart, l.duration),
            firstUI: l.firstUIEventTimestamp ? l.firstUIEventTimestamp - l.startTime : null,
            scripts: (l.scripts ?? []).map(s => ({ src: shortSrc(s), ms: s.duration })).sort((a, b) => b.ms - a.ms),
        });
        for (const s of loafs[loafs.length - 1].scripts) {
            const t = runScripts.get(s.src) ?? { n: 0, ms: 0 };
            t.n++; t.ms += s.ms;
            runScripts.set(s.src, t);
        }
        prune(loafs);
    });
    // Without LoAF (older Chromium) the plain long-task entry still says WHEN, if not who.
    if (!hasLoaf) observe('longtask', e => {
        const at = T0() + e.startTime;
        loafCount++; loafMs += e.duration;
        loafs.push({ at, end: at + e.duration, dur: e.duration, block: e.duration - 50, layout: 0, scripts: [], phases: null, firstUI: null });
        prune(loafs);
    });
    if (full) observe('resource', e => {
        const r = e as PerformanceResourceTiming;
        net.push({ at: T0() + r.responseEnd, name: shortName(r.name), kind: r.initiatorType });
        prune(net);
    });
    // NO requestAnimationFrame loop here (see the header): a main-thread rAF makes the
    // whole window render a frame every vsync for as long as it runs. Heap samples (the
    // GC hint) come from a 4 Hz timer instead, full probe only; a timer renders nothing.
    const heap: HeapSample[] = [];
    const memory = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const where = (): Where => ({ x: window.screenX, y: window.screenY, w: window.screen?.width ?? 0, h: window.screen?.height ?? 0, dpr: window.devicePixelRatio || 1 });
    const heapTimer = full && memory() ? setInterval(() => {
        const m = memory();
        if (m) { heap.push({ at: Date.now(), used: m.usedJSHeapSize }); prune(heap); }
    }, HEAP_SAMPLE_MS) : null;

    // Which GPUs, displays and compositing mode this machine has (main-process read, read-only).
    let sysLines: string[] = [];
    let topo: DisplayTopology | null = null;
    type Disp = { displayFrequency: number; isPrimary: boolean; hostsWindow?: boolean };
    const api = (window as unknown as { electronAPI?: { diagGetSystemInfo?: () => Promise<unknown>; getDisplayRefreshRates?: () => Promise<Disp[]> } }).electronAPI;
    let stopped = false;
    // The display list is read on every build (the rows carry it); the full system read only in the full probe.
    void (async () => {
        const hz = (await api?.getDisplayRefreshRates?.()) ?? [];
        if (stopped) return;
        topo = displayTopology(hz);
        if (!full) return;
        const raw = await api?.diagGetSystemInfo?.();
        if (stopped || !raw) return;
        sysLines = describeSystem(parseSystemInfoReply(raw, '', '').system, hz);
    })().catch(() => { /* no bridge (browser dev): the report just omits it */ });

    const overlaps = <T extends Span>(list: T[], from: number, to: number) => list.filter(x => x.at < to && x.end > from);

    let rate: { r: RunRate; gl: string } | null = null;
    const onWorker = (m: ProbeMsg) => {
        if (m.kind === 'rate') {
            rate = { r: { frames: m.frames, ms: m.ms, fps: m.fps, busyAvgMs: m.busyAvgMs, maxGapMs: m.maxGapMs }, gl: m.gl };
            if (typeof m.iv === 'number' && m.iv > 0) frameIv = m.iv;
            return;
        }
        if (m.kind === 'pillar') {
            if (m.k === 1) pillars.length = 0; // a fresh run counts from 1
            pillars.push({ at: m.at, k: m.k });
            return;
        }
        // The worker's own on-time frame interval: the display's rate (no main-thread rAF to learn it from).
        if (typeof m.iv === 'number' && m.iv > 0) frameIv = m.iv;
        // The late frame covers [at - gap, at]. Pad the front by a frame: work that
        // ended just before the gap opened can still have delayed this frame.
        const from = m.at - m.gap - frameIv, to = m.at;
        // The main thread's entries for this window may land a moment later (LoAF
        // reports after its frame ends): read them on the next macrotask round.
        setTimeout(() => {
            // The pillar that had entered by the hitch (one may have entered since).
            let p: { at: number; k: number } | null = null;
            for (let i = pillars.length - 1; i >= 0 && !p; i--) if (pillars[i].at <= m.at) p = pillars[i];
            const h: Hitch = {
                heap: heapHint(heap, from - 300, to + 300), where: where(),
                at: m.at, gap: m.gap, frames: m.gap / frameIv, js: m.js, score: m.score,
                pillar: p ? p.k : 0, sincePillar: p ? m.at - p.at : 0,
                loafs: overlaps(loafs, from, to),
                net: net.filter(n => n.at > from - 100 && n.at < to),
            };
            hitches.push(h);
            const lines = [
                `[fw-probe] ${h.gap.toFixed(0)}ms frame (${h.frames.toFixed(1)} frames) · `
                + (h.pillar ? `pillar #${h.pillar} ${h.pillar % 2 ? 'odd' : 'even'} +${h.sincePillar.toFixed(0)}ms` : 'before the first pillar')
                + ` · score ${h.score} · game ${h.js.toFixed(1)}ms`,
            ];
            for (const l of h.loafs) {
                const s = l.scripts.slice(0, 3).map(x => `${x.ms.toFixed(0)}ms ${x.src}`).join(', ') || 'no script attributed';
                lines.push(`   main: LoAF ${l.dur.toFixed(0)}ms @${(l.at - m.at).toFixed(0)}ms: ${s}${l.layout ? ` · style/layout ${l.layout.toFixed(0)}ms` : ''} · ${phaseText(l)}`);
            }
            for (const n of h.net) lines.push(`   net:  ${n.name} (${n.kind}) done ${(n.at - m.at).toFixed(0)}ms`);
            lines.push(`   heap ${h.heap} · window ${whereText(h.where)}`);
            if (!h.loafs.some(l => l.block >= BLOCKED_MS)) lines.push(`   main thread not blocked (${h.loafs.length ? 'long frame, no long task' : 'no long frame'}): look at the GPU / compositor side`);
            if (full && import.meta.env.DEV) console.log(lines.join('\n'));
        }, 120);
    };

    const report = (): string => {
        const nearPillar = hitches.filter(h => h.pillar && h.sincePillar < 700);
        const odd = nearPillar.filter(h => h.pillar % 2).length, even = nearPillar.length - odd;
        const withMain = hitches.filter(h => h.loafs.length).length;
        const blocked = hitches.filter(h => h.loafs.some(l => l.block >= BLOCKED_MS)).length;
        const scripts = new Map<string, number>();
        for (const h of hitches) for (const l of h.loafs) for (const s of l.scripts) scripts.set(s.src, (scripts.get(s.src) ?? 0) + 1);
        const nets = new Map<string, number>();
        for (const h of hitches) for (const n of h.net) nets.set(n.name, (nets.get(n.name) ?? 0) + 1);
        const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `  ${v}x ${k}`).join('\n') || '  none';
        return [
            `Firewall hitch probe · ${hitches.length} late frames · display ~${(1000 / frameIv).toFixed(0)} Hz · LoAF ${hasLoaf ? 'on' : 'unavailable (long tasks only)'}`,
            `Build ${import.meta.env.VITE_APP_VERSION ?? '?'} · ${(navigator.userAgent.match(/(Electron|Chrome)\/[\d.]+/g) ?? []).join(' ')} · `
                + `window ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x · ${pillars.length ? `last run ${pillars.length} pillars` : 'no pillars yet'}`,
            ...sysLines,
            `Window now ${whereText(where())} · screen.isExtended ${String((window.screen as { isExtended?: boolean })?.isExtended ?? '?')}`
                + ` · first hitch window ${hitches[0] ? whereText(hitches[0].where) : 'n/a'}`,
            rateLine(rate ? rate.r : null, 1000 / frameIv, rate ? rate.gl : ''),
            splitLine(hitches),
            cadenceLine(hitchCadence(hitches.map(h => h.at)), pillars.map(p => p.at)),
            `Within 700 ms of a pillar entering: odd ${odd}, even ${even}`,
            `Main thread had a long frame under the hitch: ${withMain} of ${hitches.length}; really BLOCKED by a long task (blockingDuration >= ${BLOCKED_MS} ms): ${blocked}`
                + (withMain > blocked ? ' -> the rest were the main thread WAITING for a frame, not working' : ''),
            `Main thread over the whole run: ${loafCount} long frames (${loafMs.toFixed(0)} ms), ${loafBlocked} of them blocked by a long task`,
            `Scripts in the hitch frames:\n${top(scripts)}`,
            `Scripts in all the run's long frames (by total ms):\n${[...runScripts].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
                .map(([k, v]) => `  ${v.ms.toFixed(0)}ms in ${v.n}x ${k}`).join('\n') || '  none'}`,
            `Network responses in those frames:\n${top(nets)}`,
            'Each hitch:',
            ...hitches.map(h => `  ${h.gap.toFixed(0)}ms p${h.pillar}${h.pillar ? (h.pillar % 2 ? 'o' : 'e') : ''}+${h.sincePillar.toFixed(0)} `
                + `loaf ${h.loafs.map(l => `${l.dur.toFixed(0)}[${l.scripts[0]?.src ?? '-'}]`).join(',') || '-'} `
                + `game ${h.js.toFixed(1)}ms net ${h.net.map(n => n.name).join(',') || '-'}\n`
                + `${h.loafs.map(l => `      ${phaseText(l)}`).join('\n') || '      no LoAF'}\n`
                + `      heap ${h.heap} · ${whereText(h.where)}`),
        ].join('\n');
    };

    return {
        onWorker,
        report: () => (hitches.length || pillars.length || rate ? report() : null),
        stop() {
            stopped = true;
            if (heapTimer) clearInterval(heapTimer);
            for (const o of observers) o.disconnect();
            if (!hitches.length && !rate) return;
            // Into the Performance log, so "Report a problem → Performance" carries it (staging included).
            const withMain = hitches.filter(h => h.loafs.length).length;
            const lite = hitches.map(h => ({ gap: h.gap, pillar: h.pillar, score: h.score, js: h.js, loafs: h.loafs.map(l => ({ dur: l.dur, phases: l.phases, scripts: l.scripts.length, block: l.block })) }));
            for (const row of probeRows(lite, hitches.map(h => h.at), rate, 1000 / frameIv, withMain, topo, full)) recordTimingRow(row.activity, row.ms);
            if (!full || !import.meta.env.DEV) return;
            const text = report();
            (window as unknown as { __fwHitchReport?: string }).__fwHitchReport = text;
            console.log(`${text}\n\n(copy it: copy(__fwHitchReport))`);
        },
    };
}
