import { describe, it, expect } from 'vitest';
import {
    computeTooltipPlacement,
    TOOLTIP_GAP,
    TOOLTIP_MARGIN,
    type TooltipRect,
    type TooltipSize,
    type TooltipViewport,
} from './tooltipPlacement';

/** 1280x720, the size the regression was reported and verified at. */
const VIEWPORT: TooltipViewport = { width: 1280, height: 720 };
/** Roughly a "Return to surface" pill at 11.5px/700. */
const TIP: TooltipSize = { width: 120, height: 26 };

/** A 32px icon button. */
function button(left: number, top: number): TooltipRect {
    return { left, top, width: 32, height: 32 };
}

describe('computeTooltipPlacement', () => {
    describe('the comfortable case', () => {
        it('sits above the anchor, centred, when there is room', () => {
            const p = computeTooltipPlacement(button(600, 400), TIP, VIEWPORT);
            expect(p.side).toBe('top');
            expect(p.clamped).toBe(false);
            // Centre of the button is 616; half the tip is 60.
            expect(p.left).toBe(556);
            expect(p.top).toBe(400 - TOOLTIP_GAP - TIP.height);
        });

        it('honours a bottom preference when both sides fit', () => {
            const p = computeTooltipPlacement(button(600, 400), TIP, VIEWPORT, { preferred: 'bottom' });
            expect(p.side).toBe('bottom');
            expect(p.top).toBe(400 + 32 + TOOLTIP_GAP);
        });
    });

    describe('vertical flip — the top-edge case', () => {
        it('flips below when the anchor is too close to the top', () => {
            // A modal header X at y=12 has only 12px above it; the tip needs 35.
            const p = computeTooltipPlacement(button(600, 12), TIP, VIEWPORT);
            expect(p.side).toBe('bottom');
            expect(p.top).toBe(12 + 32 + TOOLTIP_GAP);
        });

        it('does not flip when the top fits by exactly the margin', () => {
            const top = TOOLTIP_MARGIN + TOOLTIP_GAP + TIP.height;
            const p = computeTooltipPlacement(button(600, top), TIP, VIEWPORT);
            expect(p.side).toBe('top');
            expect(p.top).toBe(TOOLTIP_MARGIN);
        });

        it('flips one pixel earlier than that', () => {
            const top = TOOLTIP_MARGIN + TOOLTIP_GAP + TIP.height - 1;
            expect(computeTooltipPlacement(button(600, top), TIP, VIEWPORT).side).toBe('bottom');
        });

        it('flips back to the top when the anchor is near the bottom', () => {
            const p = computeTooltipPlacement(button(600, 700), TIP, VIEWPORT, { preferred: 'bottom' });
            expect(p.side).toBe('top');
            expect(p.top).toBe(700 - TOOLTIP_GAP - TIP.height);
        });

        it('picks the roomier side and clamps when neither fits', () => {
            // A control taller than the viewport's usable height.
            const tall: TooltipRect = { left: 600, top: 4, width: 32, height: 700 };
            const p = computeTooltipPlacement(tall, TIP, VIEWPORT);
            expect(p.side).toBe('bottom');
            expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.top + TIP.height).toBeLessThanOrEqual(VIEWPORT.height - TOOLTIP_MARGIN);
        });
    });

    describe('horizontal clamping — the right-edge case', () => {
        it('shifts a right-edge close button back on screen', () => {
            // A modal X hard against the right edge: centred would put the tip
            // at 1244 - 60 + 16 = 1200, overflowing by 120 - 8.
            const p = computeTooltipPlacement(button(1236, 300), TIP, VIEWPORT);
            expect(p.clamped).toBe(true);
            expect(p.left).toBe(VIEWPORT.width - TOOLTIP_MARGIN - TIP.width);
            expect(p.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width - TOOLTIP_MARGIN);
        });

        it('shifts a left-edge button back on screen', () => {
            const p = computeTooltipPlacement(button(4, 300), TIP, VIEWPORT);
            expect(p.clamped).toBe(true);
            expect(p.left).toBe(TOOLTIP_MARGIN);
        });

        it('leaves a comfortably-centred tooltip unclamped', () => {
            expect(computeTooltipPlacement(button(600, 300), TIP, VIEWPORT).clamped).toBe(false);
        });

        it('pins to the left margin when the tooltip is wider than the viewport', () => {
            const narrow: TooltipViewport = { width: 100, height: 720 };
            const p = computeTooltipPlacement(button(40, 300), TIP, narrow);
            expect(p.clamped).toBe(true);
            expect(p.left).toBe(TOOLTIP_MARGIN);
        });
    });

    describe('narrow viewports', () => {
        it('keeps a right-edge tooltip fully on screen at 720 wide', () => {
            const narrow: TooltipViewport = { width: 720, height: 600 };
            const p = computeTooltipPlacement(button(676, 300), TIP, narrow);
            expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.left + TIP.width).toBeLessThanOrEqual(narrow.width - TOOLTIP_MARGIN);
        });

        it('keeps a top-right close button on screen in both axes at once', () => {
            // The exact shape of the reported bug: top-right X in a small window.
            const narrow: TooltipViewport = { width: 720, height: 600 };
            const p = computeTooltipPlacement(button(676, 10), TIP, narrow);
            expect(p.side).toBe('bottom');
            expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.left + TIP.width).toBeLessThanOrEqual(narrow.width - TOOLTIP_MARGIN);
            expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.top + TIP.height).toBeLessThanOrEqual(narrow.height - TOOLTIP_MARGIN);
        });
    });

    it('always returns integers', () => {
        const p = computeTooltipPlacement(
            { left: 100.4, top: 200.6, width: 33.3, height: 31.7 },
            { width: 119.5, height: 25.5 },
            VIEWPORT,
        );
        expect(Number.isInteger(p.left)).toBe(true);
        expect(Number.isInteger(p.top)).toBe(true);
    });

    // 30s, not the default 5s. These two sweeps are pure, deterministic and
    // CPU-BOUND: nested integer loops over a pure function, no timers, no
    // async, no shared state. The four-placement one below runs ~6,600
    // iterations and ~26,000 assertions, measured at 900ms on an IDLE box —
    // barely 5x under the default budget. This dev box routinely sits at load
    // 15-22 with several agents running suites, and that is enough to push a
    // 900ms test past 5s. It then fails as a TIMEOUT, never an assertion, and
    // passes instantly in isolation, which reads exactly like a real
    // regression and is not one. Raising the budget is the fix; shrinking the
    // sweep would trade real coverage for a cosmetic win.
    it('never lets a tooltip escape the viewport, over a sweep of anchors', () => {
        for (let x = 0; x <= VIEWPORT.width - 32; x += 37) {
            for (let y = 0; y <= VIEWPORT.height - 32; y += 29) {
                const p = computeTooltipPlacement(button(x, y), TIP, VIEWPORT);
                expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
                expect(p.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width - TOOLTIP_MARGIN);
                expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
                expect(p.top + TIP.height).toBeLessThanOrEqual(VIEWPORT.height - TOOLTIP_MARGIN);
            }
        }
    }, 30_000);

    describe('left/right placement — the comfortable case', () => {
        it('sits to the right of the anchor, centred vertically, when there is room', () => {
            const p = computeTooltipPlacement(button(600, 400), TIP, VIEWPORT, { preferred: 'right' });
            expect(p.side).toBe('right');
            expect(p.clamped).toBe(false);
            expect(p.left).toBe(600 + 32 + TOOLTIP_GAP);
            // Centre of the button is 416; half the tip's height is 13.
            expect(p.top).toBe(400 + 16 - 13);
        });

        it('honours a left preference when both fit', () => {
            const p = computeTooltipPlacement(button(600, 400), TIP, VIEWPORT, { preferred: 'left' });
            expect(p.side).toBe('left');
            expect(p.left).toBe(600 - TOOLTIP_GAP - TIP.width);
        });
    });

    describe('horizontal flip — the right-edge case', () => {
        it('flips left when the anchor is too close to the right edge', () => {
            // Only 48px of room to the right — the tip needs gap + width = 129.
            const p = computeTooltipPlacement(button(1200, 300), TIP, VIEWPORT, { preferred: 'right' });
            expect(p.side).toBe('left');
            expect(p.left).toBe(1200 - TOOLTIP_GAP - TIP.width);
        });

        it('does not flip when the right fits by exactly the margin', () => {
            // anchor.left chosen so rightSideLeft + tip.width lands exactly on
            // the right margin boundary.
            const left = VIEWPORT.width - TOOLTIP_MARGIN - TIP.width - 32 - TOOLTIP_GAP;
            const p = computeTooltipPlacement(button(left, 300), TIP, VIEWPORT, { preferred: 'right' });
            expect(p.side).toBe('right');
            expect(p.left).toBe(left + 32 + TOOLTIP_GAP);
        });

        it('flips one pixel earlier than that', () => {
            const left = VIEWPORT.width - TOOLTIP_MARGIN - TIP.width - 32 - TOOLTIP_GAP + 1;
            expect(computeTooltipPlacement(button(left, 300), TIP, VIEWPORT, { preferred: 'right' }).side).toBe('left');
        });

        it('flips back to the right when the anchor is near the left edge', () => {
            const p = computeTooltipPlacement(button(50, 300), TIP, VIEWPORT, { preferred: 'left' });
            expect(p.side).toBe('right');
            expect(p.left).toBe(50 + 32 + TOOLTIP_GAP);
        });

        it('picks the roomier side and clamps when neither fits', () => {
            // A control almost as wide as the viewport.
            const wide: TooltipRect = { left: 4, top: 300, width: 1250, height: 32 };
            const p = computeTooltipPlacement(wide, TIP, VIEWPORT, { preferred: 'right' });
            expect(p.side).toBe('right');
            expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width - TOOLTIP_MARGIN);
        });
    });

    describe('vertical clamping — for left/right placement', () => {
        it("shifts a bottom-edge anchor's tooltip back on screen", () => {
            const p = computeTooltipPlacement(button(300, 700), TIP, VIEWPORT, { preferred: 'right' });
            expect(p.clamped).toBe(true);
            expect(p.top).toBe(VIEWPORT.height - TOOLTIP_MARGIN - TIP.height);
            expect(p.top + TIP.height).toBeLessThanOrEqual(VIEWPORT.height - TOOLTIP_MARGIN);
        });

        it("shifts a top-edge anchor's tooltip back on screen", () => {
            const p = computeTooltipPlacement(button(300, 4), TIP, VIEWPORT, { preferred: 'right' });
            expect(p.clamped).toBe(true);
            expect(p.top).toBe(TOOLTIP_MARGIN);
        });

        it('leaves a comfortably-centred tooltip unclamped', () => {
            expect(computeTooltipPlacement(button(300, 300), TIP, VIEWPORT, { preferred: 'right' }).clamped).toBe(false);
        });

        it('pins to the top margin when the tooltip is taller than the viewport', () => {
            const short: TooltipViewport = { width: 1280, height: 40 };
            const p = computeTooltipPlacement(button(300, 10), TIP, short, { preferred: 'right' });
            expect(p.clamped).toBe(true);
            expect(p.top).toBe(TOOLTIP_MARGIN);
        });
    });

    describe('narrow viewports — left/right placement', () => {
        it('keeps a bottom-edge tooltip fully on screen in a short viewport', () => {
            const narrow: TooltipViewport = { width: 600, height: 300 };
            const p = computeTooltipPlacement(button(300, 276), TIP, narrow, { preferred: 'right' });
            expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.top + TIP.height).toBeLessThanOrEqual(narrow.height - TOOLTIP_MARGIN);
        });

        it('keeps a bottom-left corner anchor on screen in both axes at once', () => {
            // The exact shape of the rail-tooltip bug: an anchor near the left
            // edge (forces a horizontal flip) that's also near the bottom
            // (forces a vertical clamp), in a small window.
            const narrow: TooltipViewport = { width: 720, height: 600 };
            const p = computeTooltipPlacement(button(4, 568), TIP, narrow, { preferred: 'left' });
            expect(p.side).toBe('right');
            expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.left + TIP.width).toBeLessThanOrEqual(narrow.width - TOOLTIP_MARGIN);
            expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
            expect(p.top + TIP.height).toBeLessThanOrEqual(narrow.height - TOOLTIP_MARGIN);
        });
    });

    it('never lets a tooltip escape the viewport, over a sweep of anchors, in any of the four placements', () => {
        const sides: Array<'top' | 'bottom' | 'left' | 'right'> = ['top', 'bottom', 'left', 'right'];
        for (const preferred of sides) {
            for (let x = 0; x <= VIEWPORT.width - 32; x += 41) {
                for (let y = 0; y <= VIEWPORT.height - 32; y += 31) {
                    const p = computeTooltipPlacement(button(x, y), TIP, VIEWPORT, { preferred });
                    expect(p.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
                    expect(p.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width - TOOLTIP_MARGIN);
                    expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
                    expect(p.top + TIP.height).toBeLessThanOrEqual(VIEWPORT.height - TOOLTIP_MARGIN);
                }
            }
        }
    }, 30_000);
});
