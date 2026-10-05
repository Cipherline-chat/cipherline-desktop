// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoWithStableCallbacks } from './memoWithStableCallbacks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ChildProps = { label: string; onPick: (x: number) => string };
let renders = 0;
let lastOnPick: ChildProps['onPick'] | null = null;
const Child: React.FC<ChildProps> = ({ label, onPick }) => { renders++; lastOnPick = onPick; return React.createElement('span', null, label); };
const Stable = memoWithStableCallbacks(Child);

let root: Root | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; renders = 0; lastOnPick = null; });

const render = async (label: string, tag: string) => {
    // A fresh inline callback every parent render — the case plain memo can't handle.
    await act(async () => { root!.render(React.createElement(Stable, { label, onPick: (x: number) => `${tag}:${x}` })); });
};

describe('memoWithStableCallbacks', () => {
    it('skips re-rendering when only callback identities changed', async () => {
        root = createRoot(document.createElement('div'));
        await render('a', 'v1');
        await render('a', 'v2');
        await render('a', 'v3');
        expect(renders).toBe(1);
    });

    it('re-renders when data props change', async () => {
        root = createRoot(document.createElement('div'));
        await render('a', 'v1');
        await render('b', 'v1');
        expect(renders).toBe(2);
    });

    it('a callback captured on an OLD render still calls the LATEST function (no stale closure)', async () => {
        root = createRoot(document.createElement('div'));
        await render('a', 'v1');
        const captured = lastOnPick!;
        await render('a', 'v2');            // child did not re-render…
        expect(renders).toBe(1);
        expect(captured(7)).toBe('v2:7');   // …but the proxy forwards to v2
    });
});
