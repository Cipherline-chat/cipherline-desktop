import { describe, it, expect } from 'vitest';
import { computeSelectPlacement } from './selectPlacement';

describe('computeSelectPlacement', () => {
    const menu = 200;
    it('opens down when there is room below', () => {
        const p = computeSelectPlacement({ top: 100, bottom: 130 }, menu, 800);
        expect(p.openUp).toBe(false);
        expect(p.top).toBe(134);
        expect(p.maxHeight).toBe(200);
    });
    it('opens up when the trigger is near the bottom (positive control: down would overflow)', () => {
        const p = computeSelectPlacement({ top: 520, bottom: 550 }, menu, 600);
        expect(554 + menu).toBeGreaterThan(600); // a down placement would be cut off
        expect(p.openUp).toBe(true);
        expect(p.bottom).toBe(600 - 520 + 4);
        // top edge of the menu = vh - bottom - height, must be on-screen
        expect(600 - p.bottom - p.maxHeight).toBeGreaterThanOrEqual(8);
    });
    it('stays inside the viewport at a tiny window height by clamping', () => {
        const p = computeSelectPlacement({ top: 150, bottom: 180 }, 280, 220);
        expect(p.openUp).toBe(true);
        expect(220 - p.bottom - p.maxHeight).toBeGreaterThanOrEqual(8);
        expect(p.maxHeight).toBeLessThan(280);
    });
    it('keeps opening down and clamps when below has more room than above', () => {
        const p = computeSelectPlacement({ top: 40, bottom: 70 }, 280, 200);
        expect(p.openUp).toBe(false);
        expect(p.top + p.maxHeight).toBeLessThanOrEqual(200 - 8);
    });
});
