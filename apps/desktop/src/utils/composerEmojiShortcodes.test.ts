import { describe, it, expect } from 'vitest';
import { buildShortcodeIndex, resolveTypedShortcodes, composerToWire, type ShortcodeSources } from './composerEmojiShortcodes';
import { extractMentionsFromText } from './mentionTokens';

const P1 = 'p_' + 'a'.repeat(32);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const sources = (over: Partial<ShortcodeSources> = {}): ShortcodeSources => ({
    personal: [{ id: P1, name: 'myemoji' }],
    server: [{ emoji_id: S1, name: 'partyblob' }],
    ...over,
});
const wire = (text: string, s = sources(), picked: Record<string, string> = {}, mentions: Record<string, string> = {}) =>
    composerToWire(text, { mentions, picked }, s);

describe('typed :name: -> emoji token (the "Enter sends plain text" bug)', () => {
    it('a typed My Emojis shortcode becomes its token exactly as a pick would', () => {
        expect(wire(':myemoji:')).toBe(`<:myemoji:${P1}>`);
    });

    it('a typed server emoji shortcode becomes its token', () => {
        expect(wire(':partyblob:')).toBe(`<:partyblob:${S1}>`);
    });

    it('works inside a sentence, repeated, and adjacent to another shortcode', () => {
        expect(wire('hi :myemoji: and :partyblob::myemoji: bye')).toBe(
            `hi <:myemoji:${P1}> and <:partyblob:${S1}><:myemoji:${P1}> bye`,
        );
    });

    it('is case-insensitive on the name and keeps the stored (lowercase) name in the token', () => {
        expect(wire(':MyEmoji:')).toBe(`<:myemoji:${P1}>`);
    });

    it('leaves an unknown shortcode, a half-typed one, and plain colons exactly as typed', () => {
        expect(wire(':nope:')).toBe(':nope:');
        expect(wire(':myemoji')).toBe(':myemoji');
        expect(wire('note: this is fine: ok')).toBe('note: this is fine: ok');
        expect(wire('a::b')).toBe('a::b');
    });

    it('finds a real shortcode right after an unknown one shares its colon', () => {
        expect(wire(':nope:myemoji:')).toBe(`:nope<:myemoji:${P1}>`);
    });

    it('does not read a clock or a ratio as an emoji', () => {
        const s = sources({ personal: [{ id: P1, name: '30' }] });
        expect(wire('meet at 10:30:45', s)).toBe('meet at 10:30:45');
        expect(wire(':30:', s)).toBe(`<:30:${P1}>`); // a real numeric name still works on its own
    });

    it('never re-matches inside an existing token', () => {
        const tok = `<:myemoji:${P1}>`;
        expect(resolveTypedShortcodes(tok, buildShortcodeIndex(sources()))).toBe(tok);
        const mention = '<@u:550e8400-e29b-41d4-a716-446655440000:myemoji>';
        expect(resolveTypedShortcodes(mention, buildShortcodeIndex(sources()))).toBe(mention);
    });

    it('survives a mention in the same text and the result still parses as a mention + an emoji', () => {
        const out = wire('@bob :myemoji:', sources(), {}, { bob: '<@u:uid-1:bob>' });
        expect(out).toBe(`<@u:uid-1:bob> <:myemoji:${P1}>`);
        expect(extractMentionsFromText(out).map(m => m.type)).toEqual(['user']);
    });
});

describe('resolution order and ambiguity (documented, deterministic)', () => {
    const both = sources({
        personal: [{ id: P1, name: 'party' }],
        server: [{ emoji_id: S1, name: 'party' }],
    });

    it('My Emojis beats a server emoji with the same name', () => {
        expect(wire(':party:', both)).toBe(`<:party:${P1}>`);
    });

    it('an explicit pick beats the library order', () => {
        const picked = { ':party:': `<:party:${S1}>` };
        expect(wire(':party:', both, picked)).toBe(`<:party:${S1}>`);
    });

    it('a server emoji is only reachable in the server it belongs to (no server list = no server emoji)', () => {
        expect(wire(':partyblob:', sources({ server: [] }))).toBe(':partyblob:');
        expect(wire(':partyblob:', sources({ server: [{ emoji_id: S2, name: 'partyblob' }] }))).toBe(`<:partyblob:${S2}>`);
    });

    it('the same text resolves the same way every time', () => {
        const a = wire(':party: :party:', both);
        expect(a).toBe(wire(':party: :party:', both));
        expect(a).toBe(`<:party:${P1}> <:party:${P1}>`);
    });

    it('a picked token whose shortcode has odd characters (edit seed) still round-trips', () => {
        const odd = { ':Party Blob:': `<:Party Blob:${S1}>` };
        expect(wire('x :Party Blob: y', sources(), odd)).toBe(`x <:Party Blob:${S1}> y`);
    });
});

describe('index', () => {
    it('is empty when there is nothing to resolve (fast path returns the same string)', () => {
        const t = 'hello :world:';
        expect(resolveTypedShortcodes(t, new Map())).toBe(t);
    });
});
