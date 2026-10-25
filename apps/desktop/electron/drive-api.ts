/**
 * Google Drive REST access — main process only.
 *
 * The renderer never holds a Drive access token and never talks to
 * googleapis.com. Everything it used to do with `fetch` + a bearer token
 * (find/create the backup folder, look a backup up, stat one file, list and
 * delete old backup files) is a purpose-specific operation here, behind a
 * narrow IPC channel (see main.ts), with its own input validation. A hostile
 * renderer can therefore ask for exactly these operations and nothing else: it
 * cannot read the token, cannot address an arbitrary Drive endpoint, cannot
 * share a file, and cannot touch anything that is not a backup file
 * (`*.enc`) inside the app's own backup folder.
 *
 * Scope reminder (googleDriveAuth.ts): the token only holds `drive.file`, so
 * Drive itself already limits it to files/folders this app created. The checks
 * below are the second wall: they bound what the app's OWN token can be asked
 * to do on a renderer's say-so.
 *
 * Free of any `electron` import so it is unit-testable with a fake transport
 * (see drive-api.test.ts).
 */

import type { DriveHttp } from './driveTransfer';
import { escapeDriveQueryLiteral } from './drive-query';

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** The folder the app creates and keeps its backups in. */
export const APP_BACKUP_FOLDER = 'Cipherline Backups';

/** Drive ids are URL-safe base64-ish; nothing else is ever sent to Drive. */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** A backup file name: a plain `<base>.enc`, no path separators or control chars. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const BACKUP_NAME_RE = /^[^\x00-\x1f\x7f/\\]{1,200}\.enc$/;
/** The user-chosen file base (without `.enc`), same constraints. */
// eslint-disable-next-line no-control-regex
const FILE_BASE_RE = /^[^\x00-\x1f\x7f/\\]{1,200}$/;
/** How long a folder that passed verification is trusted without a re-check. */
const FOLDER_VERIFY_TTL_MS = 60_000;
const MAX_DELETE_NAMES = 1000;

export interface DriveManifestFile {
    id: string;
    name: string;
    createdTime?: string;
    modifiedTime?: string;
    size?: string;
    parents?: string[];
    canEdit?: boolean;
}

export type DriveBackupTarget =
    | { kind: 'folder'; folderId: string; recovered: boolean }
    | { kind: 'file'; folderId: string; file: DriveManifestFile };

export class DriveStatusError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'DriveStatusError';
        this.status = status;
    }
}

export function isValidDriveId(id: unknown): id is string {
    return typeof id === 'string' && DRIVE_ID_RE.test(id);
}
export function isValidBackupFileName(name: unknown): name is string {
    return typeof name === 'string' && BACKUP_NAME_RE.test(name) && !name.includes('..');
}
function isValidFileBase(base: unknown): base is string {
    return typeof base === 'string' && FILE_BASE_RE.test(base) && !base.includes('..');
}

/** True for the statuses that mean "this app no longer has access to this exact file/folder". */
const isStaleAccessStatus = (status: number) => status === 403 || status === 404;

const DEFAULT_FILE_BASE = 'cipherline-backup';
const stripEnc = (s: string) => s.replace(/\.enc$/, '');
function manifestBase(fileBase: string | null | undefined): string {
    const b = fileBase && fileBase.trim() ? fileBase.trim() : DEFAULT_FILE_BASE;
    return stripEnc(b);
}

/**
 * Pick the newest chunked-era manifest out of a listing — the restore fallback
 * when no `<base>.enc` exists yet. `name contains` is a substring match
 * server-side, so re-filter on a real prefix here; also drops chunk files.
 */
export function selectLatestManifest(files: DriveManifestFile[], basePattern: string): DriveManifestFile | null {
    const manifests = (files || []).filter(f =>
        f && typeof f.name === 'string' &&
        f.name.startsWith(basePattern) && f.name.endsWith('.enc') && !f.name.startsWith('chunk-'));
    if (!manifests.length) return null;
    const stamp = (f: DriveManifestFile) => Date.parse(f.modifiedTime || f.createdTime || '') || 0;
    return manifests.reduce((best, f) => (stamp(f) > stamp(best) ? f : best));
}

export interface DriveApiDeps {
    http: DriveHttp;
    getToken: () => Promise<string>;
    /** The backup-folder id this app last created/found (persisted by main). */
    getTrustedFolderId: () => string | null;
    setTrustedFolderId: (id: string) => void;
    now?: () => number;
}

