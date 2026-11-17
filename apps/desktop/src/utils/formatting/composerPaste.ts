/**
 * Which paste prompt (components/composer/MarkdownPastePrompt) a text paste
 * into the WYSIWYG composer gets.
 *
 * A paste always goes in as plain, literal text (HTML on the clipboard is
 * never read). In a WYSIWYG box "Format" now visibly changes it: Markdown
 * becomes bold / lists / headings in the box, code becomes a code block. So:
 *  - code (codePaste.looksLikeCode, which also wins over Markdown) -> "Paste as a code block?";
 *  - Markdown from elsewhere (markdownPaste.looksLikeMarkdown) -> converted to
 *    our syntax, offered when that shows differently from the literal paste;
 *  - text already in OUR syntax (e.g. copied out of a Cipherline message with
 *    Copy Text) -> offered as it is, when it would show formatted.
 * Plain text, or text whose only "syntax" would not format anything (a lone
 * `*`, `2 * 3`, a link) gets no prompt.
 */
import { pastePromptFor } from './codePaste';
import { convertMarkdown, looksLikeMarkdown } from './markdownPaste';
import { docsEqual } from './richDoc';
import { docFromWire, literalDoc } from './richWire';

export type ComposerPastePrompt =
    | { kind: 'markdown'; wire: string }
    | { kind: 'code'; lang: string | null };

export function composerPastePrompt(text: string): ComposerPastePrompt | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    const t = text.replace(/\r\n?/g, '\n');
    const base = pastePromptFor(t);
    if (base?.kind === 'code') return base;
    const literal = literalDoc(t);
    if (base || looksLikeMarkdown(t)) {
        const wire = convertMarkdown(t);
        if (!docsEqual(docFromWire(wire), literal)) return { kind: 'markdown', wire };
    }
    if (!docsEqual(docFromWire(t), literal)) return { kind: 'markdown', wire: t };
    return null;
}
