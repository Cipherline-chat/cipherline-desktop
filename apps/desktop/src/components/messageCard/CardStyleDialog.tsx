/**
 * "Style this message" / "Edit style": the card editor in a roomy dialog.
 *
 * Opened from the composer's formatting bar (the style applies to the
 * message being written, and resets after it is sent) and from a sent
 * message's "Edit style" action (the style is sent as an edit of that
 * message). Nothing here is ever applied by default.
 */
import React, { useState } from 'react';
import type { CardStyle } from '@cipherline/shared';
import { ClModal } from '../cl';
import { ClButton } from '../ClButton';
import { CardStyleEditor, type CardStyleLibraryApi } from './CardStyleEditor';

export interface CardStyleDialogProps {
    open: boolean;
    /** The style the message has now (null = plain). */
    initial: CardStyle | null;
    title: string;
    /** "Use for this message" / "Save style". */
    applyLabel: string;
    previewText: string;
    previewName: string;
    previewFont?: string;
    library?: CardStyleLibraryApi;
    onApply: (style: CardStyle | null) => void;
    onClose: () => void;
}

export const CardStyleDialog: React.FC<CardStyleDialogProps> = ({ open, initial, title, applyLabel, previewText, previewName, previewFont, library, onApply, onClose }) => {
    // Mounted per opening (callers render it only while open), so each
    // opening starts from the message's current style.
    const [draft, setDraft] = useState<CardStyle | null>(initial);
    return (
        <ClModal open={open} onClose={onClose} width={1040} label={title} cardClassName="cse-dialog">
            <div className="cse-dialog-head">
                <h3>{title}</h3>
                <p>A card for posts that should stand apart: rules, announcements, events. It travels encrypted with this message only.</p>
            </div>
            <CardStyleEditor
                value={draft}
                onChange={setDraft}
                previewText={previewText}
                previewName={previewName}
                previewFont={previewFont}
                library={library}
            />
            <div className="cse-dialog-foot">
                {initial && (
                    <ClButton variant="ghost" size="sm" onClick={() => onApply(null)} className="cse-remove">Remove style</ClButton>
                )}
                <span style={{ flex: 1 }} />
                <ClButton variant="ghost" size="sm" onClick={onClose}>Cancel</ClButton>
                <ClButton size="sm" onClick={() => onApply(draft)} disabled={!draft && !initial}>{applyLabel}</ClButton>
            </div>
        </ClModal>
    );
};

export default CardStyleDialog;
