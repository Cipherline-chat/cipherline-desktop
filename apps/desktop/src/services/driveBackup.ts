/**
 * Unified backup service — encrypts the local vault with the user's passphrase
 * and writes it as ONE file to any combination of:
 *   • a local folder  (`<base>.enc`, UPDATED IN PLACE: only records whose
 *                      content changed are appended, then a new index — the
 *                      rest of the file is untouched; compacted with a fresh
 *                      atomic rewrite once dead space builds up)
 *   • Google Drive    (same name; Drive can't update part of a file, so a
 *                      fresh full copy is uploaded into the same file ID —
 *                      Drive's own revision history keeps prior versions for
 *                      ~30 days — no extra files)
 *
 * Nothing backup-related is stored on the Cipherline server. Google / the disk
 * only ever see ciphertext — encryption happens on-device before it leaves.
 *
 * Format: the v4 container in src/utils/backupContainer.ts — a stream of
 * independently-encrypted records (settings, one per conversation/channel,
 * one per GIF/attachment) plus an encrypted index, so the vault is never one
 * giant JSON string in memory and a restore can check the account binding
 * before reading any content. The vault is exported and encrypted ONCE per
 * run and fanned out to every destination that needs it; a destination whose
 * file already holds this exact content (fingerprint match) is skipped.
 *
 * Restore still reads the two earlier layouts — the v2 single full-vault
 * `.enc` and the chunked `<base>-YYYY-MM-DD.enc` + `chunk-*.enc` manifests —
 * and, once a container file has been written and verified at a destination, the
 * chunked-era files this app created there are removed so the destination
 * ends up holding exactly one backup file.
 */

import { beginKeysActivity } from '../utils/keysBeats';
import secureLocalStore from '../utils/secureLocalStore';
import { backupFailureReason } from '../utils/backupFailureReason';
import { reportBeta } from '../utils/betaDiagnostics/reporter';
import { importLocalHistory, decryptBackup } from '../utils/crypto';
import {
    recoverBackupKey, decryptChunk, reassembleVault, isIncrementalManifest,
} from '../utils/incrementalBackup';
import {
    ContainerWriter, openContainer, memorySource, teeSink, isContainerFile, CONTAINER_VERSION,
    type ByteSink, type ByteSource, type OpenedContainer, BackupWrongPasswordError,
} from '../utils/backupContainer';
import {
    buildBackupPlan, writeBackupRecords, applyBackupContainer,
    type BackupPlan, type WriteRecordsResult,
} from './backupRecords';
import {
    backupTarget, checkBackupFloor, recordBackupFloor,
    type BackupStaleWarning, type ContainerMark, type BackupDestinationLabel,
} from './backupGenerationFloor';

export type { BackupStaleWarning } from './backupGenerationFloor';

import { APP_BACKUP_FOLDER, resolveDriveFolder, type DriveFolderResolution } from '../utils/driveFolders';

export { resolveDriveFolder };
export type { DriveFolderResolution };

export const DEFAULT_DRIVE_FOLDER = APP_BACKUP_FOLDER;
const DEFAULT_FILE_BASE = 'cipherline-backup';
const PASSWORD_KEY = 'drive_backup_password';
/** Default per-attachment size cap (matches the free-tier upload limit). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/**
 * When the last SUCCESSFUL backup completed, ISO-8601. Written by runBackup
 * itself (below) so it covers every caller — manual, scheduled, any
 * destination — rather than relying on each call site to remember.
 *
 * The name is historical (`drive_`); it has always covered local backups too.
 */
const LAST_BACKUP_KEY = (uid: string) => `cipherline_drive_last_backup_${uid}`;
/** Legacy mirror of the same fact in epoch-ms, kept in sync so readers that
 *  only ever knew this key keep working. Both are written in one place;
 *  readers should use getLastBackupAt(). */
const LAST_BACKUP_MS_KEY = (uid: string) => `cipherline_backup_last_ts_${uid}`;
/** Per-destination fingerprint of the vault content last written there —
 *  what lets a run skip a destination that's already current. */
const FINGERPRINTS_KEY = (uid: string) => `cipherline_backup_fp_${uid}`;
/** Per-destination "last confirmed current" time + file size. The local
 *  folder and Drive run on separate schedules (Drive re-uploads the whole
 *  file, so it's usually set less often), so each needs its own clock. */
const LAST_DEST_KEY = (uid: string) => `cipherline_backup_last_dest_${uid}`;

export type DestinationLabel = 'local' | 'drive';
export interface DestinationStamp { at: string; bytes: number }

export type BackupPhase =
    | 'export' | 'encrypt' | 'local' | 'upload' | 'verify' | 'download' | 'decrypt' | 'apply' | 'done' | 'error';

export interface DriveBackupProgress {
    phase: BackupPhase;
    message?: string;
    /** Which destination a `local` / `upload` / `verify` event is about, so the UI
     *  can show one progress bar per destination. Absent on whole-run events. */
    destination?: DestinationLabel;
    attachments?: { done: number; total: number };
    /** Bytes moved so far for a Drive upload/download. */
    transfer?: { done: number; total: number };
}

export interface BackupDestinations {
    /** Absolute local folder to write the backup file to, or null. */
    localDir?: string | null;
    /** Whether to upload to the connected Google Drive. */
    drive?: boolean;
    /** @deprecated Ignored. The user can no longer choose a Drive folder (the
     *  app only holds `drive.file`), so the folder is always the app-created
     *  DEFAULT_DRIVE_FOLDER. Kept so stored configs still type-check. */
    driveFolderName?: string;
    /** The Drive folder id last used (persisted by the caller from
     *  `BackupResult.driveFolder`). Tried first: the app keeps access to a
     *  folder it created even if the user moves or renames it. For accounts
     *  that picked their own folder under the old broader grant it is that
     *  folder. When unset or unusable the app folder is found or created. */
    driveFolderId?: string | null;
    /** Filename base (e.g. `cipherline-backup-mypc`). The file written is
     *  `${base}.enc` (a value already ending in `.enc` is used as-is).
     *  Defaults to `DEFAULT_FILE_BASE` if omitted. */
    fileName?: string;
}

export interface DestinationResult {
    /** True when the destination already held this exact vault — nothing was written. */
    skipped: boolean;
    /** How the file was written: appended in place, or written whole. */
    mode?: 'update' | 'fresh';
    /** Size of the file at the destination afterwards. */
    bytes: number;
    /** Bytes actually written this run (for an in-place update: the appended
     *  records + new index; for a fresh write: the whole file). */
    bytesWritten: number;
    /** Dead space now in the file (superseded records); compacted next run
     *  once it passes the threshold. */
    deadBytes: number;
    path?: string;
    /** Chunked-era files removed after the new file was verified. */
    legacyFilesRemoved: number;
    /** The container index this run committed here — generation + createdAt,
     *  both from inside the sealed index. Absent on a skipped destination,
     *  which wrote nothing. Feeds the generation floor (see
     *  backupGenerationFloor.ts); note `generation` restarts at 1 on every
     *  fresh write, which is every Drive upload and every local compaction. */
    mark?: ContainerMark;
}

