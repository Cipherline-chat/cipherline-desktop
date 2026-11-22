import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Square corners behind the rounded panes (owner 2026-11-20, Dark: "the bottom
 * side of the channel list and the context panel").
 *
 * A pane's shadow is cast by its outer box (.app-pane2/3/4, .app-pane-solo).
 * Every one of those sits flush against a box that clips (overflow) — the
 * content column, the panels row, the list+chat grid, the chat's column/row —
 * so a plain `overflow: hidden` there cuts the shadow off along the pane's
 * own edges. The shadow then still paints in the small gap between each
 * rounded corner and that cut, and nowhere beyond it: a square of shadow
 * behind the corner. Those boxes now clip with a margin (overflow: clip +
 * overflow-clip-margin), so a pane's shadow fades out naturally and only the
 * window edge (.app-mainrow) cuts it.
 *
 * Pixel proof: harness/panel-corners-probe.mjs. These tests keep the wiring.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const drift = read('styles/layout-drift.css').replace(/\/\*[\s\S]*?\*\//g, '');
const dash = read('components/Dashboard.tsx');

const CLIP_BOXES = ['app-contentcol', 'app-contentrow', 'app-callgroup', 'app-pane3-col', 'app-pane3-row'];

/** The declarations of the drift rule whose selector list names `cls`. */
const ruleFor = (cls: string): string => {
    const re = /([^{}]+)\{([^}]*)\}/g;
    for (let m = re.exec(drift); m; m = re.exec(drift)) {
        if (m[1].split(',').some((s) => s.trim() === `[data-layout="drift"] .${cls}`)) return m[2];
    }
    return '';
};

describe('drift layout: no clip box cuts a pane shadow at the pane edge', () => {
    it.each(CLIP_BOXES)('Dashboard renders the .%s box', (cls) => {
        expect(dash).toMatch(new RegExp(`className="${cls}"`));
    });

    it('the classes sit on the boxes they are named after', () => {
        // content column: the banner column (FirewallOverlay / ClBanner find it by attribute)
        expect(dash).toMatch(/<div data-banner-column="" ref=\{contentColumnRef\} className="app-contentcol"/);
        // panels row, chat column, chat row: still the same inline overflow:hidden boxes
        expect(dash).toMatch(/<div className="app-contentrow" style=\{\{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' \}\}>/);
        expect(dash).toMatch(/<div className="app-pane3-col" style=\{\{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden', gridColumn: 3, gridRow: 2 \}\}>/);
        expect(dash).toMatch(/<div className="app-pane3-row" style=\{\{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' \}\}>[\s\S]{0,400}className="app-pane3"/);
    });

    it.each(CLIP_BOXES)('.%s clips with a margin, overriding its inline overflow:hidden', (cls) => {
        const body = ruleFor(cls);
        expect(body).toMatch(/overflow:\s*clip\s*!important/);
        // the margin reaches the window edge: .app-mainrow's right / bottom padding
        const margin = Number(body.match(/overflow-clip-margin:\s*(\d+)px/)?.[1]);
        const pad = drift.match(/\.app-mainrow \{[^}]*padding:\s*(\d+)px (\d+)px (\d+)px (\d+)px/)!;
        expect(margin).toBeGreaterThanOrEqual(Math.max(Number(pad[2]), Number(pad[3])));
        // not a scroll container any more: flex/grid min size must stay 0 explicitly
        expect(body).toMatch(/min-width:\s*0/);
        expect(body).toMatch(/min-height:\s*0/);
    });

    it('the panes still cast their shadow from the outer box, never the sheet', () => {
        expect(drift).toMatch(/\.app-pane2 \{[^}]*box-shadow:\s*var\(--cl-elev-3\)/);
        expect(drift).toMatch(/\.app-pane2-sheet \{[^}]*box-shadow:\s*none !important/);
        expect(drift).toMatch(/\.app-pane3-sheet \{[^}]*box-shadow:\s*none/);
        expect(drift).toMatch(/\.app-pane4 \{[^}]*border-radius:\s*18px !important;[^}]*box-shadow:\s*var\(--cl-shadow-panel\)/);
        expect(drift).toMatch(/\.app-pane-solo \{[^}]*border-radius:\s*18px;[^}]*box-shadow:\s*var\(--cl-shadow-panel\)/);
    });
});
