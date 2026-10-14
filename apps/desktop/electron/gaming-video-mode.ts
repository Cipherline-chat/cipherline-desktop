/**
 * "Prioritize calls and screen share while gaming" — the main-process half.
 *
 * Settings → Voice & Video, ON by default (it was call-only and OFF). Stored as `gamingVideo` in
 * <userData>/startup-flags.json (./startup-flags.ts) because part of it is a
 * set of Chromium command-line switches, which Chromium reads only at launch.
 *
 * What it changes, and why (the root-causing is in the commit that added this
 * file; the short version):
 *
 *   1. AT LAUNCH (needs a restart) — keep Chromium from treating the window as
 *      background when a fullscreen game covers it:
 *        --disable-features=CalculateNativeWinOcclusion   (Windows)
 *        --disable-renderer-backgrounding
 *        --disable-backgrounding-occluded-windows
 *        --disable-background-timer-throttling
 *      The main window already runs with `backgroundThrottling: false`, which
 *      covers most of this (the renderer is never told it is hidden — see
 *      src/utils/idleMotion.ts). These switches close the remaining
 *      occlusion/backgrounding paths at the Chromium level, for every window
 *      and process, rather than relying on that per-window flag alone.
 *
 *   2. AT RUNTIME (no restart) — while a call is active on Windows, raise every
 *      Cipherline process (browser, GPU, renderers, the video-capture and
 *      audio utility processes) to ABOVE_NORMAL priority. A foreground game
 *      saturating the CPU is otherwise scheduled ahead of the camera capture,
 *      the video encoder and decoder threads, and the GPU process's command
 *      submission, all of which run at NORMAL. Restored — to each process's
 *      own previous priority, never a guess — when the call ends, when the
 *      setting is turned off, and at quit. Never raised past ABOVE_NORMAL,
 *      never applied to a process that is already higher, and never "restored"
 *      over a value something else has since changed.
 *
 *   (3. The renderer half — the outgoing camera's degradation preference — is
 *       src/utils/gamingVideoMode.ts.)
 *
 * Deliberately free of any `electron` import so every decision here is unit
 * testable (gaming-video-mode.test.ts); main.ts supplies app.getAppMetrics()
 * and os.getPriority/setPriority.
 *
 * Which of these parts exist on which OS is ./share-platform.ts (one table).
 * Short version: the launch switches apply everywhere, the occlusion feature
 * and the priority boost are Windows-only, and off Windows this file NEVER
 * touches a process's priority — neither up (needs CAP_SYS_NICE) nor down.
 */

import { shareBoostSupport } from './share-platform';

/** Startup switches the mode adds. Values are empty: these are presence flags. */
export const GAMING_VIDEO_SWITCHES: readonly string[] = Object.freeze([
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows',
    'disable-background-timer-throttling',
]);

/** Windows-only Chromium feature the mode disables (native occlusion tracking). */
export const GAMING_VIDEO_DISABLED_FEATURE = 'CalculateNativeWinOcclusion';

export interface GamingVideoStartupSwitches {
    /** Plain `app.commandLine.appendSwitch(name)` switches. */
    switches: string[];
    /**
     * Entries to MERGE into the single `--disable-features` list main builds
     * (Chromium keeps only the last value of a repeated switch — see
     * buildChromiumMediaSwitches in ./capture-flags.ts). Never appended alone.
     */
    disableFeatures: string[];
}

export function gamingVideoStartupSwitches(enabled: boolean, platform: string): GamingVideoStartupSwitches {
    if (!enabled) return { switches: [], disableFeatures: [] };
    return {
        switches: [...GAMING_VIDEO_SWITCHES],
        disableFeatures: shareBoostSupport(platform).occlusionFeatureOff ? [GAMING_VIDEO_DISABLED_FEATURE] : [],
    };
}

/**
 * The renderer's "a call is (not) running" push (`call:set-media-active`).
 * A trust boundary: anything but a real boolean is rejected, never coerced.
 */
export function validateCallMediaActive(input: unknown): boolean {
    if (typeof input !== 'boolean') throw new Error('call:set-media-active: expected a boolean');
    return input;
}

/** Node's os.constants.priority values (identical on every platform). */
export const PRIORITY_NORMAL = 0;
export const PRIORITY_ABOVE_NORMAL = -7;
/** HIGH_PRIORITY_CLASS on Windows: no privilege needed (REALTIME is the one that needs it, and is never used). */
export const PRIORITY_HIGH = -14;

export interface PriorityBoosterDeps {
    platform: string;
    /** Every Cipherline process id right now (app.getAppMetrics()). */
    listPids(): number[];
    /**
     * Optional richer listing (app.getAppMetrics() pid + Electron process
     * `type`: 'Browser' | 'Tab' | 'GPU' | 'Utility' ...). When present it is
     * used instead of listPids, so the GPU process can be raised higher than
     * the rest while a screen share is live.
     */
    listProcesses?(): Array<{ pid: number; type?: string }>;
    /** os.getPriority — throws for a process that has exited. Lower = higher priority. */
    getPriority(pid: number): number;
    /** os.setPriority — throws when not permitted or the process has exited. */
    setPriority(pid: number, priority: number): void;
}

