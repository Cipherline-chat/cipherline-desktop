/**
 * The `share_power` call event: what the main process did about Windows power
 * throttling for the screen share (electron/share-boost.ts PowerThrottleOptOut),
 * pushed over `share:power` and logged by ShareBoostGuard.
 *
 * Reading it (owner test, game focused, then Send report):
 *   phase    apply (share went live) | reapply (a process appeared mid-share) | restore
 *   procs    processes handled in this pass;  ok_n / fail_n  how many accepted / refused
 *   main_err / gpu_err / ren_err
 *            0 = the OS accepted the opt-out; > 0 = Win32 GetLastError (5 = access
 *            denied, 87 = invalid parameter); -1 = no such process listed (no GPU
 *            process yet); -2 = the addon lacks the export (stale build: run
 *            `npm run rebuild-native`)
 *   mask     the ControlMask Windows took: 5 = execution-speed + timer-resolution
 *            throttling both lifted, 1 = only execution speed (older Windows), 0 = none
 *   timer    timeBeginPeriod(1) (apply) / timeEndPeriod(1) (restore) succeeded
 *
 * Counters and enums only; the call event log's allowlist enforces it.
 */

export interface SharePowerDetail {
    phase: 'apply' | 'reapply' | 'restore';
    procs: number;
    ok: number;
    failed: number;
    mainErr: number;
    gpuErr: number;
    rendererErr: number;
    mask: number;
    timer: boolean;
}

const PHASES: ReadonlySet<string> = new Set(['apply', 'reapply', 'restore']);
const int = (v: unknown, min: number, max: number): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** Narrow main's `share:power` payload; null = malformed (dropped, never logged half-way). */
export function parseSharePowerReport(raw: unknown): SharePowerDetail | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.phase !== 'string' || !PHASES.has(r.phase)) return null;
    const procs = int(r.procs, 0, 4096);
    const ok = int(r.ok, 0, 4096);
    const failed = int(r.failed, 0, 4096);
    // Win32 error codes fit int32; ours are small negatives or 0x20000001.
    const mainErr = int(r.mainErr, -16, 0x7fffffff);
    const gpuErr = int(r.gpuErr, -16, 0x7fffffff);
    const rendererErr = int(r.rendererErr, -16, 0x7fffffff);
    const mask = int(r.mask, 0, 0xff);
    if ([procs, ok, failed, mainErr, gpuErr, rendererErr, mask].some(v => v === null) || typeof r.timer !== 'boolean') return null;
    return {
        phase: r.phase as SharePowerDetail['phase'],
        procs: procs!, ok: ok!, failed: failed!,
        mainErr: mainErr!, gpuErr: gpuErr!, rendererErr: rendererErr!,
        mask: mask!, timer: r.timer,
    };
}
