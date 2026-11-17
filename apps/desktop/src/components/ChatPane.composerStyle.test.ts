/**
 * "make it so all of them is never remembered after I send the message. I
 * don't want people always typing out in a special font" (owner, 2026-11-16).
 *
 * The composer's message font and size are per message: back to Default /
 * Normal (and no style switched on) after every send, never persisted, not
 * carried across conversations, and an edit's own font / size never leak into
 * the next new message. ChatPane has no render harness, so the wiring is pinned
 * at the source level; the box's own reset (pending styles and undo history
 * dropped when the text is cleared) is driven in RichComposer.render.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDraftStore, parseDrafts } from '../utils/composerDrafts';

const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const send = src.slice(src.indexOf('const handleSendAll = async'), src.indexOf('const handleSendAllRef'));
const early = send.slice(send.indexOf('const releaseComposerEarly'), send.indexOf('try {', send.indexOf('const releaseComposerEarly')));
const late = send.slice(send.indexOf('if (!earlyReleased) {\n'), send.indexOf("if (!earlyReleased) playIco(sendIcoRef.current, 'play-send');"));

describe('nothing sticks after a send', () => {
    it('the font starts at the default (pane state only); text size has no pane state — it is a span style in the text', () => {
        expect(src).toContain('const [composerFont, setComposerFont] = useState<MessageFont | null>(null);');
        expect(src).not.toMatch(/composerSize|setComposerSize|preEditSizeRef/);
        // The picker sets the size on the box's selection (or arms it for what is typed next).
        expect(src).toContain('onSizeChange={(sz) => { inputRef.current?.applySize(sz); inputRef.current?.focus(); }}');
    });

    it('an instant text send clears the box (spans with it) and resets the font', () => {
        expect(early).toContain("setInputText('');");
        expect(early).toContain('setComposerFont(null);');
    });

    it('an awaited send (files) resets the font; saving an edit hands back the DRAFT\'s own, never the edited message\'s', () => {
        expect(late).toContain('setInputText(resumeDraft);');
        expect(late).toContain('setComposerFont(editingId ? preEditFontRef.current : null);');
        // The pre-edit ref only ever holds what was in the composer BEFORE the edit.
        const start = src.slice(src.indexOf('const startEdit = (msg: any) => {'), src.indexOf('const beginReply = '));
        expect(start).toMatch(/if \(!editingId\) \{[\s\S]*preEditFontRef\.current = composerFont;[\s\S]*\}/);
        // An edited message's whole-message size loads as spans in ITS text, so it can't leak.
        expect(start).toContain('applyMessageSize(mentionsToDisplayText(rawText), messageSizeOf(msg.content))');
    });

    it('active inline styles are cleared with the text: the box drops pending marks when its value is replaced', () => {
        const box = readFileSync(join(__dirname, 'composer', 'RichComposer.tsx'), 'utf8');
        const effect = box.slice(box.indexOf('// ── The value prop'), box.indexOf('// ── Imperative handle'));
        expect(effect).toContain('typingMarksRef.current = null;');
        expect(effect).toContain('pastRef.current = [];');
    });
});

describe('never persisted, never carried across conversations', () => {
    it('no font / size reaches the draft store, secureLocalStore or any other store', () => {
        // The only draft write is the TEXT.
        expect(src.match(/composerDrafts\.set\(/g)).toHaveLength(1);
        expect(src).toContain('composerDrafts.set(draftUserId, draftConvKey, inputText, activeChannel?.server_id);');
        for (const line of src.split('\n')) {
            if (/secureLocalStore\.setItem|secureStore\.set|localStorage|sessionStorage|indexedDB/.test(line)) {
                expect(line, line).not.toMatch(/composerFont|composerFormats|font|size/i);
            }
        }
    });

    it('a draft record holds text, time and server only (a font / size field is dropped on read)', () => {
        const parsed = parseDrafts(JSON.stringify({ d: { 'dm:1': { t: 'hi', at: 1, font: 'mono', size: 'large' } } }));
        expect(parsed['dm:1']).toEqual({ t: 'hi', at: 1 });
        // and the store API cannot take one
        expect(createDraftStore.length).toBe(1);
    });

    it('each conversation gets a fresh pane (Dashboard keys it), so a choice cannot follow you', () => {
        expect(dash).toContain("key={activeChat?.id ?? activeChannel?.channel_id ?? 'empty'}");
    });

    it('a restored draft is text only, so it starts at the defaults too', () => {
        expect(src).toContain('composerDrafts.get(draftUserId, draftConvKey)');
        const restore = src.slice(src.indexOf('void composerDrafts.whenReady().then('), src.indexOf('void composerDrafts.whenReady().then(') + 400);
        expect(restore).not.toMatch(/setComposerFont|setComposerSize/);
    });
});

describe('every send carries the chosen style for that one message', () => {
    it('text sends and edits carry the font, and a size field only for a one-size message', () => {
        expect(send.match(/\.\.\.fontField\(composerFont\), \.\.\.sizeField\(sized\.size\)/g)).toHaveLength(3);
        expect(send).toContain('const sized = extractUniformSize(inputText);');
    });
});
