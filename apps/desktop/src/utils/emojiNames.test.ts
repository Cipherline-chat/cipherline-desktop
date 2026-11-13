import { describe, it, expect } from 'vitest';
import { isEmojiName, sanitizeEmojiNameInput, repairEmojiName, toShortcode, toShortcodeQuery } from './emojiNames';

describe('isEmojiName (letters, numbers, underscores; 2-32; lowercase)', () => {
    it.each(['ab', 'red_heart', 'a1', '__', 'x'.repeat(32), '0123'])('accepts %s', (n) => expect(isEmojiName(n)).toBe(true));
    it.each(['a', '', 'x'.repeat(33), 'red heart', 'red-heart', 'Red', 'a.b', 'a:b', ' ab', 'ab ', 'ab\n', 'é'.repeat(3), '😀😀'])(
        'rejects %j', (n) => expect(isEmojiName(n)).toBe(false));
    it('rejects non-strings', () => {
        for (const v of [null, undefined, 5, {}, ['ab']]) expect(isEmojiName(v)).toBe(false);
    });
});

describe('sanitizeEmojiNameInput (what a name <input> holds as you type or paste)', () => {
    it('a typed space becomes an underscore', () => expect(sanitizeEmojiNameInput('red ')).toBe('red_'));
    it('a typed dash becomes an underscore', () => expect(sanitizeEmojiNameInput('red-')).toBe('red_'));
    it('a pasted name gets the same treatment, end to end', () => {
        expect(sanitizeEmojiNameInput('Red Heart')).toBe('red_heart');
        expect(sanitizeEmojiNameInput('red-heart-2')).toBe('red_heart_2');
        expect(sanitizeEmojiNameInput('red–heart')).toBe('red_heart'); // en dash
        expect(sanitizeEmojiNameInput('a\tb c')).toBe('a_b_c');          // tab, nbsp
    });
    it('is 1:1 for separators: no collapsing or trimming, so the caret never jumps', () => {
        expect(sanitizeEmojiNameInput('a  b')).toBe('a__b');
        expect(sanitizeEmojiNameInput(' a')).toBe('_a');
    });
    it('drops anything else outside letters/numbers/underscores, lowercases, caps at 32', () => {
        expect(sanitizeEmojiNameInput('Pa:rty!.<3')).toBe('party3');
        expect(sanitizeEmojiNameInput('😀ok')).toBe('ok');
        expect(sanitizeEmojiNameInput('a'.repeat(40))).toHaveLength(32);
        expect(sanitizeEmojiNameInput('')).toBe('');
    });
    it('its output for ordinary text is always valid once 2+ chars long', () => {
        for (const raw of ['hello world', 'a-b', 'X Y Z', 'ok']) expect(isEmojiName(sanitizeEmojiNameInput(raw))).toBe(true);
    });
});

describe('repairEmojiName (stored names from before the rule)', () => {
    it('leaves a valid name alone', () => expect(repairEmojiName('red_heart')).toBe('red_heart'));
    it('turns separators into single underscores and trims', () => {
        expect(repairEmojiName('red heart')).toBe('red_heart');
        expect(repairEmojiName('red - heart')).toBe('red_heart');
        expect(repairEmojiName('  party-parrot ')).toBe('party_parrot');
        expect(repairEmojiName('Party Blob')).toBe('party_blob');
    });
    it('never returns something invalid, however bad the input', () => {
        for (const raw of ['', ' ', '-', 'a', '!!', '😀', 'x'.repeat(80), 'a b'.repeat(30), '--a--']) {
            expect(isEmojiName(repairEmojiName(raw))).toBe(true);
        }
    });
    it('a one-character name is padded rather than lost', () => expect(repairEmojiName('a')).toBe('a_emoji'));
});

describe('toShortcode (lookup form)', () => {
    it('Red Heart / red-heart / red heart / red_heart are the same name', () => {
        for (const v of ['Red Heart', 'red-heart', 'red heart', 'red_heart', 'RED_HEART', 'red  heart']) {
            expect(toShortcode(v)).toBe('red_heart');
        }
    });
    it('drops punctuation inside standard names', () => {
        expect(toShortcode("Man's Shoe")).toBe('mans_shoe');
        expect(toShortcode('Flag: United States')).toBe('flag_united_states');
        expect(toShortcode('Woman & Man Holding Hands')).toBe('woman_man_holding_hands');
    });
    it('keeps +, so +1 stays a name', () => expect(toShortcode('+1')).toBe('+1'));
    it('trims edge underscores', () => expect(toShortcode('_a_')).toBe('a'));
});

describe('toShortcodeQuery (mid-name)', () => {
    it('keeps a trailing underscore so "red_" can still find red_heart', () => {
        expect(toShortcodeQuery('red_')).toBe('red_');
        expect(toShortcodeQuery('red ')).toBe('red_');
        expect(toShortcodeQuery('red--')).toBe('red_');
    });
});
