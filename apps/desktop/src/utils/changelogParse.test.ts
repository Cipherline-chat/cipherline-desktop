import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countItems, flattenInline, parseChangelog, MAX_ITEMS, MAX_ITEM_CHARS } from './changelogParse';

const doc = (body: string) => `# Changelog\n\n${body}`;

describe('parseChangelog', () => {
    it('reads the What\'s new bullets of a release, with its date', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- First thing.\n- Second thing.\n\n### Changes\n\n- Not this.\n`));
        expect(Object.keys(d.releases)).toEqual(['1.2.3']);
        const r = d.releases['1.2.3'];
        expect(r.date).toBe('2026-10-14');
        expect(r.groups).toEqual([{ title: null, items: [{ title: null, text: 'First thing.' }, { title: null, text: 'Second thing.' }] }]);
        expect(countItems(r)).toBe(2);
    });

    it('splits a bold lead into the item title', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- **Calls.** Moving someone is not a kick.\n- **Only a lead.**\n`));
        const items = d.releases['1.2.3'].groups[0].items;
        expect(items[0]).toEqual({ title: 'Calls', text: 'Moving someone is not a kick.' });
        // a bullet that is only bold has nothing after the lead: it is the text, not a heading
        expect(items[1]).toEqual({ title: null, text: 'Only a lead.' });
    });

    it('supports #### group headings and a bullet before any heading', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- Loose.\n\n#### Calls\n- In calls.\n\n#### Chat\n- In chat.\n`));
        const g = d.releases['1.2.3'].groups;
        expect(g.map(x => x.title)).toEqual([null, 'Calls', 'Chat']);
        expect(g[1].items[0].text).toBe('In calls.');
    });

    it('joins a wrapped bullet', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- A long thing that\n  wraps onto the next line\n  and again.\n- Next.\n`));
        expect(d.releases['1.2.3'].groups[0].items[0].text).toBe('A long thing that wraps onto the next line and again.');
    });

    it('flattens inline markdown to plain text', () => {
        expect(flattenInline('Press `?` for **all** the [shortcuts](https://x.test) and *more* and _more_.')).toBe('Press ? for all the shortcuts and more and more.');
        expect(flattenInline('snake_case_name stays')).toBe('snake_case_name stays');
        expect(flattenInline('2 * 3 * 4')).toBe('2 * 3 * 4');
    });

    it('never produces HTML: markup in a bullet stays literal text', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- <b>bold</b> <img src=x onerror=alert(1)>\n`));
        expect(d.releases['1.2.3'].groups[0].items[0].text).toBe('<b>bold</b> <img src=x onerror=alert(1)>');
    });

    it('accepts a curly apostrophe and any case in the heading', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What’s New\n\n- Yes.\n`));
        expect(countItems(d.releases['1.2.3'])).toBe(1);
    });

    it('keys pre-releases by their exact version and keeps releases apart', () => {
        const d = parseChangelog(doc(`## [1.2.4-staging.7] - 2026-10-19\n\n### What's new\n\n- Staging only.\n\n## [1.2.3] - 2026-10-14\n\n### What's new\n\n- Stable.\n`));
        expect(Object.keys(d.releases).sort()).toEqual(['1.2.3', '1.2.4-staging.7']);
        expect(d.releases['1.2.4-staging.7'].groups[0].items[0].text).toBe('Staging only.');
        expect(d.releases['1.2.3'].groups[0].items[0].text).toBe('Stable.');
    });

    it('returns Unreleased separately', () => {
        const d = parseChangelog(doc(`## [Unreleased]\n\n### What's new\n\n- Draft.\n\n## [1.2.3] - 2026-10-14\n\n### What's new\n\n- Done.\n`));
        expect(d.unreleased?.groups[0].items[0].text).toBe('Draft.');
        expect(d.unreleased?.date).toBeNull();
        expect(d.releases['Unreleased']).toBeUndefined();
    });

    it('skips releases with no What\'s new, or an empty one', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### Changes\n\n- Only changes.\n\n## [1.2.2] - 2026-10-01\n\n### What's new\n\nJust prose, no bullets.\n\n### Changes\n\n- x\n`));
        expect(d.releases).toEqual({});
        expect(d.unreleased).toBeNull();
    });

    it('stops at the next ### heading and does not read other subsections', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- In.\n\n### Security\n\n- GHSA-xxxx-xxxx-xxxx\n`));
        expect(d.releases['1.2.3'].groups[0].items.map(i => i.text)).toEqual(['In.']);
    });

    it('caps the number and length of items', () => {
        const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => `- Item ${i}.`).join('\n');
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n${many}\n- ${'x'.repeat(MAX_ITEM_CHARS * 2)}\n`));
        expect(countItems(d.releases['1.2.3'])).toBe(MAX_ITEMS);
        const long = parseChangelog(doc(`## [1.2.3] - 2026-10-14\n\n### What's new\n\n- ${'x'.repeat(MAX_ITEM_CHARS * 2)}\n`));
        expect(long.releases['1.2.3'].groups[0].items[0].text.length).toBe(MAX_ITEM_CHARS);
    });

    it('handles CRLF and never throws on junk', () => {
        const d = parseChangelog(doc(`## [1.2.3] - 2026-10-14\r\n\r\n### What's new\r\n\r\n- Windows line endings.\r\n`));
        expect(d.releases['1.2.3'].groups[0].items[0].text).toBe('Windows line endings.');
        expect(parseChangelog('')).toEqual({ releases: {}, unreleased: null });
        expect(parseChangelog(undefined as unknown as string)).toEqual({ releases: {}, unreleased: null });
        expect(() => parseChangelog('## [x\n### What\'s new\n- ')).not.toThrow();
    });

    it('ignores a heading that is not a version', () => {
        const d = parseChangelog(doc(`## [v1.2.3] - 2026-10-14\n\n### What's new\n\n- Nope.\n`));
        expect(d.releases).toEqual({});
    });
});

describe('the real CHANGELOG.md', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
    const d = parseChangelog(text);

    it('parses, and the newest release carries What\'s new notes', () => {
        // [Unreleased] may be empty right after a release; the newest numbered release must always have notes.
        const versions = Object.keys(d.releases);
        expect(versions.length).toBeGreaterThan(0);
        const latest = d.releases[versions[0]];
        expect(countItems(latest)).toBeGreaterThan(0);
    });

    it('every release that has notes has well-formed, short items', () => {
        for (const r of [...Object.values(d.releases), ...(d.unreleased ? [d.unreleased] : [])]) {
            for (const g of r.groups) for (const i of g.items) {
                expect(i.text.length, i.text).toBeGreaterThan(0);
                expect(i.text.length, i.text).toBeLessThanOrEqual(MAX_ITEM_CHARS);
                expect(i.text, i.text).not.toMatch(/TODO|FIXME/);
            }
        }
    });
});
