// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
const writes: string[] = [];
let readyUser: string | null = null;
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); writes.push(k); },
        removeItem: (k: string) => { store.delete(k); },
        isAccountReady: (u: string) => readyUser === u,
    };
    return { default: api, secureLocalStore: api };
});

import { useServerRailOrder, serverRailOrderKey } from './useServerRailOrder';

const A = 'user-a', B = 'user-b';
type Hook = ReturnType<typeof useServerRailOrder>;
let latest: Hook | null = null;
let root: Root | null = null;
const Probe: React.FC<{ userId: string | null; ids: string[] }> = ({ userId, ids }) => {
    // eslint-disable-next-line react-hooks/globals -- test probe
    latest = useServerRailOrder(userId, ids); return null;
};
const mount = (userId: string | null, ids: string[]) => {
    root = createRoot(document.createElement('div'));
    act(() => { root!.render(React.createElement(Probe, { userId, ids })); });
};
const rerender = (userId: string | null, ids: string[]) =>
    act(() => { root!.render(React.createElement(Probe, { userId, ids })); });

beforeEach(() => { store.clear(); writes.length = 0; readyUser = null; latest = null; });
afterEach(() => { act(() => { root?.unmount(); }); root = null; });

describe('useServerRailOrder per account', () => {
    it('reads the saved order and never writes on mount', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        readyUser = A;
        mount(A, ['s1', 's2']);
        expect(latest!.orderedIds).toEqual(['s2', 's1']);
        expect(writes).toEqual([]); // the useGameSettings-class bug: writing loaded state back on mount
    });

    it('a cold account namespace (not yet ready) reads as empty and does NOT overwrite a real saved order', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        readyUser = null; // account not marked ready yet, even though the record is already on disk
        mount(A, ['s1', 's2']);
        // Falls back to currentIds order for THIS render (the merge has nothing
        // saved to reconcile against from the hook's own state)...
        act(() => { latest!.moveByKeyboard('s1', 1); });
        // ...but the write is gated on isAccountReady, so even an explicit
        // user action while the account is still cold must not persist and
        // clobber the real record.
        expect(store.get(serverRailOrderKey(A))).toBe(JSON.stringify(['s2', 's1']));
    });

    it("two accounts on one device keep separate orders; switching accounts reloads, not merges", () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        store.set(serverRailOrderKey(B), JSON.stringify(['s3', 's1']));
        readyUser = A;
        mount(A, ['s1', 's2']);
        expect(latest!.orderedIds).toEqual(['s2', 's1']);

        readyUser = B;
        rerender(B, ['s1', 's3']);
        expect(latest!.orderedIds).toEqual(['s3', 's1']);
        expect(store.get(serverRailOrderKey(A))).toBe(JSON.stringify(['s2', 's1'])); // untouched
    });

    it('drag-and-drop reorder persists the full merged order for the ready account', () => {
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        act(() => { latest!.reorder('s1', 's3'); });
        expect(latest!.orderedIds).toEqual(['s2', 's3', 's1']);
        expect(store.get(serverRailOrderKey(A))).toBe(JSON.stringify(['s2', 's3', 's1']));
    });

    it('keyboard reorder (Alt+ArrowUp/Down) persists too, and clamps at the boundary as a no-op', () => {
        readyUser = A;
        mount(A, ['s1', 's2']);
        act(() => { latest!.moveByKeyboard('s1', -1); }); // already at the top
        expect(store.get(serverRailOrderKey(A))).toBeUndefined();
        act(() => { latest!.moveByKeyboard('s1', 1); });
        expect(latest!.orderedIds).toEqual(['s2', 's1']);
    });

    it('a server left between renders drops out of orderedIds without crashing', () => {
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        act(() => { latest!.reorder('s3', 's1'); }); // -> [s3, s1, s2]
        expect(latest!.orderedIds).toEqual(['s3', 's1', 's2']);
        rerender(A, ['s1', 's2']); // left s3
        expect(latest!.orderedIds).toEqual(['s1', 's2']);
    });

    it('a newly joined server appears at the bottom of orderedIds', () => {
        readyUser = A;
        mount(A, ['s1', 's2']);
        act(() => { latest!.reorder('s2', 's1'); }); // -> [s2, s1]
        rerender(A, ['s1', 's2', 's3']); // joined s3
        expect(latest!.orderedIds).toEqual(['s2', 's1', 's3']);
    });
});
