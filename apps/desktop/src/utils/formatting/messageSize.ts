/**
 * Message text size: Small / Normal / Large, picked in the composer's
 * formatting bar. Owner, 2026-11-16: "Being able to change text size (within
 * reason) would be nice too", then "highlight some text make it big, and
 * other text make it small, all in one message", then "make the big text
 * bigger too".
 *
 * Within reason: Small 0.875x, Normal 1x, Large 1.5x — Large is the cap, so
 * one message can't take over the feed. Two carriers, one allowlist
 * (packages/shared MESSAGE_SIZES):
 *  - a SPAN: `[small]…[/small]` / `[large]…[/large]` in the text
 *    (utils/formatting/markdown.ts), rendered absolute (15px x scale) and
 *    nesting with every other style;
 *  - the WHOLE message: the optional `size` field — what the composer sends
 *    when every character has the same size (clean text for older clients),
 *    and what messages sent before spans existed carry. The body sets
 *    `--cl-msg-scale`, which code blocks multiply by (styles/formatting.css).
 * Emoji-only "jumbo" messages ignore the field. Sender-controlled: anything
 * not in the allowlist is the normal size. Previews, notifications and
 * toPlainText never show a size.
 */
import { isMessageSize, type MessageSize } from '@cipherline/shared';

export interface SizeOption {
    /** null = normal (no `size` field on the wire). */
    id: MessageSize | null;
    label: string;
    hint: string;
    scale: number;
}

export const SIZE_OPTIONS: readonly SizeOption[] = [
    { id: 'small', label: 'Small', hint: 'A little quieter', scale: 0.875 },
    { id: null, label: 'Normal', hint: 'The usual size', scale: 1 },
    { id: 'large', label: 'Large', hint: 'Bigger, never huge', scale: 1.5 },
];

/**
 * Size SPANS (owner, 2026-11-16: "highlight some text make it big, and other
 * text make it small, all in one message") are inline syntax in the text,
 * `[small]…[/small]` / `[large]…[/large]` (utils/formatting/markdown.ts),
 * using the same two ids and scales. A message whose text is ALL one size is
 * sent with this per-message field instead (clean text for older clients;
 * richWire.extractUniformSize). contentValidation refuses a text with more
 * than MAX_SIZE_TAGS openers; the renderer honours MAX_SIZE_SPANS of them.
 */
export const MAX_SIZE_TAGS = 1000;

/** The largest scale any message can have (the "can't take over the feed" cap). */
export const MAX_MESSAGE_SCALE = 1.5;

/** The validated size of a message's content, or null (sender-controlled: anything unknown is normal). */
export function messageSizeOf(content: unknown): MessageSize | null {
    if (!content || typeof content !== 'object') return null;
    const s = (content as { size?: unknown }).size;
    return isMessageSize(s) ? s : null;
}

/** The scale factor for a size id (1 for normal or anything unknown), never above MAX_MESSAGE_SCALE. */
export function sizeScaleFor(size: MessageSize | null | undefined): number {
    const id = isMessageSize(size) ? size : null;
    const scale = SIZE_OPTIONS.find(o => o.id === id)?.scale ?? 1;
    return Math.min(scale, MAX_MESSAGE_SCALE);
}

export function sizeLabelFor(size: MessageSize | null | undefined | 'mixed'): string {
    if (size === 'mixed') return 'Mixed';
    return SIZE_OPTIONS.find(o => o.id === (size ?? null))?.label ?? 'Normal';
}

/** `{ size }` to spread into outgoing content: nothing at all for normal, so old clients see no change. */
export function sizeField(size: MessageSize | null | undefined): { size?: MessageSize } {
    return size && isMessageSize(size) ? { size } : {};
}

/**
 * The chat row's message body text: 15px at normal size, line-height
 * 'normal'. The ONE source for ChatPane's row body and the composer's live
 * card preview (components/messageCard/ComposerCardSurface), so the preview's
 * text can't drift from the posted message's.
 */
export const MESSAGE_BODY_PX = 15;
/** 'normal' unless Accessibility > Line spacing: Relaxed sets --cl-msg-leading (styles/readability.css). */
export const MESSAGE_BODY_LINE_HEIGHT = 'var(--cl-msg-leading, normal)';

/**
 * The chat row's message body element classes (ChatPane's row body; harnesses
 * draw the same element). `cl-msg-body` (styles/formatting.css) clips only
 * SIDEWAYS: an inline emoji (1.25em in a line sized for 1em text) draws a few
 * px above its line, and the old `overflow-hidden` cut the top off every emoji
 * on a message's first line (owner, 2026-11-18). Line spacing is unchanged.
 */
export const MESSAGE_BODY_CLASS = 'text-white/90 break-words whitespace-pre-wrap cl-msg-body';

/** The message body's font size for a base px size and a message size (15px -> 13.125 / 15 / 22.5). */
export function scaledPx(basePx: number, size: MessageSize | null | undefined): string {
    return `${+(basePx * sizeScaleFor(size)).toFixed(3)}px`;
}

/**
 * A size SPAN's font-size: absolute (15px x scale in a normal message), so
 * it is divided by the scale around it — the message's own field, or an
 * outer span's, which the renderer re-sets on the span's inner element.
 */
export function spanFontSize(size: MessageSize): string {
    return `calc(1em * ${sizeScaleFor(size)} / var(--cl-msg-scale, 1))`;
}
