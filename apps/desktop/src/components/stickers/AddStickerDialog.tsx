import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sticker as StickerIcon, Loader2, AlertTriangle } from 'lucide-react';
import { ClButton, ClInput, ClModal, ClSegment } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { personalStickers } from '../../utils/personalEmoji/service';
import { processEmojiImage, EmojiProcessError, type ProcessedEmoji } from '../../utils/personalEmoji/process/client';
import type { FrameMode } from '../../utils/personalEmoji/process/geometry';
import { isPersonalEmojiName, suggestEmojiName } from '../../utils/personalEmoji/token';
import { sanitizeEmojiNameInput } from '../../utils/emojiNames';
import { PERSONAL_STICKER_LIBRARY_MAX, STICKER_DISPLAY_PX } from '@cipherline/shared';
import type { EmojiEntry } from '../../utils/personalEmoji/library';

/**
 * Add a picture to My stickers. Same on-device pipeline as AddEmojiDialog
 * (worker, metadata stripped by the re-encode) with the sticker profile:
 * 320 px, the whole picture kept by default, stills about 96 KB, animations
 * an animated WebP under 512 KB. The preview is the REAL processed result at
 * the size chat shows it.
 */
interface Props {
    file: File;
    onClose: () => void;
    onAdded?: (entry: EmojiEntry) => void;
    /** Over another layer (the sticker picker): raise the overlay. */
    overlayStyle?: React.CSSProperties;
}