export interface BackupResult {
    at: string;
    fileName: string;
    fingerprint: string;
    attachments?: WriteRecordsResult;
    local?: DestinationResult;
    drive?: DestinationResult;
    /** Present when at least one requested destination failed — during setup
     *  (e.g. Drive auth/network/403) or during its own write/verify — while
     *  at least one other destination (or this one, partially) still
     *  succeeded. A failure here is reported per-destination and NEVER
     *  implies the other destination wasn't attempted; see runBackup. */
    errors?: Partial<Record<DestinationLabel, string>>;
    /** Set when the previously-stored Drive folder (`destinations.driveFolderId`)
     *  had gone stale — 403/404 under the app's current OAuth grant, or in the
     *  trash — and this run fell back to (and possibly created) the app folder
     *  instead of failing outright. The caller should persist this as the new
     *  folder and surface it to the user; otherwise every future run keeps
     *  retrying the same dead folder ID. */
    driveFolderRecovered?: { folderId: string; folderName: string };
    /** The Drive folder id this run settled on, whenever it differs from the
     *  stored `destinations.driveFolderId` (first backup: the folder was just
     *  created or found by name). The caller should persist it so later runs
     *  go straight to it by id. A superset of `driveFolderRecovered`, which
     *  additionally means "tell the user". */
    driveFolder?: { folderId: string; folderName: string };
}

// ── Passphrase caching (OS-wrapped SecureStore via IPC) ─────────────────────

export async function setCachedPassword(password: string): Promise<void> {
    await window.electronAPI?.secureReplaceMany?.({ [PASSWORD_KEY]: password });
}
export async function getCachedPassword(): Promise<string | null> {
    const res = await window.electronAPI?.secureGetMany?.([PASSWORD_KEY]);
    const v = res?.[PASSWORD_KEY];
    return v && v.length > 0 ? v : null;
}
export async function clearCachedPassword(): Promise<void> {
    await window.electronAPI?.secureDeleteMany?.([PASSWORD_KEY]);
}

// ── Filenames ───────────────────────────────────────────────────────────────

