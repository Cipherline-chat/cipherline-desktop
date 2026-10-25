/**
 * gpu-restart — main's half of "video stopped after a graphics driver reset".
 *
 * WHAT HAPPENS ON WINDOWS. Chromium's GPU process EXITS ON PURPOSE when its
 * D3D11 device is lost (driver reset / TDR, the device removed, a display or
 * adapter reconfiguration the driver does not survive). With ANGLE's
 * passthrough decoder — the Windows default — every real context loss forces
 * that exit (gpu/ipc/service/gpu_channel_manager.cc OnContextLost:
 * `force_restart = use_passthrough_cmd_decoder()` → MaybeExitOnContextLost),
 * and the exit code is 34:
 *   components/viz/service/gl/exit_code.h
 *     RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST = 34
 *   chrome/common/chrome_result_codes.h
 *     CHROME_RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST ("The GPU process was
 *     terminated due to context lost").
 * base/process/kill_win.cc maps any exit code that is not a kill / OOM /
 * integrity code to TERMINATION_STATUS_PROCESS_CRASHED, so Electron reports
 * it as `child-process-gone {type: 'GPU', reason: 'crashed', exitCode: 34}`
 * — exactly the prod record of 2026-10-11. The browser then launches a fresh
 * GPU process; after 3 such deaths inside the 5-minute forgiveness window
 * (content/browser/gpu/gpu_process_host.cc, GetFallbackCrashLimit) Chromium
 * falls back to software for the rest of the session.
 *
 * WHAT IT DOES TO A CALL. Hardware video decode and encode live in the GPU
 * process. The renderer's compositor recovers by itself, but a call's WebRTC
 * decoders / encoders and the camera capture path (D3D11 shared textures)
 * can be left dead or stuck — and H.265 has NO software fallback in Chromium's
 * WebRTC at all (decode or encode), while H.264 / VP8 fall back to software.
 *
 * THIS MODULE (no runtime `electron` import, nothing from src/ — the rootDir
 * trap in CLAUDE.md; unit tested in gpu-restart.test.ts):
 *   • gpuRestartFromChildGone — should this `child-process-gone` become a
 *     `gpu:process-restarted` signal to the renderer, and with what payload;
 *   • parseGpuRecoveryReport — strict validation of the renderer's answer
 *     (what it did about it) on `gpu:recovery-outcome`;
 *   • GpuRestartLedger — which pending crash record each signal belongs to,
 *     so that answer can mark it handled (see diagnostics.ts markHandled).
 *
 * NOTHING here decides whether the event is recorded as a crash — that stays
 * with the crash reporter, unchanged. A GPU restart is still recorded (it is
 * the evidence this whole feature was built from); what changes is that one
 * the renderer HANDLED (recovered, told the user, or no call to recover) is
 * marked seen, so the next launch's generic "Cipherline closed unexpectedly"
 * prompt does not ask about an app that never closed.
 */

import { crashFromChildGone, crashSignature, isOsSessionEndExit } from './diagnostics';

/** Chromium's GPU process exit code for "exited to recover from a lost context". */
export const GPU_EXIT_ON_CONTEXT_LOST = 34;

/** main → renderer: a GPU process died and Chromium is starting a new one. */
export const GPU_RESTARTED_CHANNEL = 'gpu:process-restarted';
/** renderer → main: what the renderer did about it. */
export const GPU_RECOVERY_OUTCOME_CHANNEL = 'gpu:recovery-outcome';

/**
 * Electron `reason`s for a GPU death that left something to recover.
 * Not 'clean-exit' (an orderly shutdown) and not 'memory-eviction' (Android).
 * 'killed' IS included: a GPU process killed from outside (Task Manager, a
 * driver-update installer) leaves the same dead decoders behind.
 */
export const GPU_GONE_REASONS = ['crashed', 'abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure'] as const;
export type GpuGoneReason = (typeof GPU_GONE_REASONS)[number];

export interface GpuRestartedPayload {
    v: 1;
    /** 1, 2, 3… — GPU restarts this app session (Chromium gives up on hardware after 3 in 5 min). */
    seq: number;
    reason: GpuGoneReason;
    /** Electron's exitCode; null when it was not a finite number. */
    exit_code: number | null;
    /** exit_code === 34: Chromium exited the GPU process to recover from a lost D3D device. */
    ctx_lost: boolean;
}

