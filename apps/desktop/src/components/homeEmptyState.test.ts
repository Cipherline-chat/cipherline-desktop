import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Home deck's empty states ("While you were away" with nothing missed,
 * "Friends" with nobody online). Source-level, like the other home wiring
 * tests: the tile owns its space, and its only loop obeys every motion gate.
 */
const panel = readFileSync(join(__dirname, 'HomePanel.tsx'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'styles', 'home-deck.css'), 'utf8');

describe('Home empty states', () => {
    it('both sparse tiles use the one HomeEmpty treatment (no hand-rolled .hd-clear left)', () => {
        expect(panel).toContain('glyph="check"');
        expect(panel).toContain('glyph="moon"');
        expect(panel).toContain('glyph="person"');
        // `.hd-clear` with a <strong> title stays: onboarding's ending scene traces it (onboarding/ending/buildOut.ts).
        expect((panel.match(/className="hd-clear"/g) ?? []).length).toBe(1);
        expect(panel).toMatch(/<div className="hd-clear">[\s\S]*?<strong>\{title\}<\/strong>/);
    });

    it('an empty tile centres its content in the tile instead of floating under the header', () => {
        expect(css).toMatch(/\.hd-tile:has\(> \.hd-clear\) \{ display: flex; flex-direction: column; \}/);
        expect(css).toMatch(/\.hd-clear \{[^}]*flex: 1 1 auto;[^}]*justify-content: center;/);
    });

    it('the bob is decoration: behind the ambience switch, stopped by reduced motion, idle and occlusion', () => {
        expect(css).toMatch(/\.hd-host\[data-ambient="on"\] \.hd-clear-buoy \{ animation: hd-buoy/);
        expect(css).not.toMatch(/^\.hd-clear-buoy \{[^}]*animation/m);
        const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(reduced).toMatch(/\.hd-host\[data-ambient="on"\] \.hd-clear-buoy \{ animation: none; \}/);
        expect(css).toMatch(/:root\[data-cl-motion="idle"\] \.hd-host\[data-ambient="on"\] \.hd-clear-buoy \{ animation: none; \}/);
        expect(css).toMatch(/:root\[data-cl-occluded="on"\] \.hd-host\[data-ambient="on"\] \.hd-clear-buoy:not\(\.sd-root \*\) \{ animation: none; \}/);
    });

    it('the check draw is a one-shot (never infinite) and stays OUT of the idle gate (its end frame is its resting look)', () => {
        expect(css).toMatch(/\.hd-clear-check \{[^}]*animation: hd-check-draw [^;]*both;/);
        expect(css).not.toMatch(/hd-check-draw[^;]*infinite/);
        expect(css).not.toMatch(/data-cl-motion="idle"\][^{]*\.hd-clear-check/);
    });

    it('the art animates only transform and stroke-dashoffset', () => {
        for (const name of ['hd-buoy', 'hd-check-draw']) {
            const body = css.slice(css.indexOf(`@keyframes ${name}`)).split(/\n/)[0];
            const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
            expect(props.length).toBeGreaterThan(0);
            for (const p of props) expect(['transform', 'stroke-dashoffset']).toContain(p);
        }
    });
});
