/**
 * The screen-share half of "Prioritize calls and screen share while gaming".
 *
 * ONE setting (Settings -> Voice & Video -> While gaming), ON by default,
 * stored as `gamingVideo` in <userData>/startup-flags.json
 * (./startup-flags.ts) because part of it is Chromium command-line switches,
 * read only at launch. It drives all of: the launch switches (below), the
 * in-call priority boost and camera preference (./gaming-video-mode.ts), and
 * the screen-share boost in this file. An earlier draft gave screen share its
 * own separate toggle; the owner already had the call toggle on and
 * expected it to cover sharing, so there is one.
 *
 * ── The report (owner, 2026-10-13, Windows + NVIDIA) ───────────────────────
 * "While in a game, screensharing, my frame rate was like 1 fps. When I
 * clicked into Cipherline it went to 50-60 fps." A share that recovers the
 * moment Cipherline is focused is a background-scheduling problem, not an
 * encoder one. Three independent layers can slow a window that a fullscreen
 * game covers; this file owns the launch/OS-level ones:
 *
 *   1. Chromium backgrounding (launch switches, applied when the setting is
 *      ON): --disable-renderer-backgrounding,
 *      --disable-backgrounding-occluded-windows,
 *      --disable-background-timer-throttling, and the Windows features
 *        CalculateNativeWinOcclusion   (Chromium's own "is my window covered"
 *                                       tracker, which marks a covered window
 *                                       hidden and lowers its renderer's
 *                                       priority)
 *        UseEcoQoSForBackgroundProcess (Chromium's Windows 11 "efficiency
 *                                       mode": a backgrounded process is put
 *                                       on EcoQoS - slowest cores, lowest
 *                                       clocks. NOT VERIFIED - see below.)
 *      The windows themselves already run with `backgroundThrottling: false`.
 *
 *   2. Scheduling (runtime, Windows): while a share is live, every Cipherline
 *      process goes to ABOVE_NORMAL and the GPU and main processes to HIGH, via
 *      CallPriorityBooster (./gaming-video-mode.ts). A game that saturates the
 *      CPU/GPU otherwise runs ahead of the browser process (which owns the
 *      desktop capture thread), the GPU process (readback + the hardware
 *      encoder) and the renderer (RTP pacing). Restored to each process's own
 *      previous priority when the share ends, when the setting is turned off,
 *      and at quit. The owner explicitly accepts the cost to game
 *      performance; that is what the setting says on its face.
 *
 *   3. Power (runtime, every platform): a `prevent-app-suspension`
 *      powerSaveBlocker while a share is live, released after. On Windows that
 *      is a PowerRequestExecutionRequired request, which tells the OS not to
 *      throttle or suspend the process; on macOS it holds off App Nap.
 *
 *   4. OS power throttling (runtime, Windows): the same Windows 11 policy that
 *      Chromium's feature flag does NOT cover. Windows puts a process whose
 *      windows are not foreground/visible on EcoQoS ("execution speed"
 *      throttling) and coalesces its timers; a game in front makes Cipherline
 *      exactly that process, and the browser process owns the desktop capture
 *      thread. While a share is live (setting ON) this opts the main process,
 *      the GPU process and the renderer(s) OUT of both
 *      (SetProcessInformation / ProcessPowerThrottling, in the native addon,
 *      share_power.cc), re-applies when a process id appears (a GPU restart,
 *      a renderer reload), and hands every process back to the OS - and ends
 *      the timeBeginPeriod(1) held for the capture pacing timers - the moment
 *      the share ends, the setting goes off, or the app quits. See
 *      PowerThrottleOptOut below; every apply / restore is reported (the
 *      renderer logs it as the `share_power` call event).
 *
 *   5. GPU scheduling priority (runtime, Windows): the WDDM scheduler's
 *      per-process class, which Windows raises for the FOREGROUND process. A
 *      game that saturates the GPU is boosted over Cipherline, and the browser
 *      process's desktop-duplication copy / the GPU process's encode wait
 *      behind the game's work (owner report on 1.0.22-staging.163: Cyberpunk
 *      in front, src_fps 8-17, grab 25 ms; Cipherline in front, 90 fps; the
 *      power-throttling opt-out in 4 was applied and did not change it). OBS
 *      solves exactly this with D3DKMTSetProcessSchedulingPriorityClass. See
 *      GpuSchedulingBoost below: REALTIME (needs SeIncreaseBasePriorityPrivilege,
 *      i.e. an elevated process) with a fallback to HIGH, for the main process
 *      and the GPU process, read back to confirm, NORMAL on restore. Reported
 *      as the `share_gpu_sched` call event.
 *
 * ── Other platforms (./share-platform.ts is the table) ────────────────────
 * The setting shows everywhere and does what the OS allows. Layer 1's three
 * backgrounding switches and layer 3's power request apply on Linux and macOS
 * too (macOS: the request is an IOPMAssertion NoIdleSleep, which also keeps
 * App Nap off the process; Linux: a D-Bus suspend inhibit). Layers 2, 4 and 5 and
 * the occlusion feature are Windows-only: off Windows nothing here ever
 * touches a process priority (raising needs CAP_SYS_NICE; lowering would be a
 * regression), and the GPU scheduling priority is not reachable from outside
 * Chromium's GPU process on Linux (EGL_IMG_context_priority /
 * VK_EXT_global_priority are picked inside it, HIGH needs CAP_SYS_NICE).
 *
 * What could NOT be verified from the dev box (a Linux machine with no
 * Windows Electron binary): the exact feature name `UseEcoQoSForBackgroundProcess`
 * in Chromium 150. The name is from Chromium's base/features.cc as of the
 * versions this was written against; an unknown name in --disable-features is
 * silently ignored by Chromium, so a wrong name costs nothing - the priority
 * boost (2) and --disable-renderer-backgrounding (1, which stops Chromium
 * from putting a renderer in the "background" class that EcoQoS is tied to)
 * work regardless.
 *
 * Deliberately free of any `electron` import so every decision here is unit
 * testable (share-boost.test.ts); main.ts supplies powerSaveBlocker.
 */

