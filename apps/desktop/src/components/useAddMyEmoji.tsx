import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePersonalEmojiLibrary } from '../hooks/usePersonalEmojis';
import { useToast } from '../contexts/ToastContext';
import { IMAGE_ACCEPT_ATTR } from '../utils/imageUploadValidation';
import { emojiFileProblem } from '../utils/personalEmoji/pickFile';
import { PERSONAL_EMOJI_LIBRARY_MAX } from '../utils/personalEmoji/token';
import type { EmojiEntry } from '../utils/personalEmoji/library';
import { AddEmojiDialog } from './settings/panes/AddEmojiDialog';
import { addEmojiButtonState } from './emojiPickerTabs';

/** Above the emoji picker (z-index 9999) and the call overlays that can host it. */
const DIALOG_OVERLAY_STYLE: React.CSSProperties = { zIndex: 10050 };

/**
 * "Add an emoji" straight from the emoji picker: the same file rule and the
 * same AddEmojiDialog (resize, name, save) Settings -> Activity & Style uses; this
 * only owns the hidden file input and the dialog's mount point.
 *
 *   open()      choose a picture (no-op while My Emojis is full)
 *   state       { disabled, label, tooltip } for the "+" buttons
 *   node        render ONCE inside the picker: the file input and the dialog
 *   dialogOpen  the dialog (or the file chooser) is up
 *
 * `onAdded` fires with the new entry; `onSettled` after the flow ends either
 * way (cancel, bad file, added) so the picker can give focus back to its "+".
 */
export function useAddMyEmoji(opts: {
    onAdded?: (entry: EmojiEntry) => void;
    onSettled?: () => void;
}) {
    const { entries } = usePersonalEmojiLibrary();
    const toast = useToast();
    const fileRef = useRef<HTMLInputElement>(null);
    const [pending, setPending] = useState<File | null>(null);
    const optsRef = useRef(opts);
    useEffect(() => { optsRef.current = opts; });

    const state = addEmojiButtonState(entries.length, PERSONAL_EMOJI_LIBRARY_MAX);
    const disabled = state.disabled;

    const open = useCallback(() => {
        if (disabled) return;
        fileRef.current?.click();
    }, [disabled]);

    const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) { optsRef.current.onSettled?.(); return; }
        const problem = emojiFileProblem(f);
        if (problem) { toast.push({ kind: 'error', message: problem }); optsRef.current.onSettled?.(); return; }
        setPending(f);
    };

    const node = (
        <>
            <input ref={fileRef} type="file" accept={IMAGE_ACCEPT_ATTR} hidden tabIndex={-1} onChange={onFile} data-testid="picker-add-emoji-input" />
            {pending && (
                <AddEmojiDialog
                    file={pending}
                    overlayStyle={DIALOG_OVERLAY_STYLE}
                    onClose={() => { setPending(null); optsRef.current.onSettled?.(); }}
                    onAdded={entry => {
                        toast.push({ kind: 'success', message: `Added :${entry.name}: to My Emojis.` });
                        optsRef.current.onAdded?.(entry);
                    }}
                />
            )}
        </>
    );

    return { open, state, node, dialogOpen: pending !== null };
}
