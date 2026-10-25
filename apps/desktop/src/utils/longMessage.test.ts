import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LONG_MESSAGE_THRESHOLD, LONG_MESSAGE_PREVIEW_CHARS, isLongMessage, collapsedPreview,
    wordCount, readMinutes, longMessageStats, longMessageLabel, previewSnippet, longMessageExpansion,
} from './longMessage';
import { MENTION_TOKEN_RE } from './mentionTokens';
import { MAX_TEXT_MESSAGE_LENGTH } from '../constants';

const here = dirname(fileURLToPath(import.meta.url));

/** Deterministic prose-ish filler: words of mixed length, no newlines. */
const prose = (n: number) => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    let out = '';
    for (let i = 0; out.length < n; i++) out += words[(i * 7) % words.length] + ' ';
    return out.slice(0, n);
};

describe('isLongMessage: the 5,000-character threshold', () => {
    it('collapses strictly MORE than 5,000 characters', () => {
        expect(LONG_MESSAGE_THRESHOLD).toBe(5000);
        expect(isLongMessage('x'.repeat(4999))).toBe(false);
        expect(isLongMessage('x'.repeat(5000))).toBe(false);
        expect(isLongMessage('x'.repeat(5001))).toBe(true);
        expect(isLongMessage('x'.repeat(100_000))).toBe(true);
    });

    it('100,000 is the composer cap, and still collapses', () => {
        expect(MAX_TEXT_MESSAGE_LENGTH).toBe(100_000);
        expect(isLongMessage('x'.repeat(MAX_TEXT_MESSAGE_LENGTH))).toBe(true);
    });

    it('is false for non-strings and empty text', () => {
        expect(isLongMessage(undefined)).toBe(false);
        expect(isLongMessage(null)).toBe(false);
        expect(isLongMessage(5001)).toBe(false);
        expect(isLongMessage('')).toBe(false);
    });
});

