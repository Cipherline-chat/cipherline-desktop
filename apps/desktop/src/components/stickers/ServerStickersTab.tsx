/**
 * Server Settings → Stickers. The Emojis tab's flow for stickers: upload one
 * (inline review) or many (BulkEmojiDialog, the same bulk uploader), rename,
 * edit description/tags, delete, preview at chat size. Same permission
 * (MANAGE_EMOJIS, shown as "Manage emojis & stickers"), same upload route
 * (an encrypted attachment under the server's emoji prefix), same storage
 * quota as emojis and server saves. The server re-processes every upload to
 * fit a 320 px box (aspect kept) under 512 KB.
 */
import { useEffect, useRef, useState } from 'react';
import { Upload, Pencil, Trash2, Check, X, Sticker as StickerIcon } from 'lucide-react';
import { MAX_STICKERS_PER_SERVER, STICKER_DESCRIPTION_MAX, STICKER_TAGS_MAX } from '@cipherline/shared';
import { parseStickerTags } from '../../utils/stickers/tags';
import { ClButton, ClInput } from '../cl';
import type { ServerInfo } from '../../hooks/useServers';
import { useAttachments } from '../../hooks/useAttachments';
import { useServerStorageQuota } from '../../hooks/useServerStorageQuota';
import { useToast } from '../../contexts/ToastContext';
import { useEscape } from '../../hooks/useEscape';
import { IMAGE_ACCEPT_ATTR, validateEmojiUpload } from '../../utils/imageUploadValidation';
import { EMOJI_NAME_RE, sanitizeEmojiNameInput } from '../../utils/emojiNames';
import { isStorageQuotaError } from '../../utils/serverStorageCopy';
import { serverCreateGapMs } from '../../utils/emojiBulk/batch';
import { BulkEmojiDialog } from '../emoji/BulkEmojiDialog';
import { useServerStickers, type ServerSticker } from '../../utils/stickers/serverStickers';
import { StickerImage } from './StickerImage';
import { formatBytes } from '@cipherline/shared';

const NAME_HELP = 'Names may only use letters, numbers and underscores - no spaces or dashes (2-32 characters).';

