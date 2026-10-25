/**
 * fs-confinement — which paths the RENDERER may name on each fs-shaped IPC
 * channel (`fs:read-file`, `fs:write-file`, `fs:read-dir`, `fs:unlink`, the
 * `backup:*` family and `gdrive:upload-file`).
 *
 * WHY THIS IS NOT "ANYTHING UNDER userData"
 * userData is the main process's control plane as well as the renderer's
 * scratch space: `store.key` and `secure-store.json` (the keystore),
 * `startup-flags.json`, `update-install-attempt.json`, window state, crash
 * markers, and the persisted list of folders the user picked. Treating the
 * whole directory as one renderer-reachable root let renderer code read the
 * keystore files and rewrite the folder grant list, so a renderer compromise
 * turned into whole-disk file access after the next restart. The renderer only
 * ever needs a few named SUBDIRECTORIES of userData, so those are the roots,
 * and nothing at the top level of userData is reachable at all.
 *
 * WHAT A PICKED FOLDER GRANTS
 * A folder the user picked in the OS dialog (the local backup folder) grants
 * the backup operations on `.enc` files in it, listing it, and deleting `.enc`
 * files from it (retiring the old chunked backup layout). It does NOT grant
 * reading or writing arbitrary files there: the user chose a place to keep
 * backups, which is not consent to the app reading `~/.ssh` because that
 * folder happened to be the home directory. And a picked folder never reaches
 * into userData, even when it contains it; userData is reachable only through
 * the named app roots.
 *
 * No `electron` import: main.ts injects the live state, tests inject fixtures.
 */

import * as nodePath from 'path';
import { isPathInside } from './path-containment';

/** Subdirectories of userData that renderer fs channels may use. */
export const RENDERER_APP_SUBDIRS = {
    /** Encrypted GIF library (src/utils/gifStorage.ts). */
    gifs: 'cipherline-gifs',
    /** Drive backup staging copy (src/services/driveBackup.ts). */
    backupStaging: 'backup-staging',
} as const;

export type RendererFsOp =
    /** fs:read-file */
    | 'read'
    /** fs:write-file */
    | 'write'
    /** fs:read-dir */
    | 'list'
    /** fs:unlink */
    | 'unlink'
    /** fs:write-backup-file / backup:begin-write — the DIRECTORY argument */
    | 'backup-dir'
    /** backup:stat / backup:read-range */
    | 'backup-read'
    /** gdrive:upload-file — the source file */
    | 'drive-upload';

export interface FsConfinementState {
    userData: string;
    /** Folders granted through the native directory picker. */
    pickedDirs: Iterable<string>;
    /** Files picked in an open dialog this launch (normalised, see `normalize`). */
    pickedFiles: ReadonlySet<string>;
    /** Files named in a save dialog this launch (normalised, realpath'd). */
    saveFiles: ReadonlySet<string>;
    platform: NodeJS.Platform;
    /** Symlink-resolving realpath with a missing-leaf fallback. */
    resolveReal: (p: string) => string;
    /** Path implementation; tests pass `path.win32` to exercise Windows rules. */
    pathApi?: typeof nodePath;
}

/** A backup container name: `.enc`, no separators. */
export function isBackupFileName(name: string): boolean {
    return typeof name === 'string' && name.length > 0 && name.endsWith('.enc')
        && !/[/\\]/.test(name) && !name.includes('..');
}

/**
 * Resolve `p` and decide whether the renderer may perform `op` on it.
 * Returns the resolved path to operate on, or throws.
 */
export function assertRendererPath(state: FsConfinementState, op: RendererFsOp, p: unknown): string {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('Invalid path');
    const P = state.pathApi ?? nodePath;
    const isWin = state.platform === 'win32';
    const norm = (s: string) => (isWin ? s.toLowerCase() : s);
    const inside = (base: string, target: string) =>
        isPathInside(norm(base), norm(target), { allowEqual: true, pathApi: P });

    const resolvedLexical = P.resolve(p);
    const resolved = state.resolveReal(resolvedLexical);
    const userData = state.resolveReal(P.resolve(state.userData));

    const appRoot = (sub: string) => P.join(userData, sub);
    const inAppRoot = (subs: readonly string[]) => subs.some(s => inside(appRoot(s), resolved));
    const allSubs = Object.values(RENDERER_APP_SUBDIRS);

    // userData is reachable ONLY through the named app roots above, whatever
    // folder grant might otherwise cover it.
    const inUserData = inside(userData, resolved);
    const inPickedDir = !inUserData && [...state.pickedDirs].some(d => {
        if (typeof d !== 'string' || !d) return false;
        return inside(state.resolveReal(P.resolve(d)), resolved);
    });
    const base = P.basename(resolved);
    const pickedFile = state.pickedFiles.has(norm(resolvedLexical)) || state.pickedFiles.has(norm(resolved));

    let ok = false;
    switch (op) {
        case 'read':
            ok = inAppRoot(allSubs) || pickedFile;
            break;
        case 'write':
            ok = inAppRoot(allSubs) || state.saveFiles.has(norm(resolved));
            break;
        case 'list':
            ok = inAppRoot(allSubs) || inPickedDir;
            break;
        case 'unlink':
            ok = inAppRoot(allSubs) || (inPickedDir && isBackupFileName(base));
            break;
        case 'backup-dir': {
            const staging = appRoot(RENDERER_APP_SUBDIRS.backupStaging);
            ok = norm(resolved) === norm(staging) || inPickedDir;
            break;
        }
        case 'backup-read':
            ok = pickedFile
                || inAppRoot([RENDERER_APP_SUBDIRS.backupStaging])
                || (inPickedDir && isBackupFileName(base));
            break;
        case 'drive-upload':
            ok = inAppRoot([RENDERER_APP_SUBDIRS.backupStaging]) && isBackupFileName(base);
            break;
    }
    if (!ok) throw new Error(`Path outside allowed root: ${p}`);
    return resolved;
}

/**
 * Picked-folder persistence. Lives in SecureStore under a key the renderer
 * cannot name (it is not in secure-store-policy.ts's RENDERER_SECURE_KEYS),
 * so the grant list is only ever written by main, from the native picker.
 */
export const PICKED_DIRS_STORE_KEY = 'main_picked_dirs_v1';

/** Parse the stored list; anything malformed yields an empty grant. */
export function parsePickedDirs(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 4096);
    } catch {
        return [];
    }
}
