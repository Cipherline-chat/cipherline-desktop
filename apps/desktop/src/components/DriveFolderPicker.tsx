/**
 * DriveFolderPicker — chooses the Google Drive folder that encrypted backups
 * are written into.
 *
 * A Cipherline-styled, in-app folder browser: it walks the user's real Drive
 * tree (My Drive → sub-folders → …) with breadcrumbs, lets them create a folder
 * anywhere along the way, and confirms whichever folder they're standing in.
 * Restored 2026-09-05 in place of the Google Picker widget, which put a Google-
 * chrome iframe in the middle of our own settings UI.
 *
 * ⚠️ SCOPE / GOOGLE VERIFICATION — the one thing to know before touching this ⚠️
 *
 * Browsing needs `drive.metadata.readonly` (metadata only — names, ids, parents;
 * never file content). It is a Google *sensitive* scope, so the app must pass
 * **Google OAuth app verification** before accounts outside the Cloud project's
 * registered test users can connect Drive AT ALL. Until that clears, a
 * non-test-user hits "Access blocked … has not completed verification" on the
 * consent screen. See the long note in electron/googleDriveAuth.ts.
 *
 * A user who linked Drive BEFORE the scope was re-added still holds a
 * `drive.file`-only refresh token; listing then 403s and we tell them to
 * disconnect and reconnect (DriveScopeMissingError → the reconnect message).
 * Creating a folder keeps working in that state, so the dialog stays useful.
 *
 * The Drive calls themselves live in src/utils/driveFolders.ts (tested there);
 * this file is UI only.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, Loader2, X } from 'lucide-react';
import { ClButton, ClInput, ClModal } from './cl';
import { useModalExit } from '../hooks/useModalExit';
import {
    DRIVE_ROOT_ID,
    DriveScopeMissingError,
    createDriveFolder,
    listDriveFolders,
    type DriveFolder,
} from '../utils/driveFolders';

const MY_DRIVE: DriveFolder = { id: DRIVE_ROOT_ID, name: 'My Drive' };

const RECONNECT_HINT =
    'Cipherline needs permission to see your folder names before it can browse them. '
    + 'Disconnect Google Drive and connect again to grant it — you can still create a folder below in the meantime.';

interface DriveFolderPickerProps {
    token: string;
    onSelect: (folder: DriveFolder) => void;
    onClose: () => void;
}

export const DriveFolderPicker: React.FC<DriveFolderPickerProps> = ({ token, onSelect, onClose }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);

    /** Breadcrumb trail; the last entry is the folder currently being shown. */
    const [stack, setStack] = useState<DriveFolder[]>([MY_DRIVE]);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    /**
     * The outcome of one listing, tagged with the folder it belongs to. Keeping
     * the folder id IN the state (rather than a separate `loading` flag set the
     * moment we navigate) means "still loading" is derived — current folder ≠
     * the folder we hold a result for — so nothing has to be set synchronously
     * when the effect fires. Also makes a late response from a folder the user
     * already navigated away from unrenderable rather than merely ignored.
     */
    const [listing, setListing] = useState<{ id: string; folders?: DriveFolder[]; error?: string } | null>(null);

    const current = stack[stack.length - 1];

    // Navigating faster than Drive answers must not let an older listing paint
    // over a newer one — only the most recent request may write state.
    const requestSeq = useRef(0);

    useEffect(() => {
        const seq = ++requestSeq.current;
        const id = current.id;
        void (async () => {
            try {
                const folders = await listDriveFolders(token, id);
                if (seq === requestSeq.current) setListing({ id, folders });
            } catch (err: unknown) {
                if (seq !== requestSeq.current) return;
                setListing({
                    id,
                    error: err instanceof DriveScopeMissingError
                        ? RECONNECT_HINT
                        : (err instanceof Error && err.message) || 'Could not load your Drive folders.',
                });
            }
        })();
    }, [current.id, token]);

    const shown = listing && listing.id === current.id ? listing : null;
    const loading = shown === null;
    const folders = shown?.folders ?? null;
    const error = createError ?? shown?.error ?? null;

    const navigate = useCallback((folder: DriveFolder) => {
        setStack(s => [...s, folder]); setNewName(''); setCreateError(null);
    }, []);
    const goTo = useCallback((index: number) => {
        setStack(s => s.slice(0, index + 1)); setNewName(''); setCreateError(null);
    }, []);

    const handleCreate = useCallback(async () => {
        if (!newName.trim() || creating) return;
        setCreating(true); setCreateError(null);
        try {
            // createDriveFolder omits `parents` for My Drive itself — passing
            // the literal 'root' would ask for something outside drive.file.
            const created = await createDriveFolder(token, newName, current.id);
            setNewName('');
            // Step into what they just made: it's almost certainly the folder
            // they want, it makes "Use …" immediately available (My Drive
            // itself can't be used — see canUseCurrent), and it's the one path
            // that still works end-to-end when listing is blocked because the
            // grant predates the metadata scope.
            navigate(created);
        } catch (err: unknown) {
            setCreateError((err instanceof Error && err.message) || 'Could not create the folder.');
        } finally {
            setCreating(false);
        }
    }, [token, newName, creating, current.id, navigate]);

    /**
     * My Drive itself is not a usable destination. Drive would take the pick,
     * but the upload later creates the backup file with `parents: ['<id>']`,
     * and the literal 'root' is not an id our `drive.file` write grant may
     * address — that exact request is what used to fail. A real folder id
     * always works.
     */
    const canUseCurrent = current.id !== DRIVE_ROOT_ID;

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={448}
            label="Select backup folder"
            cardClassName="flex flex-col overflow-hidden"
            cardStyle={{ maxHeight: '80vh', padding: 0 }}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
                <span className="text-white font-semibold text-[15px]">Select backup folder</span>
                <ClButton icon variant="ghost" onClick={handleClose} tooltip="Close">
                    <X size={16} />
                </ClButton>
            </div>

            {/* Breadcrumbs */}
            <nav
                aria-label="Folder path"
                className="flex items-center gap-0.5 px-5 py-2 overflow-x-auto shrink-0 border-b border-white/[0.04]"
            >
                {stack.map((crumb, i) => {
                    const isCurrent = i === stack.length - 1;
                    return (
                        <React.Fragment key={`${crumb.id}-${i}`}>
                            {i > 0 && <ChevronRight size={11} className="shrink-0 mx-0.5" style={{ color: 'var(--cl-faint)' }} />}
                            <button
                                type="button"
                                onClick={() => !isCurrent && goTo(i)}
                                disabled={isCurrent}
                                aria-current={isCurrent ? 'location' : undefined}
                                className={`text-[12px] shrink-0 border-none bg-transparent px-1.5 py-0.5 rounded transition-colors whitespace-nowrap ${
                                    isCurrent
                                        ? 'font-medium cursor-default'
                                        : 'cursor-pointer hover:bg-white/[0.05]'
                                }`}
                                style={{ color: isCurrent ? 'var(--cl-text)' : 'var(--cl-faint)' }}
                            >
                                {crumb.name}
                            </button>
                        </React.Fragment>
                    );
                })}
            </nav>

            {/* Folder list */}
            <div className="flex-1 overflow-y-auto px-3 py-2 min-h-0" style={{ minHeight: 200 }}>
                {loading && (
                    <div className="flex items-center justify-center py-10" role="status" aria-label="Loading folders">
                        <Loader2 size={18} className="animate-spin" style={{ color: 'var(--cl-faint)' }} />
                    </div>
                )}

                {error && (
                    <div
                        className="text-[12px] rounded-xl px-4 py-3 mt-2 mx-2 leading-relaxed"
                        style={{
                            color: 'var(--cl-flash)',
                            background: 'rgba(245,158,11,.10)',
                            border: '1px solid rgba(245,158,11,.20)',
                        }}
                    >
                        {error}
                    </div>
                )}

                {/* A failed create must not hide a listing that loaded fine —
                    `folders` is already null whenever the listing itself failed. */}
                {!loading && folders !== null && (
                    folders.length === 0
                        ? (
                            <p className="text-[12px] py-8 px-4 text-center leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                                {canUseCurrent
                                    ? `No folders in here — create one below, or back up straight into “${current.name}”.`
                                    : 'No folders in your Drive yet — create one below to back up into.'}
                            </p>
                        )
                        : (
                            <div className="space-y-0.5">
                                {folders.map(f => (
                                    <button
                                        key={f.id}
                                        type="button"
                                        onClick={() => navigate(f)}
                                        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-white/[0.05] group cursor-pointer transition-colors border-none bg-transparent text-left"
                                    >
                                        <Folder size={15} className="shrink-0" style={{ color: 'var(--cl-muted)' }} />
                                        <span className="text-[13px] flex-1 truncate" style={{ color: 'var(--cl-text)' }}>{f.name}</span>
                                        <ChevronRight size={13} className="shrink-0" style={{ color: 'var(--cl-faint)' }} />
                                    </button>
                                ))}
                            </div>
                        )
                )}
            </div>

            {/* New folder */}
            <div className="px-5 py-3 border-t border-white/[0.06] shrink-0">
                <div className="flex items-center gap-2">
                    <FolderPlus size={14} className="shrink-0" style={{ color: 'var(--cl-faint)' }} />
                    <ClInput
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); }}
                        placeholder="New folder name…"
                        aria-label={`New folder inside ${current.name}`}
                        style={{ flex: 1 }}
                    />
                    <ClButton
                        size="sm"
                        onClick={handleCreate}
                        disabled={!newName.trim() || creating}
                        loading={creating}
                    >
                        Create
                    </ClButton>
                </div>
                <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                    Creates a folder inside “{current.name}” and opens it.
                </p>
            </div>

            {/* Confirm / cancel */}
            <div className="flex gap-2.5 px-5 py-4 border-t border-white/[0.06] shrink-0">
                <ClButton onClick={() => canUseCurrent && onSelect(current)} disabled={!canUseCurrent} fullWidth>
                    {canUseCurrent ? `Use “${current.name}”` : 'Open or create a folder'}
                </ClButton>
                <ClButton variant="ghost" onClick={handleClose}>
                    Cancel
                </ClButton>
            </div>
        </ClModal>
    );
};
