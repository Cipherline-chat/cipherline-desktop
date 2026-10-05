import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { WEB_FONTS_CSS_URL, loadWebFonts } from './webFonts';

/**
 * Startup-path guards. Each of these was a measured cause of a slow or hung
 * launch; they are cheap to regress silently (one innocent-looking import),
 * so they are pinned here. See the module docs named in each test.
 */
const SRC = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
}
const sources = walk(SRC).map(p => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
/** Static (value) imports of `spec` — type-only imports are erased and don't count. */
const staticImporters = (spec: RegExp) => sources
    .filter(f => f.text.split('\n').some(l => /^\s*import\s+(?!type\b)/.test(l) && spec.test(l)))
    .map(f => f.path);

describe('boot bundle: nothing heavy or blocking on the startup path', () => {
    it('index.css has no remote @import (it blocked first paint AND the app scripts until Google answered) — webFonts.ts', () => {
        const css = read('index.css');
        expect(css).not.toMatch(/@import\s+(url\()?\s*['"]?https?:/i);
    });

    it('the brand fonts are still requested, from script, with the same URL as the non-blocking preload', () => {
        const html = readFileSync(resolve(SRC, '..', 'index.html'), 'utf8');
        expect(html).toContain(`<link rel="preload" as="style" href="${WEB_FONTS_CSS_URL}"`);
        expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+fonts\.googleapis/);
        expect(read('main.tsx')).toMatch(/loadWebFonts\(\)/);
    });

    it('loadWebFonts inserts exactly one stylesheet link (idempotent)', () => {
        const appended: Array<Record<string, string>> = [];
        const head = {
            querySelector: (sel: string) => (sel.includes('data-cl-webfonts') && appended.length ? appended[0] : null),
            appendChild: (el: Record<string, string>) => { appended.push(el); },
        };
        const doc = {
            head,
            createElement: () => {
                const el: Record<string, string> & { setAttribute?: (k: string, v: string) => void } = {};
                el.setAttribute = (k: string, v: string) => { el[k] = v; };
                return el;
            },
        } as unknown as Document;
        loadWebFonts(doc);
        loadWebFonts(doc);
        expect(appended).toHaveLength(1);
        expect(appended[0].rel).toBe('stylesheet');
        expect(appended[0].href).toBe(WEB_FONTS_CSS_URL);
    });

    it('the 4.8 MB RNNoise worklet source is only reachable through the lazy loader — rnnoiseSources.ts', () => {
        const importers = staticImporters(/from\s+['"][./]*(utils\/)?rnnoise(In)?WorkletSource['"]/);
        expect(importers).toEqual([]);
        expect(read('utils/rnnoiseSources.ts')).toMatch(/import\(['"]\.\/rnnoiseInWorkletSource['"]\)/);
    });

    it('emoji-mart and its dataset are only reachable through the lazy picker — emojiPickerLazy.tsx', () => {
        expect(staticImporters(/from\s+['"]\.\.?\/(components\/)?EmojiPicker['"]/)).toEqual([]);
        const direct = staticImporters(/from\s+['"](@emoji-mart\/|emoji-mart)/);
        expect(direct).toEqual(['components/EmojiPicker.tsx']);
    });

    it('reconnecting never hard-reloads the renderer (a full cold start on every wake) — OfflineScreen.tsx', () => {
        const src = read('components/OfflineScreen.tsx').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
        expect(src).not.toMatch(/location\.reload/);
    });
});
