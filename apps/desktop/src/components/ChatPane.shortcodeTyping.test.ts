import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ChatPane's wiring for live `:name:` conversion, pinned at the source level
 * (the rules themselves are unit-tested in utils/composerShortcodeTyping.test.ts;
 * the real composer is driven in a browser by harness/emoji-shortcodes-shots.mjs).
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const typing = src.slice(src.indexOf('const handleComposerChange = '), src.indexOf('const insertEmojiSuggestion = '));
const textarea = src.slice(src.indexOf('<RichComposer\n'), src.indexOf('{emojiSuggestions.length > 0 && composerEl && ('));

describe('composer shortcode wiring', () => {
    it('the change handler converts a typed closing colon before the autocomplete runs', () => {
        // On the box's PLAIN text and caret (a formatting marker never hides the colon).
        expect(typing).toContain('convertTypedShortcode(plain, cursor, inputRef.current)');
        // Every menu trigger (`:` / `@` / `#`) reads the plain text before the caret — never
        // the serialised message text, where `**` in front of an `@` / `#` would hide it —
        // and nothing triggers inside code.
        expect(typing).toContain("const before = inCode ? '' : plain.slice(0, cursor);");
        expect(typing).not.toMatch(/val\.slice\(0, cursor\)/);
        expect(typing.indexOf('convertTypedShortcode(')).toBeLessThan(typing.indexOf('searchEmojiWithCustom('));
    });

    it('the safety net at send resolves standard shortcodes through the same lookup', () => {
        const fn = src.slice(src.indexOf('const toWireText = '), src.indexOf('const toWireText = ') + 900);
        expect(fn).toContain('nativeLookup: t => lookupNativeShortcode(getNativeShortcodeIndex(), t)');
    });

    it('Space is an ordinary key in the message bar: no key handler special-cases it', () => {
        expect(textarea).not.toMatch(/key === ' '/);
        expect(textarea).not.toMatch(/key === "Spacebar"|e\.code === 'Space'/);
        expect(src).not.toMatch(/spaceKeyAction|AutoUnderscore|checkAutoUnderscore/);
    });

    it('menu labels and picker picks use the underscore shortcode, never the raw name', () => {
        expect(src).toContain('label: `:${s.shortcode ?? toShortcode(s.name)}:`');
        expect(src).toContain('const pickedName = emoji.name ? toShortcode(emoji.name) : \'\';');
    });
});
