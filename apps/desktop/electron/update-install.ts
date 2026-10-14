/**
 * update-install — installing a DOWNLOADED update without the user clicking
 * "Restart to update", and never twice for the same version.
 *
 * ── The four ways a downloaded update gets installed ────────────────────────
 *   quit      electron-updater's own `autoInstallOnAppQuit`: on Electron's
 *             `quit` event with exit code 0 it runs the installer silently.
 *             That covers tray Quit, Ctrl/Cmd+Q and the last window closing
 *             with close-to-tray off — they all end in app.quit(). It does NOT
 *             cover app.exit() (no `quit`), a non-zero exit code, a kill, or
 *             an OS shutdown that ends the process before `quit` (session-end).
 *   relaunch  "Restart Cipherline to apply": delegated to quitAndInstall when a
 *             download is ready (otherwise the installer would race the
 *             relaunched old copy).
 *   startup   THE CATCH-ALL for everything `quit` misses. The previous session
 *             downloaded an update and ended without installing it. The first
 *             startup check finds it in electron-updater's cache (re-verified:
 *             signed manifest -> sha512 of the cached file; the Authenticode
 *             check ran when it was downloaded) and emits `update-downloaded`
 *             within seconds, with NO download progress. That is the signal
 *             (`fromCache`): install it now, before the user starts working,
 *             behind a small "Installing update…" splash.
 *   reopen    Close-to-tray is the default, so "close and reopen the app"
 *             usually never quits anything: X hides the window and the process
 *             lives on. Showing the window again after it was hidden a while,
 *             with an update waiting, installs it exactly like a startup would.
 *
 * Never mid-use: startup/reopen only fire at the moment the user is arriving,
 * never during a call, and never for a download that finished in this very
 * session while the window was up (that gets the non-blocking tile).
 *
 * ── Loop guard ──────────────────────────────────────────────────────────────
 * Before handing over to the installer an attempt marker is written
 * (userData/update-install-attempt.json: target version, running version,
 * trigger, time — nothing user-specific). If the next launch is STILL on the
 * running version and offers the same target, the attempt did not take, so it
 * is not repeated: the tile stays and the reason is logged. One automatic
 * attempt per target version, whichever trigger made it. A marker that cannot
 * be written means no automatic install (no guard, no attempt).
 *
 * The marker is a plain file, not SecureStore: it is written synchronously in
 * the instant before the process hands over, and SecureStore writes are
 * deferred (and a startup SecureStore write is a smoke-test trap — CLAUDE.md).
 *
 * No `electron` import: unit-testable with fakes (update-install.test.ts).
 */
import type { MarkerFs } from './diagnostics';

export const INSTALL_ATTEMPT_FILE = 'update-install-attempt.json';
/** Startup install only applies to a cache hit in the first minutes of the process. */
export const STARTUP_INSTALL_WINDOW_MS = 3 * 60 * 1000;
/** A window hidden for less than this is a glance, not "closed it and came back". */
export const REOPEN_MIN_HIDDEN_MS = 60 * 1000;
/** The quit after quitAndInstall did not happen: give up and bring the window back. */
export const INSTALL_WATCHDOG_MS = 45_000;

export type InstallTrigger = 'startup' | 'reopen';

export interface InstallAttempt {
    targetVersion: string;
    fromVersion: string;
    trigger: InstallTrigger;
    at: number;
}

const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

export function parseInstallAttempt(raw: string | null | undefined): InstallAttempt | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let o: unknown;
    try { o = JSON.parse(raw); } catch { return null; }
    if (!o || typeof o !== 'object') return null;
    const a = o as Record<string, unknown>;
    if (typeof a.targetVersion !== 'string' || !VERSION_RE.test(a.targetVersion)) return null;
    if (typeof a.fromVersion !== 'string' || !VERSION_RE.test(a.fromVersion)) return null;
    if (a.trigger !== 'startup' && a.trigger !== 'reopen') return null;
    if (typeof a.at !== 'number' || !Number.isFinite(a.at)) return null;
    return { targetVersion: a.targetVersion, fromVersion: a.fromVersion, trigger: a.trigger, at: a.at };
}

