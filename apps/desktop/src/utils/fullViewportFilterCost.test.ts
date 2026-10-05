import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No FULL-VIEWPORT element may carry a backdrop-filter.
 *
 * Measured, not theorised. `.sd-veil` (settings) and `.cl-mod` (every kit
 * modal in the app) both had `position:fixed; inset:0` plus
 * `backdrop-filter: blur(3px)`. On two real Chromium windows:
 *
 *                       1920x1080            3840x2160
 *   floor               16.9 ms / 60fps      16.7 ms / 60fps
 *   with the filter    529.6 ms / 1.9fps   2124.9 ms / 0.5fps
 *
 * 18x, and 4.01x cost for 4.0x the pixels — exactly linear in viewport area,
 * because the element covers the screen and Chromium re-evaluates the filter
 * on EVERY compositor frame rather than when the backdrop changes. So any
 * animation, hover or keystroke anywhere on screen pays a full-screen blur.
 *
 * Two things make this worth guarding as a CLASS rather than by selector:
 *
 *  - Radius is not the knob. blur(1px) through blur(24px) all measured
 *    ~500 ms at 1080p, and even `brightness(.8)` cost 189 ms. Anyone
 *    "optimising" by lowering the radius will save nothing and conclude the
 *    measurement was wrong.
 *  - It is an easy and natural thing to re-add. A full-screen scrim with a
 *    blur behind it is a normal design instinct, it looks good, and it costs
 *    nothing visible on the machine of whoever adds it.
 *
 * A backdrop-filter on a SMALL element is fine and is not flagged — the cost
 * scales with filtered area. This only rejects the full-viewport shape.
 */

const ROOT = join(__dirname, '..');

/** Strip comments so the explanatory prose above (and in the CSS) can never
 *  satisfy or trip an assertion. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule { selector: string; body: string }

function rules(css: string): Rule[] {
    return stripComments(css)
        .split('}')
        .map((chunk) => {
            const i = chunk.indexOf('{');
            if (i === -1) return null;
            return { selector: chunk.slice(0, i).trim(), body: chunk.slice(i + 1) };
        })
        .filter((r): r is Rule => r !== null);
}

const isFullViewport = (body: string) =>
    /position:\s*fixed/.test(body) && /inset:\s*0/.test(body);

const hasBackdropFilter = (body: string) =>
    /(^|[^-\w])(-webkit-)?backdrop-filter\s*:/.test(body) &&
    !/backdrop-filter\s*:\s*none/.test(body);

const SHEETS = ['index.css', 'styles/settings-descent.css'];

describe('no full-viewport element carries a backdrop-filter', () => {
    it('reads the stylesheets (never passes vacuously)', () => {
        for (const sheet of SHEETS) {
            const css = readFileSync(join(ROOT, sheet), 'utf8');
            expect(css.length).toBeGreaterThan(500);
            expect(rules(css).length).toBeGreaterThan(20);
        }
    });

    it.each(SHEETS)('%s has none', (sheet) => {
        const offenders = rules(readFileSync(join(ROOT, sheet), 'utf8'))
            .filter((r) => isFullViewport(r.body) && hasBackdropFilter(r.body))
            .map((r) => r.selector);
        expect(offenders).toEqual([]);
    });

    it('still FINDS a full-viewport filter when one exists', () => {
        // Guards the detector itself: if the matching ever silently stopped
        // working, the two assertions above would pass for the wrong reason.
        const planted = '.x{position:fixed;inset:0;backdrop-filter:blur(3px)}';
        const found = rules(planted).filter(
            (r) => isFullViewport(r.body) && hasBackdropFilter(r.body),
        );
        expect(found.map((r) => r.selector)).toEqual(['.x']);
    });

    it('does NOT flag a backdrop-filter on a small element', () => {
        // The cost scales with filtered area, so these are legitimate and
        // several ship today (buttons, the call console inner surface).
        const small = '.btn{position:absolute;backdrop-filter:blur(6px)}';
        expect(rules(small).filter((r) => isFullViewport(r.body))).toEqual([]);
    });
});
