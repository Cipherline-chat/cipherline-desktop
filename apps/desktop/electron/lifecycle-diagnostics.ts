/**
 * lifecycle-diagnostics — what the Performance log needs to explain a freeze
 * we cannot reproduce: the owner's "minimized window won't open / hangs" and
 * "first thing after waking the PC hangs" happen on Windows only.
 *
 * Wires, into the freeze monitor's EVENT and METRICS rings:
 *   • BrowserWindow show / hide / minimize / restore / focus / blur / moved,
 *     with how long the window had been hidden;
 *   • time from a restore/show to the renderer's next painted frame (a
 *     requestAnimationFrame round trip through the preload — the number that
 *     IS the "won't open" symptom);
 *   • webContents unresponsive → responsive with the hang's duration, and
 *     render-process-gone / child-process-gone with Electron's fixed reason
 *     codes;
 *   • per-process CPU% / memory (app.getAppMetrics) every 15 s while the
 *     window is visible, on every restore, and after any main stall ≥ 1 s;
 *   • GPU feature status, once.
 *
 * PRIVACY: everything recorded is a static label, an Electron enum value, a
 * process TYPE, or a number. No titles, URLs, ids, names or content — the
 * freeze monitor re-validates every string (LABEL_RE / DETAIL_RE) and drops
 * anything else. Nothing is written to disk.
 *
 * The electron objects are passed in (structurally typed) so this file has
 * no runtime `electron` import and is unit-testable.
 */
import type { FreezeMonitor } from './freeze-monitor';

export interface ProcessMetricLike {
    type: string;
    cpu: { percentCPUUsage: number };
    memory: { workingSetSize: number; privateBytes?: number };
}