/** Base filename (no `.enc`) — shared by write and read so they agree. */
export function manifestBasePattern(fileBase?: string | null): string {
    return (fileBase && fileBase.trim() ? fileBase.trim() : DEFAULT_FILE_BASE).replace(/\.enc$/, '');
}
/** The single file a destination holds for `fileBase`. */
export function backupFileName(fileBase?: string | null): string {
    return `${manifestBasePattern(fileBase)}.enc`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorMessage = (err: unknown): string | undefined =>
    err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
/** One combined line for a partial-failure `onProgress` event — callers that
 *  want per-destination detail should read `BackupResult.errors` instead. */
function summarizeDestinationErrors(errors: Partial<Record<DestinationLabel, string>>): string {
    return (['local', 'drive'] as const)
        .filter(l => errors[l])
        .map(l => `${l === 'local' ? 'Local' : 'Google Drive'} backup failed: ${errors[l]}`)
        .join(' ');
}
/** Files the chunked-era layout produced for `basePattern`: dated manifests
 *  and content-addressed chunks. Exported for tests. */
export function isLegacyChunkedFile(name: string, basePattern: string): boolean {
    return new RegExp(`^${escapeRe(basePattern)}-\\d{4}-\\d{2}-\\d{2}\\.enc$`).test(name)
        || /^chunk-[0-9a-f]{64}\.enc$/.test(name);
}

// ── Drive access ────────────────────────────────────────────────────────────
// The renderer holds no Drive token and makes no Drive REST call. Every lookup
// (find/create the app folder, locate a backup, stat/list/delete backup files)
// is a purpose-specific operation in the main process (electron/drive-api.ts)
// reached through window.electronAPI.gdrive*; transfers go through
// gdriveUploadFile / gdriveDownloadFile (electron/driveTransfer.ts).

/** A Drive backup file as the main process reports it. */
export type DriveManifestFile = DriveBackupFile;

const BRIDGE_MISSING = 'Desktop bridge not loaded. Fully quit and re-run the app.';
function driveBridge() {
    const a = window.electronAPI;
    if (!a?.gdriveLocateBackup || !a.gdriveResolveBackupTarget || !a.gdriveEnsureFolder) throw new Error(BRIDGE_MISSING);
    return a;
}
/** Throws the user-facing "not connected" error unless a Google account is linked. */
async function requireDriveLinked(): Promise<void> {
    const status = await window.electronAPI?.gdriveAuthStatus?.();
    if (!status?.linked) throw new Error('Google Drive is not connected.');
}

/**
 * Where a Drive backup run writes. Either a folder (the normal case), or —
 * for an account that picked its own folder under the old broader grant and has
 * since re-connected with only `drive.file` — a single existing backup FILE
 * that is kept up to date in place.
 *
 * Why the file case exists: that folder is not the app's (so it is invisible
 * and unwritable now), but the `<base>.enc` inside it IS: the app created it.
 * Updating it by id keeps ONE backup file, with the user's Drive revision
 * history and without abandoning their existing backup in a folder the app can
 * no longer see. If that ever stops working (404/403) the run falls back to the
 * app folder — see driveDestination.
 */
export type DriveBackupTarget =
    | { kind: 'folder'; folderId: string; recovered: boolean }
    | { kind: 'file'; folderId: string; file: DriveManifestFile };

export async function resolveDriveBackupTarget(
    storedFolderId: string | null | undefined, fileName: string,
): Promise<DriveBackupTarget> {
    return driveBridge().gdriveResolveBackupTarget(storedFolderId ?? null, fileName);
}

/**
 * Pull a Drive file into the staging dir (main process) and read it whole —
 * legacy chunk fetches and the like need the bytes in memory. null when the
 * file is gone or no longer ours (404/403).
 */
async function downloadDriveFileById(file: { id: string; name: string }): Promise<Uint8Array | null> {
    const api = window.electronAPI;
    if (!api?.gdriveDownloadFile) throw new Error(BRIDGE_MISSING);
    let stagedPath: string;
    try { stagedPath = (await api.gdriveDownloadFile(file.id, file.name)).path; }
    catch (err) {
        if (/HTTP (403|404)\b/.test(errorMessage(err) || '')) return null;
        throw err;
    }
    try { return await readWholeLocalFile(stagedPath); }
    finally { api.deleteFile(stagedPath).catch(() => {}); }
}

// ── Destinations ────────────────────────────────────────────────────────────

/** A write into a destination. 'fresh' lands as a whole new file on
 *  commit; 'update' appends to the existing file in place. */
export interface DestinationSink extends ByteSink {
    commit(): Promise<{ size: number; path?: string }>;
    abort(): Promise<void>;
}
export type WriteMode = 'fresh' | 'update';

/**
 * One place a backup file lives. Exported so the orchestration (skip /
 * update-or-rewrite / verify / clean up) can be unit-tested against an
 * in-memory fake without Electron IPC or the Drive REST API — see
 * driveBackup.test.ts.
 */
export interface SingleFileDestination {
    label: 'local' | 'drive';
    /** Whether this destination can append to its existing file in place.
     *  Local disks can; Drive cannot (whole-file uploads only). */
    supportsUpdate: boolean;
    stat(fileName: string): Promise<{ size: number; modifiedTime?: string } | null>;
    openSink(fileName: string, mode: WriteMode): Promise<DestinationSink>;
    /** Random access to a file at the destination (legacy chunk fetches). */
    openSource(fileName: string): Promise<ByteSource | null>;
    /** Prove the just-committed file is the one we meant to write. Throws
     *  otherwise. Local reopens the container; Drive is verified by checksum
     *  inside the upload itself (see electron/driveTransfer.ts). */
    verify(fileName: string, expect: { password: string; fingerprint: string }): Promise<void>;
    listFiles(): Promise<string[]>;
    deleteFiles(names: string[]): Promise<void>;
}

function pathJoin(dir: string, file: string): string {
    if (!dir) return file;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + file;
}

/** Random-access source over a local file via the ranged IPC reader. */
function localFileSource(filePath: string, size: number): ByteSource {
    const api = window.electronAPI!;
    return {
        size: async () => size,
        read: async (offset, length) => new Uint8Array(await api.backupReadRange(filePath, offset, length)),
    };
}

/** Read an entire local file through the ranged reader (legacy formats need
 *  the whole blob; the ranged handler caps single reads, so loop). */
async function readWholeLocalFile(filePath: string): Promise<Uint8Array | null> {
    const api = window.electronAPI;
    if (!api?.backupStat || !api.backupReadRange) return null;
    const st = await api.backupStat(filePath);
    if (!st) return null;
    const out = new Uint8Array(st.size);
    const STEP = 64 * 1024 * 1024;
    for (let off = 0; off < st.size; off += STEP) {
        const part = new Uint8Array(await api.backupReadRange(filePath, off, Math.min(STEP, st.size - off)));
        out.set(part, off);
    }
    return out;
}

function localDestination(dir: string): SingleFileDestination {
    const api = () => {
        const a = window.electronAPI;
        if (!a?.backupBeginWrite || !a.backupStat) throw new Error('Desktop bridge not loaded. Fully quit and re-run the app.');
        return a;
    };
    return {
        label: 'local',
        supportsUpdate: true,
        stat: async (fileName) => {
            const st = await api().backupStat(pathJoin(dir, fileName));
            return st ? { size: st.size, modifiedTime: new Date(st.mtimeMs).toISOString() } : null;
        },
        openSink: async (fileName, mode) => {
            const a = api();
            const { sessionId } = await a.backupBeginWrite(dir, fileName, mode);
            const STEP = 8 * 1024 * 1024; // keep individual IPC messages modest
            return {
                write: async (bytes) => {
                    for (let off = 0; off < bytes.length; off += STEP) {
                        await a.backupAppend(sessionId, bytes.subarray(off, Math.min(off + STEP, bytes.length)));
                    }
                },
                writeAt: (offset, bytes) => a.backupWriteAt(sessionId, offset, bytes),
                commit: () => a.backupCommit(sessionId),
                abort: () => a.backupAbort(sessionId),
            };
        },
        openSource: async (fileName) => {
            const p = pathJoin(dir, fileName);
            const st = await api().backupStat(p);
            return st ? localFileSource(p, st.size) : null;
        },
        verify: async (fileName, expect) => {
            const p = pathJoin(dir, fileName);
            const st = await api().backupStat(p);
            if (!st) throw new Error('Backup was written but could not be read back.');
            const check = await openContainer(localFileSource(p, st.size), expect.password);
            if (check.index.fingerprint !== expect.fingerprint) {
                throw new Error("Backup verification failed: the file's content doesn't match what was written.");
            }
        },
        listFiles: async () => {
            try { return await window.electronAPI!.readDir(dir); } catch { return []; }
        },
        deleteFiles: async (names) => {
            for (const n of names) {
                try { await window.electronAPI!.deleteFile(pathJoin(dir, n)); }
                catch (e) { console.warn('[backup] could not remove old backup file', n, e); }
            }
        },
    };
}

/**
 * Google Drive. The encrypted file is staged on disk (under userData) as
 * it's produced, then the main process streams it up with Drive's resumable
 * protocol and checks Drive's stored MD5 against the file — see
 * electron/driveTransfer.ts. Drive has no partial-content update, so the
 * whole file goes up each run; the existing file is updated in place (same
 * ID, new revision), which is what keeps it ONE file.
 */
function driveDestination(
    folderId: string,
    onTransfer?: (p: { done: number; total: number }) => void,
    /** An existing backup file to keep updating in place instead of looking in
     *  `folderId` (see DriveBackupTarget). */
    pinnedFile?: DriveManifestFile | null,
): SingleFileDestination & { fellBackToFolderId?: string } {
    const api = () => {
        const a = window.electronAPI;
        if (!a?.backupStagingDir || !a.gdriveUploadFile || !a.gdriveStatFile || !a.gdriveFindFile) throw new Error(BRIDGE_MISSING);
        return a;
    };
    let pin = pinnedFile ?? null;
    let folder = folderId;
    const isPinned = (fileName: string) => !!pin && pin.name === fileName;
    const dest: SingleFileDestination & { fellBackToFolderId?: string } = {
        label: 'drive',
        supportsUpdate: false,
        stat: async (fileName) => {
            const a = api();
            if (pin && isPinned(fileName)) {
                // null = gone or no longer ours: report absent; the write below
                // then takes the fallback path rather than failing the run.
                return a.gdriveStatFile(pin.id);
            }
            const f = await a.gdriveFindFile(folder, fileName);
            return f ? { size: f.size ? parseInt(f.size, 10) : 0, modifiedTime: f.modifiedTime } : null;
        },
        openSink: async (fileName) => {
            const a = api();
            const stagingDir = await a.backupStagingDir();
            const { sessionId } = await a.backupBeginWrite(stagingDir, fileName, 'fresh');
            const STEP = 8 * 1024 * 1024;
            let stagedPath: string | null = null;
            return {
                write: async (bytes) => {
                    for (let off = 0; off < bytes.length; off += STEP) {
                        await a.backupAppend(sessionId, bytes.subarray(off, Math.min(off + STEP, bytes.length)));
                    }
                },
                writeAt: (offset, bytes) => a.backupWriteAt(sessionId, offset, bytes),
                commit: async () => {
                    const staged = await a.backupCommit(sessionId);
                    stagedPath = staged.path;
                    const unsub = onTransfer ? a.onGdriveTransferProgress?.(p => { if (p.kind === 'upload') onTransfer(p); }) : undefined;
                    try {
                        if (pin && isPinned(fileName)) {
                            try {
                                const stored = await a.gdriveUploadFile(folder, fileName, staged.path, pin.id);
                                return { size: stored.size };
                            } catch (err) {
                                // The file we were updating in place can no longer
                                // be written (deleted, access revoked): that is the
                                // one case where the backup moves to the app folder.
                                // Anything else (network, 5xx) is a real failure.
                                if (!/HTTP (403|404)\b/.test(errorMessage(err) || '')) throw err;
                                folder = (await a.gdriveEnsureFolder()).folderId;
                                pin = null;
                                dest.fellBackToFolderId = folder;
                            }
                        }
                        const stored = await a.gdriveUploadFile(folder, fileName, staged.path);
                        return { size: stored.size };
                    } finally {
                        unsub?.();
                        a.deleteFile(staged.path).catch(() => {});
                    }
                },
                abort: async () => {
                    await a.backupAbort(sessionId).catch(() => {});
                    if (stagedPath) a.deleteFile(stagedPath).catch(() => {});
                },
            };
        },
        // Upload-time checksum verification already proved the stored bytes
        // match the staged file, which was produced by the same writer that
        // just verified locally (or would have been) — nothing to re-download.
        verify: async () => {},
        openSource: async (fileName) => {
            const f = pin && isPinned(fileName) ? pin : (folder ? await api().gdriveFindFile(folder, fileName) : null);
            if (!f) return null;
            const bytes = await downloadDriveFileById(f);
            return bytes ? memorySource(bytes) : null;
        },
        // Legacy chunked-era leftovers are cleaned up only inside a folder the
        // app can see; a pinned file's (invisible) folder is left alone.
        listFiles: async () => {
            if (pin || !folder) return [];
            try { return (await api().gdriveListFolder(folder)).map(f => f.name); } catch { return []; }
        },
        deleteFiles: async (names) => {
            if (pin || !folder || names.length === 0) return;
            try {
                const { failed, deleted } = await api().gdriveDeleteFolderFiles(folder, names);
                if (failed > 0) console.warn(`[backup] ${failed}/${failed + deleted} old Drive backup file deletions failed`);
            } catch { /* best-effort cleanup */ }
        },
    };
    return dest;
}

// ── Orchestration (destination-agnostic; unit-tested) ───────────────────────

export interface SingleFileRunOpts {
    destinations: SingleFileDestination[];
    plan: BackupPlan;
    password: string;
    fileName: string;
    basePattern: string;
    /** Fingerprint last written per destination label, if known. */
    lastFingerprints: Partial<Record<SingleFileDestination['label'], string>>;
    /** One pass over the plan into the writers that need it (injectable for tests). */
    writeRecords: (writers: { update?: ContainerWriter; fresh?: ContainerWriter }) => Promise<WriteRecordsResult>;
    onProgress?: (p: DriveBackupProgress) => void;
    /** Dead-space fraction above which an in-place update gives way to a
     *  compaction (fresh rewrite). Default 0.3. */
    compactAbove?: number;
}

/**
 * runSingleFileBackup's rejection when every destination failed ON ITS OWN
 * (stat / commit / verify) — as opposed to the shared encrypt-and-write pass
 * failing. The message is unchanged (the joined per-destination messages);
 * the map lets beta diagnostics classify each destination's own failure.
 */
export class AllDestinationsFailedError extends Error {
    readonly destinationErrors: Partial<Record<DestinationLabel, string>>;
    constructor(message: string, destinationErrors: Partial<Record<DestinationLabel, string>>) {
        super(message);
        this.name = 'AllDestinationsFailedError';
        this.destinationErrors = destinationErrors;
    }
}

/**
 * Bring every destination that isn't already current up to date:
 *
 *   • A destination that can be updated in place (local folder) and already
 *     holds a readable file gets an IN-PLACE UPDATE: only records whose
 *     content changed are appended, then a new index; unchanged records are
 *     neither read nor rewritten. Once dead space (superseded records) passes
 *     `compactAbove`, or the file can't be opened with the current passphrase,
 *     it's compacted with a fresh write + atomic rename instead.
 *   • Everything else (first backup, compaction, Google Drive) gets a FRESH
 *     full file — encrypted once and fanned out to every such destination.
 *
 * Each write is verified by reopening the result with the passphrase, then
 * that destination's chunked-era files are removed. A destination whose new
 * file didn't verify keeps its old files untouched.
 *
 * Failure isolation: checking whether a destination is already current
 * (`stat`) and actually writing to it (commit + verify) are BOTH per
 * destination from here on — one destination being unreachable (auth
 * expired, network down, a Drive 403/SCOPE_MISSING) or failing verification
 * never stops another destination in the same run from being attempted, and
 * never discards a result another destination already produced. Such
 * failures land in the returned `errors` map instead. The one exception is
 * the shared encrypt-and-write pass below (openSink → writeRecords → finish):
 * every destination reached at that point writes from the SAME
 * once-encrypted stream (see the module doc), so a failure there isn't
 * destination-specific — there's nothing to isolate — and still rejects the
 * whole call, aborting every sink opened so far.
 *
 * The call rejects (instead of resolving with `errors` populated) only when
 * NO destination succeeded at all — with at least one success, a co-occurring
 * failure is reported via `errors` on an otherwise-successful return so a
 * partial failure is never confused with, or masked by, a total one.
 */
export async function runSingleFileBackup(opts: SingleFileRunOpts): Promise<{
    results: Partial<Record<SingleFileDestination['label'], DestinationResult>>;
    attachments?: WriteRecordsResult;
    errors?: Partial<Record<SingleFileDestination['label'], string>>;
}> {
    const { destinations, plan, password, fileName, basePattern, lastFingerprints, writeRecords, onProgress } = opts;
    const compactAbove = opts.compactAbove ?? 0.3;
    const results: Partial<Record<SingleFileDestination['label'], DestinationResult>> = {};
    const errors: Partial<Record<SingleFileDestination['label'], string>> = {};

    /** Resolve with whatever succeeded, UNLESS nothing did — in which case
     *  throw, matching the pre-isolation contract for a single failing
     *  destination (and for every destination failing together). */
    const finish = (attachments?: WriteRecordsResult) => {
        const errorEntries = Object.entries(errors);
        if (Object.keys(results).length === 0 && errorEntries.length > 0) {
            throw new AllDestinationsFailedError(errorEntries.map(([, msg]) => msg).join(' '), { ...errors });
        }
        return { results, attachments, errors: errorEntries.length ? errors : undefined };
    };

    const active: SingleFileDestination[] = [];
    for (const d of destinations) {
        try {
            const current = await d.stat(fileName);
            if (current && lastFingerprints[d.label] === plan.fingerprint) {
                results[d.label] = { skipped: true, bytes: current.size, bytesWritten: 0, deadBytes: 0, legacyFilesRemoved: 0 };
            } else {
                active.push(d);
            }
        } catch (err) {
            // Can't even check this destination (e.g. a Drive `stat` 403) —
            // that must not stop us from still trying every OTHER destination.
            errors[d.label] = errorMessage(err) || `Could not reach the ${d.label} destination.`;
        }
    }
    if (active.length === 0) return finish();

    onProgress?.({ phase: 'encrypt', message: 'Encrypting…' });

    // Decide per destination: in-place update or fresh write.
    type Opened = { dest: SingleFileDestination; mode: WriteMode; existing?: OpenedContainer; sink?: DestinationSink };
    const opened: Opened[] = [];
    for (const d of active) {
        let existing: OpenedContainer | undefined;
        if (d.supportsUpdate) {
            try {
                const src = await d.openSource(fileName);
                if (src) existing = await openContainer(src, password);
            } catch { existing = undefined; } // not a container, or a different passphrase → rewrite
        }
        const dead = existing ? existing.deadBytes / Math.max(1, existing.size) : 0;
        // A v3 file can't be updated in place — v4's header is longer, so every
        // record offset would shift. One fresh write upgrades the destination
        // to the authenticated-header format; nothing already written is lost.
        const canUpdate = !!existing && existing.version === CONTAINER_VERSION;
        const mode: WriteMode = canUpdate && dead <= compactAbove ? 'update' : 'fresh';
        opened.push({ dest: d, mode, existing: mode === 'update' ? existing : undefined });
    }

    let attachments: WriteRecordsResult | undefined;
    let updateWriter: ContainerWriter | undefined;
    let freshWriter: ContainerWriter | undefined;
    try {
        for (const o of opened) o.sink = await o.dest.openSink(fileName, o.mode);
        const upd = opened.find(o => o.mode === 'update');
        if (upd) updateWriter = ContainerWriter.resume(upd.existing!, upd.sink!);
        const freshSinks = opened.filter(o => o.mode === 'fresh').map(o => o.sink!);
        if (freshSinks.length) {
            // Share the update's key when there is one, so every file written
            // this run is under the same salt; otherwise derive once.
            const keyMaterial = upd ? upd.existing!.keyMaterial : await ContainerWriter.newKey(password);
            freshWriter = await ContainerWriter.create(password, teeSink(freshSinks), { keyMaterial });
        }
        attachments = await writeRecords({ update: updateWriter, fresh: freshWriter });
        const finished = await Promise.all([
            updateWriter?.finish({ userId: plan.userId, fingerprint: plan.fingerprint }),
            freshWriter?.finish({ userId: plan.userId, fingerprint: plan.fingerprint }),
        ]);
        for (const o of opened) {
            const f = o.mode === 'update' ? finished[0]! : finished[1]!;
            (o as Opened & { totalBytes: number; deadBytes: number; bytesWritten: number }).totalBytes = f.bytes;
            (o as Opened & { deadBytes: number }).deadBytes = f.deadBytes;
            (o as Opened & { bytesWritten: number }).bytesWritten = o.mode === 'update' ? f.bytes - o.existing!.size : f.bytes;
            (o as Opened & { mark: ContainerMark }).mark =
                { generation: f.index.generation, createdAt: f.index.createdAt };
        }
    } catch (err) {
        await Promise.allSettled(opened.map(o => o.sink?.abort()));
        throw err;
    }

    for (const o of opened) {
        const d = o.dest;
        // Independent per destination from here on: commit + verify + legacy
        // cleanup for one destination running into trouble (Drive auth
        // expired, network down, a 403/SCOPE_MISSING, a failed verify) is
        // caught right here so it can never stop — or erase the result of —
        // any other destination in this loop, before or after it.
        let committed: { size: number; path?: string } | undefined;
        try {
            onProgress?.({ phase: d.label === 'local' ? 'local' : 'upload', destination: d.label, message: d.label === 'local' ? 'Writing local backup…' : 'Uploading to Google Drive…' });
            committed = await o.sink!.commit();

            onProgress?.({ phase: 'verify', destination: d.label, message: 'Verifying…' });
            await d.verify(fileName, { password, fingerprint: plan.fingerprint });

            // The new file is confirmed good — retire the chunked-era files.
            const legacy = (await d.listFiles()).filter(n => isLegacyChunkedFile(n, basePattern));
            if (legacy.length) await d.deleteFiles(legacy);

            const stats = o as Opened & { deadBytes: number; bytesWritten: number; mark?: ContainerMark };
            results[d.label] = {
                skipped: false, mode: o.mode, bytes: committed.size, bytesWritten: stats.bytesWritten,
                deadBytes: stats.deadBytes, path: committed.path, legacyFilesRemoved: legacy.length,
                // Only after verify(): a file that didn't prove to be the one
                // we meant to write must not become this device's idea of
                // "the newest thing I wrote here".
                mark: stats.mark,
            };
        } catch (err) {
            // Only abort a sink that never actually committed — once bytes
            // are confirmed written (commit succeeded, verify failed), the
            // destination's old files are already untouched by design
            // (verify never ran the legacy-cleanup step above), so there is
            // nothing to roll back.
            if (!committed) await o.sink?.abort().catch(() => {});
            errors[d.label] = errorMessage(err) || `${d.label} backup failed.`;
        }
    }
    return finish(attachments);
}

// ── Public: backup ──────────────────────────────────────────────────────────

/**
 * Run a backup to every enabled destination. Exports the vault once, encrypts
 * once, and writes only to destinations whose file isn't already current.
 * At least one destination must be set.
 */
/** A failure message → a reason CODE for beta diagnostics (the message itself never leaves). See utils/backupFailureReason.ts. */
export { backupFailureReason };

export async function runBackup(opts: {
    userId: string;
    token: string;
    password: string;
    includeAttachments?: boolean;
    maxAttachmentBytes?: number;
    destinations: BackupDestinations;
    onProgress?: (p: DriveBackupProgress) => void;
}): Promise<BackupResult> {
    const { userId, token, password, includeAttachments = true, destinations, onProgress } = opts;
    // 0 = no limit.
    const maxAttachmentBytes = (opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES) || undefined;
    const wantLocal = !!destinations.localDir;
    const wantDrive = !!destinations.drive;
    const driveFolderName = DEFAULT_DRIVE_FOLDER;
    if (!wantLocal && !wantDrive) throw new Error('No backup destination selected.');
    const fileName = backupFileName(destinations.fileName);
    const basePattern = manifestBasePattern(destinations.fileName);

    // Per-destination reason whenever that destination was requested but
    // never even got a chance to write — a Drive auth/network/API failure
    // while getting the token or resolving/creating the folder is caught
    // right here, isolated from the local destination below (and from
    // runSingleFileBackup's own write-phase isolation), so a broken Drive
    // connection can never stop the local backup from being set up and
    // attempted, whatever happens to Drive.
    const setupErrors: Partial<Record<DestinationLabel, string>> = {};

    notifyBackupStateChanged(); // run started
    // Keys on Home files papers into a little safe while this runs (a flag:
    // nothing about the backup leaves this function). Ended in `finally`.
    const endKeysFiling = beginKeysActivity('backup');
    let betaStage = 'export';
    try {
        onProgress?.({ phase: 'export', message: 'Gathering your data…' });
        const plan = await buildBackupPlan(userId, { includeAttachments, token, maxAttachmentBytes });
        betaStage = 'setup';

        const dests: SingleFileDestination[] = [];
        const targets: Partial<Record<SingleFileDestination['label'], string>> = {};
        let driveFolderRecovered: { folderId: string; folderName: string } | undefined;
        let driveFolder: { folderId: string; folderName: string } | undefined;
        let driveDest: ReturnType<typeof driveDestination> | undefined;
        if (wantLocal) {
            dests.push(localDestination(destinations.localDir!));
            targets.local = backupTarget(destinations.localDir!, fileName);
        }
        if (wantDrive) {
            try {
                await requireDriveLinked();
                // The app only holds `drive.file`, so the backup lives in the one
                // folder it created itself. A stored folder id is tried first (the
                // app keeps access to a folder it created even after the user
                // moves or renames it); a stale one — or one an older build let
                // the user pick, which the narrow grant can't see — is recovered
                // from instead of 403ing every run forever. Note the two failure
                // modes compose here rather than overlapping: resolveDriveBackupTarget
                // handles a *stale folder* internally (falling back, never
                // throwing), while a genuine Drive failure — no token, network
                // down, 401, 5xx — still throws and is caught below as a
                // per-destination setup error, so it can't take local down.
                const target = await resolveDriveBackupTarget(destinations.driveFolderId, fileName);
                if (target.kind === 'folder') {
                    if (target.recovered) driveFolderRecovered = { folderId: target.folderId, folderName: driveFolderName };
                    if (target.folderId !== destinations.driveFolderId) driveFolder = { folderId: target.folderId, folderName: driveFolderName };
                }
                driveDest = driveDestination(
                    target.folderId, (transfer) => onProgress?.({ phase: 'upload', destination: 'drive', transfer }),
                    target.kind === 'file' ? target.file : null,
                );
                dests.push(driveDest);
                targets.drive = backupTarget(target.folderId, fileName);
            } catch (err) {
                setupErrors.drive = errorMessage(err) || 'Google Drive backup failed.';
            }
        }

        if (dests.length === 0) {
            // Nothing could even be set up — there's no "other destination"
            // left to fall back to, so surface whatever went wrong directly.
            throw new Error(setupErrors.drive || setupErrors.local || 'No backup destination could be reached.');
        }

        betaStage = 'write';
        const known = readFingerprints(userId);
        const lastFingerprints: SingleFileRunOpts['lastFingerprints'] = {};
        for (const label of ['local', 'drive'] as const) {
            const k = known[label];
            if (k && k.target === targets[label]) lastFingerprints[label] = k.fingerprint;
        }

        const { results, attachments, errors: writeErrors } = await runSingleFileBackup({
            destinations: dests, plan, password, fileName, basePattern, lastFingerprints, onProgress,
            writeRecords: (writers) => writeBackupRecords(plan, writers, {
                token, maxAttachmentBytes,
                onAttachmentProgress: (done, total) => onProgress?.({ phase: 'encrypt', attachments: { done, total } }),
            }),
        });
        const errors: Partial<Record<DestinationLabel, string>> = { ...setupErrors, ...writeErrors };
        // Beta diagnostics: one event per destination that failed (stage + reason enum).
        for (const [label, msg] of Object.entries(errors) as Array<[DestinationLabel, string]>) {
            // part: 'dest' = this destination's own step (stat / commit / verify) —
            // the other destination's outcome is independent of it.
            reportBeta('backup_failed', setupErrors[label]
                ? { dest: label, stage: 'setup', reason: backupFailureReason(msg) }
                : { dest: label, stage: 'write', part: 'dest', reason: backupFailureReason(msg) });
        }

        // The file being updated in place stopped accepting writes mid-run and
        // the backup landed in the app folder instead (see driveDestination):
        // record it under THAT folder and tell the caller to repoint.
        if (driveDest?.fellBackToFolderId && results.drive) {
            driveFolderRecovered = { folderId: driveDest.fellBackToFolderId, folderName: driveFolderName };
            driveFolder = driveFolderRecovered;
            targets.drive = backupTarget(driveDest.fellBackToFolderId, fileName);
        }

        const at = new Date().toISOString();
        const stamps = getDestinationStamps(userId);
        for (const label of ['local', 'drive'] as const) {
            const r = results[label];
            if (!r || !targets[label]) continue;
            known[label] = { fingerprint: plan.fingerprint, target: targets[label]! };
            // A skipped destination is, by definition, current — its clock
            // resets too, or the scheduler would retry it every tick.
            stamps[label] = { at, bytes: r.bytes };
            // The generation floor, on the other hand, only moves when this
            // device actually AUTHORED and verified a container here. A skip
            // wrote nothing (`mark` is absent), so the previous floor is still
            // the truth — re-stamping it would be claiming to have seen a file
            // we never opened. See backupGenerationFloor.ts.
            if (r.mark) recordBackupFloor(userId, label, targets[label]!, r.mark);
        }
        writeFingerprints(userId, known);
        writeDestinationStamps(userId, stamps);
        // At least one destination is now current — record the run even if
        // another destination failed alongside it (see `errors`).
        if (results.local || results.drive) stampLastBackup(userId, at);

        const hasErrors = Object.keys(errors).length > 0;
        onProgress?.(hasErrors
            ? { phase: 'error', message: summarizeDestinationErrors(errors) }
            : { phase: 'done' });
        notifyBackupStateChanged(); // run finished
        return {
            at, fileName, fingerprint: plan.fingerprint, attachments,
            local: results.local, drive: results.drive,
            errors: hasErrors ? errors : undefined,
            driveFolderRecovered,
            driveFolder,
        };
    } catch (err: unknown) {
        onProgress?.({ phase: 'error', message: errorMessage(err) || 'Backup failed.' });
        notifyBackupStateChanged(); // run failed — nothing was stamped, so subscribers keep their nudge
        // Beta diagnostics: the whole run failed. Per-destination setup errors
        // were already reported above only if the run got that far, so report
        // each wanted destination here (the dedupe folds repeats).
        // part: 'shared' = the once-encrypted pass every destination writes
        // from (open sinks -> records -> finish), so one cause fails them all.
        // (If every destination failed on its own step instead, each is
        // classified from its own message, as part 'dest'.)
        const perDest = err instanceof AllDestinationsFailedError ? err.destinationErrors : null;
        const reason = backupFailureReason(errorMessage(err));
        const report = (dest: DestinationLabel) => {
            if (perDest) {
                const own = perDest[dest];
                if (own !== undefined) reportBeta('backup_failed', { dest, stage: betaStage, part: 'dest', reason: backupFailureReason(own) });
                else if (setupErrors[dest] !== undefined) reportBeta('backup_failed', { dest, stage: 'setup', reason: backupFailureReason(setupErrors[dest]) });
                return;
            }
            reportBeta('backup_failed', betaStage === 'write'
                ? { dest, stage: betaStage, part: 'shared', reason }
                : { dest, stage: betaStage, reason });
        };
        if (wantLocal) report('local');
        if (wantDrive) report('drive');
        throw err;
    } finally {
        endKeysFiling();
    }
}

type FingerprintMap = Partial<Record<'local' | 'drive', { fingerprint: string; target: string }>>;
function readFingerprints(userId: string): FingerprintMap {
    try {
        const raw = secureLocalStore.getItem(FINGERPRINTS_KEY(userId));
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}
function writeFingerprints(userId: string, map: FingerprintMap): void {
    try { secureLocalStore.setItem(FINGERPRINTS_KEY(userId), JSON.stringify(map)); } catch { /* ignore */ }
}

export function getDestinationStamps(userId: string): Partial<Record<DestinationLabel, DestinationStamp>> {
    try {
        const raw = secureLocalStore.getItem(LAST_DEST_KEY(userId));
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}
function writeDestinationStamps(userId: string, stamps: Partial<Record<DestinationLabel, DestinationStamp>>): void {
    try { secureLocalStore.setItem(LAST_DEST_KEY(userId), JSON.stringify(stamps)); } catch { /* ignore */ }
}
/** When `label` was last confirmed current, epoch-ms. Falls back to the
 *  overall last-backup time for installs that predate per-destination
 *  stamps, so an existing schedule doesn't fire immediately on upgrade. */
export function getDestinationLastMs(userId: string, label: DestinationLabel): number | null {
    const s = getDestinationStamps(userId)[label];
    const ms = s ? Date.parse(s.at) : NaN;
    if (Number.isFinite(ms) && ms > 0) return ms;
    return getLastBackupMs(userId);
}

/** Fired on window whenever backup state the UI summarises changes: the backup
 *  config was saved (destinations / automatic on-off), a run started, a run
 *  completed (stampLastBackup) or failed, or the scheduler's blocked reason
 *  changed. Anything that shows "set up backups" (the Home tile, the
 *  onboarding checklist) subscribes via hooks/useBackupState so it updates in
 *  place instead of only when it next happens to mount. */
export const BACKUP_STATE_EVENT = 'cipherline:backup-state';

let notifyQueued = false;

/** Announce a backup-state change. Deferred to a microtask and coalesced: the
 *  config is written from inside a React state updater (BackupSection.persist),
 *  and a synchronous dispatch there would run subscribers' setState during
 *  another component's render. By the time the microtask runs, the
 *  secure-store writes behind the change have landed, so subscribers read a
 *  consistent snapshot. */
export function notifyBackupStateChanged(): void {
    if (notifyQueued) return;
    notifyQueued = true;
    const fire = () => {
        notifyQueued = false;
        try {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new Event(BACKUP_STATE_EVENT));
            }
        } catch { /* non-fatal: the next render still reads fresh state */ }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(fire); else void Promise.resolve().then(fire);
}

/** Record a successful backup. The ONLY place either timestamp is written —
 *  see LAST_BACKUP_MS_KEY for why there are two. */
export function stampLastBackup(userId: string, atIso: string): void {
    try { secureLocalStore.setItem(LAST_BACKUP_KEY(userId), atIso); } catch { /* ignore */ }
    try {
        const ms = Date.parse(atIso);
        if (Number.isFinite(ms)) secureLocalStore.setItem(LAST_BACKUP_MS_KEY(userId), String(ms));
    } catch { /* ignore */ }
    notifyBackupStateChanged();
}

/** Locally-recorded timestamp of the last successful backup, ISO-8601.
 *  Single source of truth for every "when did we last back up" readout. */
export function getLastBackupAt(userId: string): string | null {
    try {
        const iso = secureLocalStore.getItem(LAST_BACKUP_KEY(userId));
        if (iso) return iso;
        // Fall back to the legacy epoch-ms key so an install that only ever
        // wrote that one keeps its history instead of reading as "never".
        const raw = secureLocalStore.getItem(LAST_BACKUP_MS_KEY(userId));
        const ms = raw ? Number(raw) : NaN;
        return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
    } catch { return null; }
}

/** Same fact as epoch-ms, for callers doing staleness arithmetic. */
export function getLastBackupMs(userId: string): number | null {
    const iso = getLastBackupAt(userId);
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Drive backup file info (without downloading). A stale `folderIdOverride`
 *  (403/404) falls back to the app folder rather than reporting "no backup"
 *  forever — `folderRecovered` tells the caller to re-persist it. Looks for the
 *  backup anywhere in the app's reach before giving up (a backup an older build
 *  wrote into a folder the user picked is still the app's own file). */
export async function getDriveBackupInfo(
    folderIdOverride?: string | null,
    fileBase?: string | null,
): Promise<{ exists: boolean; modifiedTime?: string; sizeBytes?: number; folderRecovered?: { folderId: string; folderName: string } } | null> {
    const api = window.electronAPI;
    if (!api?.gdriveLocateBackup) return null;
    try {
        if (!(await api.gdriveAuthStatus?.())?.linked) return null;
        // Looks in the stored/app folder first, then anywhere the app can see.
        const { file, folderId, recovered, inFolder } = await api.gdriveLocateBackup(folderIdOverride ?? null, fileBase ?? null);
        const folderRecovered = recovered && folderId ? { folderId, folderName: DEFAULT_DRIVE_FOLDER } : undefined;
        // Found somewhere else: report it, but do NOT repoint the stored folder
        // at the (empty) fallback — the real backup is where it already is.
        if (!file) return { exists: false, folderRecovered };
        return {
            exists: true, modifiedTime: file.modifiedTime, sizeBytes: file.size ? parseInt(file.size, 10) : undefined,
            folderRecovered: inFolder ? folderRecovered : undefined,
        };
    } catch { return null; }
}

// ── Public: restore ─────────────────────────────────────────────────────────

export async function restoreFromDrive(opts: {
    userId: string; password: string;
    /** @deprecated Ignored — the app folder's name is fixed (DEFAULT_DRIVE_FOLDER). */
    folderName?: string;
    /** The stored Drive folder id, if any (see BackupDestinations.driveFolderId). */
    folderId?: string | null;
    fileBase?: string | null;
    onProgress?: (p: DriveBackupProgress) => void;
    /** Advisory: asked when the file is older than the last backup this
     *  device wrote to this Drive folder. Omit to always proceed. */
    onStaleBackup?: StaleBackupConfirm;
}): Promise<{ restored: boolean; staleWarning?: BackupStaleWarning; folderRecovered?: { folderId: string; folderName: string } }> {
    const { userId, password, folderId: folderIdOverride, fileBase, onProgress, onStaleBackup } = opts;
    try {
        await requireDriveLinked();
        onProgress?.({ phase: 'download', message: 'Downloading from Google Drive…' });
        // A stale stored folder (403/404) falls back to the app folder instead
        // of permanently failing restore. Nothing in the folder (or no folder
        // at all, e.g. a backup an older build wrote into a folder the user
        // picked, which the narrow grant can no longer see): the main process
        // then looks for the app's own backup file anywhere in Drive —
        // `drive.file` limits that search to files this app created.
        const { file, folderId: appFolderId, recovered, inFolder } = await driveBridge().gdriveLocateBackup(folderIdOverride ?? null, fileBase ?? null);
        if (!file) throw new Error('No backup found in Google Drive.');
        // Only repoint the stored folder when the backup really was in it.
        const folderRecovered = inFolder && recovered && appFolderId ? { folderId: appFolderId, folderName: DEFAULT_DRIVE_FOLDER } : undefined;
        const folderId = inFolder ? appFolderId! : (folderIdOverride || file.parents?.[0] || '');
        const dest = driveDestination(inFolder ? folderId : (file.parents?.[0] || folderId));
        // Same string the backup side recorded the floor under, built by the
        // same helper so the two can't drift; a mismatch just means no floor.
        const site: FloorSite = { label: 'drive', target: backupTarget(folderId, file.name) };
        const api = window.electronAPI;
        if (!api?.gdriveDownloadFile || !api.backupStat || !api.backupReadRange) throw new Error(BRIDGE_MISSING);
        // Stream to a staging file in the main process, then read it by range
        // like a local backup — a large vault never sits in renderer memory.
        const unsub = api.onGdriveTransferProgress?.(p => { if (p.kind === 'download') onProgress?.({ phase: 'download', transfer: p }); });
        let stagedPath: string;
        try { stagedPath = (await api.gdriveDownloadFile(file.id, file.name)).path; }
        finally { unsub?.(); }
        try {
            const st = await api.backupStat(stagedPath);
            if (!st) throw new Error('Downloaded backup could not be read.');
            const head = new Uint8Array(await api.backupReadRange(stagedPath, 0, 3));
            if (isContainerFile(head)) return { ...(await applyContainer(userId, localFileSource(stagedPath, st.size), password, onProgress, site, onStaleBackup)), folderRecovered };
            const whole = await readWholeLocalFile(stagedPath);
            if (!whole) throw new Error('Downloaded backup could not be read.');
            return { ...(await applyLegacy(userId, new Blob([whole as BlobPart]), password, dest, onProgress)), folderRecovered };
        } finally {
            api.deleteFile(stagedPath).catch(() => {});
        }
    } catch (err: unknown) {
        onProgress?.({ phase: 'error', message: errorMessage(err) || 'Restore failed.' });
        throw err;
    }
}

/** Restore from a user-picked local `.enc` file. With `filePath` the file is
 *  read by range through the main process (a container backup only needs the index
 *  plus the records being applied); `file` is the fallback when no path is
 *  available (non-Electron), and for legacy formats. */
export async function restoreFromLocalFile(opts: {
    userId: string; filePath?: string; file?: Blob; password: string;
    onProgress?: (p: DriveBackupProgress) => void;
    /** Advisory: asked when the picked file is older than the last backup
     *  this device wrote to that same path. Omit to always proceed. */
    onStaleBackup?: StaleBackupConfirm;
}): Promise<{ restored: boolean; staleWarning?: BackupStaleWarning }> {
    const { userId, filePath, file, password, onProgress, onStaleBackup } = opts;
    try {
        const dir = filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : null;
        const dest = dir ? localDestination(dir) : null;
        // The user can pick ANY .enc file. Only one that sits at the exact
        // path this device backs up to has a floor to be compared against;
        // anything else finds no floor and is silent.
        const site: FloorSite | null = filePath && dir && dir !== filePath
            ? { label: 'local', target: backupTarget(dir, filePath.slice(dir.length + 1)) }
            : null;
        const api = window.electronAPI;
        if (filePath && api?.backupStat && api.backupReadRange) {
            const st = await api.backupStat(filePath);
            if (!st) throw new Error('Backup file not found.');
            const head = new Uint8Array(await api.backupReadRange(filePath, 0, 3));
            if (isContainerFile(head)) {
                return await applyContainer(userId, localFileSource(filePath, st.size), password, onProgress, site, onStaleBackup);
            }
            const whole = await readWholeLocalFile(filePath);
            if (!whole) throw new Error('Backup file not found.');
            return await applyLegacy(userId, new Blob([whole as BlobPart]), password, dest, onProgress);
        }
        if (!file) throw new Error('No backup file provided.');
        return await applyBackupBytes(userId, new Uint8Array(await file.arrayBuffer()), password, dest, onProgress, site, onStaleBackup);
    } catch (err: unknown) {
        onProgress?.({ phase: 'error', message: errorMessage(err) || 'Restore failed.' });
        throw err;
    }
}

/**
 * What a backup file says about the account that wrote it, plus a deferred
 * step that applies the rest of it.
 *
 * This exists for the first-run "Restore from backup file" flow (AuthScreen's
 * `history-options` screen), which — unlike the Settings restore — is not
 * signed in yet. It has to read the vault's account id BEFORE it binds
 * `secureLocalStore` to that account, and must not touch the store at all when
 * the file turns out to belong to someone else.
 *
 * It no longer surfaces the keypair older vaults carried (`privateKey` /
 * `publicKey`): that pair belonged to the device that wrote the backup, and
 * installing it here copied one device's key material onto another. See
 * BackupVault.privateKey in utils/crypto.ts.
 */
export interface OpenedBackupFile {
    /** Account the backup was written by ('' when the file carries none). */
    userId: string;
    /**
     * Apply the backup's contents for `targetUserId`. Only call this once the
     * store is bound to that account (`secureLocalStore.whenAccountReady()`).
     * Re-checks account binding itself, so a caller that skipped the check
     * still cannot cross-restore.
     */
    apply(targetUserId: string, onProgress?: (p: DriveBackupProgress) => void): Promise<void>;
}

/**
 * Decrypt a user-picked `.enc` backup far enough to identify the account, and
 * hand back a closure that applies the remainder.
 *
 * Format-aware, exactly like `restoreFromLocalFile`: v3/v4 containers, v2 full
 * vaults and v1 legacy blobs all land here.
 *
 * The first-run restore screen used to hand the file straight to
 * `decryptBackup` + `JSON.parse`, which understands only v1/v2. Every backup
 * written by the current app is a container (magic `CL\x03` or `CL\x04`), so it failed
 * the v2 magic check, fell through to the v1 reader, derived a key over the
 * wrong salt with the wrong KDF parameters, and surfaced as "Decryption
 * failed. Incorrect password or corrupted file." — while restoring the very
 * same file from Settings worked, because that path detects the container.
 */
export async function openBackupFile(file: Blob, password: string): Promise<OpenedBackupFile> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (isContainerFile(bytes)) {
        const container = await openContainer(memorySource(bytes), password); // throws on wrong password
        const meta = await container.readJson<Record<string, unknown>>('meta');
        return {
            userId: container.index.userId || asBackupString(meta.userId),
            apply: async (targetUserId, onProgress) => {
                onProgress?.({ phase: 'apply', message: 'Restoring your data…' });
                await applyBackupContainer(targetUserId, container, (done, total) =>
                    onProgress?.({ phase: 'apply', attachments: { done, total } }));
                onProgress?.({ phase: 'done' });
            },
        };
    }

    // Legacy v2 full vault / v1 blob — one self-contained JSON payload.
    const vaultStr = await decryptBackup(new Blob([bytes as BlobPart]), password); // throws on wrong password
    const vault = JSON.parse(vaultStr) as Record<string, unknown>;
    // A chunked manifest needs its sibling chunk files, which a single picked
    // file doesn't give us. Say so instead of restoring an empty vault.
    if (isIncrementalManifest(vault)) {
        throw new Error('This backup references separate chunk files — restore it from Settings → Backups, using the folder that holds them.');
    }
    return {
        userId: asBackupString(vault.userId),
        apply: async (targetUserId, onProgress) => {
            onProgress?.({ phase: 'apply', message: 'Restoring your data…' });
            await importLocalHistory(targetUserId, new Blob([vaultStr], { type: 'application/json' }));
            onProgress?.({ phase: 'done' });
        },
    };
}

function asBackupString(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

/** Route in-memory backup bytes to the right reader by format. */
async function applyBackupBytes(
    userId: string, bytes: Uint8Array, password: string,
    chunkDest: SingleFileDestination | null,
    onProgress?: (p: DriveBackupProgress) => void,
    site?: FloorSite | null,
    onStaleBackup?: StaleBackupConfirm,
): Promise<{ restored: boolean; staleWarning?: BackupStaleWarning }> {
    if (isContainerFile(bytes)) return applyContainer(userId, memorySource(bytes), password, onProgress, site, onStaleBackup);
    // Legacy v1/v2/chunked files carry no generation and no sealed
    // createdAt, so there is nothing to compare — silent, as everywhere else.
    return applyLegacy(userId, new Blob([bytes as BlobPart]), password, chunkDest, onProgress);
}

/**
 * Which destination a file being restored came from, so its container can be
 * compared against what this device last wrote THERE. Omitted (or unmatched)
 * means no comparison is possible, which is silent by design.
 */
interface FloorSite { label: BackupDestinationLabel; target: string }

/** Asked before applying a backup that looks older than the last one this
 *  device wrote. Return false to leave the device untouched. Advisory only:
 *  when no handler is supplied the restore simply proceeds. */
export type StaleBackupConfirm = (warning: BackupStaleWarning) => boolean | Promise<boolean>;

async function applyContainer(
    userId: string, source: ByteSource, password: string,
    onProgress?: (p: DriveBackupProgress) => void,
    site?: FloorSite | null,
    onStaleBackup?: StaleBackupConfirm,
): Promise<{ restored: boolean; staleWarning?: BackupStaleWarning }> {
    onProgress?.({ phase: 'decrypt', message: 'Decrypting…' });
    const container = await openContainer(source, password); // throws on wrong password

    // Between opening (so the index is authenticated) and applying (so a
    // declined restore changes nothing). A null warning — new device, no
    // floor for this destination, locked keystore — is SILENT: the restore
    // runs exactly as it did before this check existed.
    const staleWarning = site
        ? await checkBackupFloor(userId, site.label, site.target, {
            generation: container.index.generation,
            createdAt: container.index.createdAt,
        })
        : null;
    if (staleWarning && onStaleBackup) {
        let proceed = true;
        try { proceed = await onStaleBackup(staleWarning); }
        catch { proceed = true; } // a broken handler must not block a restore
        if (!proceed) return { restored: false, staleWarning };
    }

    onProgress?.({ phase: 'apply', message: 'Restoring your data…' });
    await applyBackupContainer(userId, container, (done, total) => onProgress?.({ phase: 'apply', attachments: { done, total } }));
    onProgress?.({ phase: 'done' });
    return { restored: true, ...(staleWarning ? { staleWarning } : {}) };
}

/**
 * Legacy readers, kept so every backup ever written stays restorable:
 *   - v2 full vault (single self-contained `.enc`; also what the
 *     device-to-device history sync still produces) → importLocalHistory.
 *   - chunked manifest → fetch + decrypt each referenced `chunk-*.enc` from
 *     the same folder via `chunkDest`, reassemble, then importLocalHistory.
 * `chunkDest` is null when there's no folder to fetch chunks from; a
 * manifest-shaped backup then fails with a clear error rather than
 * restoring an empty vault.
 */
async function applyLegacy(
    userId: string, encBlob: Blob, password: string,
    chunkDest: SingleFileDestination | null,
    onProgress?: (p: DriveBackupProgress) => void,
): Promise<{ restored: boolean }> {
    onProgress?.({ phase: 'decrypt', message: 'Decrypting…' });
    const vaultStr = await decryptBackup(encBlob, password); // throws on wrong password
    const parsed: unknown = JSON.parse(vaultStr);

    let finalVaultJson: string;
    if (isIncrementalManifest(parsed)) {
        if (!chunkDest) throw new Error('This backup references separate chunk files that could not be located — try restoring from the original folder.');
        onProgress?.({ phase: 'download', message: 'Fetching backup data…' });
        const recovered = await recoverBackupKey(await encBlob.arrayBuffer(), password);
        if (!recovered) throw new BackupWrongPasswordError();
        const chunkJsonById: Record<string, string> = {};
        for (const ref of parsed.chunks) {
            const src = await chunkDest.openSource(ref.file);
            const raw = src ? await src.read(0, await src.size()) : null;
            if (!raw) throw new Error(`Backup is missing data for "${ref.id}" (file ${ref.file}) — it may be incomplete or corrupted.`);
            chunkJsonById[ref.id] = await decryptChunk(raw, recovered.key);
        }
        finalVaultJson = JSON.stringify(reassembleVault(parsed, chunkJsonById));
    } else {
        finalVaultJson = vaultStr;
    }

    onProgress?.({ phase: 'apply', message: 'Restoring your data…' });
    await importLocalHistory(userId, new Blob([finalVaultJson], { type: 'application/json' }));
    onProgress?.({ phase: 'done' });
    return { restored: true };
}
