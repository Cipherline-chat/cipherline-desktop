// @vitest-environment jsdom
/**
 * "Mention everyone?" mounted for real: the copy carries the member count,
 * focus starts on Cancel (an Enter that opened it must not send it), Cancel /
 * Escape answer Cancel only, "Send to everyone" answers Confirm only — each
 * after the exit animation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { EveryoneConfirmDialog } = await import('./EveryoneConfirmDialog');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

function mount(kind: 'everyone' | 'here', count: number) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    act(() => { root.render(React.createElement(EveryoneConfirmDialog, { kind, memberCount: count, onConfirm, onCancel })); });
    act(() => { vi.advanceTimersByTime(50); });
    return { onConfirm, onCancel };
}
const buttons = () => Array.from(document.querySelectorAll('button'));
const byText = (t: string) => buttons().find(b => b.textContent?.trim() === t)!;

describe('EveryoneConfirmDialog', () => {
    it('shows the title and the real member count, as a labelled dialog', () => {
        mount('everyone', 1284);
        expect(document.body.textContent).toContain('Mention everyone?');
        expect(document.body.textContent).toContain('This will notify 1,284 members.');
        expect(byText('Cancel')).toBeTruthy();
        expect(byText('Send to everyone')).toBeTruthy();
        const dlg = document.querySelector('[role="dialog"]');
        expect(dlg).not.toBeNull();
    });

    it('focus starts on Cancel', () => {
        mount('everyone', 500);
        act(() => { vi.advanceTimersByTime(400); });
        expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
    });

    it('Cancel answers cancel only, after the exit animation', () => {
        const { onConfirm, onCancel } = mount('here', 300);
        act(() => { byText('Cancel').click(); });
        expect(onCancel).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(250); });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('Escape is Cancel', () => {
        const { onConfirm, onCancel } = mount('everyone', 300);
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        act(() => { vi.advanceTimersByTime(250); });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('"Send to everyone" answers confirm once, even if double-clicked', () => {
        const { onConfirm, onCancel } = mount('everyone', 101);
        act(() => { byText('Send to everyone').click(); byText('Send to everyone')?.click(); });
        act(() => { vi.advanceTimersByTime(250); });
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });
});
