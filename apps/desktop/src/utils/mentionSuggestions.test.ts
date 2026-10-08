import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    rankMentionCandidates,
    describeMentionUserRow,
    mentionDisplayName,
    foldForMatch,
    type MentionMatchable,
} from './mentionSuggestions';

type C = MentionMatchable & { id: string };
const user = (id: string, label: string, nickname?: string | null, discriminator: number | null = null): C =>
    ({ type: 'user', id, label, nickname, discriminator });
const role = (id: string, label: string): C => ({ type: 'role', id, label });
const everyone: C = { type: 'everyone', id: 'everyone', label: 'everyone' };
const here: C = { type: 'here', id: 'here', label: 'here' };
const ids = (xs: C[]) => xs.map(x => x.id);

// The pre-fix behaviour, kept only as a positive control.
const legacyFilter = (all: C[], query: string) =>
    query === '' ? all.slice(0, 10) : all.filter(s => s.label.toLowerCase().includes(query)).slice(0, 10);

describe('rankMentionCandidates', () => {
    const all = [user('u1', 'xX_dave_Xx', 'Captain Dave'), user('u2', 'mary')];

    it('POSITIVE CONTROL: the old username-only filter misses a nickname-only query', () => {
        expect(legacyFilter(all, 'captain')).toEqual([]);
        expect(ids(rankMentionCandidates(all, 'captain'))).toEqual(['u1']);
    });

    it('still matches by username (nicknamed or not)', () => {
        expect(ids(rankMentionCandidates(all, 'dave_x'))).toEqual(['u1']);
        expect(ids(rankMentionCandidates(all, 'mar'))).toEqual(['u2']);
    });

    it('is case-insensitive on both query and names', () => {
        expect(ids(rankMentionCandidates(all, 'CAPTAIN'))).toEqual(['u1']);
        expect(ids(rankMentionCandidates(all, 'MaRy'))).toEqual(['u2']);
    });

    it('ranks prefix matches before substring matches', () => {
        const rows = [
            user('sub', 'zzbob'),             // substring (username)
            user('nsub', 'q', 'the bob'),     // substring (nickname)
            user('pu', 'bobby'),              // prefix (username)
            user('pn', 'w', 'Bob Ross'),      // prefix (nickname)
        ];
        expect(ids(rankMentionCandidates(rows, 'bob'))).toEqual(['pu', 'pn', 'sub', 'nsub']);
    });

    it('a user matching on username prefix and nickname substring is one hit (no duplicate)', () => {
        const rows = [user('a', 'alex', 'big alex')];
        expect(ids(rankMentionCandidates(rows, 'alex'))).toEqual(['a']);
    });

    it('empty / blank / null nicknames behave like username-only', () => {
        const rows = [user('a', 'ann', ''), user('b', 'bea', '   '), user('c', 'cat', null), user('d', 'dee', undefined)];
        expect(ids(rankMentionCandidates(rows, 'a'))).toEqual(['a', 'b', 'c']); // prefix: ann; substring: bea, cat
        expect(rankMentionCandidates(rows, '   ')).toHaveLength(4);
        expect(ids(rankMentionCandidates(rows, 'zzz'))).toEqual([]);
    });

    it('empty query returns the first `limit` in input order', () => {
        const many = Array.from({ length: 15 }, (_, i) => user(`u${i}`, `name${i}`, `nick${i}`));
        expect(ids(rankMentionCandidates(many, ''))).toEqual(many.slice(0, 10).map(m => m.id));
        expect(rankMentionCandidates(many, 'nick', 3)).toHaveLength(3);
    });

    it('a nickname never makes a role or @everyone match by that text', () => {
        const rows = [everyone, role('r1', 'Moderators'), user('u', 'zed', 'moderator zed')];
        expect(ids(rankMentionCandidates(rows, 'moderator'))).toEqual(['r1', 'u']);
        expect(ids(rankMentionCandidates(rows, 'everyone'))).toEqual(['everyone']);
    });

    it('does not shadow @everyone / @here behind many nicknamed members', () => {
        const members = Array.from({ length: 30 }, (_, i) => user(`m${i}`, `person${i}`, `every body ${i}`));
        const rows = [everyone, here, ...members, role('r', 'everyone-ish')];
        const out = rankMentionCandidates(rows, 'every');
        expect(out[0].id).toBe('everyone');
        expect(ids(rankMentionCandidates(rows, 'her'))[0]).toBe('here');
    });

    it('handles diacritics, emoji, combining marks, metacharacters and lone surrogates without throwing', () => {
        const rows = [
            user('j', 'jose99', 'José'),
            user('e', 'emo', '🔥 Fire 🔥'),
            user('c', 'combo', 'Café'), // e + combining acute
            user('m', 'meta', 'a.b*c(d)[e]\\'),
            user('l', 'lone', '\uD83D'),
        ];
        expect(ids(rankMentionCandidates(rows, 'jose'))).toEqual(['j']);
        expect(ids(rankMentionCandidates(rows, 'José'))).toEqual(['j']);
        expect(ids(rankMentionCandidates(rows, '🔥'))).toEqual(['e']);
        expect(ids(rankMentionCandidates(rows, 'cafe'))).toEqual(['c']);
        expect(ids(rankMentionCandidates(rows, 'a.b*c('))).toEqual(['m']);
        expect(() => rankMentionCandidates(rows, '\uD83D')).not.toThrow();
    });

    it("a nickname colliding with another member's username returns BOTH", () => {
        const rows = [user('a', 'alice', 'Bob'), user('b', 'Bob')];
        expect(ids(rankMentionCandidates(rows, 'bob')).sort()).toEqual(['a', 'b']);
    });
});

