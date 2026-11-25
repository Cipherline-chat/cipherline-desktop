/**
 * Where the near-helper binary may come from. It holds the transfer key and speaks the local-network transfer protocol (and
 * asks main to verify the account secret), so a swapped binary would move the account's history to a stranger. Same stance as
 * `native-share-helper-path.ts`:
 *   - PACKAGED build: ONLY `<resourcesPath>/near-helper[.exe]` (installed by the package: the read-only AppImage mount, a
 *     signed Mach-O in the .app on macOS; the Windows NSIS build is per-user (`perMachine: false`), so it sits under
 *     `%LOCALAPPDATA%` next to app.asar). "Packaged only" therefore keeps out a stray env override or a binary dropped in a
 *     user-writable search path, NOT other code running as the same user: that code could replace app.asar just as well. The `CIPHERLINE_NEAR_HELPER` override and every
 *     user-writable location are IGNORED.
 *   - unpackaged (dev / lab): the env override, then the in-tree cargo build (release, then debug).
 * Pure (all inputs injected) so the rule is unit-tested.
 */
import path from 'node:path';

export interface NearHelperPathInput {
    isPackaged: boolean;
    envHelper: string | undefined;
    resourcesPath: string | undefined;
    /** `path.join(__dirname, '../../desktop-host/near-helper/target')` */
    devTargetDir: string;
    exists: (p: string) => boolean;
    /** Defaults to `process.platform`; `win32` adds the `.exe` suffix. */
    platform?: NodeJS.Platform;
}

/** The helper's file name in the package (`extraResources` `to:`). */
export const NEAR_HELPER_FILE = 'near-helper';
/** The cargo binary name (`[[bin]] name` of apps/desktop-host/near-helper). */
export const NEAR_HELPER_CARGO_BIN = 'cl-near-helper';

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name);

export function resolveNearHelper(i: NearHelperPathInput): { path: string; source: 'packaged' | 'env' | 'dev' } | null {
    const platform = i.platform ?? process.platform;
    // path.join on the build host would use ITS separator; the helper path is for the running platform
    const join = platform === 'win32' ? path.win32.join : path.posix.join;
    const isAbs = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
    const packaged = i.resourcesPath ? join(i.resourcesPath, exe(NEAR_HELPER_FILE, platform)) : '';
    if (i.isPackaged) return packaged && i.exists(packaged) ? { path: packaged, source: 'packaged' } : null;
    if (i.envHelper && isAbs(i.envHelper) && i.exists(i.envHelper)) return { path: i.envHelper, source: 'env' };
    if (packaged && i.exists(packaged)) return { path: packaged, source: 'packaged' };
    for (const profile of ['release', 'debug']) {
        const p = join(i.devTargetDir, profile, exe(NEAR_HELPER_CARGO_BIN, platform));
        if (i.exists(p)) return { path: p, source: 'dev' };
    }
    return null;
}
