/**
 * The sender-built embeds a reader may draw for a message (phase 3): the
 * shared validator run against the links THIS reader finds in the text.
 */
import { sanitizeLinkEmbeds, type LinkEmbed } from '@cipherline/shared';

/** The embeds a reader may draw for this text (memoise on text + raw field). */
export function senderEmbedsFor(text: string, raw: unknown, urls: readonly string[]): LinkEmbed[] {
    if (!Array.isArray(raw) || raw.length === 0 || !text) return [];
    return sanitizeLinkEmbeds(raw, urls);
}