describe('describeMentionUserRow', () => {
    it('nickname is primary, username secondary', () => {
        const r = user('a', 'alice', 'Ali C');
        expect(describeMentionUserRow(r, [r])).toEqual({ primary: 'Ali C', secondary: 'alice' });
    });

    it('no nickname: username primary, no secondary', () => {
        const r = user('a', 'alice');
        expect(describeMentionUserRow(r, [r])).toEqual({ primary: 'alice', secondary: undefined });
    });

    it('nickname equal to username (case-insensitive) is not repeated', () => {
        const r = user('a', 'alice', 'ALICE');
        expect(describeMentionUserRow(r, [r]).secondary).toBeUndefined();
    });

    it("nickname colliding with another member's username: both rows are distinct", () => {
        const a = user('a', 'alice', 'Bob', 1);
        const b = user('b', 'Bob', null, 2);
        const ra = describeMentionUserRow(a, [a, b]);
        const rb = describeMentionUserRow(b, [a, b]);
        expect(ra).toEqual({ primary: 'Bob', secondary: 'alice' });
        expect(rb).toEqual({ primary: 'Bob', secondary: '#0002' });
    });

    it('same bare username on two members is told apart by discriminator (existing behaviour)', () => {
        const a = user('a', 'Dawson', null, 1);
        const b = user('b', 'Dawson', null, 42);
        expect(describeMentionUserRow(a, [a, b]).secondary).toBe('#0001');
        expect(describeMentionUserRow(b, [a, b]).secondary).toBe('#0042');
    });

    it('identical nickname AND username falls back to the discriminator', () => {
        const a = user('a', 'sam', 'Sammy', 7);
        const b = user('b', 'sam', 'Sammy', 8);
        expect(describeMentionUserRow(a, [a, b]).secondary).toBe('sam #0007');
    });

    it('roles in the visible list do not count as collisions', () => {
        const a = user('a', 'Admins', null, 3);
        expect(describeMentionUserRow(a, [a, role('r', 'Admins')]).secondary).toBeUndefined();
    });
});

describe('helpers', () => {
    it('mentionDisplayName ignores nickname on non-user rows and trims', () => {
        expect(mentionDisplayName({ type: 'role', label: 'Mods', nickname: 'x' })).toBe('Mods');
        expect(mentionDisplayName(user('a', 'alice', ' Ali '))).toBe('Ali');
    });
    it('foldForMatch strips accents and lowercases', () => {
        expect(foldForMatch('José')).toBe('jose');
        expect(foldForMatch('Café')).toBe('cafe');
    });
});

describe('ChatPane wiring', () => {
    const chatPane = readFileSync(join(__dirname, '../components/ChatPane.tsx'), 'utf8');

    it('ranks candidates through the shared helper, not a username-only filter', () => {
        expect(chatPane).toContain("from '../utils/mentionSuggestions'");
        expect(chatPane).toContain('rankMentionCandidates(all, query, 10)');
        expect(chatPane).not.toContain('all.filter(s => s.label.toLowerCase().includes(query))');
    });

    it('feeds server nicknames into server-channel member candidates only', () => {
        expect(chatPane).toContain('nickname: serverMemberNicknames?.[m.user_id] ?? null');
        const start = chatPane.indexOf('Object.entries(userIdToUsername)\n                        // Scoped to THIS conversation');
        expect(start).toBeGreaterThan(0);
        const dm = chatPane.slice(start, chatPane.indexOf('// 3. Roles', start));
        expect(dm).not.toContain('nickname');
    });

    it('keeps the inserted token and the wire token username-based', () => {
        expect(chatPane).toContain('mentionTokenMapRef.current[suggestion.label] = `<@u:${suggestion.id}:${suggestion.label}>`;');
        expect(chatPane).toContain(": `@${suggestion.label}`;");
    });

    it('renders the row via describeMentionUserRow', () => {
        expect(chatPane).toContain('describeMentionUserRow(s, mentionSuggestions)');
    });
});
