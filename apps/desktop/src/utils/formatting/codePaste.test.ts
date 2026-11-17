/**
 * Code paste: conservative detection (positive AND negative sets), language
 * tags, the fence, and the one-prompt precedence with Markdown paste.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeCode, fenceCode, pastePromptFor } from './codePaste';
import { parseMessage } from './markdown';
import { shouldOfferMarkdownConversion } from './markdownPaste';

const POSITIVE: [string, string, string | null][] = [
    ['TypeScript', `import { useState } from 'react';\n\nexport function useToggle(initial = false) {\n    const [on, setOn] = useState<boolean>(initial);\n    return [on, () => setOn(v => !v)] as const;\n}`, 'ts'],
    ['JavaScript', `const add = (a, b) => a + b;\nconsole.log(add(2, 3));\nmodule.exports = { add };`, 'js'],
    ['Python', `def greet(name):\n    if not name:\n        return None\n    print(f"hi {name}")\n\ngreet("sam")`, 'python'],
    ['JSON', `{\n  "name": "cipherline",\n  "version": "0.1.1",\n  "private": true\n}`, 'json'],
    ['minified JSON, one line', `{"user":"sam","roles":["admin","mod"],"active":true}`, 'json'],
    ['shell script', `#!/usr/bin/env bash\nset -euo pipefail\nnpm ci\nnpm run build --workspace apps/desktop`, 'bash'],
    ['shell commands', `git fetch origin staging\ngit checkout -b fix/thing origin/staging\nnpm test -- --watch=false`, 'bash'],
    ['one-line shell with flags', `docker compose logs -f api | grep ERROR`, 'bash'],
    ['SQL', `SELECT id, created_at\nFROM messages\nWHERE channel_id = $1\nORDER BY created_at DESC\nLIMIT 50;`, 'sql'],
    ['C', `#include <stdio.h>\n\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}`, 'c'],
    ['Java', `public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}`, 'java'],
    ['Rust', `fn main() {\n    let mut v = Vec::new();\n    v.push(1);\n    println!("{:?}", v);\n}`, 'rust'],
    ['YAML', `services:\n  api:\n    image: cipherline/api:latest\n    ports:\n      - "3005:3005"`, 'yaml'],
    ['JS stack trace', `TypeError: Cannot read properties of undefined (reading 'id')\n    at renderRow (ChatPane.tsx:8123:41)\n    at Array.map (<anonymous>)\n    at ChatPane (ChatPane.tsx:7990:17)`, null],
    ['Python traceback', `Traceback (most recent call last):\n  File "app.py", line 12, in <module>\n    main()\n  File "app.py", line 8, in main\n    1 / 0\nZeroDivisionError: division by zero`, 'python'],
    ['log lines', `2026-11-16T16:01:02Z INFO  api listening on :3005\n2026-11-16T16:01:05Z WARN  redis slow (412ms)\n2026-11-16T16:01:09Z ERROR pool exhausted (20/20)`, null],
];

const NEGATIVE: [string, string][] = [
    ['ordinary prose', 'Hey! I finished the slides last night. Can you take a look before the meeting tomorrow?\nThanks, and sorry it took so long.'],
    ['one line with a semicolon', 'I tried; it did not work.'],
    ['a URL', 'https://example.com/docs/setup?step=2#install'],
    ['a list of names', 'Sam\nAlex\nJordan\nPriya\nChen'],
    ['an emoticon chat message', "lol ok see you then :)\nbring snacks ;)"],
    ['an address', '1600 Pennsylvania Ave NW\nWashington, DC 20500\nUSA'],
    ['a contact card (key: value but not YAML)', 'Name: Sam Lee\nPhone: 555-0100\nEmail: sam@example.com'],
    ['a shopping list', '- milk\n- eggs\n- bread (the good one)'],
    ['a single word', 'deploy'],
    ['a one-line command without flags', 'npm install'],
    ['a one-line sentence mentioning git', 'git is confusing, can you help me with it later?'],
    ['a math line', '2 * (3 + 4) = 14'],
    ['already fenced', '```js\nconst a = 1;\n```'],
    ['Markdown answer', '## Setup\n\n1. Install the **CLI**\n2. Run it\n\nSee the [docs](https://example.com).'],
    ['short poem', 'Roses are red,\nviolets are blue,\nI wrote some code,\nand it compiled too.'],
    // Two code-ish lines are not enough when they are a minority (the 60% rule).
    ['names with two code-like lines', 'Sam\nAlex\nJordan\nconst x = 1;\nreturn y;'],
    // Mostly code-shaped, but it reads as an explanation (the prose guard).
    ['an explanation with code lines in it', 'I changed the config loader yesterday afternoon.\nconst a = load();\nconst b = parse(a);\nIt now reads the file only once per start.\nreturn b;\nconsole.log(b);\nThat should fix the slow boot you saw earlier.\nvalidate(b);\nexport default b;\nLet me know if anything still looks off to you.'],
];

describe('looksLikeCode — positive', () => {
    for (const [name, text, lang] of POSITIVE) {
        it(`${name} -> ${lang ?? 'no tag'}`, () => {
            expect(looksLikeCode(text)).toEqual({ lang });
        });
    }
});

describe('looksLikeCode — negative', () => {
    for (const [name, text] of NEGATIVE) {
        it(name, () => expect(looksLikeCode(text)).toBeNull());
    }
});

describe('fenceCode', () => {
    it('wraps with the tag (or none) and keeps the text exactly', () => {
        expect(fenceCode('x = 1\n', 'python')).toBe('```python\nx = 1\n```');
        expect(fenceCode('a\r\nb', null)).toBe('```\na\nb\n```');
    });
    it('the fenced text parses as one code block holding the original', () => {
        const src = POSITIVE[0][1];
        const blocks = parseMessage(fenceCode(src, 'ts'));
        expect(blocks).toHaveLength(1);
        const para = blocks[0] as { c: { t: string; v?: string; lang?: string }[] };
        expect(para.c).toEqual([{ t: 'codeBlock', lang: 'ts', v: src }]);
    });
});

describe('pastePromptFor — one prompt, documented precedence', () => {
    it('code -> the code prompt', () => {
        expect(pastePromptFor(POSITIVE[2][1])).toEqual({ kind: 'code', lang: 'python' });
    });
    it('Python with # comments and __init__ is code, not Markdown (Markdown would mangle it)', () => {
        const py = 'class A:\n    # set up\n    def __init__(self):\n        self.x = 1\n';
        expect(pastePromptFor(py)).toEqual({ kind: 'code', lang: 'python' });
    });
    it('text BOTH detectors accept is offered as code (Markdown would turn __name__ into bold)', () => {
        const py = "# Config loader\nimport os\n\n# Entry point\nif __name__ == '__main__':\n    print(os.environ.get('HOME'))\n";
        expect(shouldOfferMarkdownConversion(py)).toBe(true);
        expect(pastePromptFor(py)).toEqual({ kind: 'code', lang: 'python' });
    });
    it('Markdown containing a fence -> the Markdown prompt only', () => {
        const md = '#### Run it\n\n* step one\n* step two\n\n```bash\nnpm start --port 3000\n```';
        expect(pastePromptFor(md)).toEqual({ kind: 'markdown' });
    });
    it('plain text -> no prompt', () => {
        for (const [, t] of NEGATIVE.filter(([n]) => n !== 'Markdown answer')) {
            expect(pastePromptFor(t)?.kind === 'code').toBe(false);
        }
        expect(pastePromptFor('I *really* mean it')).toBeNull();
    });
});

describe('bounded work', () => {
    it('a huge single line or many lines stays fast', () => {
        const t0 = performance.now();
        looksLikeCode('   at ' + 'a '.repeat(40_000));
        looksLikeCode('word '.repeat(19_000));
        looksLikeCode('x = 1;\n'.repeat(12_000));
        expect(performance.now() - t0).toBeLessThan(2_500);
    });
});
