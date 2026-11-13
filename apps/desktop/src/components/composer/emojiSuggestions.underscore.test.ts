import { describe, it, expect } from 'vitest';
import { searchEmojiWithCustom, resolveExactEmoji, type ServerCandidate } from './emojiSuggestions';

const P1 = 'p_' + 'a'.repeat(32);
const P2 = 'p_' + 'b'.repeat(32);
const S1 = '11111111-1111-4111-8111-111111111111';
const srv = (name: string, id = S1, over: Partial<ServerCandidate> = {}): ServerCandidate =>
    ({ emoji_id: id, name, attachment_id: 'a', key_b64: 'k', nonce_b64: 'n', ...over });
const none = () => [];

describe('autocomplete: custom names are underscore shortcodes', () => {
    it('a name stored with a space or dash is offered and inserted as :a_b:', () => {
        const r = searchEmojiWithCustom('party', [srv('party blob'), srv('party-parrot', '2'.repeat(8))], [], { nativeSearch: none });
        expect(r.map(x => x.name)).toEqual(['party_blob', 'party_parrot']);
    });
    it('a query typed with underscores, spaces or dashes finds the same row', () => {
        for (const q of ['party_b', 'party b', 'party-b']) {
            expect(searchEmojiWithCustom(q, [srv('party_blob')], [], { nativeSearch: none }).map(x => x.name)).toEqual(['party_blob']);
        }
    });
    it('a legacy "a b" My Emoji row is canonical too', () => {
        const r = searchEmojiWithCustom('a_', [], [{ id: P1, name: 'a b' }], { nativeSearch: none });
        expect(r.map(x => x.name)).toEqual(['a_b']);
    });
});

describe('resolveExactEmoji: the same candidate rule as the menu', () => {
    const opts = { availablePersonalIds: new Set([P1]), nativeLookup: (t: string) => (t === 'smile' ? 'S' : undefined) };
    it('personal, then server, then standard', () => {
        expect(resolveExactEmoji('mine', [], [{ id: P1, name: 'mine' }], opts)).toMatchObject({ kind: 'custom', suggestion: { id: P1, personal: true } });
        expect(resolveExactEmoji('wave', [srv('wave')], [], opts)).toMatchObject({ kind: 'custom', suggestion: { id: S1 } });
        expect(resolveExactEmoji('smile', [], [], opts)).toEqual({ kind: 'native', glyph: 'S' });
        expect(resolveExactEmoji('smile', [srv('smile')], [], opts)).toMatchObject({ kind: 'custom' });
    });
    it('spellings: case, spaces, dashes', () => {
        expect(resolveExactEmoji('Party Blob', [srv('party_blob')], [], opts)).toBeTruthy();
        expect(resolveExactEmoji('PARTY-BLOB', [srv('party blob')], [], opts)).toBeTruthy();
    });
    it('refuses what the menu would not offer', () => {
        expect(resolveExactEmoji('mine', [], [{ id: P2, name: 'mine' }], opts)).toBeUndefined();          // picture not on this device
        expect(resolveExactEmoji('wave', [srv('wave', S1, { key_b64: '' })], [], opts)).toBeUndefined();  // cannot render
        expect(resolveExactEmoji('wave', [], [], opts)).toBeUndefined();                                  // not this server's
        expect(resolveExactEmoji('', [], [], opts)).toBeUndefined();
        expect(resolveExactEmoji('zzz', [], [], opts)).toBeUndefined();
    });
});
