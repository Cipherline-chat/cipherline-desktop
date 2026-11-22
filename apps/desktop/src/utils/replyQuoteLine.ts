import { stickerPreviewText } from './stickers/wire';
/**
 * The one line a reply quote shows for its original (owner, 2026-11-16):
 * replies to an image say "Image", to any other file "Attachment", to a GIF
 * "GIF"; text shows its snippet. The author's name is drawn above it
 * separately. Never the filename: the quote says what it is, not its name.
 *
 * `snippetOf` is the caller's text preview (mentions resolved, clipped), so
 * this stays pure and the text path is unchanged.
 */
export function replyQuoteLine(
    content: { type?: unknown; mime?: unknown; text?: unknown } | null | undefined,
    snippetOf: (c: { text?: unknown }) => string,
): string {
    if (content?.type === 'attachment') {
        return typeof content.mime === 'string' && content.mime.toLowerCase().startsWith('image/') ? 'Image' : 'Attachment';
    }
    if (content?.type === 'klipy_gif') return 'GIF';
    // A sticker rides a text message; quote what it is, not its fallback text.
    const sticker = stickerPreviewText(content);
    if (sticker) return sticker;
    const s = content ? snippetOf(content) : '';
    return s || 'Original message';
}
