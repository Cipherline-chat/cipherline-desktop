import { describe, it, expect, vi, afterEach } from 'vitest';
import { Permissions } from '@cipherline/shared';
import {
    detectChannelTrigger, isInsideCode, canViewChannel, linkableChannels, buildChannelCandidates,
    rankChannelCandidates, sanitizeChannelRefs, findChannelRefSpans, collectChannelRefs, channelRefNameMap,
    segmentByChannelSpans, resolveChannelRef, channelPillView, channelNavigationFor, revealChannelRow,
    UNAVAILABLE_CHANNEL_LABEL, MAX_CHANNEL_REFS, CHANNEL_ROW_FLASH_CLASS,
    type LinkableChannel,
} from './channelRefs';
import { mentionsToDisplayText, MENTION_TOKEN_RE, parseMentionToken } from './mentionTokens';
import { displayTextOf, messageTextMatches } from './messagePreviewText';
import { editedContent } from './channelHistoryMerge';

const SID = 'srv-1';
const VIEW = Permissions.VIEW_CHANNEL.toString(10);
const NO_VIEW = (Permissions.SEND_MESSAGES).toString(10);

function ch(over: Partial<LinkableChannel> & { channel_id: string; name: string }): LinkableChannel {
    return {
        server_id: SID, kind: 'text', topic: null, icon_emoji: null, icon_name: null,
        position: 0, parent_category_id: null, my_permissions: VIEW, ...over,
    };
}

const memes   = ch({ channel_id: 'c-memes', name: 'memes', position: 1, topic: 'dank only', parent_category_id: 'cat-fun' });
const general = ch({ channel_id: 'c-general', name: 'general', position: 0 });
const genChat = ch({ channel_id: 'c-genchat', name: 'general chat', position: 2 });
const lounge  = ch({ channel_id: 'c-lounge', name: 'lounge', kind: 'huddle', position: 0, parent_category_id: 'cat-calls' });
const secret  = ch({ channel_id: 'c-secret', name: 'secret-plans', position: 3, my_permissions: NO_VIEW });
const other   = ch({ channel_id: 'c-other', name: 'memes-elsewhere', server_id: 'srv-2' });
const garbage = ch({ channel_id: 'c-garbage', name: 'garbage-perms', my_permissions: 'not-a-number' });
const all = [memes, general, genChat, lounge, secret, other, garbage];
const cats = [
    { category_id: 'cat-fun', name: 'Fun', position: 1 },
    { category_id: 'cat-calls', name: 'Hangouts', position: 0 },
];

// ── Trigger ─────────────────────────────────────────────────────────────────

describe('detectChannelTrigger', () => {
    it.each([
        ['#', ''],
        ['#me', 'me'],
        ['hi #mem', 'mem'],
        ['line one\n#gen', 'gen'],
        ['look\t#gen', 'gen'],
        ['#general ch', 'general ch'],          // spaces allowed after the first char, like @
        ['#general   ', 'general'],             // trailing spaces trimmed
    ])('opens for %j with query %j', (before, query) => {
        const t = detectChannelTrigger(before);
        expect(t).not.toBeNull();
        expect(t!.query).toBe(query);
        expect(before[t!.start]).toBe('#');
    });

    it.each([
        ['C#'],                       // after a word char
        ['issue#12'],
        ['example.com/#anchor'],      // inside a URL
        ['https://example.com/x#top'],
        ['# heading'],                // space right after #
        ['#  '],
        ['`#code'],                   // inline code
        ['use `foo #bar'],
        ['```\nconst x = 1 #y'],      // fenced block
        ['#a#b'],                     // a second # closes the query
        ['#name@x'],                  // @ is not part of a channel query
        ['#<b'],
        ['plain text'],
        [''],
    ])('stays closed for %j', (before) => {
        expect(detectChannelTrigger(before)).toBeNull();
    });

    it('reopens after a closed code span / fence (negative control for the code rule)', () => {
        expect(detectChannelTrigger('`code` #me')?.query).toBe('me');
        expect(detectChannelTrigger('```\nx\n```\n#me')?.query).toBe('me');
    });

    it('isInsideCode counts fences and per-line backticks', () => {
        expect(isInsideCode('```js\n')).toBe(true);
        expect(isInsideCode('a `b')).toBe(true);
        expect(isInsideCode('a `b` ')).toBe(false);
        expect(isInsideCode('a `b\nc ')).toBe(false); // inline spans do not cross lines
    });
});

