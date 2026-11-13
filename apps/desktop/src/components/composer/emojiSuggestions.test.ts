import { describe, it, expect } from 'vitest';
import { searchEmojiWithCustom, type ServerCandidate } from './emojiSuggestions';
import type { EmojiSuggestion } from '../emojiSearch';

const P1 = 'p_' + 'a'.repeat(32);
const P2 = 'p_' + 'b'.repeat(32);
const server = (id: string, name: string, over: Partial<ServerCandidate> = {}): ServerCandidate =>
    ({ emoji_id: id, name, attachment_id: `att-${id}`, key_b64: 'k', nonce_b64: 'n', ...over });
const native = (list: string[]) => (_q: string, limit: number): EmojiSuggestion[] =>
    list.slice(0, limit).map(n => ({ id: n, native: '😀', name: n }));
const names = (r: EmojiSuggestion[]) => r.map(x => x.name);

describe('searchEmojiWithCustom', () => {
    it('lists My Emojis first, then server emojis, then native', () => {
        const r = searchEmojiWithCustom('par', [server('s1', 'partyblob')], [{ id: P1, name: 'party_me' }], { nativeSearch: native(['party_popper']) });
        expect(names(r)).toEqual(['party_me', 'partyblob', 'party_popper']);
        expect(r[0].personal).toBe(true);
        expect(r[1].custom?.attachmentId).toBe('att-s1');
        expect(r[2].native).toBe('😀');
    });

    it('shows the same server emoji once even if the list holds it twice (create response racing its own refetch)', () => {
        const r = searchEmojiWithCustom('blob', [server('s1', 'blob'), server('s1', 'blob')], [], { nativeSearch: native([]) });
        expect(r).toHaveLength(1);
    });

    it('shows the same My Emoji once', () => {
        const r = searchEmojiWithCustom('pe', [], [{ id: P1, name: 'pepe' }, { id: P1, name: 'pepe' }], { nativeSearch: native([]) });
        expect(r).toHaveLength(1);
    });

    it('hides a server emoji that shares a name with one of My Emojis (Save to My Emojis copies the name)', () => {
        const r = searchEmojiWithCustom('myemoji', [server('s1', 'myemoji')], [{ id: P1, name: 'myemoji' }], { nativeSearch: native([]) });
        expect(r).toHaveLength(1);
        expect(r[0].personal).toBe(true);
    });

    it('still offers the server emoji when the same-named personal one is not usable on this device', () => {
        const r = searchEmojiWithCustom('myemoji', [server('s1', 'myemoji')], [{ id: P1, name: 'myemoji' }], {
            availablePersonalIds: new Set<string>(), nativeSearch: native([]),
        });
        expect(r).toHaveLength(1);
        expect(r[0].custom).toBeDefined();
    });

    it('never offers a My Emoji whose picture is not on this device (it would render blank and send nothing)', () => {
        const r = searchEmojiWithCustom('em', [], [{ id: P1, name: 'emo_a' }, { id: P2, name: 'emo_b' }], {
            availablePersonalIds: new Set([P2]), nativeSearch: native([]),
        });
        expect(names(r)).toEqual(['emo_b']);
    });

    it('does not filter by availability when none is given', () => {
        const r = searchEmojiWithCustom('em', [], [{ id: P1, name: 'emo_a' }], { nativeSearch: native([]) });
        expect(names(r)).toEqual(['emo_a']);
    });

    it('never offers a server emoji whose list entry has no image key material', () => {
        const r = searchEmojiWithCustom('x', [
            server('s1', 'xa', { key_b64: '' }), server('s2', 'xb', { nonce_b64: '' }), server('s3', 'xc', { attachment_id: '' }), server('s4', 'xd'),
        ], [], { nativeSearch: native([]) });
        expect(names(r)).toEqual(['xd']);
    });

    it('puts an exact name first, then prefix, then substring (typing the whole name highlights that emoji)', () => {
        const r = searchEmojiWithCustom('cat', [], [
            { id: P1, name: 'cat_2' }, { id: P2, name: 'cat' }, { id: 'p_' + 'c'.repeat(32), name: 'bobcat' },
        ], { nativeSearch: native([]) });
        expect(names(r)).toEqual(['cat', 'cat_2', 'bobcat']);
    });

    it('matches case-insensitively', () => {
        expect(names(searchEmojiWithCustom('MyEm', [], [{ id: P1, name: 'myemoji' }], { nativeSearch: native([]) }))).toEqual(['myemoji']);
    });

    it('respects the limit and only asks the native search for the remaining slots', () => {
        let asked = -1;
        const many = Array.from({ length: 5 }, (_, i) => server(`s${i}`, `blob${i}`));
        const r = searchEmojiWithCustom('blob', many, [], { limit: 7, nativeSearch: (_q, l) => { asked = l; return []; } });
        expect(r).toHaveLength(5);
        expect(asked).toBe(2);
        const full = searchEmojiWithCustom('blob', many, [], { limit: 3, nativeSearch: (_q, l) => { asked = l; return []; } });
        expect(full).toHaveLength(3);
    });

    it('every row has a distinct id (the menu uses it as the React key)', () => {
        const r = searchEmojiWithCustom('a', [server('s1', 'aa'), server('s2', 'ab')], [{ id: P1, name: 'ac' }], { nativeSearch: native(['grin']) });
        expect(new Set(r.map(x => x.id)).size).toBe(r.length);
    });
});
