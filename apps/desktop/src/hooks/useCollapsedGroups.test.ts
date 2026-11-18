// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
const writes: string[] = [];
let readyUser: string | null = null;
let releaseReady: () => void = () => {};
let readyPromise: Promise<void> = Promise.resolve();
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); writes.push(`set ${k}`); },
        removeItem: (k: string) => { store.delete(k); writes.push(`rm ${k}`); },
        isAccountReady: (u: string) => readyUser === u,
        whenAccountReady: () => readyPromise,
    };
    return { default: api, secureLocalStore: api };
});

import { useCollapsedGroups } from './useCollapsedGroups';
import { memberGroupsCollapsedKey } from '../utils/memberGroupCollapse';

const A = 'user-a', B = 'user-b';
const kA1 = memberGroupsCollapsedKey(A, 's1');
const kA2 = memberGroupsCollapsedKey(A, 's2');
const kB1 = memberGroupsCollapsedKey(B, 's1');

type G = ReturnType<typeof useCollapsedGroups>;
let g: G | null = null;
let root: Root | null = null;

interface ProbeProps { storageKey: string | null; userId: string | null; valid: ReadonlySet<string> | null }
const Probe: React.FC<ProbeProps> = ({ storageKey, userId, valid }) => {
    // eslint-disable-next-line react-hooks/globals -- test probe
    g = useCollapsedGroups(storageKey, userId, valid);
    return null;
};
const render = (p: ProbeProps) => act(() => {
    if (!root) root = createRoot(document.createElement('div'));
    root.render(React.createElement(Probe, p));
});

beforeEach(() => {
    store.clear(); writes.length = 0; readyUser = A; g = null;
    readyPromise = Promise.resolve();
});
afterEach(() => { act(() => { root?.unmount(); }); root = null; });

describe('useCollapsedGroups', () => {
    it('reads the stored state and never writes on mount', () => {
        store.set(kA1, '["offline","role:mods"]');
        render({ storageKey: kA1, userId: A, valid: null });
        expect(g!.isCollapsed('offline')).toBe(true);
        expect(g!.isCollapsed('role:mods')).toBe(true);
        expect(g!.isCollapsed('online')).toBe(false);
        expect(writes).toEqual([]);
    });

    it('toggle persists under the per-account, per-server key; un-collapsing everything removes the key', () => {
        render({ storageKey: kA1, userId: A, valid: null });
        act(() => { g!.toggle('online'); });
        expect(g!.isCollapsed('online')).toBe(true);
        expect(store.get(kA1)).toBe('["online"]');
        act(() => { g!.toggle('online'); });
        expect(g!.isCollapsed('online')).toBe(false);
        expect(store.has(kA1)).toBe(false);
        expect(writes).toEqual([`set ${kA1}`, `rm ${kA1}`]);
    });

    it('expand only writes when the group was collapsed', () => {
        store.set(kA1, '["offline"]');
        render({ storageKey: kA1, userId: A, valid: null });
        act(() => { g!.expand('online'); });
        expect(writes).toEqual([]);
        act(() => { g!.expand('offline'); });
        expect(g!.isCollapsed('offline')).toBe(false);
        expect(writes).toEqual([`rm ${kA1}`]);
    });

    it('servers are independent, and a switch reads the new server in the same render', () => {
        store.set(kA1, '["offline"]');
        store.set(kA2, '["online"]');
        render({ storageKey: kA1, userId: A, valid: null });
        expect(g!.isCollapsed('offline')).toBe(true);
        render({ storageKey: kA2, userId: A, valid: null });
        expect(g!.isCollapsed('offline')).toBe(false);
        expect(g!.isCollapsed('online')).toBe(true);
        act(() => { g!.toggle('offline'); });
        expect(store.get(kA2)).toBe('["offline","online"]');
        expect(store.get(kA1)).toBe('["offline"]'); // untouched
    });

    it('accounts are independent: B never sees or writes A', () => {
        store.set(kA1, '["offline"]');
        readyUser = B;
        render({ storageKey: kB1, userId: B, valid: null });
        expect(g!.isCollapsed('offline')).toBe(false);
        act(() => { g!.toggle('online'); });
        expect(store.get(kB1)).toBe('["online"]');
        expect(store.get(kA1)).toBe('["offline"]');
    });

    it('prunes ids of deleted / un-hoisted roles once the roster is known, and writes the trimmed list', () => {
        store.set(kA1, '["offline","role:gone","role:mods"]');
        render({ storageKey: kA1, userId: A, valid: null });
        expect(writes).toEqual([]);                          // roster unknown: no pruning
        render({ storageKey: kA1, userId: A, valid: new Set(['online', 'offline', 'role:mods']) });
        expect(g!.isCollapsed('role:gone')).toBe(false);
        expect(store.get(kA1)).toBe('["offline","role:mods"]');
        expect(writes).toEqual([`set ${kA1}`]);
    });

    it('nothing stale: no write', () => {
        store.set(kA1, '["offline"]');
        render({ storageKey: kA1, userId: A, valid: new Set(['online', 'offline']) });
        expect(writes).toEqual([]);
    });

    it('cold namespace (account switch in flight): no write — neither prune nor toggle — then re-reads once ready', async () => {
        readyUser = null;
        readyPromise = new Promise<void>(r => { releaseReady = r; });
        render({ storageKey: kA1, userId: A, valid: new Set(['online', 'offline']) });
        expect(g!.isCollapsed('offline')).toBe(false);       // cold: nothing there yet
        act(() => { g!.toggle('online'); });                 // in-memory only
        expect(writes).toEqual([]);
        // the real record arrives, the account becomes ready
        store.set(kA1, '["offline","role:gone"]');
        readyUser = A;
        await act(async () => { releaseReady(); await readyPromise; });
        expect(g!.isCollapsed('offline')).toBe(true);
        // and the now-allowed prune trims the stale role id
        expect(store.get(kA1)).toBe('["offline"]');
    });

    it('no user / no key: inert', () => {
        render({ storageKey: null, userId: null, valid: new Set(['online']) });
        act(() => { g!.toggle('online'); });
        expect(g!.isCollapsed('online')).toBe(true);
        expect(writes).toEqual([]);
    });
});
