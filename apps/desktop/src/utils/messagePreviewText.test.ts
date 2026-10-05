import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayTextOf, messageTextMatches, searchExcerpt } from './messagePreviewText';

const UID = '3f2c9a10-1111-4222-8333-444455556666';
const WIRE = `<@u:${UID}:dawson> you recorded the whole raid? <@r:role-9:Mods> <:party:e-1>`;

describe('displayTextOf', () => {
    it('renders mention and emoji tokens the way the message body shows them', () => {
        expect(displayTextOf({ text: WIRE })).toBe('@dawson you recorded the whole raid? @Mods :party:');
    });

    it('never leaks the wire token or the user id', () => {
        const shown = displayTextOf({ text: WIRE })!;
        expect(shown).not.toContain('<@');
        expect(shown).not.toContain(UID);
    });

    it('leaves plain text and @everyone alone', () => {
        expect(displayTextOf({ text: 'gg @everyone' })).toBe('gg @everyone');
    });

    it('returns undefined when there is no text (callers keep their own fallbacks)', () => {
        expect(displayTextOf({ text: undefined })).toBeUndefined();
        expect(displayTextOf(null)).toBeUndefined();
        expect(displayTextOf({})).toBeUndefined();
        // An empty string is still text: the "Replying to" bar used `??` and keeps doing so.
        expect(displayTextOf({ text: '' })).toBe('');
    });
});

describe('messageTextMatches', () => {
    it('finds a mention by the name the user sees, with or without the @', () => {
        expect(messageTextMatches(WIRE, '@dawson')).toBe(true);
        expect(messageTextMatches(WIRE, 'DAWSON you')).toBe(true);
    });

    it('does not match on hidden token internals', () => {
        expect(messageTextMatches(WIRE, UID.slice(0, 8))).toBe(false);
        expect(messageTextMatches(WIRE, '<@u:')).toBe(false);
    });

    it('an empty query matches everything; missing text matches nothing', () => {
        expect(messageTextMatches('anything', '   ')).toBe(true);
        expect(messageTextMatches(undefined, 'x')).toBe(false);
        expect(messageTextMatches('', 'x')).toBe(false);
    });
});

describe('searchExcerpt', () => {
    it('excerpts the display text, so the highlight lines up with the query', () => {
        const ex = searchExcerpt(WIRE, 'recorded');
        expect(ex).toEqual({ before: '@dawson you ', match: 'recorded', after: ' the whole raid? @Mods :party:' });
    });

    it('shows a mention near the match as @name, not as its token', () => {
        // 'whole' sits within 30 chars of the mention, so it is in the excerpt.
        const ex = searchExcerpt(WIRE, 'whole')!;
        expect(ex.before + ex.match + ex.after).not.toContain('<@');
        expect(ex.before).toContain('@dawson');
    });

    it('cuts long text with ellipses around the match', () => {
        const long = 'a'.repeat(50) + ' needle ' + 'b'.repeat(50);
        const ex = searchExcerpt(long, 'needle')!;
        expect(ex.before.startsWith('…')).toBe(true);
        expect(ex.after.endsWith('…')).toBe(true);
        expect(ex.match).toBe('needle');
    });

    it('keeps the original casing of the matched span', () => {
        expect(searchExcerpt('Strat for tonight', 'strat')!.match).toBe('Strat');
    });

    it('returns null for no match, empty query or no text', () => {
        expect(searchExcerpt(WIRE, UID.slice(0, 8))).toBeNull();
        expect(searchExcerpt(WIRE, '  ')).toBeNull();
        expect(searchExcerpt(undefined, 'x')).toBeNull();
    });
});

// Each surface that previews or searches a message must go through the helper.
// These components are too heavy to render in this node-environment suite, so
// pin the call sites in the real source: a revert to `content.text` fails here.
describe('call sites use the display transform', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

    it('ChatPane: the reply quote above a message', () => {
        const src = read('components/ChatPane.tsx');
        const at = src.indexOf('Reply quote preview');
        expect(at).toBeGreaterThan(-1);
        const block = src.slice(at, at + 900);
        expect(block).toMatch(/displayTextOf\(/);
        expect(block).not.toMatch(/\)\?\.content\?\.text \|\|/);
    });

    it('ChatPane: the "Replying to" bar over the composer', () => {
        const src = read('components/ChatPane.tsx');
        expect(src).toMatch(/const replyText\s*=\s*displayTextOf\(replyTarget\?\.content\)/);
    });

    it('ChatPane: in-chat search matches the display text', () => {
        const src = read('components/ChatPane.tsx');
        expect(src).toMatch(/messageTextMatches\(m\.content\.text, chatSearch\)/);
        expect(src).not.toMatch(/m\.content\.text\.toLowerCase\(\)\.includes\(chatSearch/);
    });

    it('ChannelMessageSearch: excerpts come from searchExcerpt', () => {
        const src = read('components/server/ChannelMessageSearch.tsx');
        expect(src).toMatch(/searchExcerpt\(m\.text, trimmed\)/);
        expect(src).not.toMatch(/m\.text\.slice\(/);
    });

    it('PinnedMessagesPanel: search matches the display text (rows already render it)', () => {
        const src = read('components/PinnedMessagesPanel.tsx');
        expect(src).toMatch(/messageTextMatches\(text, searchQuery\)/);
        expect(src).toMatch(/mentionsToDisplayText\(msg\.content\.text/);
    });

    it('notifications already render the display text', () => {
        expect(read('hooks/useNotificationDispatch.ts')).toMatch(/mentionsToDisplayText\(text\)/);
    });
});
