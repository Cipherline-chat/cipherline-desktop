import { describe, it, expect } from 'vitest';
import { channelNameDraftError, CHANNEL_NAME_INPUT_MAX_UNITS } from './displayName';
import { callNameDraftError, cleanCallName } from './callName';

/**
 * The desktop mirrors the API's display-name rule (packages/shared/display-name.ts,
 * enforced server-side by IsChannelName / IsCallName). The exhaustive rule matrix
 * lives in apps/api/src/servers/dto/display-name.spec.ts; this pins the desktop's
 * live-input behaviour: trim-then-validate, empty is not an error, nothing stripped.
 */
describe('channelNameDraftError', () => {
    it.each([
        ['plain', 'general'],
        ['"!" and "?"', 'party time!?'],
        ['emoji', '\u{1F3AE} games'],
        ['ZWJ family', '\u{1F468}‍\u{1F469}‍\u{1F467}'],
        ['flag', '\u{1F1FA}\u{1F1F8} usa'],
        ['keycap', '1️⃣ first'],
        ['skin tone', '\u{1F44D}\u{1F3FD}'],
        ['CJK', 'ゲーム部屋'],
        ['Arabic', 'قناة عامة'],
        ['punctuation soup', "R&D (EU): #1 - it's ok"],
    ])('accepts %s', (_l, v) => expect(channelNameDraftError(v)).toBeNull());

    it('ignores leading/trailing spaces (the draft is trimmed before sending) and empty drafts', () => {
        expect(channelNameDraftError('  general  ')).toBeNull();
        expect(channelNameDraftError('')).toBeNull();
        expect(channelNameDraftError('    ')).toBeNull();
    });

    it.each([
        ['bidi override', 'a‮b', /direction/],
        ['zero-width space', 'a​b', /hidden/],
        ['control character', 'a\u0007b', /control/],
        ['stray ZWJ', 'a‍b', /joiner/],
        ['zalgo', 'à́̂̃', /stacked/],
        ['invisible-only', '​‌', /hidden/],
        ['too long', 'x'.repeat(51), /50/],
    ])('reports %s', (_l, v, why) => expect(channelNameDraftError(v)).toMatch(why as RegExp));

    it('counts an emoji once: 50 fit, 51 do not', () => {
        expect(channelNameDraftError('\u{1F525}'.repeat(50))).toBeNull();
        expect(channelNameDraftError('\u{1F525}'.repeat(51))).toMatch(/50/);
    });

    it('the input paste guard is wide enough for 50 of the longest allowed sequences', () => {
        expect(CHANNEL_NAME_INPUT_MAX_UNITS).toBe(200);
    });
});

describe('callNameDraftError / cleanCallName', () => {
    it('allows the same characters, with a 60 limit', () => {
        expect(callNameDraftError('Raid \u{1F3AE}!')).toBeNull();
        expect(callNameDraftError('x'.repeat(60))).toBeNull();
        expect(callNameDraftError('x'.repeat(61))).toMatch(/60/);
        expect(callNameDraftError('a‮b')).toMatch(/direction/);
    });
    it('cleanCallName only trims', () => {
        expect(cleanCallName('  a!  ')).toBe('a!');
    });
});
