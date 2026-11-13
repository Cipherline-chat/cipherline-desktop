/**
 * DEV AND STAGING BUILDS ONLY: names what the app was doing when the Firewall
 * game drops a frame.
 *
 * The game draws in a worker (workers/loadingScreen.worker.ts), so a hitch is
 * invisible to the main thread unless the worker says so. With `probe: true` at
 * init it reports each late frame and each pillar's entry
 * onto the screen. This file records, over the same stretch, the main thread's
 * Long Animation Frames (with their per-script attribution), its own late
 * frames, and network responses, and lays each worker hitch against them:
 *
 *   [fw-probe] 41ms frame (2.5 frames) · pillar #6 even +212ms · score 5
 *      main: LoAF 63ms @-30ms: 44ms ChatPane.tsx poll (setInterval) · style/layout 9ms
 *      net:  calls/status (xmlhttprequest) done -12ms
 *
 * A hitch with nothing on the main thread points at the GPU / compositor side.
 * report() is the summary (odd vs even pillars, how many hitches had main-thread
 * work under them, the scripts seen most); the game-over card offers it as "Copy
 * hitch report", because a packaged build closes DevTools as soon as it opens
 * (electron/main.ts). Dev builds also log each hitch to the console and leave
 * the summary in `window.__fwHitchReport` on close.
 *
 * On only where hitchProbeEnabled() says so: dev builds and staging builds
 * (version `x.y.z-staging.N`). A stable build never starts it. It records
 * timings, script file / function names and API paths (ids replaced) only:
 * nothing a user typed or received, and nothing leaves the device unless the
 * tester pastes the report somewhere.
 */
import type { ProbeMsg } from '../workers/loadingScreenProtocol';
import { parseSystemInfoReply } from '../utils/diagnostics/ipc';
import { rateLine, type RunRate } from '../utils/firewallRate';
import type { SystemInfo } from '../utils/diagnostics/reportTypes';

interface Span { at: number; end: number }
/** Where a long frame's time went, in ms: tasks+script, then rAF/ResizeObserver callbacks, then style/layout/paint/commit. */
export interface LoafPhases { tasks: number; raf: number; render: number }
interface Loaf extends Span {
    dur: number; block: number; layout: number; scripts: { src: string; ms: number }[];
    phases: LoafPhases | null; firstUI: number | null;
}
interface Frame { at: number; gap: number }
interface HeapSample { at: number; used: number }
interface Where { x: number; y: number; w: number; h: number; dpr: number }
interface MainGap extends Span { gap: number }
interface Net { at: number; name: string; kind: string }
interface Hitch { at: number; gap: number; frames: number; js: number; score: number; pillar: number; sincePillar: number; loafs: Loaf[]; mainGaps: MainGap[]; net: Net[]; frameRun: number[]; heap: string; where: Where }

interface LoafScript { duration: number; sourceURL?: string; sourceFunctionName?: string; invoker?: string; invokerType?: string }
interface LoafEntry extends PerformanceEntry { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; firstUIEventTimestamp?: number; scripts?: LoafScript[] }

/** Dev builds, and staging builds by their version (the same test as utils/stagingLock.ts). */
export function hitchProbeEnabled(version: string = import.meta.env.VITE_APP_VERSION ?? '', dev: boolean = !!import.meta.env.DEV): boolean {
    return dev || /^\d+\.\d+\.\d+-staging(?:\.|$)/.test(version);
}

const KEEP_MS = 12_000;
const T0 = () => performance.timeOrigin;

