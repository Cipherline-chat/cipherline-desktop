/**
 * The message-formatting grammar (utils/formatting/markdown.ts): Discord's
 * syntax and its edge cases, plus the places we deliberately differ.
 *
 * `show()` prints a tree compactly so each expectation reads like the markup:
 *   **a** _b_  ->  "<b>a</b> <i>b</i>"
 */
import { describe, it, expect } from 'vitest';
import { parseInline, parseMessage, type BlockNode, type InlineNode, isPlainParse, closeDanglingFence, lineTogglesFence } from './markdown';

function showInline(nodes: readonly InlineNode[]): string {
    return nodes.map(n => {
        switch (n.t) {
            case 'text': return n.v;
            case 'strong': return `<b>${showInline(n.c)}</b>`;
            case 'em': return `<i>${showInline(n.c)}</i>`;
            case 'u': return `<u>${showInline(n.c)}</u>`;
            case 'strike': return `<s>${showInline(n.c)}</s>`;
            case 'spoiler': return `<sp>${showInline(n.c)}</sp>`;
            case 'code': return `<code>${n.v}</code>`;
            case 'codeBlock': return `<pre${n.lang ? ` ${n.lang}` : ''}>${n.v}</pre>`;
            case 'link': return n.kind === 'angle' ? `<auto ${n.url}>` : `<a ${n.url}>${showInline(n.c)}</a>`;
        }
    }).join('');
}
const show = (s: string) => showInline(parseInline(s));

function showBlocks(blocks: readonly BlockNode[]): string {
    return blocks.map(b => {
        switch (b.t) {
            case 'para': return `P(${showInline(b.c)})`;
            case 'heading': return `H${b.level}(${showInline(b.c)})`;
            case 'subtext': return `SUB(${showInline(b.c)})`;
            case 'quote': return `Q[${showBlocks(b.c)}]`;
            case 'list': {
                const walk = (l: typeof b): string => `${l.ordered ? `OL${l.start}` : 'UL'}[${l.items.map(it => showInline(it.c) + (it.sub ? walk(it.sub) : '')).join('|')}]`;
                return walk(b);
            }
        }
    }).join(' ');
}
const blocks = (s: string) => showBlocks(parseMessage(s));

describe('inline emphasis (Discord rules)', () => {
    it('bold, italic (both markers), underline, strike, spoiler', () => {
        expect(show('**bold**')).toBe('<b>bold</b>');
        expect(show('*it*')).toBe('<i>it</i>');
        expect(show('_it_')).toBe('<i>it</i>');
        expect(show('__under__')).toBe('<u>under</u>');
        expect(show('~~gone~~')).toBe('<s>gone</s>');
        expect(show('||secret||')).toBe('<sp>secret</sp>');
    });

    it('***bold italic*** and __*underline italic*__ and ___u+i___', () => {
        expect(show('***both***')).toBe('<b><i>both</i></b>');
        expect(show('__*ui*__')).toBe('<u><i>ui</i></u>');
        expect(show('*__iu__*')).toBe('<i><u>iu</u></i>');
        expect(show('___ui___')).toBe('<u><i>ui</i></u>');
        expect(show('**bold *and italic***')).toBe('<b>bold <i>and italic</i></b>');
        expect(show('*a **b** c*')).toBe('<i>a <b>b</b> c</i>');
    });

    it('mixed with plain text around it', () => {
        expect(show('ship it **tonight**, maybe')).toBe('ship it <b>tonight</b>, maybe');
        expect(show('a ~~b~~ c ||d|| e')).toBe('a <s>b</s> c <sp>d</sp> e');
    });

    it('underscores inside words never italicise (snake_case)', () => {
        expect(show('snake_case_name')).toBe('snake_case_name');
        expect(show('use my_var and other_var')).toBe('use my_var and other_var');
        expect(show('x_y_')).toBe('x_y_');
        // …but asterisks inside a word do (Discord).
        expect(show('un*frigging*believable')).toBe('un<i>frigging</i>believable');
    });

    it('__dunder__ underlines like Discord does', () => {
        expect(show('call __init__ first')).toBe('call <u>init</u> first');
    });

    it('a lone or space-flanked asterisk is just an asterisk', () => {
        expect(show('2 * 3 * 4')).toBe('2 * 3 * 4');
        expect(show('* not a list here')).toBe('* not a list here');
        expect(show('a*')).toBe('a*');
        expect(show('**')).toBe('**');
        expect(show('****')).toBe('****');
        expect(show('** **')).toBe('<b> </b>');
    });

    it('unclosed markers stay literal', () => {
        expect(show('**open')).toBe('**open');
        expect(show('~~open')).toBe('~~open');
        expect(show('||open')).toBe('||open');
        expect(show('a | b | c')).toBe('a | b | c');
    });

    it('spans newlines inside one paragraph', () => {
        expect(show('**a\nb**')).toBe('<b>a\nb</b>');
    });
});

