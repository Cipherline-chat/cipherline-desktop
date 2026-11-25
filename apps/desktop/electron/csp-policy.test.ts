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

    it('link embeds: media-src/img-src gain clmedia: (main-process streams of registered URLs) and no internet origin', () => {
        const media = directive('media-src').split(/\s+/);
        expect(media).toEqual(["'self'", 'blob:', 'clmedia:']);
        const img = directive('img-src').split(/\s+/);
        expect(img).toContain('clmedia:');
        for (const d of [media, img]) {
            expect(d).not.toContain('*');
            expect(d).not.toContain('https:');
            expect(d).not.toContain('http:');
        }
        // Inline clip playback adds NO third-party frame origin (every clip host plays as a file); the only
        // player frames are YouTube and, phase 4, Twitch + TikTok — each an exact origin, never a wildcard.
        expect(directive('frame-src')).toBe('https://www.youtube-nocookie.com https://clips.twitch.tv https://player.twitch.tv https://www.tiktok.com blob: https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://link.com https://*.link.com https://challenges.cloudflare.com https://cipherline.chat');
    });

    it('clmedia: is declared before ready, streamable, and does NOT bypass CSP or get fetch(); CORS only for the renderer', () => {
        const m = main.match(/protocol\.registerSchemesAsPrivileged\(\[\s*\{ scheme: CLMEDIA_SCHEME, privileges: \{([^}]*)\} \},\s*\]\);/);
        expect(m).not.toBeNull();
        const p = m![1];
        expect(p).toContain('stream: true');
        expect(p).toContain('bypassCSP: false');
        expect(p).toContain('supportFetchAPI: false');
        // CORS-enabled (the sender's frame grab draws a frame onto a canvas), answered
        // only for the app's own renderer origin (media-protocol.ts corsHeaders).
        expect(p).toContain('corsEnabled: true');
        expect(main).toMatch(/allowOrigin: \(origin\) => isTrustedSenderUrl\(`\$\{origin\}\/`, DEV_SERVER_URL, CIPHERLINE_PROD_PORT\)/);
        expect(main.indexOf('protocol.registerSchemesAsPrivileged')).toBeLessThan(main.indexOf('app.whenReady().then('));
        expect(main).toMatch(/protocol\.handle\(CLMEDIA_SCHEME, createClmediaHandler\(mediaRegistry/);
    });
});
