import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { placeMenu, MENU_PAD } from './menuPlacement';

const box = (left: number, right: number, top = 500, bottom = 530) => ({ left, right, top, bottom });
const pane = box(240, 640, 0, 800);   // a narrow chat pane, 400px wide
const menu = { width: 210, height: 420 };

// Owner, 2026-11-17: narrow window, font menu ran off the pane's left edge.
describe('placeMenu keeps composer menus inside the chat pane', () => {
    it('default: right-aligned when there is room to the left', () => {
        expect(placeMenu(menu, box(500, 590), pane)).toMatchObject({ align: 'right', shiftX: 0, maxWidth: null });
    });
    it('the reported case: button at the left of the pane -> left-aligned, fully inside', () => {
        const a = box(250, 340);
        const p = placeMenu(menu, a, pane);
        expect(p.align).toBe('left');
        const left = a.left + p.shiftX;
        expect(left).toBeGreaterThanOrEqual(pane.left + MENU_PAD);
        expect(left + menu.width).toBeLessThanOrEqual(pane.right - MENU_PAD);
    });
    it('button hugging the right edge -> slid back inside', () => {
        const a = box(600, 640);
        const p = placeMenu(menu, a, pane);
        const right = p.align === 'right' ? a.right : a.left + p.shiftX + menu.width;
        expect(right).toBeLessThanOrEqual(pane.right - MENU_PAD);
    });
    it('pane narrower than the menu -> pinned to the left padding and width-capped', () => {
        const tiny = box(240, 400, 0, 800);
        const p = placeMenu(menu, box(250, 300), tiny);
        expect(p.maxWidth).toBe(400 - 240 - 2 * MENU_PAD);
        expect(250 + p.shiftX).toBe(240 + MENU_PAD);
    });
    it('short window: height capped to the room above the button (then it scrolls), never below a usable minimum', () => {
        expect(placeMenu(menu, box(500, 590, 300, 330), pane).maxHeight).toBe(300 - 6 - MENU_PAD);
        expect(placeMenu(menu, box(500, 590, 60, 90), pane).maxHeight).toBe(140);
        expect(placeMenu(menu, box(500, 590, 700, 730), pane).maxHeight).toBeNull();
    });
    it('wiring: both font and size menus (OptionMenu) apply the placement', () => {
        const src = readFileSync(resolve(__dirname, 'FormatToolbar.tsx'), 'utf8');
        expect(src).toContain('setPlace(placeMenu(');
        expect(src).toContain('style={placeStyle}');
    });
});
