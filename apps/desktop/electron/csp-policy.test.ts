/**
 * R-09: the renderer CSP must not list hosts that serve attacker-controllable
 * content (Google Cloud Storage buckets behind *.googleapis.com and the
 * www.googleapis.com/storage JSON API; user content on *.googleusercontent.com),
 * because connect-src / img-src are the only thing between renderer code and
 * an exfiltration request. Pinned from the source so a future edit that widens
 * it back has to change this test. Drive itself is reached only from the main
 * process (electron/drive-api.ts), so connect-src carries no Google origin.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const start = main.indexOf('  const csp = [');
const end = main.indexOf("].join('; ');", start);
const cspSource = main.slice(start, end);

/** The directive's string literal (comments stripped). */
function directive(name: string): string {
    const m = cspSource.match(new RegExp(`[\`"]${name} ([^\`"]*)[\`"]`));
    expect(m, name).not.toBeNull();
    return m![1];
}

describe('renderer CSP (R-09)', () => {
    it('connect-src: no Google origin at all (Drive runs in the main process)', () => {
        const c = directive('connect-src');
        expect(c).not.toMatch(/google/i);
        expect(c).not.toContain('googleapis.com');
        expect(c).not.toContain('storage.googleapis.com');
        expect(c).not.toContain('tenor.googleapis.com');
        expect(c).not.toContain('accounts.google.com');
    });

    it('img-src: no Google user-content or static wildcards', () => {
        const i = directive('img-src');
        expect(i).not.toMatch(/googleusercontent|gstatic/);
    });

    it('frame-src: no Google sign-in frame (OAuth runs in the system browser)', () => {
        expect(directive('frame-src')).not.toContain('accounts.google.com');
        const auth = fs.readFileSync(path.join(__dirname, 'googleDriveAuth.ts'), 'utf8');
        expect(auth).toContain("new URL('https://accounts.google.com/o/oauth2/v2/auth')");
        expect(auth).toMatch(/shell\.openExternal\(/);
    });

    it('positive control: the renderer sources hold no Google URL to fetch, so the empty allowlist breaks nothing', () => {
        for (const f of ['src/services/driveBackup.ts', 'src/utils/driveFolders.ts']) {
            const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
            expect(code.match(/https:\/\/[a-z0-9.-]*googleapis\.com[^'"`\s]*/g) ?? [], f).toEqual([]);
        }
    });
});
