import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Images, Loader2, X, Check, AlertTriangle, Clock, Plus } from 'lucide-react';
import { ClButton, ClInput, ClModal } from '../cl';
import { DialogHeader, DialogBody, DialogFooter } from '../dialog/DialogFrame';
import { sanitizeEmojiNameInput } from '../../utils/emojiNames';
import {
    BULK_EMOJI_MAX_FILES, buildRows, isPendingStatus, overSlotIds, runBatch, validateRows,
    type BulkRow, type RowStatus,
} from '../../utils/emojiBulk/batch';

/**
 * Review-then-upload list for many emojis at once. Used by Server Settings ->
 * Emojis (files go to the server, which re-checks everything) and by My Emojis
 * (processed and stored on this device). All checks here are UX only.
 *
 * Why "disabled until every row is fine" rather than "upload only the valid
 * ones": a silently skipped file looks like a lost file. Each problem row says
 * exactly what is wrong and can be fixed or removed, and "Remove N with
 * problems" is one click when the person just wants the rest.
 */
export interface BulkEmojiDialogProps {
    title: string;
    subtitle: string;
    initialFiles: File[];
    /** Names already taken (live: the library grows as rows finish). */
    existingNames: string[];
    /** How many more fit now. */
    slots: number;
    /** What the limit is about, for the banner: "on this server" / "in My Emojis". */
    slotNoun: string;
    fileProblem: (f: File) => string | null;
    upload: (row: BulkRow, signal: AbortSignal) => Promise<void>;
    concurrency: number;
    minGapMs: (batchSize: number) => number;
    fatalMessage?: (err: unknown) => string | null;
    errorMessage: (err: unknown) => string;
    /** Verb shown while a row is in flight ("Uploading" / "Adding"). */
    activeLabel: string;
    /** Batch-wide control shown above the list (e.g. crop vs fit). */
    extra?: React.ReactNode;
    /** How the picture is framed in the preview thumbnails. */
    previewFit?: 'cover' | 'contain';
    /** What is being uploaded: 'sticker' drops the :colons: and says stickers. Default 'emoji'. */
    noun?: 'emoji' | 'sticker';
    onClose: (summary: { added: number }) => void;
    overlayStyle?: React.CSSProperties;
}

const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const isImageFile = (f: File) => f.type.startsWith('image/');

