/**
 * login-item.ts — "start at login", "start minimized" and "minimize to tray":
 * the decisions behind them, with no `electron` import so every one of them is
 * unit testable (login-item.test.ts). main.ts owns the Electron/fs calls and
 * feeds this module plain values.
 *
 * ── The bug this module exists to make impossible again ──────────────────
 * Since the `--autostart` marker was added (c965df32), main.ts registered the
 * Windows login item WITH that arg but read it back with a bare
 * `app.getLoginItemSettings()`. On Windows, `openAtLogin` is only true when the
 * registry Run value equals the command line built from the QUERY's `path` and
 * `args` — and `args` defaults to `[]`. `"…\Cipherline.exe" --autostart` never
 * equals `"…\Cipherline.exe"`, so the read was false for every login item the
 * app itself had written: Settings showed "Start with Windows" OFF on every
 * open, whatever the user had just chosen ("it keeps turning off"). Linux had
 * no implementation at all (Electron's login-item API is a no-op there), so the
 * same toggle could never stay on there either.
 *
 * The fix is structural: ONE function (`loginItemTarget`) decides the
 * path + args for a platform, and both the write and the read are built from
 * it, so they cannot drift apart again.
 */

/** Marks a launch that came from the OS login item. Only such launches honor
 *  "start minimized" — a user opening the app themselves always sees it. */
export const AUTOSTART_ARG = '--autostart';

/** File name of the XDG autostart entry (Linux). */
export const XDG_AUTOSTART_FILENAME = 'cipherline.desktop';

// ── Defaults ─────────────────────────────────────────────────────────────────
// Fresh installs get all three ON, on every platform. A default applies ONLY
// while nothing is stored: an explicit choice — including OFF — always wins,
// and a restored backup that carries a value is an explicit choice too.

export const DEFAULT_START_AT_LOGIN = true;
export const DEFAULT_START_MINIMIZED = true;
export const DEFAULT_MINIMIZE_TO_TRAY = true;

/**
 * A boolean preference stored as the strings 'true' / 'false' (SecureStore).
 * Anything else — absent, empty, garbage — means "never chosen" → the default.
 */
export function resolveBoolPref(stored: string | null | undefined, defaultValue: boolean): boolean {
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return defaultValue;
}

export function encodeBoolPref(enabled: boolean): 'true' | 'false' {
    return enabled ? 'true' : 'false';
}

// ── Where the login item points ──────────────────────────────────────────────

export interface LoginItemEnv {
    platform: string;
    isPackaged: boolean;
    /** process.execPath */
    execPath: string;
    /** process.env.APPIMAGE — set by the AppImage runtime to the .AppImage
     *  file itself (execPath is inside a throwaway squashfs mount). */
    appImage?: string;
    /** process.env.PORTABLE_EXECUTABLE_FILE — electron-builder's Windows
     *  portable target (execPath is inside a per-run temp extraction). */
    portableExecutable?: string;
}

export type LoginItemTarget =
    /** Windows: HKCU\…\Run value = `"path" args…` (Electron builds the string). */
    | { kind: 'windows'; path: string; args: string[] }
    /** macOS: SMAppService main-app login item (13+) / LSSharedFileList (older).
     *  The OS launches the bundle itself; no path/args are involved. */
    | { kind: 'mac' }
    /** Linux: an XDG autostart .desktop file whose Exec is `exec`. */
    | { kind: 'xdg'; exec: string[] }
    | { kind: 'unsupported'; reason: 'dev-build' | 'platform' };

/**
 * Decide the login item for this process — the single source both the write
 * and the read are built from.
 *
 * Dev (unpackaged) builds are unsupported everywhere: the running binary is the
 * bare Electron executable, which at login would launch Electron's default app
 * (or the dev tree with no Vite server behind it). The Settings toggle says so
 * instead of pretending.
 */
export function loginItemTarget(env: LoginItemEnv): LoginItemTarget {
    if (!env.isPackaged) return { kind: 'unsupported', reason: 'dev-build' };
    switch (env.platform) {
        case 'win32': {
            // Portable build: execPath is a temp extraction that is gone after
            // exit — point at the .exe the user actually has.
            const exe = nonEmpty(env.portableExecutable) ?? env.execPath;
            return { kind: 'windows', path: exe, args: [AUTOSTART_ARG] };
        }
        case 'darwin':
            return { kind: 'mac' };
        case 'linux': {
            // AppImage: execPath is under /tmp/.mount_XXXX and changes every run.
            // deb: execPath is /opt/Cipherline/cipherline, stable across updates.
            const exe = nonEmpty(env.appImage) ?? env.execPath;
            return { kind: 'xdg', exec: [exe, AUTOSTART_ARG] };
        }
        default:
            return { kind: 'unsupported', reason: 'platform' };
    }
}

