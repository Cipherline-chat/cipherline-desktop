/**
 * unclean-exit-classify — did "Cipherline crashed" really happen, or did
 * something else end the process?
 *
 * WHY: an unclean exit (a leftover session marker, or a hung-exit freeze
 * record) is the ABSENCE of a clean quit, and plenty of things that are not
 * our crash look exactly like that. Prod, 7 days: 14 of 22 crash reports were
 * `unclean_exit`, none with any evidence; several dead sessions lived under two
 * minutes. The usual causes:
 *   • an installer / updater replaced the app (the NSIS installer taskkills a
 *     running app; 0.1.0 was rebuilt in place and many users re-ran it),
 *   • the OS restarted / shut down / lost power,
 *   • an external kill of an idle, hidden app (Task Manager, an antivirus
 *     quarantine, a logoff) — nothing we can act on.
 * Prompting about those trains users to dismiss the prompt that matters.
 *
 * This module is the PURE decision (no fs, no clock, no electron): inputs are
 * the dead session's record (from the marker / freeze record / the
 * previous-session file, electron/previous-session.ts), the executable's change
 * time, the OS boot time and the running version. Output: a class + a reason
 * code. Only `real_candidate` is ever offered to the user; the others are
 * counted locally (unclean-exit-ledger.ts) and never sent on their own.
 *
 * RULE ZERO: a bad clock never hides a crash. Every time input that is
 * missing, non-finite, before 2000, or in the future (beyond a small skew
 * allowance) is treated as UNKNOWN, and an unknown input can only ever make a
 * rule NOT fire — so the worst a broken clock does is leave the old behaviour
 * (prompt). Likewise a dead session whose own start time is nonsense is a
 * real candidate.
 *
 * Order (first match wins):
 *   1. hung-exit freeze evidence                      -> real_candidate (hung)
 *   2. installer_replaced: exe changed after the dead session was last seen,
 *      or the dead session ran another version/build
 *   3. os_restart:        boot time after the dead session was last seen
 *   4. real evidence:     call / share / camera live at death, a stall or
 *      renderer / GPU trouble in the dead session's rows -> real_candidate
 *   5. external_kill_suspected: window hidden (tray), nothing live, healthy
 *      rows, and the previous-session file proves it was alive
 *   6. anything else (no previous-session file, window visible, ...) -> real_candidate
 *
 * Must not import from src/ (the rootDir trap in CLAUDE.md).
 */
import type { PrevSessionRow, PrevSessionState, PreviousSession } from './previous-session';

export type UncleanExitClass = 'real_candidate' | 'installer_replaced' | 'os_restart' | 'external_kill_suspected';

/** Classes that are never prompted for nor sent automatically. */
export const SUPPRESSED_CLASSES = ['installer_replaced', 'os_restart', 'external_kill_suspected'] as const;
export type SuppressedClass = typeof SUPPRESSED_CLASSES[number];

export interface DeadSession {
    /** Epoch ms the dead session started (marker / freeze record). null = unknown. */
    startedAt: number | null;
    /** Epoch ms it was last known alive (previous-session file). null when there is no such file. */
    lastSeenAt: number | null;
    /** App version the dead session recorded. null = unknown. */
    appVersion: string | null;
    /** Build commit the dead session recorded, when known (not recorded today). */
    buildCommit?: string | null;
    /** The record came from the freeze watchdog: the app was hung when it died. */
    hung: boolean;
    /** Previous-session state flags; absent without a previous-session file. */
    state?: PrevSessionState;
    /** Previous-session perf rows; `t_s` relative to lastSeenAt. */
    rows?: readonly PrevSessionRow[];
}

export interface ClassifyEnv {
    /** Epoch ms now. */
    now: number;
    /** Newest of the executable's mtime / ctime / birthtime (bundle: exe + Info.plist). null = unreadable. */
    exeChangedAt: number | null;
    /** Epoch ms the OS booted (`now - os.uptime()*1000`). null = unknown. */
    bootTime: number | null;
    /** The running app's version / build commit. */
    currentVersion: string;
    currentBuildCommit?: string | null;
}

