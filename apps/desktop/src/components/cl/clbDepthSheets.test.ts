/**
 * Guards for ClButton's depth sheets following the CAP rather than the `.clb`
 * wrapper (cl-kit-ext.css). Source scans: there is no component-test setup that
 * lays out real CSS; the layout itself was measured in Chromium (worklog
 * 2026-11-23-sticker-picker-icons-add-button).
 *
 * The bug: Server Settings > Stickers stacks "Add" over a wider "Cancel" in a
 * flex column. The column stretched Add's `.clb` to Cancel's width (78.8 px)
 * while its cap stayed 62.6 px, and the l1/l2 sheets (absolute, inset:0 of
 * `.clb`) filled the stretched box: a second, darker teal slab beside the cap.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', '..', 'styles', 'cl-kit-ext.css'), 'utf8');
const scoped = css.slice(css.indexOf('@scope (.cl-kit)'));

const GRID = '.clb{display:inline-grid;grid-template:minmax(min-content,auto)/minmax(min-content,auto);justify-content:start;align-content:start}';
const PLACE = '.clb>.l,.clb>.cap{grid-area:1/1/2/2}';

describe('ClButton depth sheets follow the cap', () => {
    it('makes .clb a one-cell grid that never grows its own track (scoped rule)', () => {
        expect(scoped).toContain(GRID);
    });

    it('places sheets and cap in that cell with EXPLICIT end lines', () => {
        // `grid-area:1/1` leaves the end lines auto, and an abspos child with an
        // auto end line resolves to the padding edge = the stretched box again.
        expect(scoped).toContain(PLACE);
        expect(css).not.toMatch(/\.clb>\.l,\.clb>\.cap\{grid-area:1\/1\}/);
    });

    it('floors the tracks at min-content so tight rows do not start shrinking buttons', () => {
        // A bare `auto` track lets the overflow:hidden cap shrink to 0 as a grid
        // item; "Upload stickers" went 164 -> 101 px wide until this floor.
        expect(GRID).toContain('minmax(min-content,auto)');
        expect(css).not.toContain('.clb{display:inline-grid;grid-template:auto/auto');
    });

    it('has a global twin (Chromium @scope fallback) AFTER the global .clb base rule', () => {
        const scopeEnd = css.indexOf('/* ── Button — global fallback');
        expect(scopeEnd).toBeGreaterThan(0);
        const globalPart = css.slice(scopeEnd);
        const base = globalPart.indexOf('.clb{position:relative;display:inline-block;');
        const twin = globalPart.indexOf(GRID);
        expect(base).toBeGreaterThanOrEqual(0);
        expect(twin).toBeGreaterThan(base);
        expect(globalPart).toContain(PLACE);
    });

    it('leaves full-width buttons as block (their cap is already 100% wide)', () => {
        expect(scoped).toContain('.clb.w-full{display:block;width:100%;min-width:0}');
        // Two classes outrank the one-class grid rule, in both copies.
        expect(css.split('.clb.w-full{display:block').length - 1).toBe(2);
    });
});