describe('escaping', () => {
    it('a backslash makes the next punctuation literal', () => {
        expect(show('\\*not italic\\*')).toBe('*not italic*');
        expect(show('\\*\\*not bold\\*\\*')).toBe('**not bold**');
        expect(show('\\_\\_x\\_\\_')).toBe('__x__');
        expect(show('\\|\\|x\\|\\|')).toBe('||x||');
        expect(show('\\`x\\`')).toBe('`x`');
    });

    it('an escaped backslash is a backslash, and the marker after it still works', () => {
        expect(show('\\\\*it*')).toBe('\\<i>it</i>');
    });

    it('a backslash before a letter stays', () => {
        expect(show('C:\\Users\\me')).toBe('C:\\Users\\me');
    });
});

describe('code', () => {
    it('inline code, and double-backtick code containing a backtick', () => {
        expect(show('run `npm test` now')).toBe('run <code>npm test</code> now');
        expect(show('``a ` b``')).toBe('<code>a ` b</code>');
        expect(show('`` `x` ``')).toBe('<code>`x`</code>');
    });

    it('no formatting inside code — not even escapes', () => {
        expect(show('`**not bold** _no_ ||no||`')).toBe('<code>**not bold** _no_ ||no||</code>');
        expect(show('`a\\`')).toBe('<code>a\\</code>');
    });

    it('code wins over emphasis that would cross it', () => {
        expect(show('*see `a*b` here*')).toBe('<i>see <code>a*b</code> here</i>');
        expect(show('**x `**` y**')).toBe('<b>x <code>**</code> y</b>');
    });

    it('fenced code block with and without a language', () => {
        expect(show('```js\nconst a = 1;\n```')).toBe('<pre js>const a = 1;</pre>');
        expect(show('```\nplain\n```')).toBe('<pre>plain</pre>');
        expect(show('```one line```')).toBe('<pre>one line</pre>');
        // A "language" with nothing after it is the code itself (Discord).
        expect(show('```js\n```')).toBe('<pre>js</pre>');
    });

    it('formatting inside a code block is literal', () => {
        expect(show('```\n**a** _b_ [c](https://d.e)\n```')).toBe('<pre>**a** _b_ [c](https://d.e)</pre>');
    });

    it('an unclosed fence is literal text', () => {
        expect(show('```js\nconst a')).toBe('```js\nconst a');
        expect(show('`unclosed')).toBe('`unclosed');
    });

    it('empty code is not code', () => {
        expect(show('``')).toBe('``');
        expect(show('``````')).toBe('``````');
    });
});