/** Upper bound for `seq` on the wire (a session never gets near it). */
export const MAX_GPU_RESTART_SEQ = 1_000_000;

/**
 * `child-process-gone` → the renderer signal, or null when it is not one.
 * `quitting`: a quit was asked for — teardown kills the GPU process too, and
 * that is the app closing, not something to recover.
 */
export function gpuRestartFromChildGone(details: unknown, seq: number, quitting: boolean): GpuRestartedPayload | null {
    if (quitting) return null;
    // Windows is logging the user off / shutting down: the GPU process went with it.
    if (isOsSessionEndExit(details)) return null;
    const d = (details ?? {}) as { type?: unknown; reason?: unknown; exitCode?: unknown };
    if (d.type !== 'GPU') return null;
    if (typeof d.reason !== 'string' || !(GPU_GONE_REASONS as readonly string[]).includes(d.reason)) return null;
    if (!Number.isInteger(seq) || seq < 1 || seq > MAX_GPU_RESTART_SEQ) return null;
    const exit = typeof d.exitCode === 'number' && Number.isFinite(d.exitCode) ? Math.trunc(d.exitCode) : null;
    return {
        v: 1,
        seq,
        reason: d.reason as GpuGoneReason,
        exit_code: exit,
        ctx_lost: exit === GPU_EXIT_ON_CONTEXT_LOST,
    };
}

/**
 * What the renderer did about a GPU restart.
 *   recovered        — in a call; video confirmed flowing again after the steps;
 *   restart_prompted — in a call; video still frozen after every step, the
 *                      user was shown "Restart Cipherline to fix";
 *   not_in_call      — no call: nothing of ours to recover (Chromium restores
 *                      the compositor by itself).
 */
export const GPU_RECOVERY_OUTCOMES = ['recovered', 'restart_prompted', 'not_in_call'] as const;
export type GpuRecoveryOutcome = (typeof GPU_RECOVERY_OUTCOMES)[number];

export interface GpuRecoveryReport { seq: number; outcome: GpuRecoveryOutcome }

/**
 * Strict: a plain object with exactly `seq` (integer 1..MAX) and `outcome`
 * (one of the enum). Anything else → null (the handler then rejects).
 */
export function parseGpuRecoveryReport(v: unknown): GpuRecoveryReport | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return null;
    const keys = Object.keys(v);
    if (keys.length !== 2 || !keys.includes('seq') || !keys.includes('outcome')) return null;
    const { seq, outcome } = v as { seq: unknown; outcome: unknown };
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > MAX_GPU_RESTART_SEQ) return null;
    if (typeof outcome !== 'string' || !(GPU_RECOVERY_OUTCOMES as readonly string[]).includes(outcome)) return null;
    return { seq, outcome: outcome as GpuRecoveryOutcome };
}

/**
 * The signature of the pending crash record the crash reporter made (or will
 * make) for this `child-process-gone` — the same builder, so the renderer's
 * answer can find it. null when the reporter does not record it. Lives here,
 * not in main.ts, so main never builds a crash record outside recordCrash
 * (session-lifecycle.wiring.test.ts on claude/quit-not-crash).
 */
export function gpuCrashSignature(details: unknown, now: number, appVersion: string): string | null {
    const rec = crashFromChildGone(details, now, appVersion);
    return rec ? crashSignature(rec) : null;
}

/**
 * seq → the signature of the pending crash record that GPU death produced
 * (null when the crash reporter did not record it). One answer per seq: a
 * second report for the same seq, or one for a seq never issued, resolves to
 * nothing. Bounded — only the newest few are kept.
 */
export class GpuRestartLedger {
    private seq = 0;
    private readonly open = new Map<number, string | null>();
    private static readonly KEEP = 8;

    /** Restarts signalled so far this session. */
    get count(): number { return this.seq; }

    /** Reserve the next seq (call before building the payload). */
    next(): number { return this.seq + 1; }

    /** The payload for `seq` was sent; remember which record it belongs to. */
    issued(seq: number, signature: string | null): void {
        if (seq !== this.seq + 1) return;
        this.seq = seq;
        this.open.set(seq, signature);
        while (this.open.size > GpuRestartLedger.KEEP) this.open.delete(this.open.keys().next().value as number);
    }

    /** The renderer answered for `seq`: the record's signature, once. */
    resolve(seq: number): string | null {
        if (!this.open.has(seq)) return null;
        const sig = this.open.get(seq) ?? null;
        this.open.delete(seq);
        return sig;
    }
}
