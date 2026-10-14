/**
 * Main-process event-loop health for the Performance log, beyond the
 * stall rows FreezeMonitor's own 100 ms timer already produces:
 *
 *   - a perf_hooks 'gc' observer feeding FreezeMonitor.noteGc(), so a stall
 *     that WAS a garbage collection says so (`gc:major:1400ms`) instead of
 *     reading "idle" — the owner's 2026-10-11 report had 2–6 s main stalls
 *     labelled idle while main's heap swung 67 → 259 MB between samples;
 *   - a monitorEventLoopDelay histogram, summarised into each periodic
 *     metrics row (`main-loop p50 … p99 … max …`), so sub-threshold jank
 *     (many 50–150 ms delays that never become a 200 ms row) is visible too.
 *
 * Both are cheap: the histogram is one libuv timer at RESOLUTION_MS, and the
 * GC observer runs once per collection. Neither records anything but
 * durations and the collector kind.
 *
 * No `electron` import, so it is unit-testable; main.ts wires it up.
 */
import { monitorEventLoopDelay, PerformanceObserver, performance, constants as perfConstants } from 'perf_hooks';
import type { FreezeMonitor, GcKind } from './freeze-monitor';

const RESOLUTION_MS = 50;

export function gcKindOf(kind: unknown): GcKind | null {
    switch (kind) {
        case perfConstants.NODE_PERFORMANCE_GC_MAJOR: return 'major';
        case perfConstants.NODE_PERFORMANCE_GC_MINOR: return 'minor';
        case perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL: return 'incremental';
        case perfConstants.NODE_PERFORMANCE_GC_WEAKCB: return 'weakcb';
        default: return null;
    }
}

export interface LoopStats { p50Ms: number; p99Ms: number; maxMs: number }
export interface GcStats { ms: number; count: number; majorMs: number; majorCount: number; maxMs: number }

/** `main-loop p50 1ms p99 12ms max 230ms | main-gc 340ms/34 major 120ms/2 max 80ms` (DETAIL_RE-safe). */
export function formatLoopSummary(loop: LoopStats | null, gc: GcStats | null): string {
    const parts: string[] = [];
    if (loop) parts.push(`main-loop p50 ${Math.round(loop.p50Ms)}ms p99 ${Math.round(loop.p99Ms)}ms max ${Math.round(loop.maxMs)}ms`);
    if (gc) parts.push(`main-gc ${gc.ms}ms/${gc.count} major ${gc.majorMs}ms/${gc.majorCount} max ${gc.maxMs}ms`);
    return parts.join(' | ');
}

export interface MainLoopDiagnostics {
    /** Loop delay + GC since the previous call (both reset). */
    summary(): string;
    stop(): void;
}

export function startMainLoopDiagnostics(monitor: FreezeMonitor): MainLoopDiagnostics {
    let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
    try {
        histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
        histogram.enable();
    } catch { histogram = null; }

    let observer: PerformanceObserver | null = null;
    try {
        observer = new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
                const kind = gcKindOf((e as unknown as { detail?: { kind?: unknown } }).detail?.kind);
                if (kind) monitor.noteGc(performance.timeOrigin + e.startTime, e.duration, kind);
            }
        });
        observer.observe({ entryTypes: ['gc'] });
    } catch { observer = null; }

    return {
        summary(): string {
            let loop: LoopStats | null = null;
            if (histogram && histogram.count > 0) {
                // Nanoseconds; each sample includes the RESOLUTION_MS the timer was asked to wait.
                const ms = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS);
                loop = { p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) };
                histogram.reset();
            }
            return formatLoopSummary(loop, monitor.takeGcStats());
        },
        stop(): void {
            try { histogram?.disable(); } catch { /* ignore */ }
            try { observer?.disconnect(); } catch { /* ignore */ }
        },
    };
}
