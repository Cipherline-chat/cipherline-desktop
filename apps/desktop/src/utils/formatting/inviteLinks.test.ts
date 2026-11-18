import { describe, expect, it } from 'vitest';
import { inviteCodeFromUrl, stripBareInviteLinks as strip } from './inviteLinks';

const I = 'https://cipherline.chat/invite/abc123';

describe('inviteCodeFromUrl', () => {
    it.each([
        [I, 'abc123'],
        ['http://cipherline.chat/invite/abc123', 'abc123'],
        ['https://CipherLine.chat/invite/abc_12-3', 'abc_12-3'],
        [`${I}/`, 'abc123'],
        [`${I}?ref=x`, 'abc123'],
        [`${I}#top`, 'abc123'],
    ])('accepts %s', (u, code) => expect(inviteCodeFromUrl(u)).toBe(code));

    it.each([
        'https://www.cipherline.chat/invite/abc123',
        'https://cipherline.chat/invite/abc123/icon',
        'https://cipherline.chat/ref/abc123',
        'https://cipherline.chat/invite/',
        'https://cipherline.chat/',
        'https://evil.example/invite/abc123',
        'https://cipherline.chat.evil.example/invite/abc123',
    ])('rejects %s', u => expect(inviteCodeFromUrl(u)).toBeNull());
});

describe('stripBareInviteLinks', () => {
    it('returns the same string when there is no invite', () => {
        expect(strip('hello world')).toBe('hello world');
        expect(strip('')).toBe('');
    });

    it('bare-only message becomes empty', () => {
        expect(strip(I)).toBe('');
        expect(strip(`  ${I}  `)).toBe('');
        expect(strip(`${I}\n`)).toBe('');
    });

    it('mid-sentence: one space remains', () => {
        expect(strip(`join us ${I} please`)).toBe('join us please');
    });

    it('start and end, no dangling space', () => {
        expect(strip(`${I} come in`)).toBe('come in');
        expect(strip(`come in ${I}`)).toBe('come in');
        expect(strip(`come in ${I}   `)).toBe('come in');
    });

    it('punctuation after the URL hugs the previous word', () => {
        expect(strip(`join ${I}, thanks`)).toBe('join, thanks');
        expect(strip(`join us (${I}).`)).toBe('join us ().');
        expect(strip(`join ${I}.`)).toBe('join.');
    });

    it('a line holding only the invite is dropped, no blank line left', () => {
        expect(strip(`hello\n${I}\nbye`)).toBe('hello\nbye');
        expect(strip(`${I}\nhello`)).toBe('hello');
        expect(strip(`hello\n${I}`)).toBe('hello');
        expect(strip(`hello\n\n${I}\n\nbye`)).toBe('hello\n\nbye');
    });

    it('removes several invites', () => {
        const b = 'https://cipherline.chat/invite/zzz999';
        expect(strip(`a ${I} b ${b} c`)).toBe('a b c');
        expect(strip(`${I}\n${b}`)).toBe('');
        expect(strip(`x ${I} y ${I} z`)).toBe('x y z');
    });

    it('URL variants are removed', () => {
        expect(strip(`go http://cipherline.chat/invite/abc123 now`)).toBe('go now');
        expect(strip(`go ${I}/ now`)).toBe('go now');
        expect(strip(`go ${I}?a=1&b=2 now`)).toBe('go now');
        expect(strip(`go ${I}#x now`)).toBe('go now');
        expect(strip(`go https://CIPHERLINE.chat/invite/abc123 now`)).toBe('go now');
    });

    it('keeps formatting around the removed URL', () => {
        expect(strip(`**join** ${I} __now__`)).toBe('**join** __now__');
        expect(strip(`> quoted ${I}`)).toBe('> quoted');
        expect(strip(`> ${I}\nafter`)).toBe('after');
        expect(strip(`- ${I}\n- keep`)).toBe('- keep');
    });

    it('a masked link stays visible', () => {
        const t = `[join us](${I})`;
        expect(strip(t)).toBe(t);
        const u = `hi [join us](${I}) ${I}`;
        expect(strip(u)).toBe(`hi [join us](${I})`);
    });

    it('code, spoilers, <url> and link labels are untouched', () => {
        for (const t of [
            `\`${I}\``,
            `\`\`\`\n${I}\n\`\`\``,
            `||${I}||`,
            `<${I}>`,
            `[${I}](https://example.com/x)`,
        ]) expect(strip(t)).toBe(t);
        expect(strip(`\`${I}\` and ${I}`)).toBe(`\`${I}\` and`);
    });

    it('an invite beyond the 3-embed cap keeps its text', () => {
        const u = (n: number) => `https://example.com/page${n}`;
        const t = `${u(1)} ${u(2)} ${u(3)} ${I}`;
        expect(strip(t)).toBe(t);
        const two = `${u(1)} ${u(2)} ${I} ${u(3)}`;
        expect(strip(two)).toBe(`${u(1)} ${u(2)} ${u(3)}`);
    });

    it('non-invite cipherline.chat URLs are kept', () => {
        for (const t of [
            'see https://cipherline.chat/ref/abc123',
            'see https://cipherline.chat/privacy',
            `see ${I}/icon`,
            'see https://www.cipherline.chat/invite/abc123',
            'see https://cipherline.chat.evil.example/invite/abc123',
            'see https://evil.example/?u=https://cipherline.chat/invite/abc123',
        ]) expect(strip(t)).toBe(t);
    });

    it('is deterministic and memoised', () => {
        const t = `a ${I} b`;
        expect(strip(t)).toBe(strip(t));
    });
});