// ── Visibility + candidates ────────────────────────────────────────────────

describe('visibility', () => {
    it('canViewChannel: VIEW_CHANNEL or ADMINISTRATOR; missing perms = server-filtered list; unparseable fails closed', () => {
        expect(canViewChannel({ my_permissions: VIEW })).toBe(true);
        expect(canViewChannel({ my_permissions: Permissions.ADMINISTRATOR.toString(10) })).toBe(true);
        expect(canViewChannel({ my_permissions: NO_VIEW })).toBe(false);
        expect(canViewChannel({ my_permissions: '0' })).toBe(false);
        expect(canViewChannel({ my_permissions: 'nope' })).toBe(false);
        expect(canViewChannel({})).toBe(true);
    });

    it('linkableChannels keeps only this server and only viewable channels', () => {
        const ids = linkableChannels(all, SID).map(c => c.channel_id);
        expect(ids).toEqual(['c-memes', 'c-general', 'c-genchat', 'c-lounge']);
        expect(ids).not.toContain('c-secret');
        expect(ids).not.toContain('c-other');
        expect(ids).not.toContain('c-garbage');
        expect(linkableChannels(all, null)).toEqual([]);
        expect(linkableChannels(undefined, SID)).toEqual([]);
    });

    it('buildChannelCandidates: text before calls, sidebar order, category names, hidden never listed', () => {
        const cands = buildChannelCandidates(all, cats, SID);
        expect(cands.map(c => c.channel.name)).toEqual(['general', 'general chat', 'memes', 'lounge']);
        expect(cands.find(c => c.channel.name === 'memes')!.categoryName).toBe('Fun');
        expect(cands.find(c => c.channel.name === 'lounge')!.group).toBe('call');
        expect(cands.find(c => c.channel.name === 'lounge')!.categoryName).toBe('Hangouts');
        expect(cands.some(c => c.channel.channel_id === 'c-secret')).toBe(false);
    });

    it('rankChannelCandidates: prefix beats substring, case/diacritic-insensitive, hidden never matches', () => {
        const cands = buildChannelCandidates(all, cats, SID);
        expect(rankChannelCandidates(cands, 'gen').map(c => c.channel.name)).toEqual(['general', 'general chat']);
        expect(rankChannelCandidates(cands, 'EM').map(c => c.channel.name)).toEqual(['memes']);
        expect(rankChannelCandidates(cands, 'ér').map(c => c.channel.name)).toEqual(['general', 'general chat']);
        expect(rankChannelCandidates(cands, 'secret')).toEqual([]);
        expect(rankChannelCandidates(cands, 'elsewhere')).toEqual([]);
        expect(rankChannelCandidates(cands, '').length).toBe(4);
        expect(rankChannelCandidates(cands, '', 2).length).toBe(2);
    });
});

// ── Wire encoding ───────────────────────────────────────────────────────────

