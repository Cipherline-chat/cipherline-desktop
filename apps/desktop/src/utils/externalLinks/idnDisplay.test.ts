import { describe, it, expect } from 'vitest';
import { decodePunycode, labelToUnicode } from './punycode';
import { hostDisplay, isSpoofVerdict } from './idnDisplay';

/** What the browser's URL parser makes of a typed host (the only input these see). */
const ascii = (host: string) => new URL(`https://${host}/`).hostname;

describe('punycode decode (RFC 3492)', () => {
    it.each([
        ['mnchen-3ya', 'münchen'],
        ['fiqs8s', '中国'],
        ['p1ai', 'рф'],
        ['80ak6aa92e', 'аррӏе'],
        ['pple-43d', 'аpple'],
        ['bcher-kva', 'bücher'],
    ])('decodes %s → %s', (input, out) => {
        expect(decodePunycode(input)).toBe(out);
    });

    it.each(['', '!!!', 'a'.repeat(64), 'zzzzzzzzzzzzzzzzzzzz9'])('refuses malformed input %j', (input) => {
        expect(decodePunycode(input)).toBeNull();
    });

    it('labelToUnicode refuses a non-canonical label (must round-trip through the URL parser)', () => {
        // Upper-case basic code points decode, but the parser would never emit them.
        expect(labelToUnicode('xn--mnchen-3ya')).toBe('münchen');
        expect(labelToUnicode('xn--abc')).toBeNull();
        expect(labelToUnicode('example')).toBe('example');
    });
});

describe('hostDisplay — the browser IDN rule', () => {
    it('plain ASCII hosts are left alone', () => {
        expect(hostDisplay('www.example.com')).toEqual({ ascii: 'www.example.com', shown: 'www.example.com', unicode: null, verdict: 'ascii' });
    });

    it.each([
        ['münchen.de', 'münchen.de'],
        ['bücher.example', 'bücher.example'],
        ['中国.cn', '中国.cn'],
        ['日本語テスト.jp', '日本語テスト.jp'],     // Han + Katakana: allowed Japanese mix
        ['яндекс.рф', 'яндекс.рф'],                // Cyrillic, Cyrillic TLD
        ['ελλάδα.gr', 'ελλάδα.gr'],
    ])('honest IDN %s is shown in Unicode', (typed, shown) => {
        const d = hostDisplay(ascii(typed));
        expect(d.verdict).toBe('unicode');
        expect(d.shown).toBe(shown);
        expect(d.ascii).toMatch(/xn--/);
    });

    it.each([
        ['аpple.com', 'mixed-script'],             // Cyrillic а + Latin pple
        ['pаypal.com', 'mixed-script'],
        ['gοogle.com', 'mixed-script'],            // Greek omicron inside Latin
        ['аррӏе.com', 'whole-script-confusable'],  // all-Cyrillic, every letter Latin-alike, .com
        ['ѕсоре.com', 'whole-script-confusable'],
        ['οκ.com', 'whole-script-confusable'],     // all-Greek look-alikes on .com
    ])('confusable %s is shown as punycode (%s)', (typed, verdict) => {
        const d = hostDisplay(ascii(typed));
        expect(d.verdict).toBe(verdict);
        expect(d.shown).toBe(d.ascii);
        expect(d.shown).toMatch(/^xn--/);
        expect(isSpoofVerdict(d.verdict)).toBe(true);
    });

    it('a Latin-alike Cyrillic label on a Cyrillic TLD is honest (same rule as Chromium)', () => {
        expect(hostDisplay(ascii('аррӏе.рф')).verdict).toBe('unicode');
        expect(hostDisplay(ascii('аррӏе.ru')).verdict).toBe('unicode');
    });

    it('letters that read as punctuation fail', () => {
        // U+01C3 ǃ (looks like "!") — a \p{L} letter the URL parser lets through.
        const d = hostDisplay(ascii('helloǃ.com'));
        expect(d.verdict).toBe('disallowed-character');
        expect(d.shown).toBe(d.ascii);
    });

    it('one bad label makes the whole host punycode', () => {
        const d = hostDisplay(ascii('münchen.аpple.com'));
        expect(d.verdict).toBe('mixed-script');
        expect(d.shown).toBe(d.ascii);
        expect(d.shown).toContain('xn--mnchen-3ya');
    });

    it('an xn-- label that does not decode stays raw as invalid', () => {
        const d = hostDisplay('xn--abc.com');
        expect(d.verdict).toBe('invalid');
        expect(d.shown).toBe('xn--abc.com');
    });
});