function nonEmpty(s: string | undefined): string | undefined {
    return typeof s === 'string' && s.trim() !== '' ? s : undefined;
}

// ── Windows / macOS: Electron login-item settings ────────────────────────────

/** The `app.getLoginItemSettings(...)` query. MUST carry the same path + args
 *  the item was written with — that mismatch was the whole bug. */
export function electronLoginItemQuery(target: LoginItemTarget): { path?: string; args?: string[] } {
    if (target.kind === 'windows') return { path: target.path, args: [...target.args] };
    return {};
}

/** The `app.setLoginItemSettings(...)` argument. */
export function electronLoginItemSettings(target: LoginItemTarget, enabled: boolean): {
    openAtLogin: boolean; path?: string; args?: string[]; enabled?: boolean;
} {
    if (target.kind === 'windows') {
        // `enabled` also flips the StartupApproved key, so turning it on here
        // re-enables an entry the user had disabled in Task Manager.
        return enabled
            ? { openAtLogin: true, path: target.path, args: [...target.args], enabled: true }
            : { openAtLogin: false, path: target.path, args: [...target.args] };
    }
    return { openAtLogin: enabled };
}

/** The subset of Electron's LoginItemSettings this module reads. */
export interface ObservedLoginItemSettings {
    openAtLogin?: boolean;
    /** win32: true if THIS executable will launch at login with ANY args and
     *  its Run entry is not disabled in Task Manager / Settings → Startup. */
    executableWillLaunchAtLogin?: boolean;
    /** darwin (13+): SMAppService status. */
    status?: string;
}

export interface LoginItemState {
    /** False in dev builds and on unknown platforms — the toggle is disabled. */
    supported: boolean;
    /** What the toggle shows. */
    enabled: boolean;
    /** macOS 13+: registered, but the user must allow it in System Settings →
     *  General → Login Items before it actually launches. */
    needsApproval: boolean;
}

/** Interpret what Electron reports for a Windows/macOS login item. */
export function interpretElectronLoginItem(target: LoginItemTarget, s: ObservedLoginItemSettings): LoginItemState {
    if (target.kind === 'windows') {
        // executableWillLaunchAtLogin ignores args, so it also recognises
        // entries written before the `--autostart` marker existed, and it is
        // false when the user disabled the entry in Task Manager — which is
        // exactly what the toggle should then show.
        const enabled = s.executableWillLaunchAtLogin === true
            || (s.executableWillLaunchAtLogin === undefined && s.openAtLogin === true);
        return { supported: true, enabled, needsApproval: false };
    }
    if (target.kind === 'mac') {
        const needsApproval = s.status === 'requires-approval';
        // A registration awaiting approval is still the user's choice of ON;
        // showing it OFF would invite a second toggle that changes nothing.
        const enabled = s.openAtLogin === true || s.status === 'enabled' || needsApproval;
        return { supported: true, enabled, needsApproval };
    }
    return { supported: false, enabled: false, needsApproval: false };
}

/**
 * Windows boot reconcile: a login item that will launch this exe but without
 * our marker (written by a build before c965df32) must be re-registered, or
 * its login launches look like manual opens and ignore "start minimized".
 */
export function windowsLoginItemNeedsRetrofit(s: ObservedLoginItemSettings): boolean {
    return s.executableWillLaunchAtLogin === true && s.openAtLogin !== true;
}

/**
 * Windows turn-OFF cleanup: `setLoginItemSettings({openAtLogin:false})`
 * deletes the Run value by NAME (the AppUserModelId). An entry for this same
 * executable under any other name (an older build's default AUMID) would keep
 * launching it, and keep the toggle reading ON. Returns the names of the
 * per-user entries still pointing at this exe after the delete.
 */
export function leftoverWindowsLaunchItemNames(
    items: ReadonlyArray<{ name: string; path: string; scope?: string }> | undefined,
    exePath: string,
): string[] {
    if (!Array.isArray(items)) return [];
    const want = exePath.toLowerCase();
    return items
        .filter(i => i && i.scope !== 'machine' && typeof i.path === 'string' && i.path.toLowerCase() === want)
        .map(i => i.name)
        .filter((n): n is string => typeof n === 'string' && n !== '');
}

// ── Linux: XDG autostart entry ───────────────────────────────────────────────

/** `$XDG_CONFIG_HOME/autostart/cipherline.desktop` (default ~/.config). */
export function xdgAutostartPath(home: string, xdgConfigHome?: string): string {
    const base = nonEmpty(xdgConfigHome) && xdgConfigHome!.startsWith('/')
        ? xdgConfigHome!.replace(/\/+$/, '')
        : `${home.replace(/\/+$/, '')}/.config`;
    return `${base}/autostart/${XDG_AUTOSTART_FILENAME}`;
}

