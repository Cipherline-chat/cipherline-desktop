import { describe, it, expect } from 'vitest';
import { buildShortcodeIndex, resolveTypedShortcodes, composerToWire, type ShortcodeSources } from './composerEmojiShortcodes';

const P1 = 'p_' + 'a'.repeat(32);
const S1 = '11111111-1111-4111-8111-111111111111';
const HEART = '❤️';
const natives: Record<string, string> = { red_heart: HEART, heart: HEART, smile: '\u{1F604}' };
const nativeLookup = (t: string) => natives[t.toLowerCase().replace(/[\s-]+/g, '_')];

const src = (over: Partial<ShortcodeSources> = {}): ShortcodeSources => ({
    personal: [{ id: P1, name: 'mine' }],
    server: [{ emoji_id: S1, name: 'partyblob' }],
    nativeLookup,
    ...over,
});
const wire = (text: string, s = src()) => composerToWire(text, { mentions: {}, picked: {} }, s);

describe('send-time safety net: a complete standard :name: that was never converted live', () => {
    it('a pasted :red_heart: becomes the glyph', () => expect(wire('I :red_heart: this')).toBe(`I ${HEART} this`));
    it('old-style spaces / dashes / case resolve when the WHOLE span is a known name', () => {
        expect(wire(':red heart:')).toBe(HEART);
        expect(wire(':Red-Heart:')).toBe(HEART);
    });
    it('prose with colons and spaces is untouched', () => {
        for (const t of ['note: hello world: ok', 'times: 12:30 and 1:45 pm', 'a :) b', '::', ':red heart', 'the :red and heart: parts']) {
            expect(wire(t)).toBe(t);
        }
    });
    it('does not fire right after a letter or digit (same boundary as live conversion)', () => {
        expect(wire('foo:smile:')).toBe('foo:smile:');
        expect(wire('5:smile:')).toBe('5:smile:');
    });
    it('custom emoji outrank a same-named standard one (menu order)', () => {
        expect(wire(':heart:', src({ server: [{ emoji_id: S1, name: 'heart' }] }))).toBe(`<:heart:${S1}>`);
    });
    it('unknown names stay; with no dataset (no nativeLookup) nothing standard converts', () => {
        expect(wire(':nope:')).toBe(':nope:');
        expect(wire(':smile:', src({ nativeLookup: undefined }))).toBe(':smile:');
    });
});

describe('inline code and code blocks are literal', () => {
    it('neither custom nor standard shortcodes convert inside them', () => {
        expect(wire('`:smile:` :smile:')).toBe(`\`:smile:\` \u{1F604}`);
        expect(wire('`:mine:`')).toBe('`:mine:`');
        expect(wire('```\n:partyblob:\n```')).toBe('```\n:partyblob:\n```');
        expect(wire('```\n:partyblob:\n``` :partyblob:')).toBe(`\`\`\`\n:partyblob:\n\`\`\` <:partyblob:${S1}>`);
    });
});

describe('names stored before the underscore rule still resolve (and send a canonical name)', () => {
    it('a server emoji stored as "party blob" is :party_blob: and the token carries the underscore name', () => {
        const s = src({ server: [{ emoji_id: S1, name: 'party blob' }] });
        expect(wire(':party_blob:', s)).toBe(`<:party_blob:${S1}>`);
        expect(wire(':party blob:', s)).toBe(`<:party_blob:${S1}>`);
        expect(wire(':party-blob:', s)).toBe(`<:party_blob:${S1}>`);
    });
    it('index keys are canonical', () => {
        const idx = buildShortcodeIndex(src({ server: [{ emoji_id: S1, name: 'A-B c' }] }));
        expect([...idx.keys()]).toContain('a_b_c');
    });
});

describe('already-sent text is not touched by a second pass', () => {
    it('wire tokens and glyphs are inert', () => {
        const done = `<:partyblob:${S1}> ${HEART}`;
        expect(resolveTypedShortcodes(done, buildShortcodeIndex(src()), nativeLookup)).toBe(done);
    });
});