import {
    gamingVideoStartupSwitches, type GamingVideoStartupSwitches, type CallPriorityBooster,
} from './gaming-video-mode';
import { shareBoostSupport } from './share-platform';

/** Windows-only Chromium features the share boost disables. Merged into main's ONE disable-features list. */
export const SHARE_BOOST_DISABLED_FEATURES_WIN: readonly string[] = Object.freeze([
    'UseEcoQoSForBackgroundProcess',
]);

/**
 * The launch-time Chromium switches for "do not throttle me when a game covers
 * me": the three backgrounding switches, native occlusion tracking off, and
 * (Windows) the EcoQoS feature off. `disableFeatures` is MERGED into the single
 * list main builds, never appended as its own switch.
 */
export function launchThrottleSwitches(
    enabled: boolean,
    platform: string,
): GamingVideoStartupSwitches {
    const base = gamingVideoStartupSwitches(enabled, platform);
    const extra = enabled && shareBoostSupport(platform).powerThrottleOptOut ? SHARE_BOOST_DISABLED_FEATURES_WIN : [];
    return {
        switches: base.switches,
        disableFeatures: [...new Set([...base.disableFeatures, ...extra])],
    };
}

/**
 * The renderer's "a screen share is (not) live" push (`share:set-active`).
 * A trust boundary: anything but a real boolean is rejected, never coerced.
 */
export function validateShareActive(input: unknown): boolean {
    if (typeof input !== 'boolean') throw new Error('share:set-active: expected a boolean');
    return input;
}

/** The slice of Electron's powerSaveBlocker this needs. */
export interface PowerBlockerApi {
    start(type: 'prevent-app-suspension'): number;
    stop(id: number): void;
    isStarted(id: number): boolean;
}

/**
 * THE one switch: the "Prioritize calls and screen share while gaming" setting
 * (`gamingVideo`) turning on or off drives BOTH the call-time boost (the
 * booster's call path) and the screen-share boost (the controller). main's
 * `syncCallPriority` calls this for every change of the setting - at launch
 * and on every save - so the two can never disagree.
 */
export function applyGamingSetting(on: boolean, booster: CallPriorityBooster, share: ShareBoostController): void {
    booster.setEnabled(on);
    share.setEnabled(on);
}

// ── OS power throttling opt-out (layer 4) ───────────────────────────────────

/** What the addon's setProcessPowerThrottling answers (validated before use). */
export interface PowerThrottleResult { ok: boolean; error: number; mask: number }