/**
 * Splits a Long Animation Frame at its two marks. A frame whose `tasks` is big but has no
 * script attributed is timers / GC / decode; a big `raf` is the rAF + ResizeObserver
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
    const hint = { tasks: 'tasks/GC/decode before rendering', raf: 'rAF / ResizeObserver callbacks', render: 'style/layout/paint/commit (compositor or GPU wait)' }[top];
    return `Where the long frames' time went (${n} frames): tasks ${t.tasks.toFixed(0)} ms, rAF/RO ${t.raf.toFixed(0)} ms, render ${t.render.toFixed(0)} ms -> mostly ${hint}`;
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

export function startHitchProbe(): HitchProbe {
    const loafs: Loaf[] = [], mainGaps: MainGap[] = [], net: Net[] = [], hitches: Hitch[] = [];
    const pillars: { at: number; k: number }[] = [];
    let frameIv = 1000 / 60;
    // Every main-thread long frame of the run, hitch or not: a busy main thread under a smooth game clears it.
    let loafCount = 0, loafMs = 0, mainGapCount = 0;
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
    observe('resource', e => {
        const r = e as PerformanceResourceTiming;
        net.push({ at: T0() + r.responseEnd, name: shortName(r.name), kind: r.initiatorType });
        prune(net);
    });
    // The main thread's own frames: a 20-50 ms frame is under LoAF's 50 ms bar but
    // can still mean a big paint the GPU has to do alongside the game.
    let raf = 0, last = 0;
    const frames: Frame[] = [];
    const heap: HeapSample[] = [];
    const memory = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const where = (): Where => ({ x: window.screenX, y: window.screenY, w: window.screen?.width ?? 0, h: window.screen?.height ?? 0, dpr: window.devicePixelRatio || 1 });
    const tick = (ts: number) => {
        if (last) {
            const gap = ts - last;
            frames.push({ at: T0() + ts, gap }); prune(frames);
            const m = memory(); if (m) { heap.push({ at: T0() + ts, used: m.usedJSHeapSize }); prune(heap); }
            if (gap > Math.max(frameIv * 1.6, frameIv + 6)) { mainGapCount++; mainGaps.push({ at: T0() + ts - gap, end: T0() + ts, gap }); prune(mainGaps); }
            else frameIv += (gap - frameIv) * 0.05;
        }
        last = ts;
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // Which GPUs, displays and compositing mode this machine has (main-process read, read-only).
    let sysLines: string[] = [];
    const api = (window as unknown as { electronAPI?: { diagGetSystemInfo?: () => Promise<unknown>; getDisplayRefreshRates?: () => Promise<{ displayFrequency: number; isPrimary: boolean }[]> } }).electronAPI;
    let stopped = false;
    void Promise.all([api?.diagGetSystemInfo?.() ?? null, api?.getDisplayRefreshRates?.() ?? []]).then(([raw, hz]) => {
        if (stopped || !raw) return;
        sysLines = describeSystem(parseSystemInfoReply(raw, '', '').system, hz);
    }).catch(() => { /* no bridge (browser dev): the report just omits it */ });

    const overlaps = <T extends Span>(list: T[], from: number, to: number) => list.filter(x => x.at < to && x.end > from);

    let rate: { r: RunRate; gl: string } | null = null;
    const onWorker = (m: ProbeMsg) => {
        if (m.kind === 'rate') {
            rate = { r: { frames: m.frames, ms: m.ms, fps: m.fps, busyAvgMs: m.busyAvgMs, maxGapMs: m.maxGapMs }, gl: m.gl };
            return;
        }
        if (m.kind === 'pillar') {
            if (m.k === 1) pillars.length = 0; // a fresh run counts from 1
            pillars.push({ at: m.at, k: m.k });
            return;
        }
        // The late frame covers [at - gap, at]. Pad the front by a frame: work that
        // ended just before the gap opened can still have delayed this frame.
        const from = m.at - m.gap - frameIv, to = m.at;
        // The main thread's entries for this window may land a moment later (LoAF
        // reports after its frame ends): read them on the next macrotask round.
        setTimeout(() => {
            // The pillar that had entered by the hitch (one may have entered since).
            let p: { at: number; k: number } | null = null;
            for (let i = pillars.length - 1; i >= 0 && !p; i--) if (pillars[i].at <= m.at) p = pillars[i];
            const near = frames.filter(f => f.at >= m.at - m.gap - 40 && f.at <= m.at + 40);
            const h: Hitch = {
                frameRun: near.map(f => Math.round(f.gap)), heap: heapHint(heap, from - 50, to + 120), where: where(),
                at: m.at, gap: m.gap, frames: m.gap / frameIv, js: m.js, score: m.score,
                pillar: p ? p.k : 0, sincePillar: p ? m.at - p.at : 0,
                loafs: overlaps(loafs, from, to), mainGaps: overlaps(mainGaps, from, to),
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
            if (!h.loafs.length) for (const g of h.mainGaps) lines.push(`   main: ${g.gap.toFixed(0)}ms frame @${(g.at - m.at).toFixed(0)}ms (under 50 ms, no attribution)`);
            for (const n of h.net) lines.push(`   net:  ${n.name} (${n.kind}) done ${(n.at - m.at).toFixed(0)}ms`);
            lines.push(`   heap ${h.heap} · main rAF gaps ${h.frameRun.join(',')} · window ${whereText(h.where)}`);
            if (!h.loafs.length && !h.mainGaps.length) lines.push('   main thread idle: look at the GPU / compositor side');
            if (import.meta.env.DEV) console.log(lines.join('\n'));
        }, 120);
    };

    const report = (): string => {
        const nearPillar = hitches.filter(h => h.pillar && h.sincePillar < 700);
        const odd = nearPillar.filter(h => h.pillar % 2).length, even = nearPillar.length - odd;
        const withMain = hitches.filter(h => h.loafs.length || h.mainGaps.length).length;
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
            `Within 700 ms of a pillar entering: odd ${odd}, even ${even}`,
            `Main thread busy under the hitch: ${withMain} of ${hitches.length}`,
            `Main thread over the whole run: ${loafCount} long frames (${loafMs.toFixed(0)} ms), ${mainGapCount} late frames`,
            `Scripts in the hitch frames:\n${top(scripts)}`,
            `Scripts in all the run's long frames (by total ms):\n${[...runScripts].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
                .map(([k, v]) => `  ${v.ms.toFixed(0)}ms in ${v.n}x ${k}`).join('\n') || '  none'}`,
            `Network responses in those frames:\n${top(nets)}`,
            'Each hitch:',
            ...hitches.map(h => `  ${h.gap.toFixed(0)}ms p${h.pillar}${h.pillar ? (h.pillar % 2 ? 'o' : 'e') : ''}+${h.sincePillar.toFixed(0)} `
                + `loaf ${h.loafs.map(l => `${l.dur.toFixed(0)}[${l.scripts[0]?.src ?? '-'}]`).join(',') || '-'} `
                + `main ${h.mainGaps.map(g => g.gap.toFixed(0)).join(',') || '-'} net ${h.net.map(n => n.name).join(',') || '-'}\n`
                + `${h.loafs.map(l => `      ${phaseText(l)}`).join('\n') || '      no LoAF'}\n`
                + `      heap ${h.heap} · rAF ms ${h.frameRun.slice(0, 24).join(',')} · ${whereText(h.where)}`),
        ].join('\n');
    };

    return {
        onWorker,
        report: () => (hitches.length || pillars.length || rate ? report() : null),
        stop() {
            stopped = true;
            cancelAnimationFrame(raf);
            for (const o of observers) o.disconnect();
            if (!import.meta.env.DEV || (!hitches.length && !pillars.length && !rate)) return;
            const text = report();
            (window as unknown as { __fwHitchReport?: string }).__fwHitchReport = text;
            console.log(`${text}\n\n(copy it: copy(__fwHitchReport))`);
        },
    };
}
