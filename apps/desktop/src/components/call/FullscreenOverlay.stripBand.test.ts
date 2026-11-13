import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Owner: "in fullscreen the unfocused members don't have a background behind
 * them anymore, its supposed to have them at the bottom and a background — the
 * main screenshare/video needs to be then moved up to fit."
 *
 * Regression: 0484caca made the strip `absolute` over a full-column stage with
 * no background, so thumbnails sat ON the focused picture. The contract pinned
 * here: the STAGE and the STRIP are siblings in a flex column (the stage takes
 * the height the strip leaves), and the strip owns an opaque band background.
 * FullscreenOverlay needs a live LiveKit room to render, so this is a
 * source-level pin, like FullscreenOverlay.emptyStage.test.ts.
 */
const SRC = readFileSync(join(__dirname, 'FullscreenOverlay.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8');

const classNameAfter = (marker: string): string => {
    const at = SRC.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const m = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(SRC.slice(at));
    expect(m).not.toBeNull();
    return (m![1] ?? m![2]) as string;
};

describe('fullscreen focused view — strip band and stage fit', () => {
    // The stage wrapper is the div right before the solo/focus render.
    const stageAt = SRC.indexOf("{(layout.mode === 'solo' || layout.mode === 'focus') && renderStage");
    const stageOpen = SRC.slice(SRC.lastIndexOf('<div', stageAt), stageAt);

    it('the stage stays in normal flow and takes the height the strip leaves (never absolute inset-0)', () => {
        expect(stageOpen).toContain('flex-1 min-h-0');
        expect(stageOpen).not.toContain('absolute');
        expect(stageOpen).not.toContain('inset-0');
    });

    it('the strip is an in-flow, non-shrinking sibling of the stage, not an overlay', () => {
        const cls = classNameAfter('{stripItems.length > 0 && (');
        expect(cls).toContain('shrink-0');
        expect(cls).not.toMatch(/\babsolute\b/);
        expect(cls).not.toContain('pointer-events-none');
    });

    it('the strip owns an opaque background band so it never reads as floating on the picture', () => {
        const cls = classNameAfter('{stripItems.length > 0 && (');
        expect(cls).toMatch(/\bbg-\S+/);
    });

    it('does not lift the stage tile chrome over a floating strip any more (nothing overlaps)', () => {
        expect(SRC).not.toContain('overlayBottomPx');
    });

    it('the strip row paints the band-coloured scroll vignette, not background: none', () => {
        const row = CSS.slice(CSS.indexOf('.cl-fs-strip-row {'), CSS.indexOf('.cl-fs-strip-row::-webkit-scrollbar'));
        expect(row).not.toMatch(/background:\s*none/);
        expect(row).toContain('no-repeat local');
    });

    it('with no strip items the strip is not rendered at all, so the stage reclaims the full height', () => {
        expect(SRC).toContain('{stripItems.length > 0 && (');
    });
});