describe('links', () => {
    it('masked links (https only) with formatted labels', () => {
        expect(show('[docs](https://example.com/a)')).toBe('<a https://example.com/a>docs</a>');
        expect(show('[**bold** docs](https://example.com)')).toBe('<a https://example.com><b>bold</b> docs</a>');
        expect(show('[x](<https://example.com>)')).toBe('<a https://example.com>x</a>');
        expect(show('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('<a https://en.wikipedia.org/wiki/Foo_(bar)>wiki</a>');
    });

    it('http:// and non-web schemes are not masked links', () => {
        expect(show('[x](http://example.com)')).toBe('[x](http://example.com)');
        expect(show('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
        expect(show('[x](file:///etc/passwd)')).toBe('[x](file:///etc/passwd)');
    });

    it('no link inside a link label, and empty labels are not links', () => {
        expect(show('[](https://a.b)')).toBe('[](https://a.b)');
        expect(show('[a [b](https://c.d)')).toBe('[a <a https://c.d>b</a>');
    });

    it('<url> is a link without an embed', () => {
        expect(show('see <https://example.com/x>')).toBe('see <auto https://example.com/x>');
    });

    it('formatting characters inside a bare URL are part of the URL', () => {
        expect(show('https://example.com/a_b_c')).toBe('https://example.com/a_b_c');
        expect(show('https://x.com/*a*/b')).toBe('https://x.com/*a*/b');
        expect(show('_https://x.com/_')).toBe('<i>https://x.com/</i>');
    });

    it('…but a URL can still be wrapped in formatting', () => {
        expect(show('**https://example.com**')).toBe('<b>https://example.com</b>');
        expect(show('||https://example.com/secret||')).toBe('<sp>https://example.com/secret</sp>');
    });
});

describe('mention and emoji tokens are atomic', () => {
    it('a role name with markdown characters in it stays one token', () => {
        expect(show('hi <@r:abc:**Mods**> there')).toBe('hi <@r:abc:**Mods**> there');
        expect(show('**hi <@u:u1:a__b__c>**')).toBe('<b>hi <@u:u1:a__b__c></b>');
        expect(show('_<:party_time:e1>_')).toBe('<i><:party_time:e1></i>');
    });

    it('a delimiter inside a token never closes one outside it', () => {
        expect(show('__a <@u:u1:x__y> b__')).toBe('<u>a <@u:u1:x__y> b</u>');
    });
});

describe('blocks', () => {
    it('headings: #, ##, ### only, with a space', () => {
        expect(blocks('# Title')).toBe('H1(Title)');
        expect(blocks('## Sub')).toBe('H2(Sub)');
        expect(blocks('### Small')).toBe('H3(Small)');
        expect(blocks('#### four')).toBe('P(#### four)');
        expect(blocks('#hashtag')).toBe('P(#hashtag)');
        expect(blocks('# **bold** title')).toBe('H1(<b>bold</b> title)');
    });

    it('-# subtext', () => {
        expect(blocks('-# small print')).toBe('SUB(small print)');
    });

    it('> quotes (consecutive lines), and >>> quotes the rest', () => {
        expect(blocks('> a\n> b\nc')).toBe('Q[P(a\nb)] P(c)');
        expect(blocks('>>> a\nb\nc')).toBe('Q[P(a\nb\nc)]');
        expect(blocks('>no space')).toBe('P(>no space)');
        // No nested quotes.
        expect(blocks('> > a')).toBe('Q[P(> a)]');
        // Lists and headings inside a quote.
        expect(blocks('> # h\n> - x')).toBe('Q[H1(h) UL[x]]');
    });

    it('lists: bullets, numbers (start kept), nesting by indentation', () => {
        expect(blocks('- a\n- b')).toBe('UL[a|b]');
        expect(blocks('* a\n* b')).toBe('UL[a|b]');
        expect(blocks('3. c\n4. d')).toBe('OL3[c|d]');
        expect(blocks('- a\n  - a1\n  - a2\n- b')).toBe('UL[aUL[a1|a2]|b]');
        expect(blocks('1. a\n   - x\n2. b')).toBe('OL1[aUL[x]|b]');
        expect(blocks('- **bold** item')).toBe('UL[<b>bold</b> item]');
        // Switching kinds at the top level starts a new list.
        expect(blocks('- a\n1. b')).toBe('UL[a] OL1[b]');
    });

    it('list nesting is capped', () => {
        const deep = Array.from({ length: 12 }, (_, i) => `${' '.repeat(i * 2)}- l${i}`).join('\n');
        let depth = 0;
        const walk = (l: { items: { sub: unknown }[] }, d: number) => {
            depth = Math.max(depth, d);
            for (const it of l.items) if (it.sub) walk(it.sub as never, d + 1);
        };
        walk(parseMessage(deep)[0] as never, 1);
        expect(depth).toBe(6);
    });

    it('a fence keeps its lines raw (no headings / lists inside code)', () => {
        expect(blocks('```\n# not a heading\n- not a list\n```')).toBe('P(<pre># not a heading\n- not a list</pre>)');
        // The line breaks into and out of a fence are the block's edges, not blank lines.
        expect(blocks('before\n```py\nx = 1\n```\nafter')).toBe('P(before<pre py>x = 1</pre>after)');
        expect(blocks('a\n\n```x```\n\nb')).toBe('P(a\n<pre>x</pre>\nb)');
    });

    it('paragraph text keeps its newlines; a blank line before a block is padded', () => {
        const b = parseMessage('a\n\n- x');
        expect(b[0]).toMatchObject({ t: 'para', pad: true });
        // A blank line after a code block survives (the fence line's own break is consumed).
        expect(parseMessage('```x```\n\n# h')[0]).toMatchObject({ t: 'para', pad: true });
        expect(parseMessage('a\n- x')[0]).toMatchObject({ t: 'para', pad: false });
        // The last block never pads (a trailing newline looks as it always did).
        expect(parseMessage('a\n')[0]).toMatchObject({ t: 'para', pad: false });
    });

    it('a plain message is a single plain paragraph', () => {
        expect(isPlainParse(parseMessage('just text, nothing else'))).toBe(true);
        expect(isPlainParse(parseMessage('just **text**'))).toBe(false);
        expect(isPlainParse(parseMessage('2 * 3 = 6'))).toBe(true);
    });

    it('CRLF is treated as LF', () => {
        expect(blocks('# a\r\n- b')).toBe('H1(a) UL[b]');
    });
});

describe('helpers', () => {
    it('lineTogglesFence counts unescaped fences', () => {
        expect(lineTogglesFence('```js')).toBe(true);
        expect(lineTogglesFence('```a```')).toBe(false);
        expect(lineTogglesFence('\\```')).toBe(false);
    });

    it('closeDanglingFence closes a fence a preview cut left open, and only then', () => {
        expect(closeDanglingFence('a\n```js\ncode')).toBe('a\n```js\ncode\n```');
        expect(closeDanglingFence('```a```')).toBe('```a```');
    });
});
