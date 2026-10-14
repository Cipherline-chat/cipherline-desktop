import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import {
    UpdateInstallCoordinator, decideSilentInstall, parseInstallAttempt, settleInstallAttempt,
    readInstallAttempt, STARTUP_INSTALL_WINDOW_MS, REOPEN_MIN_HIDDEN_MS, INSTALL_WATCHDOG_MS,
    type InstallCoordinatorDeps, type InstallAttempt,
} from './update-install';
import { SessionLifecycle, type QuitTrigger } from './session-lifecycle';
import type { MarkerFs } from './diagnostics';

const nodeRequire = createRequire(__filename);

/** In-memory MarkerFs. */
function memFs(opts: { failWrites?: boolean } = {}): MarkerFs & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)!; },
        writeFileSync: (p, d) => { if (opts.failWrites) throw new Error('EACCES'); files.set(p, d); },
        unlinkSync: (p) => { if (!files.delete(p)) throw new Error('ENOENT'); },
    };
}

const ATTEMPT = '/ud/update-install-attempt.json';
const MARKER = '/ud/unclean-exit.marker';

interface Rig {
    c: UpdateInstallCoordinator;
    fs: ReturnType<typeof memFs>;
    calls: string[];
    logs: string[];
    lifecycle: SessionLifecycle;
    set: { version: string; uptimeMs: number; inCall: boolean };
    flush(): void;
}