export function createDriveApi(deps: DriveApiDeps) {
    const now = deps.now ?? Date.now;
    const verifiedFolders = new Map<string, number>(); // id -> verified-at

    /* eslint-disable @typescript-eslint/no-explicit-any -- untyped Drive REST JSON */
    async function call(method: string, url: string, jsonBody?: unknown): Promise<{ status: number; json: any }> {
        const body = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody));
        const res = await deps.http(url, {
            method,
            headers: {
                Authorization: `Bearer ${await deps.getToken()}`,
                ...(body ? { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': body.length } : {}),
            },
            body,
        });
        let json: any = null;
        if (res.body && res.body.length) { try { json = JSON.parse(res.body.toString('utf8')); } catch { json = null; } }
        return { status: res.status, json };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const encodeFields = (f: string) => encodeURIComponent(f);

    async function listQuery(q: string, fields: string, extra = ''): Promise<DriveManifestFile[]> {
        const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeFields(fields)}&spaces=drive${extra}`;
        const { status, json } = await call('GET', url);
        if (status !== 200) throw new DriveStatusError(`Drive query failed: ${status}`, status);
        return Array.isArray(json?.files) ? json.files : [];
    }

    // ── Folder trust ────────────────────────────────────────────────────────

    /**
     * Whether `folderId` is the app's own backup folder: a real, non-trashed
     * folder that is EITHER the one this app recorded when it created/found
     * it (so a user rename in Drive is harmless) OR carries the app's folder
     * name. 403/404 (and a folder that fails those tests) read as "stale";
     * any other failure (network, 401, 5xx) propagates.
     */
    async function isAppFolder(folderId: string): Promise<boolean> {
        const t = verifiedFolders.get(folderId);
        if (t !== undefined && now() - t < FOLDER_VERIFY_TTL_MS) return true;
        const { status, json } = await call('GET', `${DRIVE_FILES_URL}/${folderId}?fields=${encodeFields('id,name,mimeType,trashed')}`);
        if (status === 200) {
            if (!json || json.trashed === true || json.mimeType !== FOLDER_MIME) return false;
            let trusted: string | null = null;
            try { trusted = deps.getTrustedFolderId(); } catch { trusted = null; }
            if (json.name !== APP_BACKUP_FOLDER && trusted !== folderId) return false;
            remember(folderId);
            return true;
        }
        if (isStaleAccessStatus(status)) return false;
        throw new DriveStatusError(`Drive query failed: ${status}`, status);
    }
    function remember(folderId: string): void {
        verifiedFolders.set(folderId, now());
        try {
            if (deps.getTrustedFolderId() !== folderId) deps.setTrustedFolderId(folderId);
        } catch { /* best-effort record */ }
    }
    /** For operations that cannot proceed on a non-app folder. */
    async function assertAppFolder(folderId: unknown): Promise<string> {
        if (!isValidDriveId(folderId)) throw new Error('Invalid Drive folder id');
        if (!(await isAppFolder(folderId))) throw new Error('Refusing to use a Drive folder that is not the Cipherline backup folder');
        return folderId;
    }

    async function findFolder(): Promise<string | null> {
        const files = await listQuery(
            `mimeType='${FOLDER_MIME}' and name='${escapeDriveQueryLiteral(APP_BACKUP_FOLDER)}' and trashed=false`,
            'files(id,createdTime)', '&orderBy=createdTime&pageSize=10',
        );
        const id = files.find(f => isValidDriveId(f?.id))?.id ?? null;
        if (id) remember(id);
        return id;
    }
    async function createFolder(): Promise<string> {
        // No `parents`: under drive.file the My Drive root is not addressable and
        // omitting the field defaults to it, which is always permitted.
        const { status, json } = await call('POST', DRIVE_FILES_URL, { name: APP_BACKUP_FOLDER, mimeType: FOLDER_MIME });
        if (status === 401) throw new Error('Google Drive session expired — reconnect Drive and try again.');
        if (status !== 200 && status !== 201) throw new DriveStatusError(`Drive folder create failed: ${status}`, status);
        if (!isValidDriveId(json?.id)) throw new Error('Drive folder create returned no id');
        remember(json.id);
        return json.id;
    }
    async function ensureFolder(): Promise<string> {
        return (await findFolder()) ?? createFolder();
    }

    /**
     * Resolve the folder for an operation: a still-usable stored id as-is; no
     * stored id → find (or, with `create`, create) the app folder; a stored id
     * that is gone/foreign/trashed → fall back to the app folder with
     * `recovered: true`. Any other failure propagates.
     */
    async function resolveFolder(stored: string | null | undefined, create: boolean): Promise<{ folderId: string | null; recovered: boolean }> {
        const findOrCreate = () => (create ? ensureFolder() : findFolder());
        if (!stored) return { folderId: await findOrCreate(), recovered: false };
        if (isValidDriveId(stored) && await isAppFolder(stored)) return { folderId: stored, recovered: false };
        return { folderId: await findOrCreate(), recovered: true };
    }

    // ── Backup files ────────────────────────────────────────────────────────

    const LIST_FIELDS = 'files(id,name,modifiedTime,createdTime,size)';
    const ANYWHERE_FIELDS = 'files(id,name,modifiedTime,createdTime,size,parents,capabilities/canEdit)';
    const NEWEST_FIRST = '&orderBy=' + encodeURIComponent('modifiedTime desc');

    const clean = (f: any): DriveManifestFile => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime, size: f.size,
        parents: Array.isArray(f.parents) ? f.parents.filter(isValidDriveId) : undefined,
        canEdit: typeof f.capabilities?.canEdit === 'boolean' ? f.capabilities.canEdit : undefined,
    });
    /** Only backup-shaped, validly-identified files ever cross back to the renderer. */
    const backupShaped = (f: DriveManifestFile) => !!f && isValidDriveId(f.id) && isValidBackupFileName(f.name);

    async function findFile(folderId: unknown, name: unknown): Promise<DriveManifestFile | null> {
        const folder = await assertAppFolder(folderId);
        if (!isValidBackupFileName(name)) throw new Error('Invalid backup filename');
        const files = await listQuery(
            `name='${escapeDriveQueryLiteral(name)}' and '${escapeDriveQueryLiteral(folder)}' in parents and trashed=false`, LIST_FIELDS,
        );
        const f = files.map(clean).find(backupShaped);
        return f ? { id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime, size: f.size } : null;
    }

    async function listFolder(folderId: unknown): Promise<DriveManifestFile[]> {
        const folder = await assertAppFolder(folderId);
        const files = await listQuery(`'${escapeDriveQueryLiteral(folder)}' in parents and trashed=false`, LIST_FIELDS, '&pageSize=1000');
        return files.map(clean).filter(backupShaped)
            .map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime, size: f.size }));
    }

    async function findFileAnywhere(name: string): Promise<DriveManifestFile | null> {
        if (!isValidBackupFileName(name)) throw new Error('Invalid backup filename');
        const files = await listQuery(
            `name='${escapeDriveQueryLiteral(name)}' and mimeType!='${FOLDER_MIME}' and trashed=false`, ANYWHERE_FIELDS, NEWEST_FIRST + '&pageSize=10',
        );
        const f = files.map(clean).find(x => backupShaped(x) && x.name === name);
        return f ?? null;
    }

    async function findBackupAnywhere(fileBase: string | null | undefined): Promise<DriveManifestFile | null> {
        const base = manifestBase(fileBase);
        const exact = await findFileAnywhere(`${base}.enc`);
        if (exact) return exact;
        const files = await listQuery(
            `name contains '${escapeDriveQueryLiteral(base)}' and mimeType!='${FOLDER_MIME}' and trashed=false`, ANYWHERE_FIELDS, NEWEST_FIRST + '&pageSize=100',
        );
        return selectLatestManifest(files.map(clean).filter(backupShaped), base);
    }

    async function findBackupInFolder(folderId: string, fileBase: string | null | undefined): Promise<DriveManifestFile | null> {
        const base = manifestBase(fileBase);
        const exact = await findFile(folderId, `${base}.enc`);
        if (exact) return exact;
        return selectLatestManifest(await listFolder(folderId), base);
    }

    /** Find the backup to restore / report on: in the (resolved) app folder, else anywhere the app can see. */
    async function locateBackup(stored: string | null | undefined, fileBase: string | null | undefined): Promise<{
        file: DriveManifestFile | null; folderId: string | null; recovered: boolean; inFolder: boolean;
    }> {
        if (fileBase != null && !isValidFileBase(fileBase)) throw new Error('Invalid backup filename');
        const { folderId, recovered } = await resolveFolder(stored, false);
        const inFolder = folderId ? await findBackupInFolder(folderId, fileBase) : null;
        const file = inFolder ?? await findBackupAnywhere(fileBase);
        return { file, folderId, recovered, inFolder: !!inFolder };
    }

    /**
     * Where a backup run writes: the stored folder if still the app's, else an
     * app-owned `<fileName>` the app may still edit in place (a backup written
     * into a folder the user picked back under a broader grant), else the app
     * folder (created if needed).
     */
    async function resolveBackupTarget(stored: string | null | undefined, fileName: unknown): Promise<DriveBackupTarget> {
        if (!isValidBackupFileName(fileName)) throw new Error('Invalid backup filename');
        if (stored && isValidDriveId(stored)) {
            if (await isAppFolder(stored)) return { kind: 'folder', folderId: stored, recovered: false };
            const file = await findFileAnywhere(fileName);
            if (file && file.canEdit !== false) return { kind: 'file', folderId: stored, file };
        }
        return { kind: 'folder', folderId: await ensureFolder(), recovered: !!stored };
    }

    /**
     * Metadata for a single file the renderer named by id, accepted only if it
     * really is a backup file: not a folder, a plain `*.enc` name, optionally a
     * specific name, within the size cap. null = gone / not ours / trashed.
     */
    async function backupFileMeta(
        fileId: unknown, expectName?: string,
    ): Promise<{ id: string; name: string; size: number; modifiedTime?: string } | null> {
        if (!isValidDriveId(fileId)) throw new Error('Invalid Drive file id');
        const { status, json } = await call('GET', `${DRIVE_FILES_URL}/${fileId}?fields=${encodeFields('id,name,mimeType,trashed,size,modifiedTime')}`);
        if (isStaleAccessStatus(status)) return null;
        if (status !== 200) throw new DriveStatusError(`Drive query failed: ${status}`, status);
        if (!json || json.trashed === true) return null;
        if (json.mimeType === FOLDER_MIME || !isValidBackupFileName(json.name)) throw new Error('Refusing to use a Drive file that is not a backup file');
        if (expectName !== undefined && json.name !== expectName) throw new Error('Drive file name does not match the requested backup');
        return { id: fileId, name: json.name, size: json.size ? parseInt(json.size, 10) || 0 : 0, modifiedTime: json.modifiedTime };
    }

    async function statFile(fileId: unknown): Promise<{ size: number; modifiedTime?: string } | null> {
        const m = await backupFileMeta(fileId);
        return m ? { size: m.size, modifiedTime: m.modifiedTime } : null;
    }

    /** Delete named backup files from the app folder; returns how many went / failed. */
    async function deleteFolderFiles(folderId: unknown, names: unknown): Promise<{ deleted: number; failed: number }> {
        if (!Array.isArray(names) || names.length > MAX_DELETE_NAMES || !names.every(isValidBackupFileName)) {
            throw new Error('Invalid backup filename list');
        }
        const want = new Set<string>(names);
        const files = (await listFolder(folderId)).filter(f => want.has(f.name));
        const results = await Promise.allSettled(files.map(async f => {
            const { status } = await call('DELETE', `${DRIVE_FILES_URL}/${f.id}`);
            if (status < 200 || status >= 300) throw new DriveStatusError(`Drive delete failed: ${status}`, status);
        }));
        const failed = results.filter(r => r.status === 'rejected').length;
        return { deleted: results.length - failed, failed };
    }

    /** Validate a download request (id + the staging name) before any bytes move. */
    async function checkDownload(fileId: unknown, fileName: unknown): Promise<{ size: number }> {
        if (!isValidBackupFileName(fileName)) throw new Error('Invalid backup filename');
        const m = await backupFileMeta(fileId, fileName);
        if (!m) throw new DriveStatusError('Drive download failed: HTTP 404', 404);
        return { size: m.size };
    }

    /**
     * Validate an upload target before any bytes move: a new file needs the
     * app folder; updating in place needs an existing backup file (its folder
     * is not consulted, so a legacy file in an invisible folder still works).
     */
    async function checkUpload(folderId: unknown, fileName: unknown, existingFileId: unknown): Promise<void> {
        if (!isValidBackupFileName(fileName)) throw new Error('Invalid backup filename');
        if (existingFileId !== undefined && existingFileId !== null) {
            const m = await backupFileMeta(existingFileId);
            if (!m) throw new DriveStatusError('Drive upload could not start: HTTP 404', 404);
            return;
        }
        await assertAppFolder(folderId);
    }

    return {
        resolveFolder, ensureFolder, resolveBackupTarget, locateBackup,
        statFile, findFile, listFolder, deleteFolderFiles, checkDownload, checkUpload,
    };
}

export type DriveApi = ReturnType<typeof createDriveApi>;
