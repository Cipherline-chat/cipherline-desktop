import { describe, it, expect } from 'vitest';

/**
 * Guards the one property of the Descent's stylesheet that a design pass would
 * most plausibly "restore" without knowing what it costs.
 *
 * `.sd-veil` is `position:fixed; inset:0` — a FULL-VIEWPORT element covering the
 * whole app whenever windowed settings are open (any viewport >= 1080x780, i.e.
 * every normal desktop). A `backdrop-filter` there is re-evaluated on every
 * compositor frame, over the whole screen, for as long as the screen is open —
 * so it is paid per frame, not per change, and it scales linearly with pixel
 * count. Measured on Chromium 153 (median of 3 interleaved rounds, mean rAF
 * frame interval, only a 16px transform-only square animating):
 *
 *                              1920x1080    3840x2160
 *     with `backdrop-filter`     529.6 ms     2124.9 ms
 *     without                     28.6 ms      118.2 ms
 *
 * 18x either way, and exactly 4x for 4x the pixels — which is why the original
 * report was "the settings menu is SUPER laggy, especially on high res screens".
 * The blur radius is irrelevant (blur(1px) and blur(24px) measured the same,
 * and even `brightness()` cost 11x the floor): the expense is the full-viewport
 * filter pass itself, so a smaller radius is not a fix. See the long note on
 * `.sd-veil` in settings-descent.css.
 *
 * If a future design genuinely needs frosted glass behind the settings window,
 * it needs a different mechanism, not a smaller radius — hence this test fails
 * loudly rather than tolerating a "cheap" filter.
 */
describe('the Descent veil stays free of per-frame full-viewport filters', () => {
    const readCss = async (rel: string) => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const here = path.dirname(new URL(import.meta.url).pathname);
        return fs.readFile(path.resolve(here, '..', '..', rel), 'utf8');
    };

    /**
     * The declarations of one rule, by selector, with comments stripped first —
     * the file documents the removed property at length in prose, and a naive
     * substring search would match that instead of a real declaration.
     */
    const declarationsFor = (css: string, selector: string): string => {
        const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = bare.split('}');
        const hit = rules.find(r => {
            const head = r.slice(0, r.indexOf('{'));
            return head.split(',').some(s => s.trim() === selector);
        });
        if (hit === undefined) throw new Error(`no rule found for selector ${selector}`);
        return hit.slice(hit.indexOf('{') + 1);
    };

    it('declares no backdrop-filter on .sd-veil', async () => {
        const decls = declarationsFor(await readCss('styles/settings-descent.css'), '.sd-veil');
        // Positive control: this is the right rule, not an empty string that
        // would pass the real assertion for the wrong reason.
        expect(decls).toContain('position:fixed');
        expect(decls).toContain('inset:0');

        expect(decls).not.toMatch(/backdrop-filter/);
    });

    it('declares no backdrop-filter anywhere in the Descent stylesheet', async () => {
        const css = await readCss('styles/settings-descent.css');
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(withoutComments).not.toMatch(/backdrop-filter/);
    });
});