function nameFromFile(file: File): string {
    const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return (base.slice(0, 32) || 'sticker').padEnd(2, '_');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios / Error, read defensively
function errorMessage(e: any): string {
    const data = e?.response?.data;
    if (isStorageQuotaError(data)) return "This sticker doesn't fit in the server's storage. Remove some stickers, emojis or server saves to make room.";
    if (data?.code === 'STICKER_COUNT_LIMIT') return `This server has reached the maximum of ${MAX_STICKERS_PER_SERVER} stickers. Remove one to add another.`;
    const m = data?.message;
    return (Array.isArray(m) ? m.join(' ') : m) ?? e?.message ?? 'Upload failed';
}

interface Draft { name: string; description: string; tags: string }

export function ServerStickersTab({ server, token, canManage }: { server: ServerInfo; token: string | null; canManage: boolean }) {
    const { stickers, loading, create, update, remove } = useServerStickers(server.server_id, token);
    const { quota, refresh: refreshQuota } = useServerStorageQuota(server.server_id, token);
    const { uploadEncryptedFile } = useAttachments(token);
    const toast = useToast();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [pending, setPending] = useState<{ file: File; previewUrl: string; draft: Draft } | null>(null);
    const [uploading, setUploading] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [edit, setEdit] = useState<Draft>({ name: '', description: '', tags: '' });
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [bulkFiles, setBulkFiles] = useState<File[] | null>(null);
    const [dropActive, setDropActive] = useState(false);

    useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.previewUrl); }, [pending]);
    useEscape(() => setEditingId(null), !!editingId);

    const storageFull = !!quota && quota.limit_bytes > 0 && quota.used_bytes >= quota.limit_bytes;
    const atCountLimit = stickers.length >= MAX_STICKERS_PER_SERVER;
    const canAddMore = canManage && !storageFull && !atCountLimit && !uploading;

    const handleFiles = (files: File[]) => {
        if (!canAddMore || files.length === 0) return;
        if (files.length > 1) { setPending(null); setBulkFiles(files); return; }
        const r = validateEmojiUpload(files[0]);
        if (!r.ok) { toast.push({ kind: 'error', message: r.reason }); return; }
        setPending({ file: r.file, previewUrl: URL.createObjectURL(r.file), draft: { name: nameFromFile(r.file), description: '', tags: '' } });
    };

    const checkDraft = (d: Draft, exceptId?: string): { name: string; description: string; tags: string[] } | null => {
        const name = d.name.trim().toLowerCase();
        if (!EMOJI_NAME_RE.test(name)) { toast.push({ kind: 'error', message: NAME_HELP }); return null; }
        if (stickers.some(s => s.name === name && s.sticker_id !== exceptId)) {
            toast.push({ kind: 'error', message: `A sticker named "${name}" already exists on this server.` });
            return null;
        }
        const { tags, bad } = parseStickerTags(d.tags);
        if (bad.length) { toast.push({ kind: 'error', message: `Tags may only use letters, numbers and underscores: ${bad.join(', ')}` }); return null; }
        if (tags.length > STICKER_TAGS_MAX) { toast.push({ kind: 'error', message: `Up to ${STICKER_TAGS_MAX} tags.` }); return null; }
        return { name, description: d.description.trim().slice(0, STICKER_DESCRIPTION_MAX), tags };
    };

    const confirmAdd = async () => {
        if (!pending) return;
        const d = checkDraft(pending.draft);
        if (!d) return;
        setUploading(true);
        try {
            const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(
                pending.file, pending.file.name, pending.file.type, undefined, undefined, server.server_id,
            );
            await create({
                name: d.name, attachment_id: attachmentId, key_b64: keyB64, nonce_b64: nonceB64,
                ...(d.description ? { description: d.description } : {}),
                ...(d.tags.length ? { tags: d.tags } : {}),
            });
            setPending(null);
            toast.push({ kind: 'success', message: `Added the sticker "${d.name}".` });
        } catch (e) {
            toast.push({ kind: 'error', title: "Couldn't add sticker", message: errorMessage(e) });
        } finally {
            setUploading(false);
            void refreshQuota();
        }
    };

    const startEdit = (s: ServerSticker) => {
        setEditingId(s.sticker_id);
        setEdit({ name: s.name, description: s.description ?? '', tags: s.tags.join(', ') });
    };

    const confirmEdit = async (s: ServerSticker) => {
        const d = checkDraft(edit, s.sticker_id);
        if (!d) return;
        try {
            await update(s.sticker_id, { name: d.name, description: d.description, tags: d.tags });
            setEditingId(null);
        } catch (e) {
            toast.push({ kind: 'error', message: errorMessage(e) });
        }
    };

    const doDelete = async (s: ServerSticker) => {
        setDeletingId(s.sticker_id);
        try {
            await remove(s.sticker_id);
            void refreshQuota();
        } catch (e) {
            toast.push({ kind: 'error', message: errorMessage(e) });
        } finally {
            setDeletingId(null);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-8" role="status" aria-label="Loading stickers">
                <div className="w-5 h-5 border-2 border-cl-border border-t-cl-lume rounded-full animate-spin" />
            </div>
        );
    }

    const draftFields = (d: Draft, set: (patch: Partial<Draft>) => void, idPrefix: string, onEnter: () => void) => (
        <div className="flex-1 min-w-0 grid gap-1.5">
            <label className="sr-only" htmlFor={`${idPrefix}-name`}>Sticker name</label>
            <ClInput id={`${idPrefix}-name`} value={d.name} maxLength={32} placeholder="sticker_name" autoFocus
                onChange={e => set({ name: sanitizeEmojiNameInput(e.target.value) })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} />
            <label className="sr-only" htmlFor={`${idPrefix}-desc`}>Description (optional)</label>
            <ClInput id={`${idPrefix}-desc`} value={d.description} maxLength={STICKER_DESCRIPTION_MAX} placeholder="Description (optional)"
                onChange={e => set({ description: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} />
            <label className="sr-only" htmlFor={`${idPrefix}-tags`}>Search tags (optional, comma separated)</label>
            <ClInput id={`${idPrefix}-tags`} value={d.tags} maxLength={140} placeholder={`Search tags, comma separated (up to ${STICKER_TAGS_MAX})`}
                onChange={e => set({ tags: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} />
        </div>
    );

    return (
        <div className="space-y-4">
            {canManage && (
                <div
                    className={`dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-4 space-y-3 ${dropActive ? 'outline outline-1 outline-dashed outline-cl-lume' : ''}`}
                    onDragOver={e => { if (canAddMore && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropActive(true); } }}
                    onDragLeave={() => setDropActive(false)}
                    onDrop={e => { e.preventDefault(); setDropActive(false); handleFiles(Array.from(e.dataTransfer.files)); }}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-sm font-medium text-cl-text">Add stickers</p>
                            <p className="text-xs text-cl-faint">
                                JPG, PNG, WEBP, or GIF, animated ones too (up to 100 frames) — up to 5 MB each. Pick or drop as many as you like.
                                Shrunk to fit 320 px (nothing is cropped) and stored under 512 KB. Stickers count toward server storage, like emojis.
                            </p>
                        </div>
                        <ClButton size="sm" variant="ghost" disabled={!canAddMore} onClick={() => fileInputRef.current?.click()}>
                            <Upload size={14} className="mr-1.5" /> Upload stickers
                        </ClButton>
                        <input ref={fileInputRef} type="file" accept={IMAGE_ACCEPT_ATTR} multiple className="hidden"
                            onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; handleFiles(f); }} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-cl-faint">
                        <span>{stickers.length} of {MAX_STICKERS_PER_SERVER} stickers</span>
                        {quota && <span className="font-mono tabular-nums text-cl-muted">{formatBytes(quota.used_bytes)} / {formatBytes(quota.limit_bytes)} server storage</span>}
                    </div>
                    {storageFull && <p className="text-xs text-cl-flash-text">Server storage is full. Remove stickers, emojis or server saves to add more.</p>}
                    {atCountLimit && <p className="text-xs text-cl-flash-text">This server has reached the maximum of {MAX_STICKERS_PER_SERVER} stickers.</p>}
                    {pending && (
                        <div className="flex items-start gap-3 px-3 py-2.5 bg-cl-raise/20 border border-cl-border rounded-xl">
                            {/* Local preview, fitted like the server will store it (inside, not cropped). */}
                            <img src={pending.previewUrl} alt="" className="w-20 h-20 shrink-0 object-contain rounded bg-cl-raise/40" />
                            {draftFields(pending.draft, patch => setPending(p => p && { ...p, draft: { ...p.draft, ...patch } }), 'new-sticker', () => void confirmAdd())}
                            <div className="flex flex-col gap-1.5">
                                {/* Both fill the column, so Add is exactly as wide as Cancel (owner 2026-11-23). */}
                                <ClButton size="sm" fullWidth onClick={() => void confirmAdd()} disabled={uploading}>{uploading ? 'Uploading…' : 'Add'}</ClButton>
                                <ClButton size="sm" variant="ghost" fullWidth onClick={() => setPending(null)} disabled={uploading}>Cancel</ClButton>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {bulkFiles && (
                <BulkEmojiDialog
                    title="Add stickers"
                    subtitle="Check the names, then upload them all. The server checks each one again. Add descriptions and tags afterwards with the pencil."
                    initialFiles={bulkFiles}
                    existingNames={stickers.map(s => s.name)}
                    slots={Math.max(0, MAX_STICKERS_PER_SERVER - stickers.length)}
                    slotNoun="on this server"
                    fileProblem={f => { const r = validateEmojiUpload(f); return r.ok ? null : r.reason; }}
                    concurrency={2}
                    minGapMs={serverCreateGapMs}
                    activeLabel="Uploading"
                    previewFit="contain"
                    noun="sticker"
                    fatalMessage={e => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error, read defensively
                        const data = (e as any)?.response?.data;
                        if (isStorageQuotaError(data)) return 'server storage is full.';
                        if (data?.code === 'STICKER_COUNT_LIMIT') return 'the server has reached its sticker limit.';
                        return null;
                    }}
                    errorMessage={errorMessage}
                    upload={async (row, signal) => {
                        const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(
                            row.file, row.file.name, row.file.type, undefined, signal, server.server_id,
                        );
                        await create({ name: row.name.trim().toLowerCase(), attachment_id: attachmentId, key_b64: keyB64, nonce_b64: nonceB64 });
                    }}
                    onClose={({ added }) => {
                        setBulkFiles(null);
                        void refreshQuota();
                        if (added > 0) toast.push({ kind: 'success', message: `Added ${added} sticker${added === 1 ? '' : 's'}.` });
                    }}
                />
            )}

            {stickers.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-sm text-cl-faint">
                    <StickerIcon size={22} aria-hidden="true" />
                    <p>No stickers yet.</p>
                    {!canManage && <p className="text-xs">People who can manage emojis and stickers can add them here.</p>}
                </div>
            ) : (
                <ul className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-2 grid grid-cols-1 lg:grid-cols-2 gap-1" aria-label="Server stickers">
                    {stickers.map(s => (
                        <li key={s.sticker_id} className="flex items-start gap-3 px-3 py-2 bg-cl-raise/20 border border-cl-border rounded-xl">
                            <StickerImage sticker={{ source: 'server', id: s.sticker_id, name: s.name, server_id: s.server_id }} row={s} token={token} size={80} />
                            {editingId === s.sticker_id ? (
                                <>
                                    {draftFields(edit, patch => setEdit(d => ({ ...d, ...patch })), `edit-${s.sticker_id}`, () => void confirmEdit(s))}
                                    <div className="flex flex-col gap-1.5">
                                        <ClButton size="sm" onClick={() => void confirmEdit(s)} ariaLabel="Save sticker"><Check size={14} /></ClButton>
                                        <ClButton size="sm" variant="ghost" onClick={() => setEditingId(null)} ariaLabel="Cancel editing"><X size={14} /></ClButton>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-cl-text truncate font-mono">{s.name}</p>
                                        {s.description && <p className="text-xs text-cl-muted line-clamp-2">{s.description}</p>}
                                        {s.tags.length > 0 && <p className="text-[11px] text-cl-faint truncate">{s.tags.map(t => `#${t}`).join(' ')}</p>}
                                        {s.animated && <p className="text-[11px] text-cl-faint">Animated</p>}
                                    </div>
                                    {canManage && (
                                        <div className="flex items-center gap-1 shrink-0">
                                            <ClButton size="sm" variant="ghost" onClick={() => startEdit(s)} tooltip="Edit" ariaLabel={`Edit sticker ${s.name}`}>
                                                <Pencil size={14} />
                                            </ClButton>
                                            <ClButton size="sm" variant="ghost" onClick={() => void doDelete(s)} disabled={deletingId === s.sticker_id} tooltip="Delete" ariaLabel={`Delete sticker ${s.name}`}>
                                                <Trash2 size={14} className="text-cl-flash-text" />
                                            </ClButton>
                                        </div>
                                    )}
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export default ServerStickersTab;