function rig(o: { failWrites?: boolean; version?: string } = {}): Rig {
    const fs = memFs({ failWrites: o.failWrites });
    const calls: string[] = [];
    const logs: string[] = [];
    const set = { version: o.version ?? '1.0.21', uptimeMs: 4_000, inCall: false };
    const lifecycle = new SessionLifecycle({
        markerEnabled: true, fs, markerPath: () => MARKER, appVersion: () => set.version, now: () => Date.now(),
    });
    lifecycle.start();
    const deferred: Array<() => void> = [];
    const deps: InstallCoordinatorDeps = {
        appVersion: () => set.version,
        now: () => Date.now(),
        uptimeMs: () => set.uptimeMs,
        inCall: () => set.inCall,
        isQuitting: () => lifecycle.isQuitting,
        fs,
        attemptPath: () => ATTEMPT,
        beginQuit: (t) => { calls.push(`beginQuit:${t}`); lifecycle.beginQuit(t as QuitTrigger); },
        markInstallRequested: () => calls.push('markInstallRequested'),
        showInstallingUi: (v) => calls.push(`splash:${v}`),
        quitAndInstall: () => calls.push('quitAndInstall'),
        defer: (fn) => { deferred.push(fn); },
        onInstallStalled: () => calls.push('stalled'),
        log: (l) => logs.push(l),
        record: (n, d) => logs.push(`${n} ${d}`),
    };
    return { c: new UpdateInstallCoordinator(deps), fs, calls, logs, lifecycle, set, flush: () => { while (deferred.length) deferred.shift()!(); } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T09:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('startup install of a cached download', () => {
    it('installs: clean-quit mark -> failure flag -> splash -> (next tick) silent quitAndInstall, attempt recorded first', () => {
        const r = rig();
        const d = r.c.onUpdateDownloaded({ version: '1.0.22' }, true);
        expect(d).toEqual({ install: true });
        expect(r.calls).toEqual(['beginQuit:startup-install', 'markInstallRequested', 'splash:1.0.22']);
        expect(parseInstallAttempt(r.fs.files.get(ATTEMPT))).toMatchObject({ targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'startup' });
        r.flush();
        expect(r.calls.at(-1)).toBe('quitAndInstall');
        expect(r.c.installing).toBe(true);
    });

    it('a download that finished in THIS session (progress was shown) is left to the tile, not installed', () => {
        const r = rig();
        expect(r.c.onUpdateDownloaded({ version: '1.0.22' }, false)).toEqual({ install: false, reason: 'fresh-download' });
        r.flush();
        expect(r.calls).toEqual([]);
        expect(r.fs.files.has(ATTEMPT)).toBe(false);
    });

    it('is not mid-use: after the first minutes of the process a cache hit no longer installs', () => {
        const r = rig();
        r.set.uptimeMs = STARTUP_INSTALL_WINDOW_MS + 1;
        expect(r.c.onUpdateDownloaded({ version: '1.0.22' }, true)).toEqual({ install: false, reason: 'late' });
        r.flush();
        expect(r.calls).toEqual([]);
    });

    it('never interrupts an active call', () => {
        const r = rig();
        r.set.inCall = true;
        expect(r.c.onUpdateDownloaded({ version: '1.0.22' }, true)).toEqual({ install: false, reason: 'in-call' });
        r.flush();
        expect(r.calls).toEqual([]);
    });

    it('does not install when the loop guard marker cannot be written (no guard = no attempt)', () => {
        const r = rig({ failWrites: true });
        expect(r.c.onUpdateDownloaded({ version: '1.0.22' }, true)).toEqual({ install: false, reason: 'guard-unwritable' });
        r.flush();
        expect(r.calls).toEqual([]);
    });

    it('a second `update-downloaded` while an install is under way does nothing', () => {
        const r = rig();
        r.c.onUpdateDownloaded({ version: '1.0.22' }, true);
        r.flush();
        const n = r.calls.length;
        expect(r.c.onUpdateDownloaded({ version: '1.0.22' }, true).install).toBe(false);
        r.flush();
        expect(r.calls).toHaveLength(n);
    });
});

describe('loop guard', () => {
    it('same target, still on the old version: NOT retried, logged, tile stays', () => {
        const r = rig();
        r.c.onUpdateDownloaded({ version: '1.0.22' }, true);      // launch 1: attempt recorded
        r.flush();
        // the install did not take: next launch, same running version
        const r2 = rig();
        r2.fs.files.set(ATTEMPT, r.fs.files.get(ATTEMPT)!);
        r2.c.settleAtBoot();
        expect(r2.fs.files.has(ATTEMPT)).toBe(true);               // kept: it IS the guard
        expect(r2.c.onUpdateDownloaded({ version: '1.0.22' }, true)).toEqual({ install: false, reason: 'already-attempted' });
        r2.flush();
        expect(r2.calls).toEqual([]);
        expect(r2.logs.some((l) => l.includes('skipped: already-attempted'))).toBe(true);
    });

    it('a NEWER target version gets its own single attempt', () => {
        const r = rig();
        r.fs.files.set(ATTEMPT, JSON.stringify({ targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'startup', at: 1 }));
        expect(r.c.onUpdateDownloaded({ version: '1.0.23' }, true)).toEqual({ install: true });
    });

    it('the reopen trigger shares the budget: one automatic attempt per version, whichever trigger', () => {
        const r = rig();
        r.fs.files.set(ATTEMPT, JSON.stringify({ targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'startup', at: 1 }));
        expect(r.c.onWindowReopened('1.0.22', 10 * 60_000)).toEqual({ install: false, reason: 'already-attempted' });
    });

    it('when the install DID take effect the marker is cleared at boot', () => {
        const r = rig({ version: '1.0.22' });
        r.fs.files.set(ATTEMPT, JSON.stringify({ targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'startup', at: 1 }));
        r.c.settleAtBoot();
        expect(r.fs.files.has(ATTEMPT)).toBe(false);
        expect(r.logs.some((l) => l.includes('installed'))).toBe(true);
    });

    it('settleInstallAttempt: pure table', () => {
        const a: InstallAttempt = { targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'startup', at: 1 };
        expect(settleInstallAttempt(null, '1.0.21')).toEqual({ action: 'none' });
        expect(settleInstallAttempt(a, '1.0.21')).toEqual({ action: 'keep' });
        expect(settleInstallAttempt(a, '1.0.22')).toEqual({ action: 'clear', outcome: 'installed' });
        expect(settleInstallAttempt(a, '1.0.25')).toEqual({ action: 'clear', outcome: 'version-changed' });
    });

    it('a corrupt or hostile marker reads as "no attempt"', () => {
        for (const raw of ['', '{', 'null', '[]', '{"targetVersion":1}', JSON.stringify({ targetVersion: '../x', fromVersion: '1', trigger: 'startup', at: 1 }),
            JSON.stringify({ targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'evil', at: 1 })]) {
            expect(parseInstallAttempt(raw)).toBeNull();
        }
        expect(readInstallAttempt(memFs(), '/nope')).toBeNull();
    });

    it('NEGATIVE CONTROL: without the guard check, a failed install would be repeated on every launch', () => {
        // The guard is the only thing standing between "failed once" and "fails forever".
        const attempt: InstallAttempt = { targetVersion: '1.0.22', fromVersion: '1.0.21', trigger: 'startup', at: 1 };
        const base = { trigger: 'startup' as const, currentVersion: '1.0.21', updateVersion: '1.0.22', inCall: false, quitting: false, fromCache: true, uptimeMs: 1000 };
        expect(decideSilentInstall({ ...base, attempt })).toEqual({ install: false, reason: 'already-attempted' });
        expect(decideSilentInstall({ ...base, attempt: null })).toEqual({ install: true });
    });
});

describe('reopen from the tray (close-to-tray is the default, so "close and reopen" never quits)', () => {
    it('installs when the window was hidden a while and an update is waiting', () => {
        const r = rig();
        expect(r.c.onWindowReopened('1.0.22', REOPEN_MIN_HIDDEN_MS)).toEqual({ install: true });
        expect(parseInstallAttempt(r.fs.files.get(ATTEMPT))?.trigger).toBe('reopen');
        expect(r.calls[0]).toBe('beginQuit:reopen-install');
    });
    it('not for a glance, not with nothing downloaded, not in a call', () => {
        const r = rig();
        expect(r.c.onWindowReopened('1.0.22', REOPEN_MIN_HIDDEN_MS - 1)).toEqual({ install: false, reason: 'hidden-briefly' });
        expect(r.c.onWindowReopened(null, 10 * 60_000)).toEqual({ install: false, reason: 'not-ready' });
        r.set.inCall = true;
        expect(r.c.onWindowReopened('1.0.22', 10 * 60_000)).toEqual({ install: false, reason: 'in-call' });
        expect(r.calls).toEqual([]);
    });
});

describe('a failed or stalled hand-over', () => {
    it('stall watchdog fires after INSTALL_WATCHDOG_MS if the app is still running', () => {
        const r = rig();
        r.c.onUpdateDownloaded({ version: '1.0.22' }, true);
        r.flush();
        vi.advanceTimersByTime(INSTALL_WATCHDOG_MS - 1);
        expect(r.calls).not.toContain('stalled');
        vi.advanceTimersByTime(2);
        expect(r.calls).toContain('stalled');
    });
    it('onInstallFailed disarms the watchdog and allows normal operation again', () => {
        const r = rig();
        r.c.onUpdateDownloaded({ version: '1.0.22' }, true);
        r.c.onInstallFailed();
        vi.advanceTimersByTime(INSTALL_WATCHDOG_MS * 2);
        expect(r.calls).not.toContain('stalled');
        expect(r.c.installing).toBe(false);
    });
});

describe('clean-quit marking — no "closed unexpectedly" prompt after an automatic install', () => {
    it('the session marker is gone before the hand-over, so the installer killing us is not a crash', () => {
        const r = rig();
        expect(r.fs.files.has(MARKER)).toBe(true);                 // live session armed
        r.c.onUpdateDownloaded({ version: '1.0.22' }, true);
        expect(r.fs.files.has(MARKER)).toBe(false);                // dropped synchronously, before quitAndInstall even runs
        expect(r.lifecycle.isQuitting).toBe(true);
        // next launch (the new version): nothing to report
        const next = new SessionLifecycle({ markerEnabled: true, fs: r.fs, markerPath: () => MARKER, appVersion: () => '1.0.22', now: () => Date.now() });
        expect(next.start()).toBeNull();
    });

    it('NEGATIVE CONTROL: the same kill WITHOUT beginQuit leaves the marker (what a plain taskkill looks like)', () => {
        const r = rig();
        // process dies here, no quit asked for
        const next = new SessionLifecycle({ markerEnabled: true, fs: r.fs, markerPath: () => MARKER, appVersion: () => '1.0.21', now: () => Date.now() });
        expect(next.start()).not.toBeNull();
    });
});

/**
 * "A downloaded update installs when the app quits, by any path." This drives
 * the REAL electron-updater BaseUpdater quit hook (autoInstallOnAppQuit) with a
 * fake Electron `app`, emitting the events each path produces in the order
 * main.ts's listeners see them.
 */
describe('install on quit — real electron-updater quit hook, every quit path', () => {
    function updaterOnApp() {
        const { BaseUpdater } = nodeRequire('electron-updater/out/BaseUpdater') as { BaseUpdater: new (o: unknown, a: unknown) => FakeUpdater };
        type FakeUpdater = { downloadedUpdateHelper: unknown; autoInstallOnAppQuit: boolean; addQuitHandler(): void; install(silent: boolean, run: boolean): boolean };
        const app = new EventEmitter();
        const adapter = {
            isPackaged: true, version: '1.0.21', name: 'Cipherline', baseCachePath: '/tmp', userDataPath: '/tmp',
            appUpdateConfigPath: '/tmp/app-update.yml', whenReady: () => Promise.resolve(), quit() {}, relaunch() {},
            onQuit(h: (code: number) => void) { app.once('quit', (_e: unknown, code: number) => h(code)); },
        };
        const installs: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];
        class U extends BaseUpdater { doInstall(o: { isSilent: boolean; isForceRunAfter: boolean }) { installs.push(o); return true; } }
        const u = new U({ provider: 'generic', url: 'https://updates.example' }, adapter);
        u.downloadedUpdateHelper = { file: '/tmp/Cipherline-Setup-1.0.22.exe', downloadedFileInfo: { fileName: 'x', sha512: 'x', isAdminRightsRequired: false } };
        u.autoInstallOnAppQuit = true;
        u.addQuitHandler();                                         // what executeDownload's `done` does for a fresh AND a cached download
        return { app, installs, u };
    }
    /** app.quit(): before-quit, will-quit, then quit(exitCode 0) — the order Electron emits them. */
    const quit = (app: EventEmitter, code = 0) => { app.emit('before-quit'); app.emit('will-quit'); app.emit('quit', {}, code); };

    it.each([
        ['tray "Quit Cipherline"'],
        ['Ctrl/Cmd+Q from the application menu'],
        ['X with close-to-tray OFF (window-all-closed -> app.quit)'],
    ])('%s -> app.quit() -> installs, silently, without relaunching', () => {
        const { app, installs } = updaterOnApp();
        quit(app);
        expect(installs).toEqual([{ isSilent: true, isForceRunAfter: false, isAdminRightsRequired: false }]);
    });

    it('Windows log-off / shutdown (session-end): the process is ended without `quit` -> NOT installed here; the next launch installs it (startup trigger above)', () => {
        const { app, installs } = updaterOnApp();
        app.emit('before-quit');                                    // session-end handler runs beginQuit; no `quit` follows
        expect(installs).toEqual([]);
    });

    it('app.exit(n) skips the hook entirely (hand-off exits, fatal init errors): nothing installs', () => {
        const { app, installs } = updaterOnApp();
        expect(installs).toEqual([]);                               // exit() emits neither before-quit nor will-quit
        quit(app, 1);                                               // and a non-zero exit code is refused by the hook as well
        expect(installs).toEqual([]);
    });

    it('relaunch / explicit install with a download ready: the installer starts ONCE (the quit hook sees quitAndInstallCalled)', () => {
        const { app, installs, u } = updaterOnApp();
        u.install(true, true);                                      // what quitAndInstall(true, true) does before it calls app.quit()
        quit(app);
        expect(installs).toEqual([{ isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false }]);
    });
});