type Job =
    | { status: 'processing'; progress: number }
    | { status: 'ready'; result: ProcessedEmoji; url: string }
    | { status: 'error'; message: string };

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export const AddStickerDialog: React.FC<Props> = ({ file, onClose, onAdded, overlayStyle }) => {
    const [mode, setMode] = useState<FrameMode>('fit');
    const [name, setName] = useState(() => suggestEmojiName(file.name));
    const [outcome, setOutcome] = useState<{ mode: FrameMode; job: Job } | null>(null);
    const job: Job = outcome && outcome.mode === mode ? outcome.job : { status: 'processing', progress: 0 };
    const [saving, setSaving] = useState(false);
    const [addError, setAddError] = useState('');
    const urlsRef = useRef<string[]>([]);
    useEffect(() => {
        const urls = urlsRef.current;
        return () => { for (const u of urls) URL.revokeObjectURL(u); };
    }, []);

    useEffect(() => {
        const handle = processEmojiImage(
            file, mode,
            p => setOutcome(o => (o && o.mode === mode && o.job.status !== 'processing' ? o : { mode, job: { status: 'processing', progress: p } })),
            undefined, 'sticker',
        );
        let live = true;
        handle.result.then(result => {
            if (!live) return;
            const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: result.mime }));
            urlsRef.current.push(url);
            setOutcome({ mode, job: { status: 'ready', result, url } });
        }, (err: unknown) => {
            if (!live || (err instanceof EmojiProcessError && err.code === 'CANCELLED')) return;
            setOutcome({ mode, job: { status: 'error', message: err instanceof Error ? err.message : 'Something went wrong processing that picture.' } });
        });
        return () => { live = false; handle.cancel(); };
    }, [file, mode]);

    const library = personalStickers().load();
    const full = library.entries.length >= PERSONAL_STICKER_LIBRARY_MAX;
    const nameError = useMemo(() => {
        if (!name) return '';
        if (!isPersonalEmojiName(name)) return '2 to 32 characters: letters, numbers and underscores (no spaces or dashes).';
        if (library.entries.some(e => e.name === name)) return 'You already have a sticker with that name.';
        return '';
    }, [name, library.entries]);

    const canAdd = job.status === 'ready' && !!name && !nameError && !full && !saving;

    const add = async () => {
        if (job.status !== 'ready' || !canAdd) return;
        setSaving(true); setAddError('');
        const res = await personalStickers().add(job.result.bytes, name);
        setSaving(false);
        if (res.ok) {
            if (res.alreadyHad) { setAddError(`That picture is already in My stickers as "${res.entry.name}".`); return; }
            onAdded?.(res.entry);
            onClose();
        } else {
            setAddError(res.error === 'full' ? `You can have ${PERSONAL_STICKER_LIBRARY_MAX} stickers. Remove one first.`
                : res.error === 'duplicate_name' ? 'You already have a sticker with that name.'
                : res.error === 'too_large' ? 'That sticker came out too large. Try a shorter or simpler animation.'
                : 'That sticker could not be saved. Try again.');
        }
    };

    const ready = job.status === 'ready' ? job : null;

    return (
        <ClModal open onClose={saving ? () => {} : onClose} width={480} label="Add a sticker" cardClassName="dlg-card" overlayStyle={overlayStyle}>
            <DialogHeader icon={<StickerIcon size={18} />} title="Add a sticker" subtitle="Shrunk to 320 px on this computer. Metadata is removed. Only you and the people you send it to ever see it." />
            <DialogBody>
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-4">
                        <div
                            className="flex items-center justify-center rounded-xl bg-cl-raise/50 shrink-0"
                            style={{ width: STICKER_DISPLAY_PX, height: STICKER_DISPLAY_PX }}
                            aria-live="polite"
                        >
                            {job.status === 'processing' && (
                                <div className="flex flex-col items-center gap-2 text-cl-faint text-xs">
                                    <Loader2 size={22} className="animate-spin" aria-hidden="true" />
                                    <span>Processing{job.progress > 0 ? ` ${Math.round(job.progress * 100)}%` : '...'}</span>
                                </div>
                            )}
                            {ready && <img src={ready.url} alt="Sticker preview" style={{ width: STICKER_DISPLAY_PX, height: STICKER_DISPLAY_PX, objectFit: 'contain' }} draggable={false} />}
                            {job.status === 'error' && <AlertTriangle size={24} className="text-cl-flash-text" aria-hidden="true" />}
                        </div>
                        <div className="flex flex-col gap-2 min-w-0 text-[13px]">
                            <div className="text-cl-faint text-xs">Shown at this size in chat.</div>
                            {ready && (
                                <div className="text-cl-faint text-xs">
                                    {ready.result.animated
                                        ? `Animated, ${ready.result.frames} frames, ${(ready.result.durationMs / 1000).toFixed(1)} s`
                                        : 'Still image'}
                                    {` - ${kb(ready.result.bytes.length)}`}
                                </div>
                            )}
                        </div>
                    </div>

                    {ready?.result.animationLost && (
                        <div className="text-xs text-cl-glow-text flex gap-2" role="status">
                            <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                            <span>This picture is animated, but this computer could not read its frames, so only the first one was kept.</span>
                        </div>
                    )}
                    {job.status === 'error' && <DialogError>{job.message}</DialogError>}

                    <div>
                        <div className="text-xs text-cl-faint mb-1.5">Shape</div>
                        <ClSegment<FrameMode>
                            options={[{ value: 'fit', label: 'Whole picture' }, { value: 'crop', label: 'Crop to square' }]}
                            value={mode}
                            onChange={setMode}
                        />
                    </div>

                    <div>
                        <label htmlFor="my-sticker-name" className="text-xs text-cl-faint block mb-1.5">Name</label>
                        <ClInput
                            id="my-sticker-name"
                            value={name}
                            maxLength={32}
                            autoComplete="off"
                            spellCheck={false}
                            error={!!nameError}
                            onChange={e => { setName(sanitizeEmojiNameInput(e.target.value)); setAddError(''); }}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
                            aria-invalid={!!nameError}
                            aria-describedby={nameError ? 'my-sticker-name-err' : undefined}
                        />
                        {nameError && <div id="my-sticker-name-err" className="text-xs text-cl-flash-text mt-1.5">{nameError}</div>}
                    </div>
                    {(addError || full) && <DialogError>{addError || `You have ${PERSONAL_STICKER_LIBRARY_MAX} stickers, the most allowed. Remove one first.`}</DialogError>}
                </div>
            </DialogBody>
            <DialogFooter hint={job.status === 'processing' ? 'Working on it...' : ready ? 'Looks right? Add it.' : undefined}>
                <ClButton variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</ClButton>
                <ClButton size="sm" onClick={() => void add()} disabled={!canAdd} loading={saving}>Add sticker</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default AddStickerDialog;
