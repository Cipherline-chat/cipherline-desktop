/**
 * driveFolders — the Google Drive calls behind the "Select backup folder"
 * dialog: browsing the user's existing folder tree, and creating a new folder.
 *
 * TWO SCOPES, TWO JOBS (see electron/googleDriveAuth.ts for the full note):
 *
 *   • CREATING a folder works under the narrow `drive.file` scope alone: an app
 *     may always create new items and keeps access to whatever it created.
 *
 *   • LISTING someone's existing folders needs `drive.metadata.readonly`, which
 *     exposes names/ids/parents but NEVER file content. ⚠️ Google lists it among
 *     Drive's *restricted* scopes, so the app must pass Google's OAuth app
 *     verification before accounts outside the project's test-user list can
 *     connect Drive at all. That is an owner action in the Cloud Console, not
 *     something code can arrange.
 *
 * `parents` is OMITTED rather than set to 'root' when creating with no chosen
 * parent. Under `drive.file` the My Drive root is not an item we can address,
 * so naming it explicitly is a request to touch something outside the grant;
 * omitting the field makes Drive default to My Drive root, which is what we
 * want and is always permitted. (Listing is different — 'root' IS a valid
 * query alias there, and metadata.readonly covers it.)
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive's alias for "My Drive", valid in a `parents` QUERY (never as a create parent). */
export const DRIVE_ROOT_ID = 'root';

/** Stop runaway paging on an account with an absurd number of sibling folders. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export interface DriveFolder { id: string; name: string; }

/**
 * Thrown when Drive answers 401/403 to a metadata listing — i.e. the connected
 * Google account granted us `drive.file` but not `drive.metadata.readonly`.
 * That is the normal state for anyone who linked Drive BEFORE this scope was
 * re-added: the stored refresh token carries the old, narrower grant, and only
 * disconnecting and reconnecting re-runs consent. The dialog turns this into
 * "reconnect Drive" guidance rather than a raw HTTP error.
 */
export class DriveScopeMissingError extends Error {
    constructor() {
        super('SCOPE_MISSING');
        this.name = 'DriveScopeMissingError';
    }
}

/**
 * List the sub-folders of one Drive folder, alphabetically.
 *
 * @param parentId Folder id, or DRIVE_ROOT_ID for the top of My Drive.
 */
export async function listDriveFolders(token: string, parentId: string): Promise<DriveFolder[]> {
    const q = `'${parentId.replace(/'/g, "\\'")}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;

    const folders: DriveFolder[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
            q,
            fields: 'nextPageToken,files(id,name)',
            orderBy: 'name',
            pageSize: String(PAGE_SIZE),
            spaces: 'drive',
            corpora: 'user',
        });
        if (pageToken) params.set('pageToken', pageToken);

        const res = await fetch(`${DRIVE_FILES}?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        // 401/403 here means the grant lacks drive.metadata.readonly (or has
        // lapsed) — both are fixed by reconnecting, so they share a message.
        if (res.status === 401 || res.status === 403) throw new DriveScopeMissingError();
        if (!res.ok) throw new Error(`Could not list folders (HTTP ${res.status}).`);

        const data = await res.json();
        for (const f of (data.files || []) as DriveFolder[]) {
            if (f && f.id) folders.push({ id: f.id, name: f.name || 'Untitled folder' });
        }

        pageToken = data.nextPageToken || undefined;
        if (!pageToken) break;
    }

    return folders;
}

export async function createDriveFolder(
    token: string,
    name: string,
    parentId?: string | null,
): Promise<DriveFolder> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Enter a folder name.');

    const body: Record<string, unknown> = { name: trimmed, mimeType: FOLDER_MIME };
    // Only constrain the parent when the user actually picked a real folder.
    // DRIVE_ROOT_ID must never reach this field — see the header note.
    if (parentId && parentId !== DRIVE_ROOT_ID) body.parents = [parentId];

    const res = await fetch(`${DRIVE_FILES}?fields=id,name`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (res.status === 401) throw new Error('Google Drive session expired — reconnect Drive and try again.');
    if (!res.ok) throw new Error(`Could not create the folder (HTTP ${res.status}).`);

    const data = await res.json();
    return { id: data.id, name: data.name || trimmed };
}
