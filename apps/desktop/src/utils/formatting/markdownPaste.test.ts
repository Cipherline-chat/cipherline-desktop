/**
 * Markdown paste: detection (positive AND negative) and the GFM -> our-syntax
 * converter (utils/formatting/markdownPaste.ts).
 */
import { describe, it, expect } from 'vitest';
import { looksLikeMarkdown, convertMarkdown, shouldOfferMarkdownConversion } from './markdownPaste';
import { parseMessage } from './markdown';

const CHATGPT = `## Quick setup

Here's how to get started:

1. Install the **CLI** with \`npm i -g thing\`
2. Run \`thing init\`
3. Read the [docs](https://example.com/docs)

| Option | Default | Notes |
|:-------|:-------:|------:|
| \`port\` | 3000 | HTTP port |
| \`debug\` | false | Verbose logs |

#### Notes
- Works on __Linux__ and _macOS_
- [ ] Windows support
- [x] Tests

\`\`\`bash
thing start --port 3000
\`\`\`
`;

describe('looksLikeMarkdown — positive', () => {
    it('a ChatGPT-style answer', () => expect(looksLikeMarkdown(CHATGPT)).toBe(true));
    it('a GitHub README fragment', () => expect(looksLikeMarkdown('# Project\n\nSome text with a [link](https://github.com/a/b).\n\n## Install\n')).toBe(true));
    it('a table alone', () => expect(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true));
    it('a fenced code block alone', () => expect(looksLikeMarkdown('```js\nconsole.log(1)\n```')).toBe(true));
    it('a list of several items', () => expect(looksLikeMarkdown('* one\n* two\n* three')).toBe(true));
    it('a heading plus emphasis', () => expect(looksLikeMarkdown('### Summary\nThis is **important**.')).toBe(true));
    it('a task list', () => expect(looksLikeMarkdown('- [ ] buy milk\n- [x] call mom')).toBe(true));
});

describe('looksLikeMarkdown — negative (ordinary chat)', () => {
    const plain = [
        'I *really* mean it',
        '2 * 3 * 4 = 24',
        'ok **fine** whatever',
        'see you at 5pm - bring snacks',
        'footnote* applies',
        '*sigh*',
        'price: $5 * 3 people',
        'my_variable_name is wrong',
        'C:\\Users\\me\\file.txt',
        'lol',
        'Hey! Are you coming tonight? Let me know :)',
        'a - b - c',
        '#1 fan right here',
        'check out https://example.com/some_page_here',
    ];
    for (const t of plain) it(JSON.stringify(t), () => expect(looksLikeMarkdown(t)).toBe(false));
});

describe('convertMarkdown', () => {
    it('GFM __bold__ is bold here (not underline), _italic_ uses *', () => {
        expect(convertMarkdown('a __b__ c')).toBe('a **b** c');
        expect(convertMarkdown('a _b_ c')).toBe('a *b* c');
        expect(convertMarkdown('snake_case_stays')).toBe('snake_case_stays');
    });

    it('headings past ### are capped; setext headings become ATX; closing #s go', () => {
        expect(convertMarkdown('#### four')).toBe('### four');
        expect(convertMarkdown('###### six ##')).toBe('### six');
        expect(convertMarkdown('Title\n=====')).toBe('# Title');
        expect(convertMarkdown('Sub\n---')).toBe('## Sub');
    });

    it('list markers and task lists', () => {
        expect(convertMarkdown('* a\n+ b\n1) c')).toBe('- a\n- b\n1. c');
        expect(convertMarkdown('- [ ] todo\n- [x] done')).toBe('- ☐ todo\n- ☑ done');
        expect(convertMarkdown('\t- tabbed')).toBe('  - tabbed');
    });

    it('rules, images, html, quotes', () => {
        expect(convertMarkdown('a\n\n---\n\nb')).toBe('a\n\n\n\nb');
        expect(convertMarkdown('![cat](https://x.y/cat.png)')).toBe('[cat](https://x.y/cat.png)');
        expect(convertMarkdown('<b>x</b> <i>y</i> <u>z</u> <s>w</s>')).toBe('**x** *y* __z__ ~~w~~');
        expect(convertMarkdown('a<br>b')).toBe('a\nb');
        expect(convertMarkdown('> > nested\n>tight')).toBe('> nested\n> tight');
    });

    it('a table becomes an aligned code block', () => {
        const out = convertMarkdown('| Name | Qty |\n|:--|--:|\n| **apple** | 3 |\n| kiwi | 12 |');
        expect(out).toBe([
            '```',
            'Name  │ Qty',
            '──────┼────',
            'apple │   3',
            'kiwi  │  12',
            '```',
        ].join('\n'));
    });

    it('never touches code', () => {
        expect(convertMarkdown('```py\n__init__ * _x_\n```')).toBe('```py\n__init__ * _x_\n```');
        expect(convertMarkdown('use `__init__` here')).toBe('use `__init__` here');
        expect(convertMarkdown('~~~\ncode\n~~~')).toBe('```\ncode\n```');
    });

    it('the converted ChatGPT answer parses into the blocks it should', () => {
        const blocks = parseMessage(convertMarkdown(CHATGPT));
        const kinds = blocks.map(b => b.t);
        expect(kinds).toContain('heading');
        expect(kinds).toContain('list');
        // The table and the bash block are code blocks inside paragraphs.
        const codeBlocks = JSON.stringify(blocks).match(/"codeBlock"/g) ?? [];
        expect(codeBlocks.length).toBe(2);
        expect(convertMarkdown(CHATGPT)).toContain('**Linux** and *macOS*');
    });
});

describe('shouldOfferMarkdownConversion', () => {
    it('offers when converting changes something', () => {
        expect(shouldOfferMarkdownConversion(CHATGPT)).toBe(true);
    });
    it('does not offer for Markdown already in our syntax (it renders formatted as is)', () => {
        expect(shouldOfferMarkdownConversion('## Plan\n- **one**\n- two\n- three')).toBe(false);
    });
    it('does not offer for plain chat', () => {
        expect(shouldOfferMarkdownConversion('I *really* mean it, 2 * 3')).toBe(false);
    });
});
