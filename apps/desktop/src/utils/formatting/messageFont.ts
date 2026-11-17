/**
 * Message fonts: the whole-message typeface picked in the composer's
 * formatting bar, carried as the optional `font` field on text / edit content
 * (packages/shared/content.ts MESSAGE_FONTS).
 *
 * Seven deliberately DIFFERENT looks: the app font, a book serif, a mono, a
 * handwriting, a typewriter, a marker and a high-legibility face. The four
 * new faces are latin-subset woff2 files bundled in the app
 * (src/assets/fonts, @font-face in styles/formatting.css; licences in
 * LICENSES.md and public/licenses/fonts). Nothing is ever fetched from the
 * network because of a message — a message can't be a tracking beacon (the
 * roadmap's "no remote fonts" promise) — and the browser only reads a face
 * from disk once something on screen uses it (the picker, or a message in it).
 * Fredoka ("Fun") was dropped: next to Nunito it was a second rounded sans.
 */
import { isMessageFont, isMessageSize, type MessageFont } from '@cipherline/shared';

export interface FontOption {
    /** null = the default (no `font` field on the wire). */
    id: MessageFont | null;
    label: string;
    /** One-line description for the picker. */
    hint: string;
    stack: string;
}

export const FONT_OPTIONS: readonly FontOption[] = [
    { id: null, label: 'Default', hint: 'Nunito, the app font', stack: 'var(--cl-font-body)' },
    { id: 'serif', label: 'Serif', hint: 'Lora, for longer reads', stack: "'Cipherline Lora', Georgia, 'Times New Roman', serif" },
    { id: 'mono', label: 'Mono', hint: 'JetBrains Mono, even columns', stack: 'var(--cl-font-mono)' },
    { id: 'hand', label: 'Handwritten', hint: 'Caveat, like a note', stack: "'Cipherline Caveat', 'Segoe Print', cursive" },
    { id: 'typewriter', label: 'Typewriter', hint: 'Special Elite, inky keys', stack: "'Cipherline Special Elite', 'Courier New', monospace" },
    { id: 'marker', label: 'Marker', hint: 'Permanent Marker, bold strokes', stack: "'Cipherline Permanent Marker', 'Comic Sans MS', cursive" },
    { id: 'readable', label: 'Readable', hint: 'Atkinson Hyperlegible, easiest to read', stack: "'Cipherline Atkinson Hyperlegible', system-ui, sans-serif" },
];

/** The validated font of a message's content, or null (sender-controlled: anything unknown is the default). */
export function messageFontOf(content: unknown): MessageFont | null {
    if (!content || typeof content !== 'object') return null;
    const f = (content as { font?: unknown }).font;
    return isMessageFont(f) ? f : null;
}

/** The CSS font-family for a font id, or undefined for the default (inherit). */
export function fontStackFor(font: MessageFont | null | undefined): string | undefined {
    if (!font) return undefined;
    return FONT_OPTIONS.find(o => o.id === font)?.stack;
}

export function fontLabelFor(font: MessageFont | null | undefined): string {
    return FONT_OPTIONS.find(o => o.id === (font ?? null))?.label ?? 'Default';
}

/** `{ font }` to spread into outgoing content: nothing at all for the default, so old clients see no change. */
export function fontField(font: MessageFont | null | undefined): { font?: MessageFont } {
    return font && isMessageFont(font) ? { font } : {};
}

/**
 * The content of an edited message with the EDIT's font and size: an edit
 * carries the message's complete new presentation, so its font / size replace
 * the original's and an edit without one (older client, or set back to
 * Default / Normal) clears it. Sender-controlled, so only a known id is ever
 * written.
 */
export function withEditFont<T extends object>(content: T, editFont: unknown, editSize?: unknown): T {
    const rest = { ...content } as Record<string, unknown>;
    delete rest.font;
    delete rest.size;
    if (isMessageFont(editFont)) rest.font = editFont;
    if (isMessageSize(editSize)) rest.size = editSize;
    return rest as T;
}
