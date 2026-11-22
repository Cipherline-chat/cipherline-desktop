/**
 * Hard-coded colour RATCHET (plan: "Literal regression"). The theme sweep
 * (slices T2+) replaces literal colours with theme tokens; this test makes sure
 * it only moves forward:
 *
 *   - color-literal-baseline.json records, per file, how many colour literals
 *     (`#hex`, `rgb()/rgba()/hsl()/hsla()` not built on `var()`) it has today;
 *   - a file whose count goes UP fails, and so does a new file with any;
 *   - a file whose count goes DOWN passes — lower its number in the baseline in
 *     the same commit (UPDATE_COLOR_BASELINE=1 npx vitest run src/theme/colorLiteralRatchet.test.ts
 *     rewrites the whole file; review the diff: it must only go down).
 *
 * A literal that must stay (brand colours, decorative art, dark islands) is
 * simply part of its file's count. Token definitions themselves
 * (src/theme/themes.ts, electron/theme-boot.ts, the custom-theme data + derivation in
 * src/theme/customTheme.ts / customPresets.ts, index.css's :root mirror) are not counted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DESKTOP = resolve(__dirname, '..', '..');
const BASELINE_PATH = join(__dirname, 'color-literal-baseline.json');
const ROOTS = ['src', 'electron'];
// customTheme.ts / customPresets.ts are theme DATA and its derivation (the
// custom-theme counterpart of themes.ts): token definitions, not uses.
const EXEMPT = new Set(['src/theme/themes.ts', 'electron/theme-boot.ts', 'src/theme/customTheme.ts', 'src/theme/customPresets.ts']);

const HEX = /(?<![\w&$-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNC = /\b(?:rgba?|hsla?)\(\s*(?!var\()/g;

/** Colour literals in a source text (comments included: a commented-out colour still shows intent to hard-code). */
export function countColorLiterals(text: string): number {
    return (text.match(HEX)?.length ?? 0) + (text.match(FUNC)?.length ?? 0);
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
    }
    return out;
}

function scan(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const root of ROOTS) {
        for (const f of walk(join(DESKTOP, root)).sort()) {
            const rel = f.slice(DESKTOP.length + 1).split('\\').join('/');
            if (EXEMPT.has(rel)) continue;
            let text = readFileSync(f, 'utf8');
            // index.css's first :root block is the static token mirror (pinned to
            // the theme data by themeTokens.test.ts): token definitions, not uses.
            if (rel === 'src/index.css') {
                const start = text.search(/(^|\n):root\s*\{/);
                text = text.slice(0, start) + text.slice(text.indexOf('}', start) + 1);
            }
            const n = countColorLiterals(text);
            if (n > 0) out[rel] = n;
        }
    }
    return out;
}

describe('colour literal ratchet', () => {
    it('the counter sees hex and functional colours, not var()-based ones or entities', () => {
        expect(countColorLiterals('color:#fff;background:#0B0F1E;border-color:#0b0f1e80')).toBe(3);
        expect(countColorLiterals('rgba(0,0,0,.5) rgb(var(--cl-deep-rgb) / .2) hsl(200 50% 50%)')).toBe(2);
        expect(countColorLiterals('&#123; issue-#12 a#fff $#abc var(--cl-lume)')).toBe(0);
    });

    it('no file has MORE colour literals than its baseline, and no new file adds any', () => {
        const now = scan();
        if (process.env.UPDATE_COLOR_BASELINE === '1') {
            writeFileSync(BASELINE_PATH, JSON.stringify(now, null, 1) + '\n');
            return;
        }
        const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;
        const worse = Object.entries(now)
            .filter(([f, n]) => n > (base[f] ?? 0))
            .map(([f, n]) => `${f}: ${base[f] ?? 0} -> ${n}`);
        expect(worse, 'new hard-coded colours: use a theme token (var(--cl-*), a Tailwind cl-* class, or themeColor())').toEqual([]);
    });

    it('positive control: one added literal in a clean file is caught', () => {
        const base: Record<string, number> = { 'src/a.css': 2 };
        const now: Record<string, number> = { 'src/a.css': 2, 'src/clean.tsx': countColorLiterals("style={{ color: '#ff0000' }}") };
        const worse = Object.entries(now).filter(([f, n]) => n > (base[f] ?? 0)).map(([f]) => f);
        expect(worse).toEqual(['src/clean.tsx']);
    });
});