/** The addon exports this needs; each may be missing on an older build. */
export interface PowerNativeApi {
    setProcessPowerThrottling?(pid: number, enabled: boolean): unknown;
    setTimerResolution?(ms: number, on: boolean): unknown;
}

/** Error codes the per-process results use besides GetLastError() values (> 0). */
export const POWER_ERR_NOT_PRESENT = -1;   // no such process in the list (e.g. no GPU process yet)
export const POWER_ERR_UNAVAILABLE = -2;   // the addon lacks the export, or it threw / answered nonsense

/** Electron process types whose throttling is lifted: main, GPU (encode), renderers (RTP pacing). */
export const POWER_THROTTLE_TYPES: readonly string[] = Object.freeze(['Browser', 'GPU', 'Tab']);

/** The timer resolution held while sharing, in ms. */
export const SHARE_TIMER_RESOLUTION_MS = 1;

export type SharePowerPhase = 'apply' | 'reapply' | 'restore';

/**
 * One `share_power` report. Error fields: 0 = ok, > 0 = GetLastError(),
 * POWER_ERR_* otherwise. `mask` = the ControlMask the OS accepted for the
 * first successful process (5 = execution speed + timer resolution, 1 = the
 * older-Windows subset, 0 = none / a restore). `timer` = timeBeginPeriod(1)
 * (apply) or timeEndPeriod(1) (restore) succeeded.
 */
export interface SharePowerReport {
    phase: SharePowerPhase;
    /** Processes handled in THIS pass. */
    procs: number;
    ok: number;
    failed: number;
    mainErr: number;
    gpuErr: number;
    rendererErr: number;
    mask: number;
    timer: boolean;
}

export interface PowerThrottleDeps {
    platform: string;
    /** The loaded addon, or null before it loads / when it failed to. Read on every use. */
    native(): PowerNativeApi | null;
    /** app.getAppMetrics() pid + type. */
    listProcesses(): Array<{ pid: number; type?: string }>;
    /** process.pid - the main process, always included. */
    selfPid: number;
    report?(r: SharePowerReport): void;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Validate what crossed the native boundary; anything off-shape is "unavailable". */
export function cleanPowerResult(raw: unknown): PowerThrottleResult {
    if (!raw || typeof raw !== 'object') return { ok: false, error: POWER_ERR_UNAVAILABLE, mask: 0 };
    const r = raw as Record<string, unknown>;
    if (typeof r.ok !== 'boolean') return { ok: false, error: POWER_ERR_UNAVAILABLE, mask: 0 };
    return {
        ok: r.ok,
        error: r.ok ? 0 : (isInt(r.error) && r.error !== 0 ? r.error : POWER_ERR_UNAVAILABLE),
        mask: r.ok && isInt(r.mask) ? r.mask : 0,
    };
}

/**
 * Opts Cipherline's processes out of Windows power throttling while active,
 * and gives every one back when it ends. The caller (ShareBoostController)
 * sets `active` = (setting ON) AND (a share live).
 *
 *   setActive(true)   opt out every wanted process; begin timer resolution 1 ms
 *   tick()            while active: opt out processes that appeared since
 *                     (a restarted GPU process, a reloaded renderer); forget the
 *                     ones that left. A process that FAILED is not retried
 *                     (it would only repeat the same error every few seconds).
 *   setActive(false)  hand each opted-out process back to the OS
 *                     (ControlMask 0), end the timer resolution - exactly once,
 *                     and only if it was begun - and clear.
 *
 * Windows only; anywhere else every method does nothing and never reports.
 */
export class PowerThrottleOptOut {
    private on = false;
    private readonly optedOut = new Map<number, string>();   // pid -> type
    private readonly tried = new Set<number>();               // pids already attempted (ok or not)
    private timerHeld = false;

    constructor(private readonly deps: PowerThrottleDeps) {}

    /** True while the opt-out is in force. */
    get active(): boolean { return this.on; }

    /** pids currently opted out by us (tests / diagnostics). */
    optedOutPids(): number[] { return [...this.optedOut.keys()]; }

    /** True while a timeBeginPeriod is held. */
    get timerResolutionHeld(): boolean { return this.timerHeld; }

    setActive(on: boolean): void {
        if (!shareBoostSupport(this.deps.platform).powerThrottleOptOut) return;
        if (on === this.on) return;
        this.on = on;
        if (on) this.apply('apply');
        else this.restore();
    }

