/**
 * session-lifecycle — when is a process ending a CRASH, and when is it a quit?
 *
 * The crash reporter (./diagnostics.ts) has two kinds of evidence:
 *   • EVENTS while running — render-process-gone, child-process-gone, a main
 *     uncaughtException / unhandledRejection, the root error boundary's report;
 *   • the UNCLEAN-EXIT MARKER — a file written once this instance is the live
 *     one and removed when the session ends on purpose. Found at the next
 *     launch → "Cipherline closed unexpectedly".
 *
 * Both used to misfire on an ordinary close ("I closed it, reopened it, and it
 * says it crashed"). The rules this module owns, all driven by one fact — has
 * a quit been ASKED FOR?:
 *
 *   1. The marker goes the moment a quit is asked for (before-quit, OS
 *      session-end / shutdown, "Restart & install", relaunch), synchronously —
 *      not at will-quit, the LAST step of a quit. A quit that is then cut short
 *      is still a quit the user asked for: the NSIS updater (`--updated`)
 *      force-kills the old app ~1.3 s after launching (Sleep 300 + Sleep 1000,
 *      then taskkill /F — app-builder-lib allowOnlyOneInstallerInstance.nsh),
 *      Windows ends a logging-off session on its own clock, and an impatient
 *      user ends a slow quit in Task Manager. None of those is a crash.
 *   2. Once a quit is asked for, nothing that dies is recorded: teardown kills
 *      the GPU / utility / renderer processes, and a callback that touches a
 *      half-destroyed window throws. The user experienced a quit, not a crash.
 *      A quit that does NOT happen (the updater could not launch its
 *      installer) is cancelQuit(): recording resumes and the marker comes back.
 *   3. The marker is only taken over by THE live instance — one that won the
 *      loopback port (packaged) — so a second launch that slipped past the
 *      single-instance lock and is about to hand off + exit can neither report
 *      the running instance's marker as an unclean exit nor leave its own.
 *   4. A leftover marker from a DIFFERENT app version is not reported: between
 *      that session and this one an installer replaced the app, and installers
 *      terminate the running app (rule 1 again, for the copy that predates
 *      this module). See crashFromLeftoverMarker in ./diagnostics.ts.
 *
 * Real crashes are still caught: a renderer / GPU / utility crash while
 * running, a main-process JS exception while running, and a main process that
 * dies without being asked to quit (native crash, taskkill /F, power loss)
 * still leaves the marker for the next launch.
 *
 * No runtime `electron` import (fs, paths and clocks are injected) so it is
 * unit-testable — session-lifecycle.test.ts. It must not import from src/
 * (the rootDir trap in CLAUDE.md).
 */
import {
    clearSessionMarker, crashFromChildGone, crashFromMainError, crashFromRenderGone, crashFromRendererReport,
    rotateSessionMarker, writeSessionMarker, type CrashInfoLike, type MarkerFs,
} from './diagnostics';
import type { Scrubber } from './diagnostics-scrub';

/** Every crash signal main receives, as data. */
export type CrashEvent =
    | { source: 'render-process-gone'; details: unknown }
    | { source: 'child-process-gone'; details: unknown }
    | { source: 'main-exception'; thrown: unknown; origin: 'uncaughtException' | 'unhandledRejection' }
    | { source: 'renderer-report'; payload: unknown };

export interface CrashContext {
    now: number;
    appVersion: string;
    /** Lazy: building the scrubber reads the OS account name. */
    scrubber: () => Scrubber;
}

/**
 * THE decision: should this event become a pending crash record?
 * null = no. The decision table (session-lifecycle.test.ts) is event ×
 * reason × quitting:
 *   quitting → never;
 *   process-gone events → only Electron's abnormal reasons (CRASH_REASONS:
 *     crashed / oom / launch-failed / integrity-failure / abnormal-exit —
 *     never clean-exit, killed or memory-eviction);
 *   main exceptions → always (while running);
 *   renderer report → when it carries something (name / message / stack).
 */
export function crashRecordFor(event: CrashEvent, quitting: boolean, ctx: CrashContext): CrashInfoLike | null {
    if (quitting) return null;
    switch (event.source) {
        case 'render-process-gone': return crashFromRenderGone(event.details, ctx.now, ctx.appVersion);
        case 'child-process-gone': return crashFromChildGone(event.details, ctx.now, ctx.appVersion);
        case 'main-exception': return crashFromMainError(event.thrown, event.origin, ctx.now, ctx.appVersion, ctx.scrubber());
        case 'renderer-report': return crashFromRendererReport(event.payload, ctx.now, ctx.appVersion, ctx.scrubber());
        default: return null;
    }
}

/** Why a quit was asked for — logging only; every trigger is handled alike. */
export type QuitTrigger = 'before-quit' | 'session-end' | 'os-shutdown' | 'quit-and-install' | 'startup-install' | 'reopen-install' | 'relaunch';

export interface SessionLifecycleDeps {
    /** Packaged (or opted in) and not the smoke test — see main.ts. */
    markerEnabled: boolean;
    fs: MarkerFs;
    /** Resolved lazily, at start() — userData is not readable before ready. */
    markerPath: () => string;
    appVersion: () => string;
    now: () => number;
}

export class SessionLifecycle {
    private path: string | null = null;
    private startedAt = 0;
    private quitting = false;
    private trigger: QuitTrigger | null = null;

    constructor(private readonly d: SessionLifecycleDeps) {}

    /** Has a quit been asked for (and not cancelled)? */
    get isQuitting(): boolean { return this.quitting; }

    /** What first asked for the current quit, for the log; null when not quitting. */
    get quitTrigger(): QuitTrigger | null { return this.quitting ? this.trigger : null; }

    /** Is the marker on disk on behalf of this process? (tests / logging) */
    get armed(): boolean { return this.path !== null && !this.quitting; }

    /**
     * This instance is THE live one now (it holds the loopback port, or loaded
     * the dev server). Consumes the previous session's marker — returning its
     * record, if it is one — and writes this session's. Once per process; a
     * second call (macOS re-creating the window) is a no-op. When a quit was
     * already asked for, the previous session is still judged but no new
     * marker is left behind.
     */
    start(): CrashInfoLike | null {
        if (!this.d.markerEnabled || this.path) return null;
        this.path = this.d.markerPath();
        this.startedAt = this.d.now();
        const leftover = rotateSessionMarker(this.d.fs, this.path, this.d.appVersion(), this.startedAt);
        if (this.quitting) clearSessionMarker(this.d.fs, this.path);
        return leftover;
    }

    /**
     * A quit was asked for. Synchronous and idempotent: the marker is gone
     * before this returns, and crash events stop counting.
     */
    beginQuit(trigger: QuitTrigger): void {
        this.trigger ??= trigger;
        this.quitting = true;
        if (this.path) clearSessionMarker(this.d.fs, this.path);
    }

    /**
     * The quit that was asked for is not happening after all (the updater
     * could not launch its installer and the window came back). Re-arm, so a
     * crash later in this session is still caught.
     */
    cancelQuit(): void {
        if (!this.quitting) return;
        this.quitting = false;
        this.trigger = null;
        if (this.path) writeSessionMarker(this.d.fs, this.path, this.d.appVersion(), this.startedAt);
    }
}