export type UncleanReason =
    | 'hung_exit' | 'bad_dead_session_time'
    | 'exe_newer_than_session' | 'version_changed' | 'build_changed'
    | 'boot_after_last_seen'
    | 'call_active' | 'share_active' | 'camera_active' | 'stall_before_death' | 'renderer_or_gpu_trouble'
    | 'hidden_idle_healthy'
    | 'window_visible' | 'window_state_unknown' | 'no_previous_session_evidence';

export interface Classification { cls: UncleanExitClass; reason: UncleanReason }

/** Clock tolerance: a "future" time within this much of now is skew, not nonsense. */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** Boot time is derived from uptime and jitters by about a second. */
export const BOOT_JITTER_MS = 5_000;
/** An exe change this close after last-seen is not "later" (file-time granularity / FAT 2 s). */
export const EXE_GRACE_MS = 2_000;
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
/** A main / renderer row this long counts as a stall. */
export const STALL_ROW_MS = 3_000;
/** Only rows this close to the last write say anything about how it ended. */
export const RECENT_ROW_WINDOW_S = 60;
/** Events whose presence in the last minute means renderer / GPU / child-process trouble. */
export const TROUBLE_ROW_RE = /(?:^|[\s:])(?:gpu[:_]|process:gone|render[-_]?process|crashed|oom\b|launch-failed|abnormal|unresponsive|(?:linux_hw_(?:en|de)code):failure)/i;

/** A timestamp we are willing to reason with: finite, after 2000, not in the future. */
export function sane(t: number | null | undefined, now: number): t is number {
    return typeof t === 'number' && Number.isFinite(t) && t >= MIN_PLAUSIBLE_MS && t <= now + CLOCK_SKEW_MS;
}

const real = (reason: UncleanReason): Classification => ({ cls: 'real_candidate', reason });

/** Real-crash evidence in the dead session's own record (rule 4). null = none. */
export function realEvidence(d: DeadSession): UncleanReason | null {
    const s = d.state ?? {};
    if (s.in_call === true) return 'call_active';
    if (s.sharing === true) return 'share_active';
    if (s.camera_live === true) return 'camera_active';
    for (const r of d.rows ?? []) {
        if (r.t_s < -RECENT_ROW_WINDOW_S) continue;
        if ((r.source === 'main' || r.source === 'renderer') && r.ms >= STALL_ROW_MS) return 'stall_before_death';
        if (r.source === 'event' && TROUBLE_ROW_RE.test(r.activity)) return 'renderer_or_gpu_trouble';
    }
    return null;
}

export function classifyUncleanExit(d: DeadSession, env: ClassifyEnv): Classification {
    const { now } = env;
    if (d.hung) return real('hung_exit');
    // The dead session's own start must make sense, or we know nothing about it.
    if (!sane(d.startedAt, now)) return real('bad_dead_session_time');
    // last-seen is the better reference; one that is nonsense or before the start is dropped.
    const lastSeen = sane(d.lastSeenAt, now) && d.lastSeenAt >= d.startedAt ? d.lastSeenAt : null;
    const ref = lastSeen ?? d.startedAt;

    // 2. installer / updater replaced the app
    if (d.appVersion && env.currentVersion && d.appVersion !== env.currentVersion) return { cls: 'installer_replaced', reason: 'version_changed' };
    if (d.buildCommit && env.currentBuildCommit && d.buildCommit !== env.currentBuildCommit) return { cls: 'installer_replaced', reason: 'build_changed' };
    if (sane(env.exeChangedAt, now) && env.exeChangedAt > ref + EXE_GRACE_MS) return { cls: 'installer_replaced', reason: 'exe_newer_than_session' };

    // 3. the machine restarted after the session was last seen alive
    if (sane(env.bootTime, now) && env.bootTime > ref + BOOT_JITTER_MS) return { cls: 'os_restart', reason: 'boot_after_last_seen' };

    // 4. evidence that it was our own trouble
    const ev = realEvidence(d);
    if (ev) return real(ev);

    // 5. hidden, idle and healthy: an external kill
    if (!lastSeen || !d.state) return real('no_previous_session_evidence');
    if (d.state.window_visible === undefined) return real('window_state_unknown');
    if (d.state.window_visible) return real('window_visible');
    return { cls: 'external_kill_suspected', reason: 'hidden_idle_healthy' };
}

