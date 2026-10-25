// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { RowErrorBoundary } from './RowErrorBoundary';
import { MemoRow } from './MemoRow';

// One row whose content makes its renderer throw (what a `{ type: 'text',
// text: 42 }` message did) must cost that row only: its siblings render and
// nothing reaches the root error boundary.
let root: Root | null = null;
let host: HTMLDivElement;
const mount = (el: React.ReactElement) => {
    host = document.createElement('div');
    root = createRoot(host);
    act(() => { root!.render(el); });
};
afterEach(() => { act(() => { root?.unmount(); }); root = null; vi.restoreAllMocks(); });

const Row: React.FC<{ text: unknown }> = ({ text }) => React.createElement('p', null, (text as string).trim());

describe('RowErrorBoundary', () => {
    it('contains a throwing row; siblings still render', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mount(React.createElement('div', null,
            React.createElement(RowErrorBoundary, { key: 1 }, React.createElement(Row, { text: ' ok ' })),
            React.createElement(RowErrorBoundary, { key: 2 }, React.createElement(Row, { text: 42 })),
            React.createElement(RowErrorBoundary, { key: 3 }, React.createElement(Row, { text: 'after' })),
        ));
        expect(host.querySelectorAll('p')).toHaveLength(2);
        expect(host.textContent).toContain('ok');
        expect(host.textContent).toContain('after');
        expect(host.querySelector('[data-row-error]')).not.toBeNull();
    });

    it('retries when its reset keys change', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const el = (text: unknown) => React.createElement(RowErrorBoundary, { resetKeys: [text] }, React.createElement(Row, { text }));
        mount(el(42));
        expect(host.querySelector('[data-row-error]')).not.toBeNull();
        act(() => { root!.render(el('fixed')); });
        expect(host.textContent).toBe('fixed');
    });
});

describe('MemoRow', () => {
    it('a throw inside render() is caught by the row, not the list', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const bad = { content: { type: 'text', text: 42 } };
        mount(React.createElement('div', null,
            React.createElement(MemoRow, { key: 'a', deps: [bad], render: () => React.createElement('span', null, (bad.content.text as unknown as string).trim()) }),
            React.createElement(MemoRow, { key: 'b', deps: [], render: () => React.createElement('span', null, 'fine') }),
        ));
        expect(host.textContent).toContain('fine');
        expect(host.querySelector('[data-row-error]')).not.toBeNull();
    });
});
