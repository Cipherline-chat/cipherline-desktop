// @vitest-environment jsdom
/**
 * ClSlideConfirm: only a COMPLETED slide confirms. Pointer drag short of the
 * end springs back with no call; to the end, exactly one call. Keyboard: arrow
 * keys walk it to the end; holding Enter/Space for holdMs confirms, letting go
 * early does not. A failed action (busy true -> false) resets it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClSlideConfirm } from './ClSlideConfirm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

/** Track 356px wide -> 300px of thumb travel (356 - 48 - 2*4). */
async function mount(props: Partial<React.ComponentProps<typeof ClSlideConfirm>> = {}) {
    const onConfirm = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const render = async (p: Partial<React.ComponentProps<typeof ClSlideConfirm>> = {}) => {
        await act(async () => {
            root!.render(React.createElement(ClSlideConfirm, {
                label: 'Slide to cancel', ariaLabel: 'Slide to cancel and lose founding price', onConfirm, holdMs: 300,
                'data-testid': 'slide', ...props, ...p,
            }));
        });
    };
    await render();
    const track = host.querySelector('[data-testid="slide"]') as HTMLElement;
    Object.defineProperty(track, 'clientWidth', { configurable: true, get: () => 356 });
    const thumb = host.querySelector('[role="slider"]') as HTMLElement;
    return { onConfirm, track, thumb, render };
}

function pointer(el: HTMLElement, type: string, clientX: number) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    act(() => { el.dispatchEvent(ev); });
}
function key(el: HTMLElement, type: 'keydown' | 'keyup', k: string) {
    act(() => { el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true })); });
}
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe('ClSlideConfirm', () => {
    it('is an accessible slider with the given name, starting at 0', async () => {
        const { thumb } = await mount();
        expect(thumb.getAttribute('aria-label')).toBe('Slide to cancel and lose founding price');
        expect(thumb.getAttribute('aria-valuenow')).toBe('0');
        expect(thumb.tabIndex).toBe(0);
    });

    it('a partial drag springs back and sends NOTHING', async () => {
        const { thumb, track, onConfirm } = await mount();
        pointer(thumb, 'pointerdown', 0);
        pointer(thumb, 'pointermove', 150);
        expect(track.getAttribute('data-progress')).toBe('50');
        pointer(thumb, 'pointerup', 150);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(track.getAttribute('data-progress')).toBe('0');
    });

    it('positive control: a drag to the end confirms exactly once', async () => {
        const { thumb, onConfirm } = await mount();
        pointer(thumb, 'pointerdown', 0);
        pointer(thumb, 'pointermove', 320);
        pointer(thumb, 'pointerup', 320);
        expect(onConfirm).toHaveBeenCalledTimes(1);
        pointer(thumb, 'pointerdown', 300);                 // already confirmed: ignored
        pointer(thumb, 'pointerup', 400);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('keyboard: arrows walk it to the end (no call until the end); Home resets', async () => {
        const { thumb, track, onConfirm } = await mount();
        for (let i = 0; i < 9; i++) key(thumb, 'keydown', 'ArrowRight');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(track.getAttribute('data-progress')).toBe('90');
        key(thumb, 'keydown', 'Home');
        expect(track.getAttribute('data-progress')).toBe('0');
        key(thumb, 'keydown', 'End');                       // End does NOT jump to confirm
        expect(onConfirm).not.toHaveBeenCalled();
        for (let i = 0; i < 10; i++) key(thumb, 'keydown', 'ArrowRight');
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('keyboard: releasing Enter early sends nothing; holding it for holdMs confirms', async () => {
        const { thumb, track, onConfirm } = await mount();
        key(thumb, 'keydown', 'Enter');
        await wait(120);
        key(thumb, 'keyup', 'Enter');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(track.getAttribute('data-progress')).toBe('0');
        key(thumb, 'keydown', ' ');
        await wait(500);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('a failed action (busy -> false) hands the control back at 0', async () => {
        const { thumb, track, onConfirm, render } = await mount();
        for (let i = 0; i < 10; i++) key(thumb, 'keydown', 'ArrowRight');
        expect(onConfirm).toHaveBeenCalledTimes(1);
        await render({ busy: true });
        expect(track.textContent).toContain('Working');
        await render({ busy: false });
        expect(track.getAttribute('data-progress')).toBe('0');
        for (let i = 0; i < 10; i++) key(thumb, 'keydown', 'ArrowRight');
        expect(onConfirm).toHaveBeenCalledTimes(2);
    });

    it('disabled: ignores input', async () => {
        const { thumb, onConfirm } = await mount({ disabled: true });
        for (let i = 0; i < 10; i++) key(thumb, 'keydown', 'ArrowRight');
        pointer(thumb, 'pointerdown', 0); pointer(thumb, 'pointerup', 400);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(thumb.tabIndex).toBe(-1);
    });
});
