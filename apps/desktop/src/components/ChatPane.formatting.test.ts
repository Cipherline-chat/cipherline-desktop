import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ChatPane's wiring for message formatting, pinned at the source level (the
 * rules are unit-tested in utils/formatting/*.test.ts, the components in
 * components/formatting + components/composer render tests, and the real
 * components are driven in a browser by harness/text-formatting-shots.mjs).
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const textarea = src.slice(src.indexOf('<RichComposer\n'), src.indexOf('{emojiSuggestions.length > 0 && composerEl && ('));
const body = src.slice(src.indexOf('const renderLeaf = (leaf: string'), src.indexOf('{/* URL embeds'));
const send = src.slice(src.indexOf('const handleSendAll = async'), src.indexOf('const handleSendAllRef'));

describe('message body', () => {
    it('renders through the formatter, with every plain run going to renderTextWithMentions', () => {
        expect(body).toContain('const renderBody = (t: string) => renderFormatted(t, {');
        expect(body).toMatch(/: renderTextWithMentions\(leaf, /);
        // #channel spans are found per run (the run is what renderTextWithMentions sees).
        expect(body).toContain('spans: findChannelRefSpans(leaf, channelRefs)');
        // A masked link's label is never a second link.
        expect(body).toContain('? mentionsToDisplayText(leaf)');
        expect(body).toContain('codeText: mentionsToDisplayText');
        expect(body).toContain('truncated: t.length < rawText.length');
        // A long message's collapsed preview is cut on the parsed tree (no open fence / spoiler / list).
        expect(src).toContain('renderPreview={(t) => renderFormattedPreview(t, { renderLeaf, codeText: mentionsToDisplayText })}');
    });

    it('applies the sender font through the allowlist only', () => {
        expect(body).toContain('fontFamily: fontStackFor(messageFontOf(msg.content))');
    });

    it('embeds come from the parse (no URL in code / spoiler / <url>)', () => {
        const embeds = src.slice(src.indexOf('{/* URL embeds'), src.indexOf('{/* URL embeds') + 900);
        expect(embeds).toContain('embedUrlsOf(text).slice(0, 3)');
        expect(embeds).not.toContain('matchAll(new RegExp(URL_REGEX.source');
    });
});

describe('composer', () => {
    it('the Aa toggle sits right after the paperclip', () => {
        const clip = src.indexOf('title="Attach File"');
        const toolbar = src.indexOf('<FormatToolbar');
        const ta = src.indexOf('<RichComposer\n');
        expect(clip).toBeGreaterThan(0);
        expect(toolbar).toBeGreaterThan(clip);
        expect(toolbar).toBeLessThan(ta);
    });

    it('shortcuts and list continuation run before ArrowUp-to-edit and Enter-to-send, and Enter alone still sends', () => {
        const fmt = textarea.indexOf('const fmtAction = shortcutAction(e, IS_MAC)');
        const cont = textarea.indexOf('inputRef.current?.newline();');
        const arrow = textarea.indexOf("if (e.key === 'ArrowUp') {\n");
        const fence = textarea.indexOf("if (e.key === 'Enter' && !e.shiftKey && inputRef.current?.enterShortcut()) { e.preventDefault(); return; }");
        const enter = textarea.indexOf("if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendAll(e); }");
        expect(fmt).toBeGreaterThan(0);
        expect(cont).toBeGreaterThan(fmt);
        expect(arrow).toBeGreaterThan(cont);
        // ``` + Enter makes a code block; otherwise Enter sends.
        expect(fence).toBeGreaterThan(arrow);
        expect(enter).toBeGreaterThan(fence);
        // Continuation is on the NEWLINE key only, decided by the editor (richDoc.newlineAt).
        expect(textarea).toContain("if (e.key === 'Enter' && e.shiftKey) {");
        // An IME composition owns every key, Enter included.
        expect(textarea.indexOf('if (e.nativeEvent.isComposing) return;')).toBeLessThan(textarea.indexOf('if (channelSuggestions.length > 0)'));
        // …and after every suggestion menu has had its turn at Enter.
        expect(textarea.indexOf('insertEmojiSuggestion(emojiSuggestions[selectedSuggestionIdx])')).toBeLessThan(fmt);
    });

    it('formatting goes through the WYSIWYG box (its own undo step), never by editing marker text', () => {
        const fn = src.slice(src.indexOf('const runFormatAction = '), src.indexOf('const formatPastedMarkdown = '));
        expect(fn).toContain('ed.applyFormat(action);');
        expect(src).not.toContain('replaceRangeUndoable');
        expect(src).not.toContain('applyComposerEdit');
    });

    it('a paste is offered formatting only through composerPastePrompt, and only when all of it went in', () => {
        const pasted = src.slice(src.indexOf('const handlePasted = '), src.indexOf('const removeStagedFile = '));
        // ONE offer per paste: composerPastePrompt picks code or Markdown (utils/formatting/composerPaste.ts).
        expect(pasted).toContain("inserted === original.replace(/\\r\\n?/g, '\\n') ? composerPastePrompt(original) : null");
        const fmt = src.slice(src.indexOf('const formatPastedMarkdown = '), src.indexOf('// The prompt belongs to that exact pasted text'));
        expect(fmt).toContain('ed.replaceWithCodeBlock(p.start, end, p.offer.lang)');
        expect(fmt).toContain('ed.replaceWithWire(p.start, end, p.offer.wire)');
        expect(src).toContain('{mdPaste?.landed && (');
        // Files are taken over before the box inserts anything.
        const paste = src.slice(src.indexOf('const handlePaste = '), src.indexOf('const handlePasted = '));
        expect(paste).toContain('const raw = Array.from(e.clipboardData.files);');
    });

    it('every text / edit send carries the composer font and size (and nothing for the defaults)', () => {
        expect(send.match(/\.\.\.fontField\(composerFont\)/g)?.length).toBe(3);
        // Size: the whole-message field only when every character has one size (richWire.extractUniformSize).
        expect(send.match(/\.\.\.fontField\(composerFont\), \.\.\.sizeField\(sized\.size\)/g)?.length).toBe(3);
        expect(send).toContain("type: 'edit', target_id: editingId, text: wireText,");
    });

    it('an edit loads the message font (given back afterwards) and its whole-message size as a span', () => {
        const start = src.slice(src.indexOf('const startEdit = (msg: any) => {'), src.indexOf('const beginReply = '));
        expect(start).toContain('preEditFontRef.current = composerFont;');
        expect(start).toContain('setComposerFont(messageFontOf(msg.content));');
        expect(start).toContain('setInputText(applyMessageSize(mentionsToDisplayText(rawText), messageSizeOf(msg.content)));');
        const cancel = src.slice(src.indexOf('const cancelEdit = () => {'), src.indexOf('useEscape(() => cancelEdit()'));
        expect(cancel).toContain('setComposerFont(preEditFontRef.current);');
        // no pane-level size state any more: size lives in the text
        expect(src).not.toMatch(/composerSize|preEditSizeRef/);
    });
});

describe('no HTML pass-through anywhere on the formatting path', () => {
    it('no dangerouslySetInnerHTML / innerHTML in the formatter, its components or its utils', () => {
        const dirs = [join(__dirname, 'formatting'), join(__dirname, '..', 'utils', 'formatting')];
        const files = [
            ...dirs.flatMap(d => readdirSync(d).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('.test.')).map(f => join(d, f))),
            join(__dirname, 'composer', 'FormatToolbar.tsx'),
            join(__dirname, 'composer', 'MarkdownPastePrompt.tsx'),
            join(__dirname, 'composer', 'RichComposer.tsx'),
            join(__dirname, 'composer', 'richDom.ts'),
        ];
        expect(files.length).toBeGreaterThan(6);
        for (const f of files) {
            // Code only: the doc comments say what is NOT used.
            const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
        }
    });
});

describe('previews strip formatting', () => {
    it('conversation list, notification, pinned panel', () => {
        const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
        expect(dash).toContain("text={toPlainText(lastMsg.content.text, { tokens: 'keep' })}");
        const notif = readFileSync(join(__dirname, '..', 'hooks', 'useNotificationDispatch.ts'), 'utf8');
        expect(notif).toContain('const displayText = toPlainText(text);');
        const pinned = readFileSync(join(__dirname, 'PinnedMessagesPanel.tsx'), 'utf8');
        expect(pinned).toContain('? toPlainText(msg.content.text)');
    });
});
