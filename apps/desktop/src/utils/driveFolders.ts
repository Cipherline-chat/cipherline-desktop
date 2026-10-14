/**
 * driveFolders — where on Google Drive the encrypted backup lives.
 *
 * ONE SCOPE, ONE RULE (see electron/googleDriveAuth.ts): the app only holds
 * `drive.file`, under which it can see and modify ONLY the files and folders it
 * created itself (or that the user explicitly opened with it). It cannot
 * enumerate the user's Drive, so there is no folder browser and no folder
 * picker. Backups go into one folder the app creates, "Cipherline Backups".
 *
 * Finding that folder again, in order of trust:
 *
 *   1. The STORED folder id. The app keeps access to a folder it created even
 *      after the user moves or renames it in Drive, so the id outlives both.
 *   2. A `q` search for a folder with the app's name. Under `drive.file` this
 *      can only ever return folders THIS app created — which is exactly the
 *      set we want — and works on a second device that has never seen the id
 *      (the scope is per Google Cloud project, so a folder created on device A
 *      is visible to the app on device B after sign-in).
 *   3. Create it.
 *
 * `parents` is OMITTED when creating: under `drive.file` the My Drive root is
 * not an item the app can address, and omitting the field makes Drive default
 * to the root, which is always permitted.
 */

export const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** The folder the app creates and keeps its backups in. */
export const APP_BACKUP_FOLDER = 'Cipherline Backups';

/** Escape a value for use inside a single-quoted Drive `q` string literal. */
export function escapeDriveQuery(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * True for the specific Drive REST statuses that mean "this app no longer has
 * access to this exact file/folder" — it was deleted, or it is outside what
 * the narrow `drive.file` grant lets the app see (a folder the user chose
 * themselves back when the app could browse). Anything else (network outage,
 * a 401 from an expired token, a 5xx) is NOT this and must propagate as a real
 * failure rather than be papered over.
 */
export function isStaleAccessStatus(status: number): boolean {
    return status === 403 || status === 404;
}

/**
 * Whether `folderId` — a previously stored backup folder — is still reachable
 * under the app's current grant and not in the trash. A lightweight metadata
 * GET scoped to that exact ID, so classification is unambiguous: a 403/404 on
 * THIS call means the folder itself is the problem, not a transient or
 * auth-wide failure. Any other error (network, 401, 5xx) rethrows so the
 * caller fails normally instead of silently reassigning the backup target.
 */
export async function isFolderAccessible(token: string, folderId: string): Promise<boolean> {
    const res = await fetch(`${DRIVE_FILES}/${folderId}?fields=id,trashed`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
        const data = await res.json().catch(() => null);
        return !(data && data.trashed === true);
    }
    if (isStaleAccessStatus(res.status)) return false;
    throw new Error(`Drive query failed: ${res.status}`);
}

/**
 * Find the app's own backup folder by name, anywhere in Drive (it may have
 * been moved). Under `drive.file` only app-created folders are visible, so a
 * folder the user happened to name the same is never returned. If several
 * exist (two devices raced to create it) the OLDEST wins, so every device
 * converges on the one that already holds backups.
 */
export async function findAppFolder(token: string, name: string = APP_BACKUP_FOLDER): Promise<string | null> {
    const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(name)}' and trashed=false`);
    const res = await fetch(
        `${DRIVE_FILES}?q=${q}&fields=${encodeURIComponent('files(id,createdTime)')}&orderBy=createdTime&pageSize=10&spaces=drive`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Drive query failed: ${res.status}`);
    const data = await res.json();
    return data.files?.[0]?.id ?? null;
}

/** Create the backup folder (no `parents` — see the header note). */
export async function createAppFolder(token: string, name: string = APP_BACKUP_FOLDER): Promise<string> {
    const res = await fetch(DRIVE_FILES, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    if (res.status === 401) throw new Error('Google Drive session expired — reconnect Drive and try again.');
    if (!res.ok) throw new Error(`Drive folder create failed: ${res.status}`);
    return (await res.json()).id;
}

export async function ensureAppFolder(token: string, name: string = APP_BACKUP_FOLDER): Promise<string> {
    return (await findAppFolder(token, name)) ?? createAppFolder(token, name);
}

export interface DriveFolderResolution {
    /** Folder to use for this run/operation. Null only when `create` is
     *  false and no app folder exists at all (e.g. a first-ever restore or
     *  info check). */
    folderId: string | null;
    /** True when a stored folder id was no longer usable (403/404/trashed)
     *  and this fell back to the app's own folder instead of failing. The
     *  caller should persist the new id and tell the user. */
    recovered: boolean;
}

/**
 * Resolve the Drive folder for an operation:
 *
 *   - A stored id that is still accessible: used as-is (this is what keeps a
 *     moved or renamed folder working — and, for accounts that connected under
 *     the old broader grant, a folder they once chose themselves).
 *   - No stored id: find the app's folder by name, or create it when
 *     `create: true`.
 *   - A stored id that 403s/404s: NOT fatal. Falls back to the app's folder
 *     (found, or created with `create: true`) and reports `recovered: true`.
 *   - Any other failure while checking the stored id (network outage, an
 *     expired token, ...) is a real failure and propagates unchanged — never
 *     treated as a stale folder.
 *
 * `folderName` exists for callers/tests that pass it explicitly; production
 * callers always pass APP_BACKUP_FOLDER because the user can no longer pick a
 * different folder (a stored legacy NAME is ignored — it would otherwise make
 * the app create a folder called whatever the user once picked).
 */
export async function resolveDriveFolder(
    token: string,
    storedFolderId: string | null | undefined,
    folderName: string,
    opts: { create: boolean },
): Promise<DriveFolderResolution> {
    const findOrCreate = () => (opts.create ? ensureAppFolder(token, folderName) : findAppFolder(token, folderName));
    if (!storedFolderId) return { folderId: await findOrCreate(), recovered: false };
    if (await isFolderAccessible(token, storedFolderId)) return { folderId: storedFolderId, recovered: false };
    return { folderId: await findOrCreate(), recovered: true };
}