/**
 * Raises Cipherline's processes while a boost is wanted on Windows, and puts
 * each one back exactly as it found it otherwise. Two independent reasons to
 * boost, either of which is enough:
 *   - the "Prioritize call video while gaming" mode: setting on AND in a call
 *     -> every process to ABOVE_NORMAL;
 *   - the same setting, while a screen share is live (./share-boost.ts): setting on AND a
 *     screen share live -> every process to ABOVE_NORMAL, the GPU process
 *     (capture readback + the hardware encoder's command submission) and the
 *     browser/main process (the desktop-capture thread) to HIGH.
 *
 * Why Windows only: there, ABOVE_NORMAL / HIGH priority classes need no
 * privilege. On Linux and macOS a negative nice value needs root /
 * CAP_SYS_NICE, so the call would just fail — the mode's other parts still
 * apply there.
 */
export class CallPriorityBooster {
    private enabled = false;
    private inCall = false;
    private shareEnabled = false;
    private sharing = false;
    /** pid -> the priority it had before we raised it, and the one we set. */
    private readonly raised = new Map<number, { before: number; set: number }>();

    constructor(private readonly deps: PriorityBoosterDeps) {}

    /** True while the boost should be in force. */
    get active(): boolean {
        return shareBoostSupport(this.deps.platform).priorityBoost && ((this.enabled && this.inCall) || this.shareActive);
    }

    /** True while the SCREEN-SHARE boost (setting on AND a share live) is wanted. */
    get shareActive(): boolean {
        return this.shareEnabled && this.sharing;
    }

    /** pids currently held above their original priority by us (for tests / diagnostics). */
    raisedPids(): number[] {
        return [...this.raised.keys()];
    }

    setEnabled(on: boolean): void {
        this.enabled = on;
        this.sync();
    }

    setInCall(on: boolean): void {
        this.inCall = on;
        this.sync();
    }

    setShareEnabled(on: boolean): void {
        this.shareEnabled = on;
        this.sync();
    }

    setSharing(on: boolean): void {
        this.sharing = on;
        this.sync();
    }

    /**
     * Re-apply while active: picks up child processes that started after the
     * call did (a restarted GPU process, a new utility process) and re-raises
     * a process Chromium has put back to exactly the priority it had before
     * (Chromium re-asserts NORMAL for a foreground renderer on its own
     * visibility updates). A process Chromium has moved anywhere ELSE (e.g.
     * backgrounded) is left alone — that is Chromium's decision, not ours.
     * main.ts calls this on a timer while active.
     */
    tick(): void {
        if (!this.active) return;
        this.apply();
    }

    /** Restore everything we raised. Safe to call any number of times. */
    reset(): void {
        for (const [pid, entry] of this.raised) {
            try {
                // Only undo OUR change: if something else has set a different
                // priority since, theirs stands.
                if (this.deps.getPriority(pid) === entry.set) this.deps.setPriority(pid, entry.before);
            } catch { /* process exited — nothing to restore */ }
        }
        this.raised.clear();
    }

    private sync(): void {
        if (this.active) this.apply();
        else this.reset();
    }

    /** What this process should be held at right now. */
    private targetFor(type: string | undefined): number {
        // During a share the GPU process (readback + encoder) AND the browser
        // process (which owns the desktop-capture thread) go to HIGH; the rest
        // stay ABOVE_NORMAL. HIGH_PRIORITY_CLASS needs no privilege.
        return this.shareActive && (type === 'GPU' || type === 'Browser') ? PRIORITY_HIGH : PRIORITY_ABOVE_NORMAL;
    }

    private apply(): void {
        let procs: Array<{ pid: number; type?: string }>;
        try {
            procs = this.deps.listProcesses
                ? this.deps.listProcesses()
                : this.deps.listPids().map(pid => ({ pid }));
        } catch { return; }
        const live = new Set(procs.map(p => p.pid));
        // Forget processes that are gone.
        for (const pid of [...this.raised.keys()]) if (!live.has(pid)) this.raised.delete(pid);
        for (const { pid, type } of procs) {
            if (!Number.isInteger(pid) || pid <= 0) continue;
            let current: number;
            try { current = this.deps.getPriority(pid); } catch { continue; }
            const target = this.targetFor(type);
            const entry = this.raised.get(pid);
            if (entry === undefined) {
                // Never LOWER a process that is already at or above the boost.
                if (current <= target) continue;
                try {
                    this.deps.setPriority(pid, target);
                    this.raised.set(pid, { before: current, set: target });
                } catch { /* not permitted / exited — skip it */ }
            } else if (current === entry.set) {
                // Still ours; move it if the wanted level changed (a share
                // started or ended while the call boost stays).
                if (entry.set !== target) {
                    try { this.deps.setPriority(pid, target); entry.set = target; } catch { /* skip */ }
                }
            } else if (current === entry.before) {
                // Put back to its original value by someone else (Chromium) — re-raise.
                try { this.deps.setPriority(pid, target); entry.set = target; } catch { /* skip */ }
            } else {
                // Moved somewhere else entirely: not ours any more.
                this.raised.delete(pid);
            }
        }
    }
}

/** How often main re-applies the boost during a call. */
export const PRIORITY_REAPPLY_MS = 15_000;