    tick(): void {
        if (!this.on) return;
        this.apply('reapply');
    }

    private wanted(): Array<{ pid: number; type: string }> {
        let procs: Array<{ pid: number; type?: string }> = [];
        try { procs = this.deps.listProcesses(); } catch { procs = []; }
        const out = new Map<number, string>();
        for (const p of procs) {
            if (!isInt(p.pid) || p.pid <= 0) continue;
            if (p.pid === this.deps.selfPid) { out.set(p.pid, 'Browser'); continue; }
            if (p.type && POWER_THROTTLE_TYPES.includes(p.type)) out.set(p.pid, p.type);
        }
        // The main process is always handled, even if the metrics list lost it.
        if (!out.has(this.deps.selfPid)) out.set(this.deps.selfPid, 'Browser');
        return [...out].map(([pid, type]) => ({ pid, type }));
    }

    private call(pid: number, enabled: boolean): PowerThrottleResult {
        const native = this.deps.native();
        const fn = native?.setProcessPowerThrottling;
        if (typeof fn !== 'function') return { ok: false, error: POWER_ERR_UNAVAILABLE, mask: 0 };
        try { return cleanPowerResult(fn.call(native, pid, enabled)); }
        catch { return { ok: false, error: POWER_ERR_UNAVAILABLE, mask: 0 }; }
    }

    private timer(on: boolean): boolean {
        const native = this.deps.native();
        const fn = native?.setTimerResolution;
        if (typeof fn !== 'function') return false;
        try { return fn.call(native, SHARE_TIMER_RESOLUTION_MS, on) === true; } catch { return false; }
    }

    private apply(phase: 'apply' | 'reapply'): void {
        const wanted = this.wanted();
        const live = new Set(wanted.map(w => w.pid));
        // A process that exited needs no restore; forget it so a recycled pid is treated as new.
        for (const pid of [...this.optedOut.keys()]) if (!live.has(pid)) this.optedOut.delete(pid);
        for (const pid of [...this.tried]) if (!live.has(pid)) this.tried.delete(pid);

        if (!this.timerHeld) this.timerHeld = this.timer(true);

        const fresh = wanted.filter(w => !this.tried.has(w.pid));
        let ok = 0, failed = 0, mask = 0;
        let mainErr = POWER_ERR_NOT_PRESENT, gpuErr = POWER_ERR_NOT_PRESENT, rendererErr = POWER_ERR_NOT_PRESENT;
        for (const { pid, type } of fresh) {
            this.tried.add(pid);
            const r = this.call(pid, false);
            if (r.ok) { ok++; this.optedOut.set(pid, type); if (mask === 0) mask = r.mask; } else failed++;
            if (pid === this.deps.selfPid) mainErr = r.error;
            else if (type === 'GPU') gpuErr = r.error;
            else if (type === 'Tab') rendererErr = worseError(rendererErr, r.error);
        }
        // A re-apply that found nothing new has nothing to say.
        if (phase === 'reapply' && fresh.length === 0) return;
        this.deps.report?.({ phase, procs: fresh.length, ok, failed, mainErr, gpuErr, rendererErr, mask, timer: this.timerHeld });
    }