export function readInstallAttempt(fs: MarkerFs, p: string): InstallAttempt | null {
    try { return parseInstallAttempt(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** true = the marker is on disk. */
export function writeInstallAttempt(fs: MarkerFs, p: string, a: InstallAttempt): boolean {
    try { fs.writeFileSync(p, JSON.stringify(a), { encoding: 'utf8', mode: 0o600 }); return true; } catch { return false; }
}

export function clearInstallAttempt(fs: MarkerFs, p: string): void {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/**
 * Boot: what does a leftover marker mean now?
 *   running version != the one that attempted -> the installer ran; forget it.
 *   same version -> the attempt did not take; KEEP it (it is the loop guard).
 */
export function settleInstallAttempt(a: InstallAttempt | null, currentVersion: string):
    { action: 'none' } | { action: 'clear'; outcome: 'installed' | 'version-changed' } | { action: 'keep' } {
    if (!a) return { action: 'none' };
    if (a.fromVersion === currentVersion) return { action: 'keep' };
    return { action: 'clear', outcome: a.targetVersion === currentVersion ? 'installed' : 'version-changed' };
}

export type SkipReason =
    | 'fresh-download' | 'late' | 'in-call' | 'already-attempted' | 'quitting'
    | 'hidden-briefly' | 'not-ready' | 'guard-unwritable';

export interface InstallDecisionInput {
    trigger: InstallTrigger;
    attempt: InstallAttempt | null;
    currentVersion: string;
    updateVersion: string | null;
    inCall: boolean;
    quitting: boolean;
    /** startup: the download came from electron-updater's cache (no progress events). */
    fromCache?: boolean;
    /** startup: process uptime. */
    uptimeMs?: number;
    /** reopen: how long the window was hidden. */
    hiddenForMs?: number;
}
export type InstallDecision = { install: true } | { install: false; reason: SkipReason };

/** THE decision (pure). Order matters only for which reason gets reported. */
export function decideSilentInstall(i: InstallDecisionInput): InstallDecision {
    if (!i.updateVersion) return { install: false, reason: 'not-ready' };
    if (i.quitting) return { install: false, reason: 'quitting' };
    if (i.trigger === 'startup') {
        if (!i.fromCache) return { install: false, reason: 'fresh-download' };
        if ((i.uptimeMs ?? Infinity) > STARTUP_INSTALL_WINDOW_MS) return { install: false, reason: 'late' };
    } else if ((i.hiddenForMs ?? 0) < REOPEN_MIN_HIDDEN_MS) {
        return { install: false, reason: 'hidden-briefly' };
    }
    if (i.inCall) return { install: false, reason: 'in-call' };
    const a = i.attempt;
    if (a && a.targetVersion === i.updateVersion && a.fromVersion === i.currentVersion) {
        return { install: false, reason: 'already-attempted' };
    }
    return { install: true };
}

export interface InstallCoordinatorDeps {
    appVersion(): string;
    now(): number;
    uptimeMs(): number;
    inCall(): boolean;
    isQuitting(): boolean;
    fs: MarkerFs;
    attemptPath(): string;
    /** Mark the session as ending ON PURPOSE (no crash prompt next launch). */
    beginQuit(trigger: 'startup-install' | 'reopen-install'): void;
    /** The updater's error listener must treat the next `error` as an install failure. */
    markInstallRequested(): void;
    /** Hide the app window and show the "Installing update…" splash. */
    showInstallingUi(version: string): void;
    /** Hand over to the installer (silent, relaunch). Called on a later tick. */
    quitAndInstall(): void;
    /** Run on a later tick (setImmediate). */
    defer(fn: () => void): void;
    /** The quit did not happen in time: surface it through the updater's error path. */
    onInstallStalled(): void;
    log(line: string): void;
    record(name: string, detail: string): void;
}

export class UpdateInstallCoordinator {
    private active = false;
    private watchdog: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly d: InstallCoordinatorDeps) {}

    /** An automatic install has been handed to the updater and not yet failed. */
    get installing(): boolean { return this.active; }

    /** Boot: settle the previous attempt's marker (clear when it took, keep as the guard when not). */
    settleAtBoot(): void {
        const p = this.d.attemptPath();
        const a = readInstallAttempt(this.d.fs, p);
        const s = settleInstallAttempt(a, this.d.appVersion());
        if (s.action === 'clear') {
            clearInstallAttempt(this.d.fs, p);
            this.d.log(`[Main/Updater] previous automatic install ${s.outcome} (target=${a!.targetVersion})`);
            this.d.record('updater:install-settled', `outcome=${s.outcome} target=${a!.targetVersion}`);
        } else if (s.action === 'keep') {
            this.d.log(`[Main/Updater] previous automatic install of ${a!.targetVersion} did not take effect — will not retry it automatically`);
            this.d.record('updater:install-settled', `outcome=not-installed target=${a!.targetVersion}`);
        }
    }

    /** `update-downloaded` fired. `fromCache` = no download progress preceded it in this session. */
    onUpdateDownloaded(info: { version: string }, fromCache: boolean): InstallDecision {
        return this.consider('startup', info.version, { fromCache, uptimeMs: this.d.uptimeMs() });
    }

    /** The window was shown again after being hidden to the tray. `readyVersion` = downloaded update, if any. */
    onWindowReopened(readyVersion: string | null, hiddenForMs: number): InstallDecision {
        return this.consider('reopen', readyVersion, { hiddenForMs });
    }

    /** The installer could not start (or never quit us): back to a normal session. */
    onInstallFailed(): void {
        this.active = false;
        if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
    }

    private consider(trigger: InstallTrigger, version: string | null, extra: { fromCache?: boolean; uptimeMs?: number; hiddenForMs?: number }): InstallDecision {
        if (this.active) return { install: false, reason: 'quitting' };
        const attempt = readInstallAttempt(this.d.fs, this.d.attemptPath());
        const decision = decideSilentInstall({
            trigger, attempt, currentVersion: this.d.appVersion(), updateVersion: version,
            inCall: this.d.inCall(), quitting: this.d.isQuitting(), ...extra,
        });
        if (!decision.install) {
            // The two silent, common cases are not worth a log line each time.
            if (decision.reason !== 'fresh-download' && decision.reason !== 'not-ready' && decision.reason !== 'hidden-briefly') {
                this.d.log(`[Main/Updater] ${trigger} install of ${version} skipped: ${decision.reason} — leaving the Restart tile`);
                this.d.record('updater:install-skipped', `trigger=${trigger} reason=${decision.reason}`);
            }
            return decision;
        }
        const wrote = writeInstallAttempt(this.d.fs, this.d.attemptPath(), {
            targetVersion: version!, fromVersion: this.d.appVersion(), trigger, at: this.d.now(),
        });
        if (!wrote) {
            this.d.log(`[Main/Updater] ${trigger} install of ${version} skipped: cannot write the attempt marker (no loop guard)`);
            this.d.record('updater:install-skipped', `trigger=${trigger} reason=guard-unwritable`);
            return { install: false, reason: 'guard-unwritable' };
        }
        this.start(trigger, version!);
        return decision;
    }

    private start(trigger: InstallTrigger, version: string): void {
        this.active = true;
        this.d.log(`[Main/Updater] ${trigger} install: ${version} is downloaded — installing now (silent, relaunch)`);
        this.d.record('updater:install', `trigger=${trigger} target=${version} from=${this.d.appVersion()}`);
        // Order matters: the clean-quit mark first (the NSIS installer can kill
        // us ~1.3 s after launch), the failure flag before the hand-over.
        this.d.beginQuit(trigger === 'startup' ? 'startup-install' : 'reopen-install');
        this.d.markInstallRequested();
        this.d.showInstallingUi(version);
        this.watchdog = setTimeout(() => { this.watchdog = null; this.d.onInstallStalled(); }, INSTALL_WATCHDOG_MS);
        (this.watchdog as { unref?: () => void }).unref?.();
        // A tick later, so the caller (an event listener) returns first.
        this.d.defer(() => this.d.quitAndInstall());
    }
}
