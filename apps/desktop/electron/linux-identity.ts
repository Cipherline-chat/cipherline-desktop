/**
 * linux-identity.ts — one application identity for the .deb and the AppImage.
 *
 * KDE (Plasma 6, kwalletd, xdg-desktop-portal) names a process by finding the
 * .desktop file for its app id; with none it shows "unidentifiable application".
 * Chromium takes our app id from `desktopName` in package.json
 * (`cipherline.desktop` -> app_id/WM class `cipherline`). The .deb installs that
 * file under /usr/share/applications. The AppImage installs nothing, so every
 * prompt from an AppImage run (global shortcuts, wallet, notifications) had no
 * application behind it.
 *
 * Decision (AppImage): write a USER-LEVEL `cipherline.desktop` on the first run
 * and refresh it when `$APPIMAGE` moves, rather than only registering over the
 * portal. Why: the portal Registry call covers the portal alone and itself needs
 * a desktop file (`<id>.desktop`, "App info not found" without); the wallet, the
 * notification server and the task manager match on the file too. The file is ours
 * only if it carries `X-Cipherline-Managed=true`: a file without it (a
 * hand-made one, AppImageLauncher's own) is never touched, and a system-wide
 * `cipherline.desktop` (the .deb) is never shadowed from an AppImage run.
 *
 * The portal id (`chat.cipherline.Cipherline`, see wayland-global-shortcuts.ts)
 * keeps its own hidden file; it is refreshed the same way so its Exec follows the
 * running install.
 *
 * Pure of `electron`; the fs is injected (linux-identity.test.ts).
 */
import path from 'node:path';
import { MANAGED_KEY, desktopEntryValue, quoteExecArg } from './login-item';

/** `desktopName` in package.json; Chromium derives the Wayland app_id / WM class from it. */
export const MAIN_DESKTOP_FILE = 'cipherline.desktop';
export const WM_CLASS = 'Cipherline';

export interface IdentityFs {
    existsSync(p: string): boolean;
    readFileSync(p: string, enc: 'utf8'): string;
    writeFileSync(p: string, data: string, opts?: { mode?: number }): void;
    renameSync(a: string, b: string): void;
    mkdirSync(p: string, opts?: { recursive: boolean }): void;
    copyFileSync?(src: string, dest: string): void;
}

export function dataDirs(env: Readonly<Record<string, string | undefined>>, home: string): { dataHome: string; all: string[] } {
    const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
    const sys = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
    return { dataHome, all: [dataHome, ...sys] };
}

export function buildMainDesktopEntry(execPath: string): string {
    return [
        '[Desktop Entry]', 'Type=Application', 'Version=1.0', 'Name=Cipherline',
        'Comment=End-to-end encrypted messaging and calls',
        `Exec=${quoteExecArg(execPath)} %U`, 'Icon=cipherline', 'Terminal=false',
        'Categories=Network;Chat;', `StartupWMClass=${WM_CLASS}`,
        `${MANAGED_KEY}=true`, '',
    ].join('\n');
}

function isManaged(content: string): boolean {
    return (desktopEntryValue(content, MANAGED_KEY) ?? '').toLowerCase() === 'true';
}

/**
 * Write `file` into the user applications dir unless something that is not ours
 * is already there. Returns what happened. Never throws.
 */
export function writeManagedDesktopFile(fsApi: IdentityFs, dir: string, file: string, content: string): 'written' | 'unchanged' | 'foreign' | 'error' {
    try {
        const target = path.join(dir, file);
        if (fsApi.existsSync(target)) {
            let cur = '';
            try { cur = fsApi.readFileSync(target, 'utf8'); } catch { return 'error'; }
            if (!isManaged(cur)) return 'foreign';
            if (cur === content) return 'unchanged';
        }
        fsApi.mkdirSync(dir, { recursive: true });
        const tmp = `${target}.tmp`;
        fsApi.writeFileSync(tmp, content, { mode: 0o644 });
        fsApi.renameSync(tmp, target);
        return 'written';
    } catch {
        return 'error';
    }
}

/**
 * Make `cipherline.desktop` resolvable for this run.
 * - .deb / unpacked (no `$APPIMAGE`): the package owns the file; do nothing.
 * - AppImage: a system-wide one exists (the .deb is also installed): do nothing,
 *   it already names the app. Else write / refresh the user-level one.
 */
export function ensureMainDesktopEntry(
    fsApi: IdentityFs,
    env: Readonly<Record<string, string | undefined>>,
    home: string,
): 'package-owned' | 'system-entry' | 'written' | 'unchanged' | 'foreign' | 'error' {
    const appImage = env.APPIMAGE;
    if (typeof appImage !== 'string' || !appImage.startsWith('/')) return 'package-owned';
    const { dataHome, all } = dataDirs(env, home);
    const systemHas = all.filter(d => d !== dataHome).some(d => fsApi.existsSync(path.join(d, 'applications', MAIN_DESKTOP_FILE)));
    if (systemHas) return 'system-entry';
    const r = writeManagedDesktopFile(fsApi, path.join(dataHome, 'applications'), MAIN_DESKTOP_FILE, buildMainDesktopEntry(appImage));
    if (r === 'written' || r === 'unchanged') ensureUserIcon(fsApi, env, dataHome);
    return r;
}

/** Icon sizes the AppImage carries (build-assets/linux-icons), largest first. */
const ICON_SIZES = ['512x512', '256x256', '128x128'];

/**
 * `Icon=cipherline` resolves through the icon theme, and the AppImage installs no icon, so KDE drew a blank one.
 * Copy the AppImage's own icon ($APPDIR/usr/share/icons/hicolor/<size>/apps/cipherline.png, electron-builder's
 * layout) into the user's hicolor theme once. An icon already there (ours from an earlier run, or anyone's) is left
 * alone. Never throws: a missing icon is cosmetic.
 */
export function ensureUserIcon(fsApi: IdentityFs, env: Readonly<Record<string, string | undefined>>, dataHome: string): 'copied' | 'present' | 'no-source' | 'error' {
    try {
        const appDir = env.APPDIR;
        if (!fsApi.copyFileSync || typeof appDir !== 'string' || !appDir.startsWith('/')) return 'no-source';
        for (const size of ICON_SIZES) {
            const dest = path.join(dataHome, 'icons', 'hicolor', size, 'apps', 'cipherline.png');
            if (fsApi.existsSync(dest)) return 'present';
        }
        for (const size of ICON_SIZES) {
            const src = path.join(appDir, 'usr', 'share', 'icons', 'hicolor', size, 'apps', 'cipherline.png');
            if (!fsApi.existsSync(src)) continue;
            const destDir = path.join(dataHome, 'icons', 'hicolor', size, 'apps');
            fsApi.mkdirSync(destDir, { recursive: true });
            fsApi.copyFileSync(src, path.join(destDir, 'cipherline.png'));
            return 'copied';
        }
        return 'no-source';
    } catch {
        return 'error';
    }
}
