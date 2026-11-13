/**
 * Where the native share helper binary may come from. The helper inherits the user's xdg-desktop-portal consent and the persisted
 * ScreenCast restore_token, so a swapped binary would capture the screen silently under Cipherline's identity (Wayland shows
 * "Cipherline is sharing your screen" and nothing else). Hence:
 *   - PACKAGED build: ONLY `<resourcesPath>/share-encoder-helper` (installed by the package, root-owned / read-only AppImage mount).
 *     The CIPHERLINE_NATIVE_SHARE_HELPER env override and the user-writable `userData/native/` drop-in are IGNORED.
 *   - unpackaged (dev / lab / tester): env override, then the in-tree build, then the userData drop-in (the tester bundle's `install`).
 * Pure (all inputs injected) so the rule is unit-tested; same stance as smoke mode refusing env-only activation in packaged builds.
 */
import path from 'node:path';

export interface HelperPathInput {
    isPackaged: boolean;
    envHelper: string | undefined;
    resourcesPath: string | undefined;
    /** `path.join(__dirname, '../native/share-encoder/build/share-encoder-helper')` */
    devBuildPath: string;
    userDataPath: string;
    exists: (p: string) => boolean;
}

export function resolveNativeShareHelper(i: HelperPathInput): { path: string; source: 'packaged' | 'env' | 'dev' | 'userData' } | null {
    const packaged = i.resourcesPath ? path.join(i.resourcesPath, 'share-encoder-helper') : '';
    if (i.isPackaged) return packaged && i.exists(packaged) ? { path: packaged, source: 'packaged' } : null;
    if (i.envHelper && path.isAbsolute(i.envHelper)) return { path: i.envHelper, source: 'env' };
    if (packaged && i.exists(packaged)) return { path: packaged, source: 'packaged' };
    if (i.exists(i.devBuildPath)) return { path: i.devBuildPath, source: 'dev' };
    const user = path.join(i.userDataPath, 'native', 'share-encoder-helper');
    return i.exists(user) ? { path: user, source: 'userData' } : null;
}

/** The software test backend (pcm) is a lab tool: never in a packaged build, whatever the environment says. */
export function allowNativeShareTestBackend(isPackaged: boolean, env: string | undefined): boolean {
    return !isPackaged && env === '1';
}