// ── Executable change time ───────────────────────────────────────────────────

export interface ExeStampInput { platform: string; execPath: string; env: { APPIMAGE?: string } }

/**
 * Files whose change time says "the app was replaced": Windows `process.execPath`;
 * macOS the bundle's executable + Info.plist (execPath is Contents/MacOS/<exe>);
 * a Linux AppImage its own file (`$APPIMAGE`; execPath is inside a transient
 * mount), otherwise execPath (.deb / unpacked).
 */
export function exeStampPaths(i: ExeStampInput): string[] {
    const out: string[] = [];
    if (i.platform === 'darwin') {
        out.push(i.execPath);
        const m = /^(.*\/Contents)\/MacOS\/[^/]+$/.exec(i.execPath);
        if (m) out.push(`${m[1]}/Info.plist`);
    } else if (i.platform === 'linux' && i.env.APPIMAGE) {
        out.push(i.env.APPIMAGE);
    } else {
        out.push(i.execPath);
    }
    return out.filter(p => typeof p === 'string' && p.length > 0);
}

export interface StatLike { mtimeMs: number; ctimeMs: number; birthtimeMs?: number }

/**
 * Newest of mtime / ctime / birthtime over the files that could be stat'ed.
 * ctime matters: NSIS / dpkg keep the SOURCE file's old mtime, but ctime (on
 * Windows: ChangeTime) moves when the file is written or replaced. null when
 * nothing could be read.
 */
export function newestFileChange(stat: (p: string) => StatLike | null, paths: readonly string[]): number | null {
    let best: number | null = null;
    for (const p of paths) {
        let s: StatLike | null = null;
        try { s = stat(p); } catch { s = null; }
        if (!s) continue;
        for (const t of [s.mtimeMs, s.ctimeMs, s.birthtimeMs]) {
            if (typeof t === 'number' && Number.isFinite(t) && t > 0 && (best === null || t > best)) best = t;
        }
    }
    return best;
}

/** `now - uptime`, or null when uptime is nonsense. */
export function bootTimeFrom(now: number, uptimeSeconds: number): number | null {
    if (!Number.isFinite(now) || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;
    return now - uptimeSeconds * 1000;
}

// ── Glue (still pure: every input is passed in) ──────────────────────────────

/**
 * The dead session as the classifier sees it. `startedAt` is the marker's /
 * freeze record's session start (epoch ms); `prev` is the previous-session
 * file for THAT session (already matched on start time), if there was one.
 */
export function deadSessionFrom(
    crash: { app_version_at_crash?: string },
    prev: PreviousSession | null,
    startedAt: number | null,
    hung: boolean,
): DeadSession {
    const seen = prev ? Date.parse(prev.last_written_at) : NaN;
    return {
        startedAt,
        lastSeenAt: Number.isFinite(seen) ? seen : null,
        appVersion: crash.app_version_at_crash ?? prev?.app_version ?? null,
        hung,
        ...(prev ? { state: prev.state, rows: prev.rows } : {}),
    };
}

export interface ClassifyEnvInput extends ExeStampInput {
    now: number;
    stat: (p: string) => StatLike | null;
    uptimeSeconds: number;
    currentVersion: string;
}

export function classifyEnvNow(i: ClassifyEnvInput): ClassifyEnv {
    return {
        now: i.now,
        exeChangedAt: newestFileChange(i.stat, exeStampPaths(i)),
        bootTime: bootTimeFrom(i.now, i.uptimeSeconds),
        currentVersion: i.currentVersion,
    };
}
