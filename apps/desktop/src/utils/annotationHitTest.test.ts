/**
 * The annotation canvas has to WIN the tile's pointer hit-test, and whether it
 * does is decided by CSS stacking, which no unit test in jsdom can evaluate —
 * jsdom has no layout, no paint order and no elementFromPoint worth the name.
 * So this file locks the structural rule that the browser's answer depends on,
 * the same way annotationOverlayContract.test.ts locks the wire format.
 *
 * ── The bug this exists for ────────────────────────────────────────────────
 *
 * VideoTile lays a full-bleed `absolute inset-0 z-10` div over every tile to
 * catch right-clicks; clicks on it bubble to the wrapper's onClick, which is
 * `callCtx.toggleFocusedStream(...)`. The annotation canvas therefore has to
 * sit ABOVE that div (z-11) whenever the local user may draw, and below it
 * (z-2) otherwise — AnnotationOverlay's own `canDraw ? z-[11] : z-[2]`.
 *
 * In the FOCUSED view the canvas does not carry that z-index itself: it shares
 * a zoom/pan transform layer with the <video> (strokes are normalized to the
 * frame, so the two must scale together), and that layer sits inside a clip
 * window that rounds the letterboxed picture's corners. The transform opens a
 * stacking context, so the GROUP's z-index is what competes with the z-10
 * catcher — and the group's z-index has to live on the OUTERMOST element of
 * the group, because `clip-path: <anything but none>` ALSO opens a stacking
 * context (CSS Masking Level 1). With the z-index one level in, under the
 * clip, it was sealed inside that context and compared against nothing
 * outside: the whole group hit-tested below the catcher, every pointerdown
 * aimed at the canvas landed on the catcher instead, and the tile un-focused
 * itself. No stroke was created locally, so nothing was published and no peer
 * saw anything either — one defect, both of "I can't draw on a focused video"
 * and "nobody can see anyone's annotations".
 *
 * Confirmed in Chromium over this exact nesting (elementFromPoint at the
 * tile's centre):
 *
 *   clip-path on the wrapper, z-index on the inner layer -> the z-10 catcher
 *   clip-path AND z-index on the wrapper                 -> the canvas
 *   no clip-path, z-index on the inner layer             -> the canvas
 *
 * The third row is why grid tiles — which clip the <video> element itself and
 * have no wrapper — were never affected, and why the bug read as "only when
 * it's focused".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), 'utf8');
/** Comments discuss the properties by name; match on code only. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const tile = code(read('../components/call/VideoTile.tsx'));
const overlay = code(read('../components/call/AnnotationOverlay.tsx'));

/**
 * The CSS properties that make an element a stacking context on their own,
 * regardless of `position` or `z-index`. Not exhaustive — these are the ones
 * this tile's layers actually use or plausibly could.
 *
 * `clip-path` is the one that caused the outage and the one everybody forgets;
 * it is listed beside its neighbours so the next person adding a visual effect
 * to a layer above the canvas has somewhere to check.
 */
const SELF_STACKING = [
    'transform', 'clipPath', 'filter', 'backdropFilter',
    'mixBlendMode', 'isolation', 'contain', 'willChange', 'perspective',
] as const;

/** Every `<div ...>` opening tag in `src`, as raw text. Divs only: the rule is
 *  about WRAPPERS around the annotation canvas. `clip-path` on the <video>
 *  element itself (what grid tiles do) is deliberately safe — the canvas is
 *  that element's SIBLING, not its descendant, so no context it opens can seal
 *  the canvas's z-index in. */
const divTags = (src: string): string[] => [...src.matchAll(/<div\b[\s\S]*?>/g)].map(m => m[0]);
const styleOf = (tag: string): string => /style=\{\{([\s\S]*?)\}\}/.exec(tag)?.[1] ?? '';

/** The one `<div>` wrapper that carries the focused view's rounded clip. */
function clipWindowTag(src: string): string {
    const hits = divTags(src).filter(t => /clipPath:\s*fitClipPath/.test(t));
    expect(hits.length, 'no <div> wrapper carries fitClipPath any more — re-derive this rule').toBe(1);
    return hits[0];
}

