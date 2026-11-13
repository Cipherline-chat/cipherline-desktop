// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ClInput, ClTextarea } from './ClInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `error` is a component prop; it must not reach the DOM (React warns on
 *  `error={false}`: "Received `false` for a non-boolean attribute"). */
function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(el); });
    return { host, unmount: () => act(() => root.unmount()) };
}

describe('ClInput / ClTextarea error prop', () => {
    afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

    for (const [name, C, sel] of [['ClInput', ClInput, 'input'], ['ClTextarea', ClTextarea, 'textarea']] as const) {
        it(`${name}: error={false} logs no React warning and sets no attribute`, () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { host, unmount } = mount(React.createElement(C as never, { error: false }));
            const el = host.querySelector(sel)!;
            expect(el.hasAttribute('error')).toBe(false);
            expect(el.hasAttribute('aria-invalid')).toBe(false);
            expect(spy).not.toHaveBeenCalled();
            unmount();
        });
        it(`${name}: error={true} marks aria-invalid and no error attribute`, () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { host, unmount } = mount(React.createElement(C as never, { error: true }));
            const el = host.querySelector(sel)!;
            expect(el.getAttribute('aria-invalid')).toBe('true');
            expect(el.hasAttribute('error')).toBe(false);
            expect(spy).not.toHaveBeenCalled();
            unmount();
        });
        it(`${name}: an explicit aria-invalid from the caller wins`, () => {
            const { host, unmount } = mount(React.createElement(C as never, { error: false, 'aria-invalid': true }));
            expect(host.querySelector(sel)!.getAttribute('aria-invalid')).toBe('true');
            unmount();
        });
    }
});