    private restore(): void {
        let ok = 0, failed = 0;
        let mainErr = POWER_ERR_NOT_PRESENT, gpuErr = POWER_ERR_NOT_PRESENT, rendererErr = POWER_ERR_NOT_PRESENT;
        const had = this.optedOut.size;
        for (const [pid, type] of this.optedOut) {
            // Hand back to the OS (ControlMask 0). A process that has exited just fails - nothing to undo.
            const r = this.call(pid, true);
            if (r.ok) ok++; else failed++;
            if (pid === this.deps.selfPid) mainErr = r.error;
            else if (type === 'GPU') gpuErr = r.error;
            else if (type === 'Tab') rendererErr = worseError(rendererErr, r.error);
        }
        // Pair every successful begin with exactly one end.
        let timerOk = false;
        if (this.timerHeld) { timerOk = this.timer(false); this.timerHeld = false; }
        this.optedOut.clear();
        this.tried.clear();
        if (had === 0 && !timerOk) return;
        this.deps.report?.({ phase: 'restore', procs: had, ok, failed, mainErr, gpuErr, rendererErr, mask: 0, timer: timerOk });
    }
}

/** Several renderers share one field: keep the first failure, else 0, else "not present". */
function worseError(current: number, next: number): number {
    if (current === POWER_ERR_NOT_PRESENT) return next;
    if (current !== 0) return current;
    return next;
}

// ── GPU scheduling priority class (layer 5) ─────────────────────────────────

/** D3DKMT_SCHEDULINGPRIORITYCLASS. */
export const GPU_SCHED_IDLE = 0;
export const GPU_SCHED_BELOW_NORMAL = 1;
export const GPU_SCHED_NORMAL = 2;
export const GPU_SCHED_ABOVE_NORMAL = 3;
export const GPU_SCHED_HIGH = 4;
export const GPU_SCHED_REALTIME = 5;

export const GPU_SCHED_NAMES: readonly string[] = Object.freeze([
    'idle', 'below_normal', 'normal', 'above_normal', 'high', 'realtime',
]);

/** What the addon's setGpuSchedulingPriority answers (validated before use). */
export interface GpuSchedSetResult { ok: boolean; status: number; error: number }
/** ...and getGpuSchedulingPriority; level -1 = unreadable. */
export interface GpuSchedGetResult extends GpuSchedSetResult { level: number }

/** The addon exports this needs; each may be missing on an older build. */
export interface GpuSchedNativeApi {
    setGpuSchedulingPriority?(pid: number, level: number): unknown;
    getGpuSchedulingPriority?(pid: number): unknown;
}

/** Our own error code for "the addon lacks the export, or it threw / answered nonsense". */
export const GPU_SCHED_ERR_UNAVAILABLE = -2;

const isInt32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;

/** Validate what crossed the native boundary; anything off-shape is "unavailable". */
export function cleanGpuSchedResult(raw: unknown): GpuSchedSetResult {
    if (!raw || typeof raw !== 'object') return { ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE };
    const r = raw as Record<string, unknown>;
    if (typeof r.ok !== 'boolean' || !isInt32(r.status) || !isInt32(r.error)) {
        return { ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE };
    }
    return { ok: r.ok, status: r.status, error: r.error };
}

export function cleanGpuSchedRead(raw: unknown): GpuSchedGetResult {
    const base = cleanGpuSchedResult(raw);
    const level = (raw as Record<string, unknown> | null)?.level;
    if (!base.ok || typeof level !== 'number' || !Number.isInteger(level) || level < GPU_SCHED_IDLE || level > GPU_SCHED_REALTIME) {
        return { ...base, ok: false, level: -1 };
    }
    return { ...base, level };
}

/**
 * One result as a short string for the event log: "0" = accepted; "0x<hex>" =
 * the NTSTATUS the kernel returned (0xc0000061 = STATUS_PRIVILEGE_NOT_HELD,
 * i.e. REALTIME without admin; 0xc0000022 access denied); "err<N>" = the call
 * was never made (Win32 error from OpenProcess, 87 bad argument, 120 export
 * missing, 536870913 = not our process); "na" = no addon / not attempted.
 */
export function formatGpuSchedStatus(r: GpuSchedSetResult | null): string {
    if (!r) return 'na';
    if (r.error === GPU_SCHED_ERR_UNAVAILABLE) return 'na';
    if (r.error !== 0) return `err${r.error}`;
    if (r.status === 0) return '0';
    return `0x${(r.status >>> 0).toString(16)}`;
}

/** The label for a level read back from the OS. */
export const gpuSchedName = (level: number): string => GPU_SCHED_NAMES[level] ?? 'unknown';

export type GpuSchedPhase = 'apply' | 'reapply' | 'restore';

/**
 * What happened to one process. level: the class READ BACK from the OS
 * (idle .. realtime), 'unread' (set, but the read-back failed), 'none' (every
 * attempt was refused), 'absent' (no such process listed, e.g. no GPU process
 * yet). rt: status of the REALTIME attempt ('na' when none was made - a
 * restore). status: of the last attempt (HIGH after a fallback, NORMAL on a
 * restore); equals rt when REALTIME was accepted.
 */
export interface GpuSchedProcReport { level: string; rt: string; status: string }

export interface GpuSchedReport {
    phase: GpuSchedPhase;
    /** Processes handled in THIS pass. */
    procs: number;
    main: GpuSchedProcReport;
    gpu: GpuSchedProcReport;
}

export interface GpuSchedDeps {
    platform: string;
    /** The loaded addon, or null before it loads / when it failed to. Read on every use. */
    native(): GpuSchedNativeApi | null;
    /** app.getAppMetrics() pid + type. */
    listProcesses(): Array<{ pid: number; type?: string }>;
    /** process.pid - the main process, where capture runs. */
    selfPid: number;
    report?(r: GpuSchedReport): void;
}

type GpuSlot = 'main' | 'gpu';
const ABSENT: GpuSchedProcReport = Object.freeze({ level: 'absent', rt: 'na', status: 'na' });

/**
 * Raises the WDDM GPU scheduling class of the main process (desktop capture)
 * and the GPU process (encode) while active, and puts both back to NORMAL
 * when it ends. The caller (ShareBoostController) sets `active` = (setting ON)
 * AND (a share live).
 *
 *   setActive(true)   per wanted process: REALTIME; if the OS refuses (it needs
 *                     SeIncreaseBasePriorityPrivilege, i.e. "Run as
 *                     administrator"), HIGH. The class is READ BACK to confirm.
 *   tick()            while active: handle a process that appeared since (a
 *                     restarted GPU process); forget ones that left. A process
 *                     where every attempt failed is not retried.
 *   setActive(false)  NORMAL on every process we raised, read back; clear.
 *
 * Windows only; anywhere else every method does nothing and never reports.
 */
export class GpuSchedulingBoost {
    private on = false;
    private readonly held = new Map<number, { slot: GpuSlot; level: number }>();
    private readonly tried = new Map<number, GpuSlot>();         // pid -> slot, attempted (ok or not)
    private readonly slots = new Map<GpuSlot, GpuSchedProcReport>();

