// @vitest-environment jsdom
/**
 * The settings picker row: shows the current choice, opens a labelled dialog,
 * Escape closes it through the shared escape stack (and gives focus back), a
 * click outside closes it, and Settings underneath never sees that Escape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PickerPopover } from './PickerPopover';
import { useEscape } from '../../../hooks/useEscape';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (...a: any[]) => React.ReactElement;

let host: HTMLDivElement;
let root: Root;
const underneath = vi.fn();

const Page: React.FC = () => {
    useEscape(() => { underneath(); }, true);   // stands in for Settings' own Escape
    return h('div', null,
        h(PickerPopover, {
            label: 'Avatar decoration', value: h('span', null, 'Lume ring'),
            children: (close: () => void) => h('div', { role: 'radiogroup', 'aria-label': 'Decorations' },
                h('button', { role: 'radio', 'aria-checked': 'true', id: 'pick-a', onClick: close }, 'Lume ring'),
                h('button', { role: 'radio', 'aria-checked': 'false', id: 'pick-b', onClick: close }, 'Deep dash')),
        }),
        h('button', { id: 'elsewhere' }, 'elsewhere'));
};

beforeEach(() => {
    underneath.mockClear();
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof window.requestAnimationFrame;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(h(Page)));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const trigger = () => host.querySelector('button.su-pick-trigger') as HTMLButtonElement;
const press = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });

describe('<PickerPopover>', () => {
    it('shows the current choice on the row and a closed, labelled trigger', () => {
        expect(trigger().textContent).toContain('Lume ring');
        expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('opens a dialog named by the row and moves focus to the checked option', () => {
        act(() => trigger().click());
        const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dlg).not.toBeNull();
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(dlg.getAttribute('aria-labelledby')).toBe(trigger().getAttribute('aria-labelledby'));
        expect(document.getElementById(dlg.getAttribute('aria-labelledby')!)!.textContent).toBe('Avatar decoration');
        expect(document.activeElement?.id).toBe('pick-a');
    });

    it('Escape closes it, returns focus to the row, and does NOT reach the screen underneath', () => {
        act(() => trigger().click());
        press('Escape');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger());
        expect(underneath).not.toHaveBeenCalled();
        press('Escape');                       // the next press backs out one level further
        expect(underneath).toHaveBeenCalledTimes(1);
    });

    it('picking an option can close it (the render prop gets close)', () => {
        act(() => trigger().click());
        act(() => (document.getElementById('pick-b') as HTMLButtonElement).click());
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger());
    });

    it('the row toggles it closed again', () => {
        act(() => trigger().click());
        act(() => trigger().click());
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('a click outside closes it', () => {
        act(() => trigger().click());
        act(() => {
            document.getElementById('elsewhere')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});

describe('<PickerPopover variant="tile">', () => {
    it('one button: preview, label and value, named by both; opens the same labelled dialog and Escape returns to it', () => {
        // The outside-click test above leaves its one-shot "swallow the trailing click" listener armed; spend it.
        document.body.click();
        act(() => root.render(h(PickerPopover, {
            variant: 'tile', label: 'Theme', value: 'Glow', preview: h('i', { id: 'swatch' }),
            children: () => h('button', { role: 'radio', 'aria-checked': 'true', id: 'glow' }, 'Glow'),
        })));
        const tile = host.querySelector('button.ps-tile') as HTMLButtonElement;
        expect(tile.querySelector('#swatch')).not.toBeNull();
        const names = tile.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent);
        expect(names).toEqual(['Theme', 'Glow']);
        act(() => tile.click());
        const dlg = document.querySelector('[role="dialog"]')!;
        expect(document.getElementById(dlg.getAttribute('aria-labelledby')!)!.textContent).toBe('Theme');
        expect(document.activeElement?.id).toBe('glow');
        press('Escape');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(tile);
    });
});
