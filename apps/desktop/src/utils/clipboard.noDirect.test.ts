import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Ratchet: the packaged app's permission handler denies the renderer's
 * `navigator.clipboard.*` (electron/permission-policy.ts decidePermissionRequest
 * `default: return false`), so a copy button that calls it directly silently does
 * nothing. Every copy goes through utils/clipboard.ts (copyText / writeToClipboard).
 */
const SRC = join(__dirname, '..');

/** Files that may touch navigator.clipboard: the helper, the image path (own tiered fallback), dev harnesses. */
const ALLOWED = new Set([
    'utils/clipboard.ts',
    'utils/copyImage.ts',
    'components/onboarding/dev/OnboardingHarness.tsx',
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p, out); continue; }
        if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
}

/** Strips comments so prose mentioning the API does not trip the check. */
function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no direct navigator.clipboard in the renderer', () => {
    it('only the clipboard helpers call it', () => {
        const offenders = walk(SRC)
            .map(f => relative(SRC, f).split(sep).join('/'))
            .filter(rel => !ALLOWED.has(rel))
            .filter(rel => /navigator\s*\.\s*clipboard/.test(code(readFileSync(join(SRC, rel), 'utf8'))));
        expect(offenders).toEqual([]);
    });
});
