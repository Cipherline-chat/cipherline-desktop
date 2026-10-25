import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SmilePlus, Loader2, AlertTriangle } from 'lucide-react';
import { ClButton, ClInput, ClModal, ClSegment } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../../dialog/DialogFrame';
import { personalEmojis } from '../../../utils/personalEmoji/service';
import { processEmojiImage, EmojiProcessError, type ProcessedEmoji } from '../../../utils/personalEmoji/process/client';
import type { FrameMode } from '../../../utils/personalEmoji/process/geometry';
import { PERSONAL_EMOJI_LIBRARY_MAX, isPersonalEmojiName, suggestEmojiName } from '../../../utils/personalEmoji/token';
import type { EmojiEntry } from '../../../utils/personalEmoji/library';

/**
 * Add a picture as a personal emoji. The file is shrunk to 128 px, stills to
 * about 16 KB and animations to an animated WebP under 256 KB, in a worker
 * (nothing here blocks the UI), with metadata stripped by the re-encode. The
 * preview is the REAL processed result at the sizes chat shows it.
 */
interface Props {
    file: File;
    onClose: () => void;
    onAdded: (entry: EmojiEntry) => void;
}

type Job =
    | { status: 'processing'; progress: number }
    | { status: 'ready'; result: ProcessedEmoji; url: string }
    | { status: 'error'; message: string };

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export const AddEmojiDialog: React.FC<Props> = ({ file, onClose, onAdded }) => {
    const [mode, setMode] = useState<FrameMode>('crop');
    const [name, setName] = useState(() => suggestEmojiName(file.name));
    // The outcome of the run for one `mode`; any other mode's run is "processing".
    const [outcome, setOutcome] = useState<{ mode: FrameMode; job: Job } | null>(null);
    const job: Job = outcome && outcome.mode === mode ? outcome.job : { status: 'processing', progress: 0 };
    const [saving, setSaving] = useState(false);
    const [addError, setAddError] = useState('');
    // Preview URLs live until the dialog closes: a result for a mode stays
    // valid (same file, same mode, same output) if the user switches back to it.
    const urlsRef = useRef<string[]>([]);
    useEffect(() => {
        const urls = urlsRef.current;
        return () => { for (const u of urls) URL.revokeObjectURL(u); };
    }, []);

    useEffect(() => {
        const handle = processEmojiImage(file, mode, p => setOutcome(o => (o && o.mode === mode && o.job.status !== 'processing' ? o : { mode, job: { status: 'processing', progress: p } })));
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

    const library = personalEmojis().load();
    const full = library.entries.length >= PERSONAL_EMOJI_LIBRARY_MAX;
    const nameError = useMemo(() => {
        if (!name) return '';
        if (!isPersonalEmojiName(name)) return '2 to 32 characters: lowercase letters, numbers and underscores.';
        if (library.entries.some(e => e.name === name)) return 'You already have an emoji with that name.';
        return '';
    }, [name, library.entries]);

    const canAdd = job.status === 'ready' && !!name && !nameError && !full && !saving;

    const add = async () => {
        if (job.status !== 'ready' || !canAdd) return;
        setSaving(true); setAddError('');
        const res = await personalEmojis().add(job.result.bytes, name);
        setSaving(false);
        if (res.ok) {
            if (res.alreadyHad) { setAddError(`That picture is already in your emojis as :${res.entry.name}:.`); return; }
            onAdded(res.entry);
            onClose();
        } else {
            setAddError(res.error === 'full' ? `You can have ${PERSONAL_EMOJI_LIBRARY_MAX} emojis. Remove one first.`
                : res.error === 'duplicate_name' ? 'You already have an emoji with that name.'
                : 'That emoji could not be saved. Try again.');
        }
    };

    const ready = job.status === 'ready' ? job : null;

    return (
        <ClModal open onClose={saving ? () => {} : onClose} width={460} label="Add an emoji" cardClassName="dlg-card">
            <DialogHeader icon={<SmilePlus size={18} />} title="Add an emoji" subtitle="Shrunk to 128 px on this computer. Metadata is removed." />
            <DialogBody>
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-4">
                        <div
                            className="flex items-center justify-center rounded-xl bg-cl-raise/50 shrink-0"
                            style={{ width: 128, height: 128 }}
                            aria-live="polite"
                        >
                            {job.status === 'processing' && (
                                <div className="flex flex-col items-center gap-2 text-cl-faint text-xs">
                                    <Loader2 size={22} className="animate-spin" aria-hidden="true" />
                                    <span>Processing{job.progress > 0 ? ` ${Math.round(job.progress * 100)}%` : '...'}</span>
                                </div>
                            )}
                            {ready && <img src={ready.url} alt="Emoji preview" width={ready.result.width} height={ready.result.width} draggable={false} />}
                            {job.status === 'error' && <AlertTriangle size={24} className="text-cl-flash" aria-hidden="true" />}
                        </div>
                        <div className="flex flex-col gap-2 min-w-0 text-[13px]">
                            <div className="text-cl-faint text-xs">In chat</div>
                            <div className="flex items-center gap-3">
                                <span className="inline-flex items-center gap-1.5 rounded-md bg-cl-raise/40 px-2 py-1">
                                    {ready ? <img src={ready.url} alt="" style={{ width: 22, height: 22 }} /> : <span style={{ width: 22, height: 22 }} />}
                                    <span className="text-cl-faint text-xs">in a message</span>
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5">
                                    {ready ? <img src={ready.url} alt="" style={{ width: 18, height: 18 }} /> : <span style={{ width: 18, height: 18 }} />}
                                    <span className="text-xs">1</span>
                                </span>
                                <span className="text-cl-faint text-xs">as a reaction</span>
                            </div>
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
                        <div className="text-xs text-cl-glow flex gap-2" role="status">
                            <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                            <span>This picture is animated, but this computer could not read its frames, so only the first one was kept.</span>
                        </div>
                    )}
                    {job.status === 'error' && <DialogError>{job.message}</DialogError>}

                    <div>
                        <div className="text-xs text-cl-faint mb-1.5">Shape</div>
                        <ClSegment<FrameMode>
                            options={[{ value: 'crop', label: 'Crop to square' }, { value: 'fit', label: 'Fit whole picture' }]}
                            value={mode}
                            onChange={setMode}
                        />
                    </div>

                    <div>
                        <label htmlFor="my-emoji-name" className="text-xs text-cl-faint block mb-1.5">Name</label>
                        <div className="flex items-center gap-2">
                            <span className="text-cl-faint">:</span>
                            <ClInput
                                id="my-emoji-name"
                                value={name}
                                maxLength={32}
                                autoComplete="off"
                                spellCheck={false}
                                error={!!nameError}
                                onChange={e => { setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')); setAddError(''); }}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
                                aria-invalid={!!nameError}
                                aria-describedby={nameError ? 'my-emoji-name-err' : undefined}
                            />
                            <span className="text-cl-faint">:</span>
                        </div>
                        {nameError && <div id="my-emoji-name-err" className="text-xs text-cl-flash mt-1.5">{nameError}</div>}
                    </div>
                    {(addError || full) && <DialogError>{addError || `You have ${PERSONAL_EMOJI_LIBRARY_MAX} emojis, the most allowed. Remove one first.`}</DialogError>}
                </div>
            </DialogBody>
            <DialogFooter hint={job.status === 'processing' ? 'Working on it...' : ready ? 'Looks right? Add it.' : undefined}>
                <ClButton variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</ClButton>
                <ClButton size="sm" onClick={() => void add()} disabled={!canAdd} loading={saving}>Add emoji</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default AddEmojiDialog;