describe('the annotation canvas wins the focused tile\'s hit test', () => {
    it('the tile still has the z-10 hit surface this rule is about', () => {
        // Positive control for the whole file: if the catcher ever goes away,
        // these assertions are vacuous and should be re-derived, not trusted.
        expect(tile, 'VideoTile no longer lays a z-10 hit surface over the tile')
            .toMatch(/absolute inset-0 z-10/);
    });

    it('the group z-index is named once and mirrors the canvas rule', () => {
        const m = /const annotLayerZ = annotCanDraw \? (\d+) : (\d+);/.exec(tile);
        expect(m, 'VideoTile no longer derives annotLayerZ from annotCanDraw').not.toBeNull();
        const [above, below] = [Number(m![1]), Number(m![2])];
        // The canvas's own rule, for the tiles that are not wrapped.
        const c = /canDraw \? 'z-\[(\d+)\]' : 'z-\[(\d+)\]'/.exec(overlay);
        expect(c, 'AnnotationOverlay no longer picks its own z-index from canDraw').not.toBeNull();
        expect([above, below], 'VideoTile and AnnotationOverlay disagree about the annotation z-index')
            .toEqual([Number(c![1]), Number(c![2])]);
        // ...and the drawable one must actually clear the catcher.
        expect(above, 'the drawable annotation layer no longer sits above the z-10 hit surface').toBeGreaterThan(10);
        expect(below, 'the passive annotation layer no longer sits below the z-10 hit surface').toBeLessThan(10);
    });

    it('carries the z-index on the clip window, not under it', () => {
        // THE REGRESSION. `clip-path` opens a stacking context, so a z-index
        // applied below it cannot compete with the z-10 catcher above.
        expect(styleOf(clipWindowTag(tile)), 'the focused view\'s clip window carries clipPath but not annotLayerZ — the z-index is sealed inside the stacking context clip-path opens, and the tile un-focuses instead of drawing')
            .toMatch(/zIndex:\s*annotLayerZ/);
    });

    it('does not put a competing z-index on the transformed layer inside it', () => {
        // Two z-indexes on nested layers is how the previous version read as
        // correct while being inert. The inner layer opens its own stacking
        // context via `transform` regardless; a z-index there only hides which
        // one is load-bearing.
        const zoomLayer = divTags(tile).filter(t => /ref=\{zoomLayerRef\}/.test(t));
        expect(zoomLayer.length, 'the zoom/pan layer moved or was removed').toBe(1);
        expect(styleOf(zoomLayer[0]), 'the transformed zoom/pan layer carries its own z-index again')
            .not.toMatch(/zIndex/);
    });

    it('no element between the catcher and the canvas self-stacks without the z-index', () => {
        // Generalised guard: any layer in the focused-view group that sets one
        // of the self-stacking properties has to be the one carrying
        // annotLayerZ, or it seals the z-index in again. Today exactly one
        // element in that group sets such a property outside the transform
        // layer — the clip window — and it carries annotLayerZ.
        const at = tile.indexOf('const frame = (');
        expect(at, 'the focused-view group was restructured — re-derive this rule').toBeGreaterThan(-1);
        const wrappers = divTags(tile.slice(at));
        expect(wrappers.length, 'the focused-view group no longer wraps the frame in any div').toBeGreaterThan(0);
        for (const tag of wrappers) {
            const s = styleOf(tag);
            const self = SELF_STACKING.filter(p => new RegExp(`\\b${p}\\s*:`).test(s));
            // The transform layer is exempt: it is INSIDE the element that
            // carries the z-index, so its own stacking context is harmless.
            if (!self.length || /transformOrigin/.test(s)) continue;
            expect(s, `a wrapper sets ${self.join('/')} (which opens a stacking context) without carrying annotLayerZ`)
                .toMatch(/zIndex:\s*annotLayerZ/);
        }
    });
});
