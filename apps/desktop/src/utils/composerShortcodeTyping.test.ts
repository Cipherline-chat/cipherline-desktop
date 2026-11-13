import { describe, it, expect } from 'vitest';
import { codeRanges, isInsideCode, findTypedShortcode, planLiveConversion } from './composerShortcodeTyping';
import { resolveExactEmoji, type ServerCandidate } from '../components/composer/emojiSuggestions';

const P1 = 'p_' + 'a'.repeat(32);
const S1 = '11111111-1111-4111-8111-111111111111';
const server: ServerCandidate[] = [
    { emoji_id: S1, name: 'partyblob', attachment_id: 'att', key_b64: 'k', nonce_b64: 'n' },
];
const natives: Record<string, string> = { red_heart: '❤️', heart: '❤️', smile: '\u{1F604}', '100': '\u{1F4AF}', ok: '\u{1F197}' };
const nativeLookup = (t: string) => natives[t.toLowerCase().replace(/[\s-]+/g, '_')];

const plan = (text: string, caret = text.length, over: { server?: ServerCandidate[]; available?: Set<string> | null } = {}) =>
    planLiveConversion(text, caret, typed => resolveExactEmoji(typed, over.server ?? server, [{ id: P1, name: 'mine' }], {
        availablePersonalIds: over.available === undefined ? new Set([P1]) : over.available,
        nativeLookup,
    }));
/** Apply a plan to text the way the textarea edit does; returns text and caret. */
const apply = (text: string, caret = text.length) => {
    const p = plan(text, caret);
    if (!p) return null;
    return { text: text.slice(0, p.start) + p.replacement + text.slice(p.end), caret: p.start + p.replacement.length, plan: p };
};

describe('closing colon converts a complete known name', () => {
    it('standard: :red_heart: becomes the glyph with the caret directly after it', () => {
        const r = apply(':red_heart:')!;
        expect(r.text).toBe('❤️');
        expect(r.caret).toBe(r.text.length);
    });

    it('at the very start, the very end, and mid-sentence (caret after the glyph, tail untouched)', () => {
        expect(apply('hi :smile:')!.text).toBe('hi \u{1F604}');
        const mid = 'say :smile: now';
        const caret = 'say :smile:'.length;
        const r = apply(mid, caret)!;
        expect(r.text).toBe('say \u{1F604} now');
        expect(r.caret).toBe('say \u{1F604}'.length);
    });

    it('several in one line: each converts as its closing colon is typed', () => {
        let t = ':smile: and ';
        t = apply(':smile:')!.text + ' and ';
        t += ':red_heart:';
        expect(apply(t)!.text).toBe('\u{1F604} and ❤️');
        // back to back: the second opens right after the first emoji
        expect(apply('\u{1F604}:red_heart:')!.text).toBe('\u{1F604}❤️');
        expect(apply(':partyblob::smile:')!.text).toBe(':partyblob:\u{1F604}');
    });

    it('old-style spellings of a COMPLETE name resolve (spaces, dashes, case)', () => {
        expect(apply(':Red Heart:')!.text).toBe('❤️');
        expect(apply(':red-heart:')!.text).toBe('❤️');
        expect(apply(':SMILE:')!.text).toBe('\u{1F604}');
    });

    it('a server emoji stays :name: in the box and registers the same token a menu pick does', () => {
        const r = apply(':partyblob:')!;
        expect(r.text).toBe(':partyblob:');
        expect(r.plan.pick).toEqual({ display: ':partyblob:', token: `<:partyblob:${S1}>` });
    });

    it('a My Emoji does the same, and a differently spelled one is rewritten to the canonical name', () => {
        const r = apply(':Mine:')!;
        expect(r.text).toBe(':mine:');
        expect(r.plan.pick).toEqual({ display: ':mine:', token: `<:mine:${P1}>` });
    });
});

describe('what must NOT convert (the negatives)', () => {
    it.each([
        ['an unknown name', ':notanemoji:'],
        ['a clock', '12:30:'],
        ['a clock mid-sentence', 'meet at 12:30 or 10:30:'],
        ['a label then text', 'note: hi:'],
        ['a label directly followed by a known name', 'note:smile:'],
        ['letters right before the colon', 'foo:smile:'],
        ['digits right before the colon', '5:100:'],
        ['an emoticon', ':)'],
        ['an emoticon then text', ':) smile:'],
        ['double colon', '::'],
        ['empty body', ':::'],
        ['one-letter body', ':a:'],
        ['a space just inside the colons', ': smile:'],
        ['a space just before the closing colon', ':smile :'],
        ['prose with colons', 'ratio is 3:2 and the time is 4:5:'],
        ['a url', 'https://example.com:smile:'],
    ])('%s', (_label, text) => {
        expect(plan(text)).toBeNull();
    });

    it('only acts when the CLOSING colon is the character just typed (caret right after it)', () => {
        expect(plan(':smile: x', ':smile'.length)).toBeNull();
        expect(plan(':smile:', ':smil'.length)).toBeNull();
    });

    it('a half-typed name with no closing colon', () => expect(plan(':smile')).toBeNull());
});

describe('viewer cannot use it -> same rule as the autocomplete (left as typed)', () => {
    it("another server's emoji: not in the active server's list, so plain text", () => {
        expect(plan(':partyblob:', undefined, { server: [] })).toBeNull();
    });
    it('a server emoji with no image key material is never offered, so never converted', () => {
        expect(plan(':partyblob:', undefined, { server: [{ ...server[0], key_b64: '' }] })).toBeNull();
    });
    it('a My Emoji whose picture is not on this device', () => {
        expect(plan(':mine:', undefined, { available: new Set() })).toBeNull();
    });
    it('a My Emoji beats a same-named server emoji, as everywhere else', () => {
        const r = plan(':mine:', undefined, { server: [{ ...server[0], name: 'mine' }] })!;
        expect(r.pick!.token).toBe(`<:mine:${P1}>`);
    });
    it('before the standard dataset has loaded nothing standard converts (no crash)', () => {
        const p = planLiveConversion(':smile:', 7, t => resolveExactEmoji(t, [], [], {}));
        expect(p).toBeNull();
    });
});

describe('code is literal text', () => {
    it('inline code', () => {
        expect(plan('`:smile:')).toBeNull();            // unclosed backtick: rest of the line is code
        expect(plan('use `x :smile:')).toBeNull();
        expect(apply('`code` :smile:')!.text).toBe('`code` \u{1F604}'); // closed span is behind us
    });
    it('code blocks', () => {
        expect(plan('```\n:smile:')).toBeNull();
        expect(plan('```js\nfoo\n:smile:')).toBeNull();
        expect(apply('```\nx\n``` :smile:')!.text).toBe('```\nx\n``` \u{1F604}');
    });
    it('a stray backtick on an earlier line does not silence later lines', () => {
        expect(apply('it`s fine\n:smile:')!.text).toBe('it`s fine\n\u{1F604}');
    });
    it('codeRanges / isInsideCode', () => {
        expect(codeRanges('a `b` c')).toEqual([[2, 5]]);
        expect(codeRanges('no code :smile:')).toEqual([]);
        expect(isInsideCode('a `b` c', 3)).toBe(true);
        expect(isInsideCode('a `b` c', 6)).toBe(false);
    });
});

describe('findTypedShortcode', () => {
    it('reports the span and body', () => {
        expect(findTypedShortcode('hi :smile:', 10)).toEqual({ start: 3, end: 10, body: 'smile' });
    });
    it('bounds the body length', () => {
        expect(findTypedShortcode(`:${'a'.repeat(70)}:`, 72)).toBeNull();
    });
});
