import { describe, it, expect } from 'vitest';
import { placePopover, WINDOW_TITLEBAR_PX } from './popoverPlacement';

const card = { w: 320, h: 460 };

describe('placePopover', () => {
    it('never puts the popover under the titlebar, even for a click right below it', () => {
        const p = placePopover({ anchor: { x: 700, y: 40 }, size: card, viewport: { w: 800, h: 600 } });
        expect(p.top).toBeGreaterThanOrEqual(WINDOW_TITLEBAR_PX + 12);
    });

    it('opens to the LEFT of a click near the right edge (a member list), keeping the click visible', () => {
        const p = placePopover({ anchor: { x: 740, y: 60 }, size: card, viewport: { w: 800, h: 600 } });
        expect(p.side).toBe('left');
        expect(p.left + card.w).toBeLessThanOrEqual(740);
    });

    it('opens to the RIGHT of a click near the left edge (a chat avatar)', () => {
        const p = placePopover({ anchor: { x: 90, y: 300 }, size: card, viewport: { w: 1280, h: 800 } });
        expect(p.side).toBe('right');
        expect(p.left).toBeGreaterThan(90);
    });

    it('lifts the card off the bottom so the whole of it fits', () => {
        const p = placePopover({ anchor: { x: 200, y: 580 }, size: card, viewport: { w: 800, h: 600 } });
        expect(p.top + card.h).toBeLessThanOrEqual(600 - 12);
        expect(p.maxHeight).toBeNull();
    });

    it('scrolls only when the card is taller than the usable height', () => {
        const fits = placePopover({ anchor: { x: 200, y: 200 }, size: { w: 320, h: 542 }, viewport: { w: 800, h: 600 } });
        expect(fits.maxHeight).toBeNull();
        const tall = placePopover({ anchor: { x: 200, y: 200 }, size: { w: 320, h: 700 }, viewport: { w: 800, h: 600 } });
        expect(tall.maxHeight).toBe(600 - WINDOW_TITLEBAR_PX - 24);
        expect(tall.top).toBe(WINDOW_TITLEBAR_PX + 12);
    });

    it('centres in the usable area when there is no anchor', () => {
        const p = placePopover({ anchor: null, size: card, viewport: { w: 1000, h: 700 } });
        expect(p.side).toBe('center');
        expect(p.left).toBe(340);
        expect(p.top).toBeGreaterThanOrEqual(WINDOW_TITLEBAR_PX + 12);
    });

    it('a window narrower than card + click falls back to centred-and-clamped, inside both edges', () => {
        const p = placePopover({ anchor: { x: 200, y: 200 }, size: card, viewport: { w: 420, h: 600 } });
        expect(p.side).toBe('center');
        expect(p.left).toBeGreaterThanOrEqual(12);
        expect(p.left + card.w).toBeLessThanOrEqual(420 - 12);
    });
});
