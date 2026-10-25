// @vitest-environment jsdom
/**
 * Moment trigger: pushing a volume slider past 200%. A push = an increase key
 * (or a drag past the end) while the slider sits at max; three inside the
 * window asks for 'volume-ceiling'. Below max, decrease keys, or slow pushes:
 * nothing. The slider's own handling is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { VolumeCeilingWatch } = await import('./VolumeCeilingWatch');
const { MOMENT_EVENT, CEILING_WINDOW_MS, ceilingPush } = await import('../../utils/moments');

let root: Root;
let host: HTMLDivElement;
const asked: string[] = [];
const onMoment = (e: Event) => asked.push((e as CustomEvent<{ id: string }>).detail.id);
const sliderKeys = vi.fn();

function render(value: number, max = 200) {
    act(() => root.render(React.createElement(VolumeCeilingWatch, null,
        React.createElement('div', {
            role: 'slider', tabIndex: 0, 'aria-valuenow': value, 'aria-valuemax': max, 'data-testid': 's',
            onKeyDown: () => sliderKeys(),
        }))));
}
const slider = () => document.querySelector('[data-testid="s"]') as HTMLElement;
const press = (k: string) => act(() => { slider().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
    asked.length = 0;
    sliderKeys.mockReset();
    window.addEventListener(MOMENT_EVENT, onMoment);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    window.removeEventListener(MOMENT_EVENT, onMoment);
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('VolumeCeilingWatch', () => {
    it('three increase keys at 200% → the moment (once)', () => {
        render(200);
        press('ArrowRight'); press('ArrowUp');
        expect(asked).toEqual([]);
        press('End');
        expect(asked).toEqual(['volume-ceiling']);
        expect(sliderKeys).toHaveBeenCalledTimes(3); // the slider still got every key
    });
    it('below the ceiling: never', () => {
        render(180);
        for (let i = 0; i < 6; i++) press('ArrowRight');
        expect(asked).toEqual([]);
    });
    it('decrease keys at max are not pushes', () => {
        render(200);
        for (let i = 0; i < 6; i++) press('ArrowLeft');
        expect(asked).toEqual([]);
    });
    it('slow pushes (outside the window) never add up', () => {
        render(200);
        press('ArrowRight');
        vi.setSystemTime(Date.now() + CEILING_WINDOW_MS);
        press('ArrowRight');
        vi.setSystemTime(Date.now() + CEILING_WINDOW_MS);
        press('ArrowRight');
        expect(asked).toEqual([]);
    });
    it('per-user volume (ceiling 2 = 200%) counts the same', () => {
        render(2, 2);
        press('ArrowRight'); press('ArrowRight'); press('ArrowRight');
        expect(asked).toEqual(['volume-ceiling']);
    });
});

describe('ceilingPush', () => {
    it('fires on the third push inside the window and starts over', () => {
        let t = ceilingPush([], 0);
        t = ceilingPush(t.times, 100);
        expect(t.fire).toBe(false);
        t = ceilingPush(t.times, 200);
        expect(t).toEqual({ times: [], fire: true });
    });
});