describe('sanitizeChannelRefs (received, sender-controlled)', () => {
    it('keeps well-formed refs', () => {
        expect(sanitizeChannelRefs([{ id: 'c-memes', name: 'memes' }])).toEqual([{ id: 'c-memes', name: 'memes' }]);
    });
    it('rejects malformed input', () => {
        expect(sanitizeChannelRefs(undefined)).toEqual([]);
        expect(sanitizeChannelRefs('x')).toEqual([]);
        expect(sanitizeChannelRefs({ id: 'a', name: 'b' })).toEqual([]);
        expect(sanitizeChannelRefs([null, 1, 'x', { id: 1, name: 'n' }, { id: 'a' }, { name: 'n' }])).toEqual([]);
        expect(sanitizeChannelRefs([{ id: 'a"]x', name: 'n' }])).toEqual([]);     // selector-breaking id
        expect(sanitizeChannelRefs([{ id: 'a', name: 'two\nlines' }])).toEqual([]);
        expect(sanitizeChannelRefs([{ id: '', name: 'n' }, { id: 'a', name: '' }])).toEqual([]);
        expect(sanitizeChannelRefs([{ id: 'x'.repeat(65), name: 'n' }])).toEqual([]);
        expect(sanitizeChannelRefs([{ id: 'a', name: 'n'.repeat(101) }])).toEqual([]);
    });
    it('first entry per name wins, capped', () => {
        expect(sanitizeChannelRefs([{ id: 'a', name: 'n' }, { id: 'b', name: 'n' }])).toEqual([{ id: 'a', name: 'n' }]);
        const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `n${i}` }));
        expect(sanitizeChannelRefs(many)).toHaveLength(MAX_CHANNEL_REFS);
    });
});

describe('findChannelRefSpans', () => {
    const refs = [{ id: 'c-general', name: 'general' }, { id: 'c-genchat', name: 'general chat' }, { id: 'c-memes', name: 'memes' }];
    const names = (t: string) => findChannelRefSpans(t, refs).map(s => t.slice(s.start, s.end));

    it('finds #name at start / after whitespace, before a boundary', () => {
        expect(names('#memes')).toEqual(['#memes']);
        expect(names('see #memes, then #general.')).toEqual(['#memes', '#general']);
        expect(names('(#memes)')).toEqual([]);           // "(" is not whitespace
        expect(names('go to #memes!')).toEqual(['#memes']);
    });
    it('longest name wins', () => {
        expect(names('try #general chat now')).toEqual(['#general chat']);
        expect(names('try #general now')).toEqual(['#general']);
    });
    it('negative: word-joined, URL, wrong case, longer word, inside code', () => {
        expect(names('C#memes')).toEqual([]);
        expect(names('x.com/#memes')).toEqual([]);
        expect(names('#Memes')).toEqual([]);
        expect(names('#memes-archive')).toEqual([]);
        expect(names('#memesx')).toEqual([]);
        expect(names('`#memes`')).toEqual([]);
        expect(names('```\n#memes\n```')).toEqual([]);
        expect(findChannelRefSpans('#memes', [])).toEqual([]);
    });
});

describe('collectChannelRefs (send) + channelRefNameMap (edit) round trip', () => {
    it('only names still in the text are sent, in order of appearance, deduped', () => {
        const map = { memes: 'c-memes', general: 'c-general', lounge: 'c-lounge' };
        expect(collectChannelRefs('#general and #memes and #memes again', map))
            .toEqual([{ id: 'c-general', name: 'general' }, { id: 'c-memes', name: 'memes' }]);
        expect(collectChannelRefs('nothing here', map)).toEqual([]);
        expect(collectChannelRefs('hand-typed #unknown', map)).toEqual([]);
    });

    it('received refs -> composer map -> sent refs is exact for an untouched edit', () => {
        const sent = { text: 'see #memes and #general chat', channel_refs: [{ id: 'c-memes', name: 'memes' }, { id: 'c-genchat', name: 'general chat' }] };
        const seeded = channelRefNameMap(sent.channel_refs);
        expect(collectChannelRefs(sent.text, seeded)).toEqual(sent.channel_refs);
        // ...and deleting a #name in the edit drops its ref.
        expect(collectChannelRefs('see #memes', seeded)).toEqual([{ id: 'c-memes', name: 'memes' }]);
    });

    it('channelRefNameMap ignores garbage', () => {
        expect(channelRefNameMap(undefined)).toEqual({});
        expect(channelRefNameMap([{ id: 'bad id', name: 'x' }])).toEqual({});
    });
});

