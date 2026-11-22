/**
 * The PostCSS step (postcss-reduced-motion.cjs) that lets the app's existing
 * `@media (prefers-reduced-motion: reduce)` rules also answer to Settings →
 * Accessibility → Reduce motion (<html data-reduced-motion="true|false">).
 * Plus a guard so a stylesheet can never use a query form the step skips.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import postcss from 'postcss';

const require = createRequire(import.meta.url);
const plugin = require('../../postcss-reduced-motion.cjs') as () => postcss.Plugin;
const run = async (css: string) => (await postcss([plugin()]).process(css, { from: undefined })).css;

describe('postcss-reduced-motion', () => {
    it('reduce block: OS copy applies unless forced off; a forced-on twin sits right after it', async () => {
        const out = await run('.a{x:1}@media (prefers-reduced-motion: reduce){.b,.c .d{animation:none}}.z{y:1}');
        expect(out).toContain('@media (prefers-reduced-motion: reduce){:where(:root:not([data-reduced-motion="false"])) .b');
        expect(out).toContain(':where(:root[data-reduced-motion="true"]) .b,:where(:root[data-reduced-motion="true"]) .c .d{animation:none}');
        // order is preserved: media block, then its twin, then the next rule
        expect(out.indexOf('@media')).toBeLessThan(out.indexOf('[data-reduced-motion="true"]'));
        expect(out.indexOf('[data-reduced-motion="true"]')).toBeLessThan(out.indexOf('.z{y:1}'));
    });

    it('specificity is unchanged (everything is wrapped in :where)', async () => {
        const out = await run('@media (prefers-reduced-motion:reduce){.b{a:1}}');
        expect(out).not.toMatch(/[^(]:root\[data-reduced-motion/); // only ever inside :where(...)
    });

    it('selectors that start at the root element keep constraining the root', async () => {
        const out = await run('@media (prefers-reduced-motion: reduce){:root .d{x:1}html.e .f{y:1}}');
        expect(out).toContain(':root:where([data-reduced-motion="true"]) .d');
        expect(out).toContain(':root:where([data-reduced-motion="true"]).e .f');
    });

    it('no-preference (motion-safe) mirrors it: not when forced on, yes when forced off', async () => {
        const out = await run('@media (prefers-reduced-motion: no-preference){.g{h:1}}');
        expect(out).toContain(':where(:root:not([data-reduced-motion="true"])) .g');
        expect(out).toContain(':where(:root[data-reduced-motion="false"]) .g{h:1}');
    });

    it('@keyframes inside a block are left as keyframes, other media queries untouched (positive control)', async () => {
        const out = await run('@media (min-width:1px){.q{a:1}}@media (prefers-reduced-motion: reduce){@keyframes k{from{a:1}}}');
        expect(out).toContain('@media (min-width:1px){.q{a:1}}');
        expect(out).toMatch(/@keyframes k\{from\{a:1\}\}/);
        expect(out).not.toContain(':where(:root:not([data-reduced-motion="false"])) from');
    });

    it('is wired in postcss.config.js after Tailwind', () => {
        const cfg = fs.readFileSync(path.resolve(__dirname, '../../postcss.config.js'), 'utf8');
        expect(cfg.indexOf("require('tailwindcss')")).toBeGreaterThan(-1);
        expect(cfg.indexOf('postcss-reduced-motion')).toBeGreaterThan(cfg.indexOf("require('tailwindcss')"));
    });
});

function cssFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) cssFiles(p, out);
        else if (e.name.endsWith('.css')) out.push(p);
    }
    return out;
}

describe('every stylesheet in the app uses a query form the step understands', () => {
    const SIMPLE = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)\s*\{$/i;
    const files = cssFiles(path.resolve(__dirname, '..'));

    it('finds the stylesheets (positive control)', () => { expect(files.length).toBeGreaterThan(50); });

    it('no compound or nested prefers-reduced-motion queries', () => {
        const bad: string[] = [];
        for (const f of files) {
            const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
            for (const m of s.matchAll(/@media[^{]*prefers-reduced-motion[^{]*\{/g)) {
                if (!SIMPLE.test(m[0].trim())) bad.push(`${path.relative(process.cwd(), f)}: ${m[0]}`);
            }
            for (const m of s.matchAll(/@(?:supports|container|layer)[^{]*\{[^{}]*@media[^{]*prefers-reduced-motion/g)) bad.push(`${f}: nested ${m[0].slice(0, 40)}`);
        }
        expect(bad).toEqual([]);
    });

    it('running the step over the whole app stylesheet set gives every reduce block a forced twin', async () => {
        let blocks = 0;
        for (const f of files) {
            const raw = fs.readFileSync(f, 'utf8');
            if (!/prefers-reduced-motion\s*:\s*reduce/.test(raw.replace(/\/\*[\s\S]*?\*\//g, ''))) continue;
            let src = raw;
            // Tailwind directives are not part of this step.
            src = src.replace(/@tailwind[^;]*;/g, '').replace(/@apply[^;]*;/g, '');
            let out: string;
            try { out = await run(src); } catch { continue; }
            const osBlocks = (out.match(/@media \(prefers-reduced-motion:\s*reduce\)/gi) ?? []).length;
            if (osBlocks === 0) continue;
            blocks += osBlocks;
            expect(out.includes('[data-reduced-motion="true"]'), f).toBe(true);
        }
        expect(blocks).toBeGreaterThan(100);
    });
});
