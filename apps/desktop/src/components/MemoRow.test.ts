// @vitest-environment jsdom
/**
 * MemoRow is what lets ChatPane's message rows skip re-rendering on keystrokes,
 * hover and unrelated Dashboard updates. Pinned here:
 *   - equal deps → the row body does not run again;
 *   - any changed dep → it does, with the CURRENT closure;
 *   - a skipped row keeps its old handlers, which is why ChatPane routes them
 *     through useLiveCallbacks: the stand-ins must reach the latest committed
 *     function, not the one from the render that produced the row.
 */
import { describe, it, expect } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoRow } from './MemoRow';
import { useShallowStable } from '../hooks/useShallowStable';
import { useLiveCallbacks } from '../hooks/useLiveCallbacks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, rerender: (next: React.ReactElement) => act(() => root.render(next)), unmount: () => act(() => root.unmount()) };
}

describe('MemoRow', () => {
    it('skips the body while deps are shallow-equal and re-runs it when one changes', () => {
        const runs: string[] = [];
        type M = { id: string; text: string };
        const Pane = ({ keystroke, m, hovered }: { keystroke: string; m: M; hovered: boolean }) =>
            h('div', null,
                h('textarea', { value: keystroke, readOnly: true }),
                h(MemoRow, { deps: [m, hovered], render: () => { runs.push(`${m.text}/${hovered}`); return h('span', null, m.text); } }),
            );
        const msg = { id: 'm1', text: 'hi' };
        const t = mount(h(Pane, { keystroke: '', m: msg, hovered: false }));
        expect(runs).toEqual(['hi/false']);
        for (const k of ['a', 'ab', 'abc']) t.rerender(h(Pane, { keystroke: k, m: msg, hovered: false }));
        expect(runs).toEqual(['hi/false']);                 // typing: row body never re-ran
        t.rerender(h(Pane, { keystroke: 'abc', m: msg, hovered: true }));
        expect(runs).toEqual(['hi/false', 'hi/true']);       // its own flag changed
        t.rerender(h(Pane, { keystroke: 'abc', m: { id: 'm1', text: 'edited' }, hovered: true }));
        expect(runs.at(-1)).toBe('edited/true');             // new message object
        expect(t.host.textContent).toContain('edited');
        t.unmount();
    });

    it('a skipped row calling through useLiveCallbacks reaches the latest handler', () => {
        const calls: string[] = [];
        const Pane = ({ label }: { label: string }) => {
            const stable = useLiveCallbacks({ onClick: () => { calls.push(label); } }); // per-render closure inside
            return h(MemoRow, { deps: [], render: () => h('button', { onClick: stable.onClick }, 'x') });
        };
        const t = mount(h(Pane, { label: 'first' }));
        t.rerender(h(Pane, { label: 'second' }));             // row skipped
        act(() => { (t.host.querySelector('button') as HTMLButtonElement).click(); });
        expect(calls).toEqual(['second']);
        t.unmount();
    });

    it('useLiveCallbacks returns the same functions across renders', () => {
        const seen: unknown[] = [];
        const C = ({ n }: { n: number }) => { const s = useLiveCallbacks({ f: () => n }); seen.push(s.f); return null; };
        const t = mount(h(C, { n: 1 }));
        t.rerender(h(C, { n: 2 }));
        expect(seen[0]).toBe(seen[1]);
        expect((seen[1] as () => number)()).toBe(2);
        t.unmount();
    });
});

describe('useShallowStable', () => {
    it('keeps the old reference for a content-equal new array', () => {
        const seen: unknown[] = [];
        const C = ({ v }: { v: string[] }) => { seen.push(useShallowStable(v)); return null; };
        const t = mount(h(C, { v: [] }));
        t.rerender(h(C, { v: [] }));
        t.rerender(h(C, { v: ['a'] }));
        t.rerender(h(C, { v: ['a'] }));
        expect(seen[0]).toBe(seen[1]);
        expect(seen[2]).not.toBe(seen[1]);
        expect(seen[3]).toBe(seen[2]);
        t.unmount();
    });
});