/** Process types Electron reports; anything else is folded into 'Other'. */
const KNOWN_TYPES = new Set(['Browser', 'Tab', 'GPU', 'Utility', 'Zygote', 'Sandbox helper', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown']);

/**
 * "browser 1.2% 140MB | tab 8.0% 420MB | gpu 3.1% 210MB | utility(3) 0.4% 75MB"
 * — summed per process TYPE (never names or pids). workingSetSize is KB.
 */
export function summarizeAppMetrics(metrics: readonly ProcessMetricLike[]): string {
    const by = new Map<string, { n: number; cpu: number; kb: number }>();
    for (const m of metrics) {
        const type = KNOWN_TYPES.has(m.type) ? m.type : 'Other';
        const e = by.get(type) ?? { n: 0, cpu: 0, kb: 0 };
        e.n++;
        e.cpu += Number.isFinite(m.cpu?.percentCPUUsage) ? m.cpu.percentCPUUsage : 0;
        e.kb += Number.isFinite(m.memory?.workingSetSize) ? m.memory.workingSetSize : 0;
        by.set(type, e);
    }
    const order = ['Browser', 'Tab', 'GPU', 'Utility'];
    const keys = [...by.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    let totalKb = 0;
    const parts = keys.map(k => {
        const e = by.get(k)!;
        totalKb += e.kb;
        const label = k.toLowerCase().replace(/\s+/g, '-') + (e.n > 1 ? `(${e.n})` : '');
        return `${label} ${e.cpu.toFixed(1)}% ${Math.round(e.kb / 1024)}MB`;
    });
    return `${parts.join(' | ')} | total ${Math.round(totalKb / 1024)}MB`;
}

/** Structural slices of the Electron objects this module touches. */
export interface WindowLike {
    on(event: string, fn: (...a: unknown[]) => void): unknown;
    isMinimized(): boolean;
    isVisible(): boolean;
    isDestroyed(): boolean;
    webContents: {
        on(event: string, fn: (...a: unknown[]) => void): unknown;
        send(channel: string, ...args: unknown[]): void;
        isDestroyed(): boolean;
    };
}

export interface RestoredPayload {
    /** What the window was restored from. */
    from: 'minimized' | 'hidden';
    /** How long it had been minimized/hidden, ms (null if unknown). */
    hiddenMs: number | null;
    at: number;
}

export interface WindowDiagnosticsOptions {
    monitor: FreezeMonitor;
    now?: () => number;
    /** Snapshot app metrics into the log now (main.ts supplies it). */
    sampleMetrics: (why: string) => void;
    /** A restore/show coalesced into one notification (→ `window:restored`). */
    onRestored?: (p: RestoredPayload) => void;
    /** Give up waiting for the post-restore frame after this long. */
    frameTimeoutMs?: number;
}

/** Collapse a restore and the show/focus that accompany it into one. */
export const RESTORE_COALESCE_MS = 500;

export function wireWindowDiagnostics(win: WindowLike, opts: WindowDiagnosticsOptions): {
    onFramePong: (id: number) => void;
    dispose: () => void;
} {
    const { monitor, sampleMetrics } = opts;
    const now = opts.now ?? (() => Date.now());
    const frameTimeoutMs = opts.frameTimeoutMs ?? 10_000;
    let hiddenSince: number | null = null;
    let hiddenKind: 'minimized' | 'hidden' | null = null;
    let lastRestoreAt = -Infinity;
    let pingSeq = 0;
    let pendingPing: { id: number; sentAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
    let unresponsiveAt: number | null = null;
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const pingFrame = (why: string) => {
        if (disposed || win.isDestroyed() || win.webContents.isDestroyed()) return;
        if (pendingPing) { clearTimeout(pendingPing.timer); pendingPing = null; }
        const id = ++pingSeq;
        const sentAt = now();
        const timer = setTimeout(() => {
            if (pendingPing?.id !== id) return;
            pendingPing = null;
            monitor.event('window:first-frame-timeout', now() - sentAt, why);
            sampleMetrics('frame-timeout');
        }, frameTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
        pendingPing = { id, sentAt, timer };
        try { win.webContents.send('perf:frame-ping', id); } catch { /* renderer gone */ }
    };

    const restored = (from: 'minimized' | 'hidden') => {
        const t = now();
        if (t - lastRestoreAt < RESTORE_COALESCE_MS) return;
        lastRestoreAt = t;
        const hiddenMs = hiddenSince !== null ? t - hiddenSince : null;
        const kind = hiddenKind ?? from;
        hiddenSince = null;
        hiddenKind = null;
        monitor.event(`window:restore`, hiddenMs ?? 0, `from=${kind}`);
        sampleMetrics('restore');
        pingFrame(`after-${kind}`);
        opts.onRestored?.({ from: kind, hiddenMs, at: t });
    };

    win.on('minimize', () => {
        hiddenSince = now(); hiddenKind = 'minimized';
        monitor.event('window:minimize');
    });
    win.on('hide', () => {
        if (hiddenSince === null) { hiddenSince = now(); hiddenKind = 'hidden'; }
        monitor.event('window:hide');
    });
    win.on('restore', () => restored('minimized'));
    win.on('show', () => {
        // 'show' after a hide (tray), or the very first show — only the former
        // is a restore.
        if (hiddenSince !== null) restored(hiddenKind ?? 'hidden');
        else monitor.event('window:show');
    });
    win.on('focus', () => monitor.event('window:focus'));
    win.on('blur', () => monitor.event('window:blur'));
    win.on('moved', () => {
        // One row per drag, not one per pixel.
        if (moveTimer) clearTimeout(moveTimer);
        moveTimer = setTimeout(() => { moveTimer = null; monitor.event('window:moved'); }, 1000);
        (moveTimer as { unref?: () => void }).unref?.();
    });

    win.webContents.on('unresponsive', () => {
        unresponsiveAt = now();
        monitor.event('renderer:unresponsive');
        sampleMetrics('unresponsive');
    });
    win.webContents.on('responsive', () => {
        const ms = unresponsiveAt !== null ? now() - unresponsiveAt : 0;
        unresponsiveAt = null;
        // Chromium only declares a renderer hung after ~15 s without an input
        // ack, so the true hang is this plus that detection delay.
        monitor.event('renderer:responsive', ms, 'hung for this long after detection');
    });
    win.webContents.on('render-process-gone', (_e: unknown, details: unknown) => {
        const d = (details ?? {}) as { reason?: unknown; exitCode?: unknown };
        const reason = typeof d.reason === 'string' ? d.reason : 'unknown';
        const code = typeof d.exitCode === 'number' ? d.exitCode : 0;
        monitor.event('renderer:gone', 0, `reason=${reason} exit=${code}`);
    });

    return {
        onFramePong: (id: number) => {
            if (!pendingPing || pendingPing.id !== id) return;
            clearTimeout(pendingPing.timer);
            const ms = now() - pendingPing.sentAt;
            pendingPing = null;
            monitor.event('window:first-frame', ms, 'restore to next painted frame');
        },
        dispose: () => {
            disposed = true;
            if (pendingPing) clearTimeout(pendingPing.timer);
            if (moveTimer) clearTimeout(moveTimer);
        },
    };
}

/** `child-process-gone`: process TYPE + Electron's fixed reason only. */
export function describeChildProcessGone(details: unknown): string {
    const d = (details ?? {}) as { type?: unknown; reason?: unknown; exitCode?: unknown };
    const type = typeof d.type === 'string' && /^[A-Za-z -]{1,40}$/.test(d.type) ? d.type : 'unknown';
    const reason = typeof d.reason === 'string' && /^[a-z-]{1,40}$/.test(d.reason) ? d.reason : 'unknown';
    const code = typeof d.exitCode === 'number' ? d.exitCode : 0;
    return `type=${type} reason=${reason} exit=${code}`;
}

/** app.getGPUFeatureStatus() → "gpu_compositing=enabled, rasterization=enabled, …". */
export function summarizeGpuFeatureStatus(status: unknown): string {
    if (!status || typeof status !== 'object') return 'unavailable';
    const wanted = ['gpu_compositing', 'rasterization', 'video_decode', 'video_encode', 'webgl', 'webgpu', 'skia_graphite'];
    const parts: string[] = [];
    for (const k of wanted) {
        const v = (status as Record<string, unknown>)[k];
        if (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v)) parts.push(`${k}=${v}`);
    }
    return parts.join(', ') || 'unavailable';
}
