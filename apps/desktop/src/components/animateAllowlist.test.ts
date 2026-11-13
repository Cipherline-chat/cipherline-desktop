import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Owner rule: a profile picture / banner animates ONLY when hovered, in an opened
 * profile, or while the person is talking in a call. The always-on `animate`
 * prop is therefore allowed on exactly the opened-profile surfaces and the
 * profile-settings preview. Anything else must use hover / `playing` /
 * `speaking`. (ServerIcon is a server's art, not a profile, and is out of scope.)
 */
const SRC = join(__dirname, '..');
const ALLOWED = new Set([
    'components/profile/ProfileFullView.tsx',
    'components/profile/ProfilePopoutCard.tsx',
    'components/settings/panes/ProfilePane.tsx',
    'components/ProfileCardParts.tsx', // forwards a prop; its callers are checked by this same scan
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
    }
    return out;
}

describe('where a profile picture / banner may animate on its own', () => {
    it('only the opened profile and the settings preview pass `animate`', () => {
        const offenders: string[] = [];
        let seen = 0;
        for (const f of walk(SRC)) {
            const rel = relative(SRC, f);
            const src = readFileSync(f, 'utf8');
            const tag = /<(EncryptedAvatar|AuthorHoverAvatar|Banner|ProfileCardBanner)\b((?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?)\/?>/g;
            for (const m of src.matchAll(tag)) {
                if (!/(^|\s)animate(\s|=\{(?!\{)|\/?$)/.test(m[2])) continue;
                seen++;
                if (!ALLOWED.has(rel)) offenders.push(`${rel}: <${m[1]} animate>`);
            }
        }
        expect(seen).toBeGreaterThanOrEqual(5); // positive control: the scan really finds the allowed ones
        expect(offenders).toEqual([]);
    });
});