    constructor(private readonly deps: GpuSchedDeps) {}

    get active(): boolean { return this.on; }

    /** pids currently raised by us (tests / diagnostics). */
    heldPids(): number[] { return [...this.held.keys()]; }

    setActive(on: boolean): void {
        if (!shareBoostSupport(this.deps.platform).gpuPriority) return;
        if (on === this.on) return;
        this.on = on;
        if (on) this.apply('apply');
        else this.restore();
    }

    tick(): void {
        if (!this.on) return;
        this.apply('reapply');
    }

    private wanted(): Array<{ pid: number; slot: GpuSlot }> {
        let procs: Array<{ pid: number; type?: string }> = [];
        try { procs = this.deps.listProcesses(); } catch { procs = []; }
        const out = new Map<number, GpuSlot>();
        out.set(this.deps.selfPid, 'main');
        let haveGpu = false;
        for (const p of procs) {
            if (!isInt(p.pid) || p.pid <= 0 || p.pid === this.deps.selfPid) continue;
            // One GPU process is expected; if there are ever two, the first stands for the report.
            if (p.type === 'GPU' && !haveGpu) { out.set(p.pid, 'gpu'); haveGpu = true; }
        }
        return [...out].map(([pid, slot]) => ({ pid, slot }));
    }

    private set(pid: number, level: number): GpuSchedSetResult {
        const native = this.deps.native();
        const fn = native?.setGpuSchedulingPriority;
        if (typeof fn !== 'function') return { ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE };
        try { return cleanGpuSchedResult(fn.call(native, pid, level)); }
        catch { return { ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE }; }
    }

    private get(pid: number): GpuSchedGetResult {
        const native = this.deps.native();
        const fn = native?.getGpuSchedulingPriority;
        if (typeof fn !== 'function') return { ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE, level: -1 };
        try { return cleanGpuSchedRead(fn.call(native, pid)); }
        catch { return { ok: false, status: 0, error: GPU_SCHED_ERR_UNAVAILABLE, level: -1 }; }
    }

