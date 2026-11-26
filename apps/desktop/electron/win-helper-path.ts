/**
 * Where the Windows helper binary may come from. Same stance as near-helper-path.ts: in a PACKAGED build only
 * `<resourcesPath>/win-helper.exe` (installed and signed by the package); the env override and every user-writable location
 * are ignored. Unpackaged (dev): the env override, then the in-tree cargo build (release, then debug). Pure, unit-tested.
 */
import path from 'node:path';

export const WIN_HELPER_FILE = 'win-helper.exe';
/** The cargo binary name (`[[bin]] name` of apps/desktop-host/win-helper). */
export const WIN_HELPER_CARGO_BIN = 'cl-win-helper.exe';

export interface WinHelperPathInput {
    isPackaged: boolean;
    envHelper: string | undefined;
    resourcesPath: string | undefined;
    /** `path.join(__dirname, '../../desktop-host/win-helper/target')` */
    devTargetDir: string;
    exists: (p: string) => boolean;
    platform?: NodeJS.Platform;
}

export function resolveWinHelper(i: WinHelperPathInput): { path: string; source: 'packaged' | 'env' | 'dev' } | null {
    if ((i.platform ?? process.platform) !== 'win32') return null;
    const packaged = i.resourcesPath ? path.win32.join(i.resourcesPath, WIN_HELPER_FILE) : '';
    if (i.isPackaged) return packaged && i.exists(packaged) ? { path: packaged, source: 'packaged' } : null;
    if (i.envHelper && path.win32.isAbsolute(i.envHelper) && i.exists(i.envHelper)) return { path: i.envHelper, source: 'env' };
    if (packaged && i.exists(packaged)) return { path: packaged, source: 'packaged' };
    for (const profile of ['release', 'debug']) {
        const p = path.win32.join(i.devTargetDir, profile, WIN_HELPER_CARGO_BIN);
        if (i.exists(p)) return { path: p, source: 'dev' };
    }
    return null;
}