/**
 * Quote one Exec argument per the Desktop Entry spec: arguments containing
 * reserved characters are double-quoted with `"`, `` ` ``, `$` and `\`
 * backslash-escaped; a literal `%` is written `%%` (field codes) either way.
 */
export function quoteExecArg(arg: string): string {
    const pct = arg.replace(/%/g, '%%');
    if (pct !== '' && !/[\s"'\\><~|&;$*?#()`=]/.test(pct)) return pct;
    return `"${pct.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function buildXdgDesktopEntry(exec: string[]): string {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=Cipherline',
        'Comment=End-to-end encrypted messaging and calls',
        `Exec=${exec.map(quoteExecArg).join(' ')}`,
        'Icon=cipherline',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
    ].join('\n');
}

/** Value of `key` in the [Desktop Entry] group, or undefined. */
function desktopEntryValue(content: string, key: string): string | undefined {
    let inGroup = false;
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) { inGroup = line === '[Desktop Entry]'; continue; }
        if (!inGroup || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
    }
    return undefined;
}

/**
 * Is an existing autostart file ON? Absent → off. Desktop environments switch
 * an entry off without deleting it via `Hidden=true` or (GNOME/KDE)
 * `X-GNOME-Autostart-enabled=false`; both count as off.
 */
export function interpretXdgEntry(content: string | null): { enabled: boolean } {
    if (content === null) return { enabled: false };
    if ((desktopEntryValue(content, 'Hidden') ?? '').toLowerCase() === 'true') return { enabled: false };
    if ((desktopEntryValue(content, 'X-GNOME-Autostart-enabled') ?? '').toLowerCase() === 'false') return { enabled: false };
    return { enabled: true };
}

/** Linux boot reconcile: an enabled entry whose Exec no longer matches this
 *  install (AppImage moved, or an entry from an older format) is rewritten. */
export function xdgEntryNeedsRewrite(content: string | null, exec: string[]): boolean {
    if (!interpretXdgEntry(content).enabled) return false;
    return desktopEntryValue(content!, 'Exec') !== exec.map(quoteExecArg).join(' ');
}

// ── Boot-time default ────────────────────────────────────────────────────────

/**
 * Should this launch register the default login item? Exactly once per
 * install (`loginItemDefaultApplied` is then written, and a later OFF is never
 * overridden), only for a supported target, and only when the store could be
 * read — an unreadable store reads as "flag absent" and would otherwise
 * re-enable an item the user turned off.
 */
export function shouldApplyLoginDefault(opts: {
    target: LoginItemTarget;
    storeOk: boolean;
    isSmokeTest: boolean;
    defaultAppliedFlag: string | null | undefined;
}): boolean {
    if (!opts.storeOk || opts.isSmokeTest) return false;
    if (opts.target.kind === 'unsupported') return false;
    return opts.defaultAppliedFlag !== 'true' && DEFAULT_START_AT_LOGIN;
}

// ── Launch decisions ─────────────────────────────────────────────────────────

/**
 * Was this launch started by the OS login item? Windows and Linux: our marker
 * arg on the command line. macOS ignores args, so it relies on Electron's
 * `wasOpenedAtLogin`; a false negative there just shows the window, which is
 * the safe direction.
 */
export function wasLaunchedAtLogin(argv: readonly string[], platform: string, macWasOpenedAtLogin: boolean): boolean {
    if (argv.includes(AUTOSTART_ARG)) return true;
    return platform === 'darwin' && macWasOpenedAtLogin === true;
}

/**
 * Start minimized ONLY for a login launch. A user double-clicking the app, the
 * installer's "Run Cipherline" at the end of setup, and the first open after
 * install all show the window — they asked for it, and a new user has to sign
 * up. The installer/post-update splash owns visibility while it is up, and an
 * unreadable store falls back to showing the window.
 */
export function shouldStartMinimized(opts: {
    launchedAtLogin: boolean;
    showInstaller: boolean;
    storeOk: boolean;
    startMinimizedStored: string | null | undefined;
}): boolean {
    if (!opts.launchedAtLogin || opts.showInstaller || !opts.storeOk) return false;
    return resolveBoolPref(opts.startMinimizedStored, DEFAULT_START_MINIMIZED);
}

/**
 * Closing the window hides it to the tray only when the preference is on AND
 * a tray icon actually exists — otherwise the window would vanish with no way
 * back but relaunching. With no tray, the close goes through normally.
 */
export function shouldHideToTrayOnClose(opts: {
    isQuitting: boolean;
    minimizeToTray: boolean;
    trayExists: boolean;
}): boolean {
    return !opts.isQuitting && opts.minimizeToTray && opts.trayExists;
}
