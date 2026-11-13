import React from 'react';
import { mentionsToPlainText } from '../utils/mentionTokens';
import { previewParts } from '../utils/conversationPreviewParts';
import { PersonalEmojiImage } from './PersonalEmoji';

/**
 * The last-message text in the DM / group list, with custom emojis drawn as
 * the emoji itself instead of `:name:` (owner, 2026-11-08).
 *
 * Only personal ("My Emojis") emojis can be drawn here: they resolve by id on
 * this device, which is what the chat itself does in a DM. A server emoji
 * needs its server's context (and key), which a DM row does not have, so it
 * keeps its `:name:` text. Everything else (mentions, @everyone, plain text)
 * goes through the same plain-text rules as before (`mentionsToPlainText`),
 * one segment at a time, so the preview never shows a raw user id.
 *
 * The emoji box is 1.15em: one line of the 12px preview, so the row height
 * does not change. Not saveable from here (no right-click menu inside a
 * clickable list row).
 */
export function ConversationPreviewText({ text, resolveUsername, prefix }: {
    text: string;
    resolveUsername: (userId: string) => string | undefined;
    /** Shown before the text, e.g. "You: ". */
    prefix?: string;
}) {
    const parts = previewParts(text);
    if (!parts.some(p => p.kind === 'emoji')) {
        return <>{prefix}{mentionsToPlainText(text, resolveUsername)}</>;
    }
    return (
        <>
            {prefix}
            {parts.map((p, i) => p.kind === 'emoji'
                ? (
                    <PersonalEmojiImage
                        key={i}
                        id={p.id}
                        name={p.label}
                        saveable={false}
                        className="inline-block align-text-bottom"
                        style={{ width: '1.15em', height: '1.15em' }}
                    />
                )
                : <React.Fragment key={i}>{mentionsToPlainText(p.text, resolveUsername)}</React.Fragment>)}
        </>
    );
}
