/**
 * driveFolders — where on Google Drive the encrypted backup lives.
 *
 * ONE SCOPE, ONE RULE (see electron/googleDriveAuth.ts): the app only holds
 * `drive.file`, under which it can see and modify ONLY the files and folders it
 * created itself (or that the user explicitly opened with it). It cannot
 * enumerate the user's Drive, so there is no folder browser and no folder
 * picker. Backups go into one folder the app creates, "Cipherline Backups".
 *
 * The renderer holds no Drive token and makes no Drive REST call: finding,
 * creating and validating that folder happens in the main process
 * (electron/drive-api.ts) behind `window.electronAPI.gdrive*`. Finding the
 * folder again, in order of trust:
 *
 *   1. The STORED folder id. The app keeps access to a folder it created even
 *      after the user moves or renames it in Drive, so the id outlives both.
 *   2. A name search for the app's folder. Under `drive.file` this can only
 *      ever return folders THIS app created — which is exactly the set we
 *      want — and works on a second device that has never seen the id (the
 *      scope is per Google Cloud project, so a folder created on device A is
 *      visible to the app on device B after sign-in).
 *   3. Create it.
 */

/** The folder the app creates and keeps its backups in. */
export const APP_BACKUP_FOLDER = 'Cipherline Backups';

export interface DriveFolderResolution {
    /** Folder to use for this run/operation. Null only when `create` is
     *  false and no app folder exists at all (e.g. a first-ever restore or
     *  info check). */
    folderId: string | null;
    /** True when a stored folder id was no longer usable (403/404/trashed/not
     *  the app's folder) and this fell back to the app's own folder instead of
     *  failing. The caller should persist the new id and tell the user. */
    recovered: boolean;
}

/**
 * Resolve the Drive folder for an operation (main process does the work):
 *
 *   - A stored id that is still the app's folder: used as-is (this is what
 *     keeps a moved or renamed folder working).
 *   - No stored id: find the app's folder by name, or create it when
 *     `create: true`.
 *   - A stored id that 403s/404s: NOT fatal. Falls back to the app's folder
 *     (found, or created with `create: true`) and reports `recovered: true`.
 *   - Any other failure while checking the stored id (network outage, an
 *     expired token, ...) is a real failure and propagates unchanged — never
 *     treated as a stale folder.
 */
export async function resolveDriveFolder(
    storedFolderId: string | null | undefined,
    opts: { create: boolean },
): Promise<DriveFolderResolution> {
    const api = window.electronAPI;
    if (!api?.gdriveResolveFolder) throw new Error('Desktop bridge not loaded. Fully quit and re-run the app.');
    return api.gdriveResolveFolder(storedFolderId ?? null, opts.create);
}
