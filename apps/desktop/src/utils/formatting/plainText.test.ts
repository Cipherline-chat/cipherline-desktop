/**
 * Plain-text previews and embed URLs of formatted messages
 * (utils/formatting/plainText.ts, wired into utils/messagePreviewText.ts).
 */
import { describe, it, expect } from 'vitest';
import { stripFormatting, embedUrlsOf, sharedLinksOf, SPOILER_PLACEHOLDER } from './plainText';
import { displayPreviewOf, displayTextOf, messageTextMatches, searchExcerpt, toPlainText } from '../messagePreviewText';

describe('stripFormatting', () => {
    it('drops the syntax, keeps the words', () => {
        expect(stripFormatting('**ship** it _tonight_ ~~maybe~~ __now__')).toBe('ship it tonight maybe now');
        expect(stripFormatting('run `npm test`')).toBe('run npm test');
        expect(stripFormatting('# Title\nbody')).toBe('Title\nbody');
        expect(stripFormatting('> quoted\nnot')).toBe('quoted\nnot');
        expect(stripFormatting('-# small')).toBe('small');
        expect(stripFormatting('\\*literal\\*')).toBe('*literal*');
    });

    it('lists keep a readable marker', () => {
        expect(stripFormatting('- a\n- b')).toBe('• a\n• b');
        expect(stripFormatting('2. a\n3. b')).toBe('2. a\n3. b');
        expect(stripFormatting('- a\n  - b')).toBe('• a\n  • b');
    });

    it('a masked link previews as its label, an <url> as the url', () => {
        expect(stripFormatting('see [the docs](https://example.com/x)')).toBe('see the docs');
        expect(stripFormatting('see <https://example.com/x>')).toBe('see https://example.com/x');
    });

    it('NEVER reveals a spoiler', () => {
        expect(stripFormatting('the end: ||he was a ghost||')).toBe(`the end: ${SPOILER_PLACEHOLDER}`);
        expect(stripFormatting('||**bold secret**||')).toBe(SPOILER_PLACEHOLDER);
        expect(stripFormatting('||a||')).not.toContain('a]');
    });

    it('code blocks preview as their code', () => {
        expect(stripFormatting('```js\nlet x = 1\n```')).toBe('let x = 1');
        expect(stripFormatting('here:\n```js\nx()\n```\nafter')).toBe('here:\nx()\nafter');
    });

    it('plain text is unchanged; mention tokens pass through for the caller', () => {
        expect(stripFormatting('hello there, 2 * 3 = 6')).toBe('hello there, 2 * 3 = 6');
        expect(stripFormatting('hi <@u:abc:dawson_k>')).toBe('hi <@u:abc:dawson_k>');
    });
});

describe('preview surfaces strip formatting (messagePreviewText)', () => {
    it('reply quote / bar preview', () => {
        expect(displayPreviewOf({ text: '**hi** <@u:1:dawson>' })).toBe('hi @dawson');
        expect(displayPreviewOf({ text: '||spoiler text||' })).toBe(SPOILER_PLACEHOLDER);
    });

    it('conversation list / notification text', () => {
        expect(toPlainText('# **Big** news <@u:1:dawson>', { tokens: 'keep' })).toBe('Big news <@u:1:dawson>');
        expect(toPlainText('# **Big** news <@u:1:dawson>')).toBe('Big news @dawson');
        expect(toPlainText(42)).toBe('');
    });

    it('Copy Text keeps the raw syntax', () => {
        expect(displayTextOf({ text: '**hi** <@u:1:dawson>' })).toBe('**hi** @dawson');
    });

    it('search matches what is shown, not the markers, and not spoiler text', () => {
        expect(messageTextMatches('**ship** it', 'ship it')).toBe(true);
        expect(messageTextMatches('the end ||ghost||', 'ghost')).toBe(false);
        expect(searchExcerpt('a **bold** word', 'bold word')?.match).toBe('bold word');
    });
});

describe('embedUrlsOf', () => {
    it('bare URLs and masked-link destinations, deduplicated, in order', () => {
        expect(embedUrlsOf('a https://a.com b [x](https://b.com) https://a.com')).toEqual(['https://a.com', 'https://b.com']);
    });

    it('a masked link embeds its clean destination, not "url)"', () => {
        expect(embedUrlsOf('[watch](https://youtu.be/abc)')).toEqual(['https://youtu.be/abc']);
    });

    it('no embed for code, spoilers, <url>, or a URL written as a link label', () => {
        expect(embedUrlsOf('`https://code.com`')).toEqual([]);
        expect(embedUrlsOf('```\nhttps://block.com\n```')).toEqual([]);
        expect(embedUrlsOf('||https://img.example/a.png||')).toEqual([]);
        expect(embedUrlsOf('<https://quiet.com>')).toEqual([]);
        expect(embedUrlsOf('[https://label.com](https://real.com)')).toEqual(['https://real.com']);
    });

    it('sentence punctuation after a URL is not part of it; a balanced paren is', () => {
        expect(embedUrlsOf('(see https://x.y/a). and https://en.wikipedia.org/wiki/Foo_(bar), ok')).toEqual(['https://x.y/a', 'https://en.wikipedia.org/wiki/Foo_(bar)']);
        expect(sharedLinksOf('a <https://quiet.example> b ||https://hidden.example|| `https://code.example`')).toEqual(['https://quiet.example']);
    });

    it('URLs inside formatting still embed', () => {
        expect(embedUrlsOf('**https://bold.com**')).toEqual(['https://bold.com']);
        expect(embedUrlsOf('> https://quoted.com\n- https://listed.com')).toEqual(['https://quoted.com', 'https://listed.com']);
    });
});