    private apply(phase: 'apply' | 'reapply'): void {
        const wanted = this.wanted();
        const live = new Set(wanted.map(w => w.pid));
        // A process that exited needs no restore; forget it so a recycled pid (or a new GPU process) is treated as new.
        for (const [pid, h] of [...this.held]) if (!live.has(pid)) { this.held.delete(pid); this.slots.delete(h.slot); }
        for (const [pid, slot] of [...this.tried]) if (!live.has(pid)) { this.tried.delete(pid); this.slots.delete(slot); }

        const fresh = wanted.filter(w => !this.tried.has(w.pid));
        for (const { pid, slot } of fresh) {
            this.tried.set(pid, slot);
            const rt = this.set(pid, GPU_SCHED_REALTIME);
            let last = rt;
            if (!rt.ok) last = this.set(pid, GPU_SCHED_HIGH);
            if (!last.ok) {
                this.slots.set(slot, { level: 'none', rt: formatGpuSchedStatus(rt), status: formatGpuSchedStatus(last) });
                continue;
            }
            const rb = this.get(pid);
            this.held.set(pid, { slot, level: rb.ok ? rb.level : (rt.ok ? GPU_SCHED_REALTIME : GPU_SCHED_HIGH) });
            this.slots.set(slot, {
                level: rb.ok ? gpuSchedName(rb.level) : 'unread',
                rt: formatGpuSchedStatus(rt),
                status: formatGpuSchedStatus(last),
            });
        }
        // A re-apply that found nothing new has nothing to say.
        if (phase === 'reapply' && fresh.length === 0) return;
        this.deps.report?.({
            phase, procs: fresh.length,
            main: this.slots.get('main') ?? ABSENT, gpu: this.slots.get('gpu') ?? ABSENT,
        });
    }

    private restore(): void {
        const had = this.held.size;
        const slots = new Map<GpuSlot, GpuSchedProcReport>();
        for (const [pid, h] of this.held) {
            // A process that has exited just fails - nothing to undo.
            const r = this.set(pid, GPU_SCHED_NORMAL);
            const rb = r.ok ? this.get(pid) : null;
            slots.set(h.slot, {
                level: rb ? (rb.ok ? gpuSchedName(rb.level) : 'unread') : 'none',
                rt: 'na',
                status: formatGpuSchedStatus(r),
            });
        }
        this.held.clear();
        this.tried.clear();
        this.slots.clear();
        if (had === 0) return;
        this.deps.report?.({ phase: 'restore', procs: had, main: slots.get('main') ?? ABSENT, gpu: slots.get('gpu') ?? ABSENT });
    }
}

/**
 * Ties the screen-share boost's OS-level effects to one on/off pair:
 * (setting ON) AND (a share live) -> priority boost + power request + power
 * throttling opt-out and 1 ms timer resolution + GPU scheduling class. Either
 * input changing re-evaluates both, so nothing can be left held: the blocker
 * is released and the priorities restored the moment either side goes false.
 */
export class ShareBoostController {
    private enabled = false;
    private sharing = false;
    private blockerId: number | null = null;

    constructor(
        private readonly booster: CallPriorityBooster,
        private readonly power: PowerBlockerApi,
        private readonly throttle?: PowerThrottleOptOut,
        private readonly gpuSched?: GpuSchedulingBoost,
    ) {}

    /** True while the power-throttling opt-out or the GPU priority class is held (main keeps a short re-apply timer for them). */
    get throttleActive(): boolean {
        return this.throttle?.active === true || this.gpuSched?.active === true;
    }

    /** Handle processes that appeared since the share started (opt-out + GPU scheduling class). */
    tickThrottle(): void {
        this.throttle?.tick();
        this.gpuSched?.tick();
    }

    /** True while the boost should be held. */
    get active(): boolean {
        return this.enabled && this.sharing;
    }

    /** True while a power request is held (tests / diagnostics). */
    get blockerHeld(): boolean {
        return this.blockerId !== null;
    }

    setEnabled(on: boolean): void {
        this.enabled = on;
        this.sync();
    }

    setSharing(on: boolean): void {
        this.sharing = on;
        this.sync();
    }

    private sync(): void {
        this.booster.setShareEnabled(this.enabled);
        this.booster.setSharing(this.sharing);
        this.throttle?.setActive(this.active);
        this.gpuSched?.setActive(this.active);
        if (this.active) {
            if (this.blockerId === null || !this.safeIsStarted(this.blockerId)) {
                try { this.blockerId = this.power.start('prevent-app-suspension'); } catch { this.blockerId = null; }
            }
        } else if (this.blockerId !== null) {
            try { this.power.stop(this.blockerId); } catch { /* already released */ }
            this.blockerId = null;
        }
    }

    private safeIsStarted(id: number): boolean {
        try { return this.power.isStarted(id); } catch { return false; }
    }
}
