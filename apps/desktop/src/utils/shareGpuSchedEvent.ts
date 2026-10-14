/**
 * The `share_gpu_sched` call event: what the main process did about the WDDM GPU
 * scheduling priority class for the screen share (electron/share-boost.ts
 * GpuSchedulingBoost), pushed over `share:gpu-sched` and logged by ShareBoostGuard.
 *
 * Why it exists: Windows boosts the GPU scheduling of the FOREGROUND process, so
 * a game that saturates the GPU starves the desktop-capture copy (main process)
 * and the encode (GPU process) while Cipherline is behind it. Raising our class
 * is what OBS does about the same thing.
 *
 * Reading it (owner test, game focused, then Send report; read it next to the
 * `share_fps` src_fps):
 *   phase               apply (share went live) | reapply (a process appeared mid-share) | restore
 *   procs               processes handled in this pass
 *   gpu_sched_main      the class READ BACK for the main process (capture):
 *   gpu_sched_gpu       ...and for the GPU process (encode). One of
 *                       realtime | high | ... | normal (restore), unread (set but
 *                       the read-back failed), none (every attempt refused),
 *                       absent (no such process listed yet)
 *   gpu_sched_*_rt      status of the REALTIME attempt. "0" = accepted;
 *                       "0xc0000061" = STATUS_PRIVILEGE_NOT_HELD: REALTIME needs
 *                       "Run as administrator", HIGH was used instead; "na" = not tried
 *   gpu_sched_*_st      status of the last attempt (HIGH after a fallback, NORMAL
 *                       on a restore). "0" = accepted; "err<N>" = never made
 *                       (5 access denied, 120 addon lacks the export: run
 *                       `npm run rebuild-native`)
 *
 * Enums, status codes and counts only; the call event log's allowlist enforces it.
 */

export interface ShareGpuSchedProc { level: string; rt: string; status: string }

export interface ShareGpuSchedDetail {
    phase: 'apply' | 'reapply' | 'restore';
    procs: number;
    main: ShareGpuSchedProc;
    gpu: ShareGpuSchedProc;
}

const PHASES: ReadonlySet<string> = new Set(['apply', 'reapply', 'restore']);
const LEVELS: ReadonlySet<string> = new Set([
    'idle', 'below_normal', 'normal', 'above_normal', 'high', 'realtime', 'unknown', 'unread', 'none', 'absent',
]);
const STATUS_RE = /^(?:0|na|0x[0-9a-f]{1,8}|err-?\d{1,10})$/;

function proc(raw: unknown): ShareGpuSchedProc | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.level !== 'string' || !LEVELS.has(p.level)) return null;
    if (typeof p.rt !== 'string' || !STATUS_RE.test(p.rt)) return null;
    if (typeof p.status !== 'string' || !STATUS_RE.test(p.status)) return null;
    return { level: p.level, rt: p.rt, status: p.status };
}

/** Narrow main's `share:gpu-sched` payload; null = malformed (dropped, never logged half-way). */
export function parseShareGpuSchedReport(raw: unknown): ShareGpuSchedDetail | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.phase !== 'string' || !PHASES.has(r.phase)) return null;
    if (typeof r.procs !== 'number' || !Number.isInteger(r.procs) || r.procs < 0 || r.procs > 4096) return null;
    const main = proc(r.main);
    const gpu = proc(r.gpu);
    if (!main || !gpu) return null;
    return { phase: r.phase as ShareGpuSchedDetail['phase'], procs: r.procs, main, gpu };
}

/** The call-event detail for a narrowed report (8 keys; the log allows 11). */
export function shareGpuSchedEventDetail(r: ShareGpuSchedDetail): Record<string, string | number> {
    return {
        phase: r.phase, procs: r.procs,
        gpu_sched_main: r.main.level, gpu_sched_gpu: r.gpu.level,
        gpu_sched_main_rt: r.main.rt, gpu_sched_gpu_rt: r.gpu.rt,
        gpu_sched_main_st: r.main.status, gpu_sched_gpu_st: r.gpu.status,
    };
}