/** The picture's own preview; its object URL lives exactly as long as the row. */
const RowThumb: React.FC<{ file: File; fit: 'cover' | 'contain' }> = ({ file, fit }) => {
    const [url, setUrl] = useState('');
    useEffect(() => {
        const u = URL.createObjectURL(file);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [file]);
    const cls = `w-9 h-9 shrink-0 rounded bg-cl-raise/40 ${fit === 'contain' ? 'object-contain' : 'object-cover'}`;
    return url ? <img src={url} alt="" draggable={false} className={cls} /> : <span className={cls} aria-hidden="true" />;
};

export const BulkEmojiDialog: React.FC<BulkEmojiDialogProps> = (p) => {
    const [rows, setRows] = useState<BulkRow[]>(() => buildRows(p.initialFiles.slice(0, BULK_EMOJI_MAX_FILES), p.existingNames));
    const [clipped, setClipped] = useState(p.initialFiles.length > BULK_EMOJI_MAX_FILES);
    const [running, setRunning] = useState(false);
    const [started, setStarted] = useState(false);
    const [dropActive, setDropActive] = useState(false);
    const [slotsAtOpen] = useState(p.slots);
    const fileRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const liveRef = useRef(true);
    const pRef = useRef(p);
    useEffect(() => { pRef.current = p; });
    useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; abortRef.current?.abort(); }; }, []);

    const problems = useMemo(
        () => validateRows(rows, { existingNames: p.existingNames, slots: slotsAtOpen, fileProblem: p.fileProblem }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fileProblem is a stable rule per flow
        [rows, p.existingNames, slotsAtOpen],
    );

    const patchRow = useCallback((id: string, patch: Partial<BulkRow>) => {
        if (!liveRef.current) return;
        setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
    }, []);

    const addFiles = (files: File[]) => {
        if (running || files.length === 0) return;
        const room = BULK_EMOJI_MAX_FILES - rows.length;
        const take = files.slice(0, Math.max(0, room));
        if (take.length < files.length) setClipped(true);
        if (take.length === 0) return;
        setRows(rs => [...rs, ...buildRows(take, p.existingNames, rs)]);
    };

    const pendingRows = rows.filter(r => isPendingStatus(r.status));
    const failedCount = rows.filter(r => r.status === 'error').length;
    const readyCount = rows.filter(r => r.status === 'ready' || r.status === 'cancelled').length;
    const doneCount = rows.filter(r => r.status === 'done').length;
    const overIds = overSlotIds(rows, problems);
    const problemRows = pendingRows.filter(r => problems.has(r.id));
    const runnable = pendingRows.length;
    const canRun = !running && runnable > 0 && problemRows.length === 0;
    const total = rows.length;
    const finishedCount = rows.filter(r => r.status === 'done' || r.status === 'error').length;

    const start = async () => {
        if (!canRun) return;
        const toRun = pendingRows;
        const ac = new AbortController();
        abortRef.current = ac;
        setRunning(true); setStarted(true);
        const cur = pRef.current;
        await runBatch({
            rows: toRun,
            upload: (row, signal) => pRef.current.upload(row, signal),
            concurrency: cur.concurrency,
            minGapMs: cur.minGapMs(toRun.length),
            signal: ac.signal,
            onRow: (id, patch) => patchRow(id, patch),
            fatalMessage: cur.fatalMessage,
            errorMessage: cur.errorMessage,
        });
        abortRef.current = null;
        if (liveRef.current) setRunning(false);
    };

    const stop = () => abortRef.current?.abort();
    const close = () => {
        abortRef.current?.abort();
        p.onClose({ added: doneCount });
    };

    const keepFirst = () => setRows(rs => rs.filter(r => !overIds.includes(r.id)));
    const removeProblems = () => setRows(rs => rs.filter(r => !problems.has(r.id) || !isPendingStatus(r.status)));

    const primaryLabel = started
        ? (problemRows.length > 0 ? `Fix ${problemRows.length} to upload`
            : failedCount > 0 && readyCount === 0 ? `Retry ${failedCount} failed` : `Upload ${runnable} remaining`)
        : problemRows.length > 0
            ? `Fix ${problemRows.length} to upload`
            : `Upload ${runnable} ${p.noun ?? 'emoji'}${runnable === 1 ? '' : 's'}`;

    const hint = running
        ? `${finishedCount} of ${total} done`
        : started && runnable === 0 && failedCount === 0
            ? `All ${doneCount} added.`
            : problemRows.length > 0
                ? `${problemRows.length} need${problemRows.length === 1 ? 's' : ''} attention before you can continue.`
                : started
                    ? `${doneCount} added${failedCount ? `, ${failedCount} failed` : ''}`
                    : `${runnable} ready. ${Math.max(0, slotsAtOpen - doneCount - runnable)} spots left after this.`;

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault(); setDropActive(false);
        addFiles(Array.from(e.dataTransfer.files).filter(isImageFile));
    };

    const statusCell = (r: BulkRow, problem?: string) => {
        const s: RowStatus = r.status;
        if (s === 'done') return <span className="flex items-center gap-1 text-cl-lume text-xs"><Check size={14} aria-hidden="true" />Added</span>;
        if (s === 'uploading') return <span className="flex items-center gap-1 text-cl-faint text-xs"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{p.activeLabel}...</span>;
        if (s === 'queued') return <span className="flex items-center gap-1 text-cl-faint text-xs"><Clock size={14} aria-hidden="true" />Waiting</span>;
        if (s === 'waiting') return <span className="flex items-center gap-1 text-cl-glow text-xs"><Clock size={14} aria-hidden="true" />Slowing down ({r.waitSeconds}s)</span>;
        if (s === 'error' || problem) return <span className="flex items-center gap-1 text-cl-flash text-xs"><AlertTriangle size={14} aria-hidden="true" />{s === 'error' ? 'Failed' : 'Fix this'}</span>;
        return <span className="text-cl-faint text-xs">{sizeText(r.file.size)}</span>;
    };

    return (
        <ClModal open onClose={running ? () => {} : close} width={580} label={p.title} cardClassName="dlg-card" overlayStyle={p.overlayStyle}>
            <DialogHeader icon={<Images size={18} />} title={p.title} subtitle={p.subtitle} />
            <DialogBody>
                <div
                    className={`flex flex-col gap-3 rounded-xl min-h-0 flex-1 [&>*]:shrink-0 ${dropActive ? 'outline outline-1 outline-dashed outline-cl-lume' : ''}`}
                    onDragOver={e => { if (!running && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropActive(true); } }}
                    onDragLeave={() => setDropActive(false)}
                    onDrop={onDrop}
                >
                    {(overIds.length > 0 || slotsAtOpen - doneCount <= 3) && !started && (
                        <div className={`text-xs rounded-lg px-3 py-2 flex flex-wrap items-center gap-2 ${overIds.length ? 'bg-cl-flash/10 text-cl-flash' : 'bg-cl-raise/40 text-cl-faint'}`} role="status">
                            <span className="min-w-0 flex-1">
                                {overIds.length > 0
                                    ? `Only ${slotsAtOpen} more fit ${p.slotNoun}. ${overIds.length} file${overIds.length === 1 ? ' is' : 's are'} over. Remove rows to choose which ones you want, or keep the first ${slotsAtOpen}.`
                                    : `Room for ${slotsAtOpen} more ${p.slotNoun}.`}
                            </span>
                            {overIds.length > 0 && <ClButton size="sm" variant="ghost" onClick={keepFirst}>Keep the first {slotsAtOpen}</ClButton>}
                        </div>
                    )}
                    {clipped && <div className="text-xs text-cl-faint" role="status">Only the first {BULK_EMOJI_MAX_FILES} files are taken at a time.</div>}
                    {p.extra && !started && <div>{p.extra}</div>}

                    {rows.length === 0 ? (
                        <div className="text-center text-[13px] text-cl-faint py-8">
                            Nothing left in the list. Add some pictures, or drop them here.
                        </div>
                    ) : (
                        <ul className="flex flex-col gap-1.5 overflow-y-auto pr-1 m-0 p-0 list-none !shrink min-h-[132px]" aria-label="Emojis to upload">
                            {rows.map(r => {
                                const problem = isPendingStatus(r.status) ? problems.get(r.id) : undefined;
                                const detail = r.status === 'error' || r.status === 'cancelled' ? r.error : problem;
                                const editable = !running && isPendingStatus(r.status);
                                const errId = `bulk-err-${r.id}`;
                                return (
                                    <li key={r.id} className={`flex items-center gap-3 px-2.5 py-1.5 rounded-xl border ${problem || r.status === 'error' ? 'border-cl-flash/60 bg-cl-flash/5' : 'border-cl-border bg-cl-raise/20'}`}>
                                        <RowThumb file={r.file} fit={p.previewFit ?? 'cover'} />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1">
                                                {(p.noun ?? 'emoji') === 'emoji' && <span className="text-cl-faint" aria-hidden="true">:</span>}
                                                <ClInput
                                                    value={r.name}
                                                    maxLength={32}
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                    disabled={!editable}
                                                    style={{ padding: '5px 10px', fontSize: 13, borderRadius: 10 }}
                                                    error={!!problem && !!r.name}
                                                    aria-label={`Name for ${r.file.name}`}
                                                    aria-invalid={!!problem}
                                                    aria-describedby={detail ? errId : undefined}
                                                    onChange={e => patchRow(r.id, { name: sanitizeEmojiNameInput(e.target.value) })}
                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (canRun) void start(); } }}
                                                />
                                                {(p.noun ?? 'emoji') === 'emoji' && <span className="text-cl-faint" aria-hidden="true">:</span>}
                                            </div>
                                            <div className="text-[11px] text-cl-faint truncate mt-0.5" title={r.file.name}>{r.file.name}{problem || r.status !== 'ready' ? '' : ` · ${sizeText(r.file.size)}`}</div>
                                            {detail && <div id={errId} className="text-xs text-cl-flash mt-0.5 break-words" role={r.status === 'error' ? 'alert' : undefined}>{detail}</div>}
                                        </div>
                                        <div className="shrink-0 w-[112px] flex justify-end">{statusCell(r, problem)}</div>
                                        <ClButton
                                            size="sm" variant="ghost"
                                            ariaLabel={`Remove ${r.file.name} from the list`}
                                            disabled={running && !isPendingStatus(r.status)}
                                            style={{ visibility: r.status === 'done' ? 'hidden' : undefined }}
                                            onClick={() => setRows(rs => rs.filter(x => x.id !== r.id))}
                                        ><X size={14} aria-hidden="true" /></ClButton>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {running && (
                        <div role="status" aria-live="polite">
                            <div className="h-1.5 rounded-full bg-cl-raise/60 overflow-hidden" aria-hidden="true">
                                <div className="h-full bg-cl-lume transition-[width]" style={{ width: `${total ? (finishedCount / total) * 100 : 0}%` }} />
                            </div>
                            <div className="text-xs text-cl-faint mt-1">{finishedCount} of {total} finished</div>
                        </div>
                    )}
                    {!running && started && (
                        <div className="text-[13px]" role="status" aria-live="polite">
                            {doneCount} added{failedCount ? `, ${failedCount} failed` : ''}{rows.some(r => r.status === 'cancelled') ? `, ${rows.filter(r => r.status === 'cancelled').length} not sent` : ''}.
                            {failedCount > 0 && ' Fix the names or just retry.'}
                        </div>
                    )}

                    {!running && (
                        <div className="flex flex-wrap items-center gap-2">
                            <ClButton size="sm" variant="ghost" onClick={() => fileRef.current?.click()} disabled={rows.length >= BULK_EMOJI_MAX_FILES}>
                                <Plus size={14} className="mr-1.5" aria-hidden="true" />Add more pictures
                            </ClButton>
                            {problemRows.length > 0 && (
                                <ClButton size="sm" variant="ghost" onClick={removeProblems}>Remove {problemRows.length} with problems</ClButton>
                            )}
                            <input
                                ref={fileRef} type="file" multiple hidden tabIndex={-1}
                                accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp"
                                data-testid="bulk-emoji-input"
                                onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
                            />
                        </div>
                    )}
                </div>
            </DialogBody>
            <DialogFooter hint={hint}>
                {running
                    ? <ClButton variant="ghost" size="sm" onClick={stop}>Stop</ClButton>
                    : <ClButton variant="ghost" size="sm" onClick={close}>{started ? 'Done' : 'Cancel'}</ClButton>}
                {!(started && !running && runnable === 0) && (
                    <ClButton size="sm" onClick={() => void start()} disabled={!canRun} loading={running}>{primaryLabel}</ClButton>
                )}
            </DialogFooter>
        </ClModal>
    );
};

export default BulkEmojiDialog;
