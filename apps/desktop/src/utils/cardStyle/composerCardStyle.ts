/**
 * The composer's card style: a deliberate, PER-MESSAGE choice.
 *
 * Styling is for posts that should stand apart (a #rules post, an
 * announcement, an event), not for every message, so nothing is ever applied
 * by default. The user opens "Style this message" from the formatting bar,
 * picks a template, one of "My styles" or crafts one (visual or CSS), and the
 * style rides on THAT message only: the composer resets it after the send,
 * exactly like the font.
 *
 * Wire rules (packages/shared/content.ts):
 *  - a new `text` carries `card_style` only when the message is styled;
 *  - an `edit` carries `card_style` only when the style was changed during
 *    the edit (a style, or `null` to remove it); otherwise the field is
 *    absent and every reader keeps the original's style (withEditCardStyle).
 * Everything sent is normalised and under CARD_STYLE_MAX_BYTES; anything
 * else is dropped, never sent.
 */
import {
    CARD_STYLE_MAX_BYTES, cardStyleByteSize, normalizeCardStyle, sameCardStyle, type CardStyle,
} from '@cipherline/shared';
import type { LibraryCardStyle } from '../../hooks/useCardStylePrefs';
import { CARD_STYLE_TEMPLATES } from './cardStyleTemplates';

/** The style the message being written carries. */
export interface ComposerCard {
    style: CardStyle;
}

function safeStyle(s: CardStyle | null | undefined): CardStyle | null {
    const n = s ? normalizeCardStyle(s) : null;
    return n && cardStyleByteSize(n) <= CARD_STYLE_MAX_BYTES ? n : null;
}

/** `{ card_style }` to spread into a new text message: nothing at all when unstyled. */
export function cardStyleSendField(card: ComposerCard | null): { card_style?: CardStyle } {
    const s = safeStyle(card?.style);
    return s ? { card_style: s } : {};
}

/** `{ card_style }` for an edit: absent unless changed during the edit; `null` removes the style. */
export function cardStyleEditField(touched: boolean, card: ComposerCard | null): { card_style?: CardStyle | null } {
    if (!touched) return {};
    return { card_style: safeStyle(card?.style) };
}

/** A short name for a style: its template's, its "My styles" name, or "Custom". */
export function cardStyleLabel(style: CardStyle | null | undefined, library: readonly LibraryCardStyle[] = []): string | null {
    if (!style) return null;
    const t = CARD_STYLE_TEMPLATES.find(x => sameCardStyle(x.style, style));
    if (t) return t.label;
    const l = library.find(x => sameCardStyle(x.style, style));
    if (l) return l.name;
    return 'Custom';
}
