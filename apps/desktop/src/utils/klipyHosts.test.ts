import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KLIPY_ALLOWED_HOSTS, KLIPY_API_HOST, KLIPY_MEDIA_HOSTS } from '@cipherline/shared';

/**
 * Which KLIPY hosts this client may ever contact is a privacy decision: each
 * one learns the user's IP address. The allowlist is KLIPY's documented API
 * host plus its three media hosts (packages/shared/klipy.ts), and these tests
 * keep every other place that names a host in line with it:
 *
 *   1. the renderer CSP in electron/main.ts allows EXACTLY those hosts, in the
 *      right directives (API → connect-src, media → img-src), nothing broader;
 *   2. no source file names any other KLIPY host. A new one appearing — a
 *      wildcard, the marketing apex, a new CDN — fails the build until
 *      someone deliberately widens the allowlist.
 */

const DESKTOP = join(__dirname, '..', '..');
const REPO = join(DESKTOP, '..', '..');
const MAIN_TS = readFileSync(join(DESKTOP, 'electron', 'main.ts'), 'utf8');

function cspDirective(name: string): string {
    const m = MAIN_TS.match(new RegExp('[`"]' + name + " [^`\"]*[`\"]"));
    if (!m) throw new Error(`no ${name} directive found in electron/main.ts`);
    return m[0];
}
function constValue(name: string): string {
    const m = MAIN_TS.match(new RegExp(`const ${name} = '([^']*)'`));
    if (!m) throw new Error(`no ${name} in electron/main.ts`);
    return m[1];
}

describe('renderer CSP — KLIPY hosts', () => {
    const connect = constValue('KLIPY_CSP_CONNECT');
    const img = constValue('KLIPY_CSP_IMG');

    it('connect-src gets the API host only; img-src gets the three media hosts only', () => {
        expect(connect.split(' ')).toEqual([`https://${KLIPY_API_HOST}`]);
        expect(img.split(' ').sort()).toEqual(KLIPY_MEDIA_HOSTS.map(h => `https://${h}`).sort());
    });

    it('each list is interpolated into the right directive and no other', () => {
        expect(cspDirective('connect-src')).toContain('${KLIPY_CSP_CONNECT}');
        expect(cspDirective('connect-src')).not.toContain('${KLIPY_CSP_IMG}');
        expect(cspDirective('img-src')).toContain('${KLIPY_CSP_IMG}');
        expect(cspDirective('img-src')).not.toContain('${KLIPY_CSP_CONNECT}');
        // GIF/WebP render in <img>; nothing KLIPY belongs in media/script/frame.
        for (const d of ['media-src', 'script-src', 'frame-src', 'default-src']) {
            expect(cspDirective(d)).not.toMatch(/klipy/i);
        }
    });

    it('no wildcard or http: KLIPY source anywhere in the policy', () => {
        expect(MAIN_TS).not.toMatch(/\*\.klipy\.com/i);
        expect(MAIN_TS).not.toMatch(/http:\/\/[a-z0-9.-]*klipy/i);
    });
});

describe('no KLIPY host outside the allowlist appears in source', () => {
    const ROOTS = [
        join(DESKTOP, 'src'),
        join(DESKTOP, 'electron'),
        join(DESKTOP, 'index.html'),
        join(REPO, 'packages', 'shared'),
        join(REPO, 'apps', 'website', 'src'),
    ];
    const EXT = /\.(ts|tsx|js|mjs|cjs|html|css|json)$/;
    const SKIP_DIR = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'release']);

    function* walk(p: string): Generator<string> {
        let st;
        try { st = statSync(p); } catch { return; }
        if (st.isFile()) { yield p; return; }
        for (const name of readdirSync(p)) {
            if (SKIP_DIR.has(name)) continue;
            yield* walk(join(p, name));
        }
    }

    it('every *klipy.com host named in non-test source is on the allowlist', () => {
        const allowed = new Set(KLIPY_ALLOWED_HOSTS);
        const offenders: string[] = [];
        let scanned = 0;
        for (const root of ROOTS) {
            for (const file of walk(root)) {
                if (!EXT.test(file) || /\.test\.tsx?$/.test(file)) continue;
                scanned++;
                const text = readFileSync(file, 'utf8');
                // Any hostname ending in klipy.com (with or without subdomain,
                // with anything appended), case-insensitive.
                for (const m of text.matchAll(/[a-z0-9*.-]*klipy\.com[a-z0-9.-]*/gi)) {
                    const host = m[0].toLowerCase().replace(/\.$/, '');
                    if (!allowed.has(host)) offenders.push(`${relative(REPO, file)}: ${m[0]}`);
                }
            }
        }
        expect(scanned).toBeGreaterThan(100);   // the walk really covered the tree
        expect(offenders).toEqual([]);
    });

    it('positive control: the scanner flags a look-alike', () => {
        const hits = [...'x https://static.klipy.com.evil.net/a y'.matchAll(/[a-z0-9*.-]*klipy\.com[a-z0-9.-]*/gi)]
            .map(m => m[0]).filter(h => !new Set(KLIPY_ALLOWED_HOSTS).has(h));
        expect(hits).toEqual(['static.klipy.com.evil.net']);
    });
});