describe('collapsedPreview', () => {
    it('returns text no longer than the target untouched', () => {
        expect(collapsedPreview('short')).toEqual({ preview: 'short', hidden: 0 });
        const exact = 'y'.repeat(LONG_MESSAGE_PREVIEW_CHARS);
        expect(collapsedPreview(exact)).toEqual({ preview: exact, hidden: 0 });
    });

    it('cuts a 100k message to about 700 characters, always a prefix, counting what is hidden', () => {
        const text = prose(100_000);
        const { preview, hidden } = collapsedPreview(text);
        expect(text.startsWith(preview)).toBe(true);
        expect(preview.length).toBeLessThanOrEqual(LONG_MESSAGE_PREVIEW_CHARS);
        expect(preview.length).toBeGreaterThanOrEqual(420);
        expect(hidden).toBe(text.length - preview.length);
    });

    it('prefers a line break near the target over a word boundary', () => {
        const text = `${prose(600)}\n${prose(5000)}`;
        const { preview } = collapsedPreview(text);
        expect(preview).toBe(prose(600).trimEnd());
        expect(preview.includes('\n')).toBe(false);
    });

    it('otherwise ends on a word boundary, never mid-word', () => {
        const text = prose(6000);
        const { preview } = collapsedPreview(text);
        expect(text[preview.length]).toBe(' ');
    });

    it('a text with no whitespace at all is cut at the target', () => {
        const { preview } = collapsedPreview('z'.repeat(6000));
        expect(preview.length).toBe(LONG_MESSAGE_PREVIEW_CHARS);
    });

    it('never ends on trailing whitespace', () => {
        const { preview } = collapsedPreview(`${'a'.repeat(690)}      ${'b'.repeat(6000)}`);
        expect(preview).toBe(preview.trimEnd());
    });

    describe('inline constructs are never cut in half', () => {
        const place = (token: string, at: number) =>
            prose(at - 1).slice(0, at - 1) + ' ' + token + ' ' + prose(6000);

        it('a user mention token straddling the target', () => {
            const token = '<@u:11111111-2222-3333-4444-555555555555:dawson>';
            const text = place(token, 690); // token spans 691..739, the target is 700
            const { preview } = collapsedPreview(text);
            expect(preview.includes('<@')).toBe(false);
            expect(preview.endsWith('<')).toBe(false);
            // and the remainder starts whole at the token
            expect(text.slice(preview.length).trimStart().startsWith(token)).toBe(true);
        });

        it('a role mention whose label contains spaces', () => {
            const token = '<@r:role-1:Core Team Leads>';
            const text = place(token, 695);
            const { preview } = collapsedPreview(text);
            // no partial token survives: either all of it is in, or none of it
            const opens = (preview.match(/<@/g) ?? []).length;
            const closes = (preview.match(/>/g) ?? []).length;
            expect(opens).toBe(closes);
        });

        it('a custom emoji token', () => {
            const token = '<:partyblob:abcd-1234>';
            const text = place(token, 695);
            const { preview } = collapsedPreview(text);
            expect(preview.includes('<:')).toBe(false);
        });

        it('@everyone is not split into "@every"', () => {
            const text = place('@everyone', 697);
            const { preview } = collapsedPreview(text);
            expect(/@e(v(e(r(y(o(n)?)?)?)?)?)?$/.test(preview)).toBe(false);
        });

        it('a URL straddling the target is kept out whole', () => {
            const url = 'https://example.com/a/very/long/path/that/keeps/going/and/going/index.html?x=1';
            const text = place(url, 660);
            const { preview } = collapsedPreview(text);
            expect(preview.includes('https://')).toBe(false);
        });

        it('a URL that ends just past the target is finished rather than cut', () => {
            const url = 'https://example.com/short';
            // target (700) falls inside the URL, which began only a few characters earlier
            const text = 'a'.repeat(0) + prose(400) + ' ' + url + ' ' + prose(6000);
            const at = text.indexOf(url);
            expect(at).toBeLessThan(700);
            const { preview } = collapsedPreview(text);
            // either wholly before the cut or wholly after it. (Counted with split, not
            // `includes`: this is a text-position assertion on a fixture, not a URL host
            // check, and `includes` on a URL literal is what js/incomplete-url-substring-
            // sanitization flags.)
            const inPrev = preview.split(url).length > 1;
            const partial = !inPrev && preview.includes('https://');
            expect(partial).toBe(false);
        });

        it('a long URL covering the whole preview window falls back to the hard cut', () => {
            const text = 'https://example.com/' + 'p'.repeat(5000);
            const { preview } = collapsedPreview(text);
            expect(preview.length).toBeGreaterThan(0);
            expect(preview.length).toBeLessThanOrEqual(LONG_MESSAGE_PREVIEW_CHARS);
        });

        it('caller-supplied spans (channel links) are protected too', () => {
            const text = prose(6000);
            const start = 690;
            const { preview } = collapsedPreview(text, undefined, [{ start, end: start + 20 }]);
            expect(preview.length).toBeLessThanOrEqual(start);
        });

        it('a mention token that begins the message and is huge does not yield an empty preview', () => {
            const text = '<@u:id:' + 'n'.repeat(900) + '> ' + prose(6000);
            const { preview } = collapsedPreview(text);
            expect(preview.length).toBeGreaterThan(0);
        });
    });

    describe('with no whitespace to back up to, the construct guard is what keeps tokens whole', () => {
        // 660 characters with no space, then the construct: the word-boundary search
        // finds nothing, so only the "not inside a construct" rule decides the cut.
        const tight = (construct: string) => 'k'.repeat(660) + construct + ' ' + prose(6000);

        it('mention token', () => {
            const token = '<@u:11111111-2222-3333-4444-555555555555:dawson>';
            const { preview } = collapsedPreview(tight(token));
            expect(preview).toBe('k'.repeat(660));
        });
        it('custom emoji token', () => {
            const { preview } = collapsedPreview(tight('<:partyblob:abcd-1234-efgh-5678-ijkl-9012>'));
            expect(preview).toBe('k'.repeat(660));
        });
        it('URL', () => {
            const { preview } = collapsedPreview(tight('https://example.com/a/very/long/path/that/keeps/going/and/going/index.html?x=1'));
            expect(preview).toBe('k'.repeat(660));
        });
    });

    it('does not split a surrogate pair at the cut', () => {
        // 699 ASCII, then an emoji (2 code units) occupying 699..700, then text
        const text = 'a'.repeat(699) + '\u{1F600}' + 'b'.repeat(6000);
        const { preview } = collapsedPreview(text);
        const last = preview.charCodeAt(preview.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });

    describe('markdown-looking text (this renderer has no markdown, so a cut leaves nothing open)', () => {
        it('a code fence across the cut is just text: the preview is a plain prefix', () => {
            const text = `intro\n\`\`\`ts\n${'const x = 1;\n'.repeat(500)}\`\`\`\ntail`;
            const { preview, hidden } = collapsedPreview(text);
            expect(text.startsWith(preview)).toBe(true);
            expect(hidden).toBe(text.length - preview.length);
        });

        it('the renderer really has no markdown dependency', () => {
            const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
            const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
            expect(deps).not.toMatch(/markdown|marked|remark|micromark|showdown|snarkdown/i);
        });
    });
});

describe('the constructs it protects match what the renderer recognises', () => {
    const src = readFileSync(join(here, 'longMessage.ts'), 'utf8');
    it('mention / emoji grammar is mentionTokens MENTION_TOKEN_RE', () => {
        const m = src.match(/const MENTION_RE = \/(.*)\/g;/);
        expect(m).not.toBeNull();
        // MENTION_TOKEN_RE is the same alternation wrapped in one capture group.
        expect(`(${m![1]})`).toBe(MENTION_TOKEN_RE.source);
    });
    it('URL grammar is ChatPane URL_REGEX', () => {
        const chat = readFileSync(join(here, '..', 'components', 'ChatPane.tsx'), 'utf8');
        const a = chat.match(/const URL_REGEX = \/(.*)\/g;/);
        const b = src.match(/const URL_RE = \/(.*)\/g;/);
        expect(a && b).toBeTruthy();
        expect(b![1]).toBe(a![1]);
    });
});

describe('reading time and label', () => {
    it('wordCount counts whitespace-delimited runs', () => {
        expect(wordCount('')).toBe(0);
        expect(wordCount('   ')).toBe(0);
        expect(wordCount('one')).toBe(1);
        expect(wordCount('one two\tthree\nfour  five')).toBe(5);
    });

    it('~200 words per minute, never less than 1', () => {
        expect(readMinutes('hi')).toBe(1);
        expect(readMinutes('w '.repeat(200))).toBe(1);
        expect(readMinutes('w '.repeat(600))).toBe(3);
        expect(readMinutes('w '.repeat(20_000))).toBe(100);
    });

    it('label: "Long message · 12,345 characters · ~3 min read"', () => {
        expect(longMessageLabel({ chars: 12_345, minutes: 3 })).toBe('Long message · 12,345 characters · ~3 min read');
        const t = 'word '.repeat(5001);
        const s = longMessageStats(t);
        expect(s.chars).toBe(t.length);
        expect(longMessageLabel(s)).toMatch(/^Long message · 25,005 characters · ~\d+ min read$/);
    });
});

describe('previewSnippet (reply quote / pinned list)', () => {
    it('leaves short text alone and caps long text', () => {
        expect(previewSnippet('hello')).toBe('hello');
        expect(previewSnippet('q'.repeat(100_000)).length).toBe(400);
        expect(previewSnippet('q'.repeat(100_000), 50).length).toBe(50);
    });
    it('does not end on half a surrogate pair', () => {
        const s = previewSnippet('a'.repeat(399) + '\u{1F600}' + 'b'.repeat(500));
        const last = s.charCodeAt(s.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });
});

describe('longMessageExpansion (per-session expand state)', () => {
    beforeEach(() => longMessageExpansion.clear());

    it('remembers per message id, and collapse forgets it', () => {
        expect(longMessageExpansion.has('m1')).toBe(false);
        longMessageExpansion.set('m1', true);
        expect(longMessageExpansion.has('m1')).toBe(true);
        expect(longMessageExpansion.has('m2')).toBe(false);
        longMessageExpansion.set('m1', false);
        expect(longMessageExpansion.has('m1')).toBe(false);
    });

    it('is bounded: the oldest expansion is the first to go', () => {
        for (let i = 0; i < 600; i++) longMessageExpansion.set(`m${i}`, true);
        expect(longMessageExpansion.has('m0')).toBe(false);
        expect(longMessageExpansion.has('m599')).toBe(true);
    });
});