describe('legacy / plain-text behaviour (why there is no inline token)', () => {
    const content = { type: 'text', text: 'see #memes and <@u:U1:dawson>', channel_refs: [{ id: 'c-memes', name: 'memes' }] };

    it('the readable #name IS the text, so the pre-channel-link grammar leaves it alone', () => {
        // What desktop <= 1.0.21 and mobile run: their token regex never matches it...
        const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
        const tokens = content.text.match(re) ?? [];
        expect(tokens).toEqual(['<@u:U1:dawson>']);
        // ...so they print "#memes" verbatim.
        expect(mentionsToDisplayText(content.text)).toBe('see #memes and @dawson');
    });

    it('negative control: an inline <#c:...> token would have been printed raw by those clients', () => {
        const inline = 'see <#c:c-memes:memes>';
        expect(new RegExp(MENTION_TOKEN_RE.source, 'g').test(inline)).toBe(false);
        expect(parseMentionToken('<#c:c-memes:memes>')).toBeNull();
        expect(mentionsToDisplayText(inline)).toBe(inline);
    });

    it('Copy Text / reply quote / notification / search text is plain "#memes", no token or id', () => {
        const shown = displayTextOf(content)!;
        expect(shown).toBe('see #memes and @dawson');
        expect(shown).not.toContain('c-memes');
        expect(messageTextMatches(content.text, '#memes')).toBe(true);
    });
});

describe('editedContent carries the edit\'s channel_refs', () => {
    const original = { type: 'text', text: 'old #memes', channel_refs: [{ id: 'c-memes', name: 'memes' }], reply_to_id: 'r1' };

    it('replaces refs with the edit\'s own', () => {
        const next = editedContent(original, 'now #general', [{ id: 'c-general', name: 'general' }]);
        expect(next).toEqual({ type: 'text', text: 'now #general', channel_refs: [{ id: 'c-general', name: 'general' }], reply_to_id: 'r1' });
    });
    it('an edit without refs (or from an old client) drops them, and never writes []', () => {
        const next = editedContent(original, 'old #memes');
        expect(next).not.toHaveProperty('channel_refs');
        expect(next.text).toBe('old #memes');
    });
    it('sanitises refs from the edit', () => {
        expect(editedContent(original, 't', [{ id: 'x y', name: 'n' }])).not.toHaveProperty('channel_refs');
    });
    it('placeholder target becomes a text row with refs', () => {
        const next = editedContent({ type: 'system', kind: 'encrypted' }, '#memes', [{ id: 'c-memes', name: 'memes' }]);
        expect(next).toEqual({ type: 'text', text: '#memes', channel_refs: [{ id: 'c-memes', name: 'memes' }] });
    });
});

describe('segmentByChannelSpans', () => {
    it('splits a plain run around wholly-contained spans only', () => {
        const text = 'a #memes b';
        const spans = findChannelRefSpans(text, [{ id: 'c-memes', name: 'memes' }]);
        expect(segmentByChannelSpans(0, text.length, spans).map(s => s.kind === 'ref' ? `[${s.span.ref.id}]` : text.slice(s.from, s.to)))
            .toEqual(['a ', '[c-memes]', ' b']);
        // A span crossing the run's edge stays text.
        expect(segmentByChannelSpans(0, 5, spans)).toEqual([{ kind: 'text', from: 0, to: 5 }]);
        expect(segmentByChannelSpans(3, 3, spans)).toEqual([]);
    });
});

// ── Resolution + pill view ─────────────────────────────────────────────────

