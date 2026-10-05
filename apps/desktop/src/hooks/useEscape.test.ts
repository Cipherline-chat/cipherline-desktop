// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEscape } from './useEscape';
import { escapeLayerCount, __resetEscapeStackForTests } from '../utils/escapeStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const press = () => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
);

const Layer = ({ onEsc, active = true }: { onEsc: () => void; active?: boolean }) => {
    useEscape(onEsc, active);
    return null;
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const render = (el: React.ReactElement) => {
    if (!host) { host = document.createElement('div'); document.body.appendChild(host); }
    if (!root) root = createRoot(host);
    act(() => root!.render(el));
};

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    __resetEscapeStackForTests();
});

describe('useEscape', () => {
    it('registers only while active', () => {
        const fn = vi.fn();
        render(React.createElement(Layer, { onEsc: fn, active: false }));
        expect(escapeLayerCount()).toBe(0);
        render(React.createElement(Layer, { onEsc: fn, active: true }));
        expect(escapeLayerCount()).toBe(1);
        act(() => press());
        expect(fn).toHaveBeenCalledTimes(1);
        render(React.createElement(Layer, { onEsc: fn, active: false }));
        expect(escapeLayerCount()).toBe(0);
    });

    it('a re-render with a NEW handler does not jump that layer to the top of the stack', () => {
        // The hazard: an editor underneath an open dialog re-renders on every
        // keystroke-driven state change. If that re-registered its layer, the
        // editor would take Escape away from the dialog on top of it.
        const under = vi.fn();
        const over = vi.fn();
        const Tree = ({ tick }: { tick: number }) => React.createElement(React.Fragment, null,
            React.createElement(Layer, { key: 'under', onEsc: () => under(tick) }),
            React.createElement(Layer, { key: 'over', onEsc: over }),
        );
        render(React.createElement(Tree, { tick: 1 }));
        render(React.createElement(Tree, { tick: 2 })); // `under` gets a new closure
        act(() => press());
        expect(over).toHaveBeenCalledTimes(1);
        expect(under).not.toHaveBeenCalled();
        expect(escapeLayerCount()).toBe(2);
    });

    it('uses the latest handler without re-registering', () => {
        const calls: number[] = [];
        const Tree = ({ n }: { n: number }) => React.createElement(Layer, { onEsc: () => { calls.push(n); } });
        render(React.createElement(Tree, { n: 1 }));
        render(React.createElement(Tree, { n: 2 }));
        act(() => press());
        expect(calls).toEqual([2]);
    });

    it('unregisters on unmount', () => {
        render(React.createElement(Layer, { onEsc: () => {} }));
        expect(escapeLayerCount()).toBe(1);
        act(() => root!.unmount());
        root = null;
        expect(escapeLayerCount()).toBe(0);
    });
});
