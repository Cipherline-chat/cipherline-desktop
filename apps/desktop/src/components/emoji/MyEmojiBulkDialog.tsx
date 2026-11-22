import React, { useEffect, useRef, useState } from 'react';
import { ClSegment } from '../cl';
import { BulkEmojiDialog } from './BulkEmojiDialog';
import { usePersonalEmojiLibrary } from '../../hooks/usePersonalEmojis';
import { personalEmojis, personalStickers } from '../../utils/personalEmoji/service';
import { usePersonalStickerLibrary } from '../../hooks/usePersonalStickers';
import { processEmojiImage } from '../../utils/personalEmoji/process/client';
import type { FrameMode } from '../../utils/personalEmoji/process/geometry';
import { PERSONAL_EMOJI_LIBRARY_MAX } from '../../utils/personalEmoji/token';
import { emojiFileProblem } from '../../utils/personalEmoji/pickFile';

/**
 * Several pictures into My Emojis at once. Everything happens on this device:
 * each picture is shrunk by the same worker the single-add dialog uses, then
 * stored through personalEmojis().add (the encrypted local library that syncs to
 * your own devices through the encrypted backup). Nothing is sent to the server.
 *
 * One at a time on purpose: `add` reads the library, then writes it back, so
 * two at once could lose one of the entries.
 */
const ADD_ERROR: Record<string, string> = {
    full: `You can have ${PERSONAL_EMOJI_LIBRARY_MAX} emojis. Remove one first.`,
    duplicate_name: 'You already have an emoji with that name.',
    invalid_name: 'Names are 2 to 32 characters: letters, numbers and underscores.',
    too_large: 'That picture is still too large after shrinking.',
    not_an_image: 'That file is not a picture this computer can read.',
    signed_out: 'You are signed out. Sign in again and retry.',
};

export const MyEmojiBulkDialog: React.FC<{
    files: File[];
    onClose: (summary: { added: number }) => void;
    overlayStyle?: React.CSSProperties;
    /** 'sticker' = several pictures into My stickers (320 px, whole picture by default). */
    kind?: 'emoji' | 'sticker';
}> = ({ files, onClose, overlayStyle, kind = 'emoji' }) => {
    const sticker = kind === 'sticker';
    const { entries: emojiEntries } = usePersonalEmojiLibrary();
    const stickerEntries = usePersonalStickerLibrary();
    const entries = sticker ? stickerEntries : emojiEntries;
    const [mode, setMode] = useState<FrameMode>(sticker ? 'fit' : 'crop');
    const modeRef = useRef(mode);
    useEffect(() => { modeRef.current = mode; });

    return (
        <BulkEmojiDialog
            title={sticker ? 'Add stickers' : 'Add emojis'}
            subtitle={sticker ? 'Shrunk to 320 px on this computer. Nothing is uploaded.' : 'Shrunk to 128 px on this computer. Nothing is uploaded.'}
            initialFiles={files}
            existingNames={entries.map(e => e.name)}
            slots={Math.max(0, PERSONAL_EMOJI_LIBRARY_MAX - entries.length)}
            slotNoun={sticker ? 'in My stickers' : 'in My Emojis'}
            fileProblem={emojiFileProblem}
            concurrency={1}
            minGapMs={() => 0}
            activeLabel="Adding"
            previewFit={mode === 'fit' ? 'contain' : 'cover'}
            noun={kind}
            overlayStyle={overlayStyle}
            errorMessage={e => (e instanceof Error ? e.message : 'That emoji could not be added. Try again.')}
            fatalMessage={e => (e instanceof Error && e.message === ADD_ERROR.full ? (sticker ? 'My stickers is full.' : 'My Emojis is full.') : null)}
            extra={(
                <div>
                    <div className="text-xs text-cl-faint mb-1.5">Shape for all of them</div>
                    <ClSegment<FrameMode>
                        options={[{ value: 'crop', label: 'Crop to square' }, { value: 'fit', label: 'Fit whole picture' }]}
                        value={mode}
                        onChange={setMode}
                    />
                </div>
            )}
            upload={async (row, signal) => {
                const handle = processEmojiImage(row.file, modeRef.current, undefined, undefined, kind);
                const cancel = () => handle.cancel();
                signal.addEventListener('abort', cancel, { once: true });
                try {
                    const processed = await handle.result;
                    const res = await (sticker ? personalStickers() : personalEmojis()).add(processed.bytes, row.name);
                    if (!res.ok) throw new Error(ADD_ERROR[res.error] ?? 'That emoji could not be saved. Try again.');
                    if (res.alreadyHad) throw new Error(`That picture is already in your emojis as :${res.entry.name}:.`);
                } finally {
                    signal.removeEventListener('abort', cancel);
                }
            }}
            onClose={onClose}
        />
    );
};

export default MyEmojiBulkDialog;
