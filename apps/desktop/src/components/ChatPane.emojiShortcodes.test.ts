import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Typing `:name:` and pressing Enter must send the emoji exactly as picking it
 * would, and the `:` popup's keys must behave like Discord's. ChatPane has no
 * render harness, so the wiring that makes that true is pinned at the source
 * level (the conversion rules themselves are unit-tested in
 * utils/composerEmojiShortcodes.test.ts and composer/emojiSuggestions.test.ts).
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const send = src.slice(src.indexOf('const handleSendAll = async'), src.indexOf('const [pendingCallMode'));
const onKeyDown = src.slice(src.indexOf('onKeyDown={(e) => {\n                                        if (channelSuggestions.length > 0)'));

describe('typed :name: + Enter', () => {
    it('both the big-room check and the real send convert through the ONE toWireText (typed shortcodes included)', () => {
        expect(send).toContain('const wire = toWireText(inputText);');
        expect(send).toContain('const wireText = toWireText(inputText);');
        // no second, picks-only conversion left to drift from it
        expect(src).not.toMatch(/buildEmojiWireText\(\s*buildWireText\(inputText/);
    });

    it('toWireText resolves against My Emojis whose picture is on this device and THIS channel\'s server emojis', () => {
        const fn = src.slice(src.indexOf('const toWireText = '), src.indexOf('const toWireText = ') + 600);
        expect(fn).toContain('composerToWire(');
        expect(fn).toContain('myEmojiEntries.filter(e => have.has(e.id))');
        expect(fn).toContain('server: serverEmojis');
    });

    it('picks are forgotten on a conversation switch and once their message is sent (no stale token reaches another chat)', () => {
        expect(src).toContain('useEffect(() => { emojiTokenMapRef.current = {}; }, [draftConvKey]);');
        const early = send.slice(send.indexOf('const releaseComposerEarly'), send.indexOf('const releaseComposerEarly') + 400);
        expect(early).toContain('emojiTokenMapRef.current = {};');
        const late = send.slice(send.indexOf('const resumeDraft'), send.indexOf('const resumeDraft') + 400);
        expect(late).toContain('emojiTokenMapRef.current = {};');
    });
});

describe('the : popup keys', () => {
    const emojiBlock = onKeyDown.slice(onKeyDown.indexOf('if (emojiSuggestions.length > 0)'), onKeyDown.indexOf('// Up on an empty composer'));

    it('Enter and Tab accept the highlighted suggestion (and do not send); Shift+Enter is left alone', () => {
        expect(emojiBlock).toContain("if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertEmojiSuggestion(emojiSuggestions[selectedSuggestionIdx]); return; }");
    });

    it('with no popup open Enter falls through to send', () => {
        expect(onKeyDown).toContain("if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendAll(e); }");
    });

    it('the popup closes the moment the closing colon is typed (so Enter then sends), and matches either case', () => {
        expect(src).toContain("before.match(/:([a-z0-9_+-]{2,})$/i)");
    });

    it('the suggestions are filtered to emojis whose picture is on this device', () => {
        expect(src).toContain('availablePersonalIds: new Set(personalEmojis().store.ids())');
    });
});
