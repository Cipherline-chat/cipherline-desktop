import { describe, it, expect } from 'vitest';
import { extractMentionsFromText, mentionsToPlainText, parseMentionToken } from './mentionTokens';

describe('mentionsToPlainText', () => {
    it('resolves a known user mention to @username via the resolver', () => {
        const text = '<@u:user-123:staleName> how are you doing?';
        const out = mentionsToPlainText(text, (id) => (id === 'user-123' ? 'dawson' : undefined));
        expect(out).toBe('@dawson how are you doing?');
        // Never falls back to the token's own embedded (possibly stale) label.
        expect(out).not.toContain('staleName');
    });

    it('resolves an unknown/unresolvable user id to @unknown, never the raw id', () => {
        const text = 'ping <@u:3939siojf09-309fk2:someone> please';
        const out = mentionsToPlainText(text, () => undefined);
        expect(out).toBe('ping @unknown please');
        expect(out).not.toContain('3939siojf09-309fk2');
    });

    it('renders @everyone as itself', () => {
        const out = mentionsToPlainText('@everyone please read this', () => undefined);
        expect(out).toBe('@everyone please read this');
    });

    it('renders @here as itself', () => {
        const out = mentionsToPlainText('@here anyone around?', () => undefined);
        expect(out).toBe('@here anyone around?');
    });

    it('resolves multiple mentions in one string independently', () => {
        const text = 'hey <@u:a1:oldA> and <@u:b2:oldB>, plus @everyone';
        const out = mentionsToPlainText(text, (id) => (id === 'a1' ? 'alice' : id === 'b2' ? undefined : undefined));
        expect(out).toBe('hey @alice and @unknown, plus @everyone');
    });

    it('handles a mention directly adjacent to punctuation', () => {
        const text = '<@u:u1:bob>, are you there?!<@u:u1:bob>';
        const out = mentionsToPlainText(text, () => 'bob');
        expect(out).toBe('@bob, are you there?!@bob');
    });

    it('leaves a malformed near-miss token unchanged (never matched, nothing to resolve)', () => {
        const text = 'this looks like <@u:onlyid> a mention but is not';
        const out = mentionsToPlainText(text, () => 'shouldNotBeUsed');
        expect(out).toBe(text);
    });

    it('returns a message with no mentions unchanged', () => {
        const text = 'just a plain message, nothing to see here';
        const out = mentionsToPlainText(text, () => 'irrelevant');
        expect(out).toBe(text);
    });

    it('renders a role mention using its own embedded label', () => {
        const out = mentionsToPlainText('<@r:role-1:Moderators> only', () => undefined);
        expect(out).toBe('@Moderators only');
    });

    it('renders a custom emoji token as its plain shortcode', () => {
        const out = mentionsToPlainText('nice <:partyblob:emoji-9> today', () => undefined);
        expect(out).toBe('nice :partyblob: today');
    });

    it('empty string in, empty string out', () => {
        expect(mentionsToPlainText('', () => 'x')).toBe('');
    });
});

describe('parseMentionToken', () => {
    it('parses a well-formed user token', () => {
        expect(parseMentionToken('<@u:uid-1:alice>')).toEqual({ kind: 'user', id: 'uid-1', label: 'alice' });
    });

    it('returns null for an unrecognised token', () => {
        expect(parseMentionToken('<@u:onlyid>')).toBeNull();
    });
});

describe('extractMentionsFromText', () => {
    it('sends only the real role mention when a custom emoji is in the same message', () => {
        const text = 'nice <:partyparrot:emoji-9> <@r:role-mods:Mods> take a look';
        expect(extractMentionsFromText(text)).toEqual([{ type: 'role', id: 'role-mods' }]);
    });

    it('never turns a custom emoji into a mention of any kind', () => {
        expect(extractMentionsFromText('<:partyparrot:emoji-9> <:wave:emoji-2>')).toEqual([]);
    });

    it('keeps a real @here that follows a custom emoji', () => {
        // The emoji's dedupe key used to fall through to 'here', so this @here was dropped.
        expect(extractMentionsFromText('<:partyparrot:emoji-9> @here meeting now')).toEqual([{ type: 'here' }]);
    });

    it('still extracts and dedupes every real mention kind', () => {
        const text = '<@u:u1:ana> <@u:u1:ana> <@r:r1:Mods> @everyone @here @here';
        expect(extractMentionsFromText(text)).toEqual([
            { type: 'user', id: 'u1' },
            { type: 'role', id: 'r1' },
            { type: 'everyone' },
            { type: 'here' },
        ]);
    });
});