describe('resolveChannelRef / channelPillView', () => {
    const visible = linkableChannels(all, SID);

    it('visible: current name, clickable, topic on hover, accessible name', () => {
        const v = channelPillView({ id: 'c-memes', name: 'memes' }, resolveChannelRef({ id: 'c-memes', name: 'memes' }, visible));
        expect(v).toEqual({ label: 'memes', clickable: true, ariaLabel: 'Channel memes', title: 'dank only', kind: 'text' });
    });

    it('renamed: resolves by id, shows the CURRENT name, not the stored one', () => {
        const renamed = [{ ...memes, name: 'dank-memes' }];
        const v = channelPillView({ id: 'c-memes', name: 'memes' }, resolveChannelRef({ id: 'c-memes', name: 'memes' }, renamed));
        expect(v.label).toBe('dank-memes');
        expect(v.ariaLabel).toBe('Channel dank-memes');
    });

    it('a stored name matching a different visible channel never redirects the link', () => {
        const r = resolveChannelRef({ id: 'c-gone', name: 'memes' }, visible);
        expect(r.state).toBe('unavailable');
    });

    it('hidden, deleted and other-server refs are indistinguishable and leak no name', () => {
        const hidden = channelPillView({ id: 'c-secret', name: 'secret-plans' }, resolveChannelRef({ id: 'c-secret', name: 'secret-plans' }, visible));
        const deleted = channelPillView({ id: 'c-deleted', name: 'old-stuff' }, resolveChannelRef({ id: 'c-deleted', name: 'old-stuff' }, visible));
        const elsewhere = channelPillView({ id: 'c-other', name: 'memes-elsewhere' }, resolveChannelRef({ id: 'c-other', name: 'memes-elsewhere' }, visible));
        expect(hidden).toEqual(deleted);
        expect(elsewhere).toEqual(deleted);
        expect(hidden.label).toBe(UNAVAILABLE_CHANNEL_LABEL);
        expect(hidden.clickable).toBe(false);
        expect(JSON.stringify(hidden)).not.toContain('secret');
    });

    it('call channel: call kind, default hover text without a topic', () => {
        const v = channelPillView({ id: 'c-lounge', name: 'lounge' }, resolveChannelRef({ id: 'c-lounge', name: 'lounge' }, visible));
        expect(v.kind).toBe('call');
        expect(v.title).toBe('Calls channel lounge');
    });

    it('pending (list not loaded): stored name, inert', () => {
        const v = channelPillView({ id: 'c-memes', name: 'memes' }, resolveChannelRef({ id: 'c-memes', name: 'memes' }, null));
        expect(v).toMatchObject({ label: 'memes', clickable: false, kind: 'neutral' });
    });
});

// ── Navigation ─────────────────────────────────────────────────────────────

describe('channelNavigationFor', () => {
    it('text channel -> open; Calls channel -> reveal only (never join)', () => {
        expect(channelNavigationFor('c-memes', all, SID)).toEqual({ action: 'open', channel: memes });
        expect(channelNavigationFor('c-lounge', all, SID)).toEqual({ action: 'reveal', channel: lounge });
    });
    it('negative: hidden, other server, unknown, no server -> nothing', () => {
        expect(channelNavigationFor('c-secret', all, SID)).toBeNull();
        expect(channelNavigationFor('c-other', all, SID)).toBeNull();
        expect(channelNavigationFor('c-nope', all, SID)).toBeNull();
        expect(channelNavigationFor('c-memes', all, null)).toBeNull();
    });
});

describe('revealChannelRow', () => {
    afterEach(() => { vi.useRealTimers(); });

    function fakeRoot() {
        const classes = new Set<string>();
        const el = { scrollIntoView: vi.fn(), classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
        const querySelector = vi.fn((sel: string) => (sel === '[data-channel-id="c-memes"]' ? el : null));
        return { root: { querySelector }, el, classes, querySelector };
    }

    it('scrolls the row into view and flashes it', () => {
        vi.useFakeTimers();
        const { root, el, classes } = fakeRoot();
        expect(revealChannelRow('c-memes', root, 500)).toBe(true);
        expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
        expect(classes.has(CHANNEL_ROW_FLASH_CLASS)).toBe(true);
        vi.advanceTimersByTime(500);
        expect(classes.has(CHANNEL_ROW_FLASH_CLASS)).toBe(false);
    });

    it('missing row -> false; a selector-breaking id never reaches querySelector', () => {
        const { root, querySelector } = fakeRoot();
        expect(revealChannelRow('c-absent', root)).toBe(false);
        expect(revealChannelRow('x"], body, [a="', root)).toBe(false);
        expect(querySelector).toHaveBeenCalledTimes(1);
    });
});
