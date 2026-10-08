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

import { useServerRailLayout, serverRailOrderKey, serverRailLayoutKey, loadRailLayout } from './useServerRailLayout';
import { flattenServerIds, folderKey, serverKey, type RailLayout } from './serverFolders';

const A = 'user-a', B = 'user-b';
type Hook = ReturnType<typeof useServerRailLayout>;
let latest: Hook | null = null;
let root: Root | null = null;
const Probe: React.FC<{ userId: string | null; ids: string[] }> = ({ userId, ids }) => {
    // eslint-disable-next-line react-hooks/globals -- test probe
    latest = useServerRailLayout(userId, ids); return null;
};
const mount = (userId: string | null, ids: string[]) => {
    root = createRoot(document.createElement('div'));
    act(() => { root!.render(React.createElement(Probe, { userId, ids })); });
};
const rerender = (userId: string | null, ids: string[]) =>
    act(() => { root!.render(React.createElement(Probe, { userId, ids })); });

const order = () => flattenServerIds(latest!.layout);
const shape = (l: RailLayout) => l.items.map(it => it.kind === 'server' ? it.id : `[${it.folder.serverIds.join(',')}]`);
const savedV2 = (u: string) => JSON.parse(store.get(serverRailLayoutKey(u)) ?? 'null');

beforeEach(() => { store.clear(); writes.length = 0; readyUser = null; latest = null; });
afterEach(() => { act(() => { root?.unmount(); }); root = null; });

describe('useServerRailLayout — legacy order compatibility', () => {
    it('migrates a pre-folder saved ORDER (bare id array) and never writes on mount', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        readyUser = A;
        mount(A, ['s1', 's2']);
        expect(order()).toEqual(['s2', 's1']);
        expect(writes).toEqual([]); // the useGameSettings-class bug: writing loaded state back on mount
    });

    it('the v2 record wins over the legacy order when both exist', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s1', 's2', 's3']));
        store.set(serverRailLayoutKey(A), JSON.stringify({ v: 2, items: ['s3', { id: 'f1', name: 'Games', color: 'glow', servers: ['s1', 's2'] }] }));
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        expect(shape(latest!.layout)).toEqual(['s3', '[s1,s2]']);
    });

    it('a corrupt v2 record falls back to the legacy order instead of throwing', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        store.set(serverRailLayoutKey(A), '{not json');
        expect(flattenServerIds(loadRailLayout(A))).toEqual(['s2', 's1']);
    });

    it('every change writes BOTH the v2 layout and the flattened legacy order (downgrade-safe)', () => {
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        act(() => { latest!.createFolder('s1', 's3'); });
        expect(shape(latest!.layout)).toEqual(['[s1,s3]', 's2']);
        expect(JSON.parse(store.get(serverRailOrderKey(A))!)).toEqual(['s1', 's3', 's2']);
        expect(savedV2(A).v).toBe(2);
        expect(savedV2(A).items[0].servers).toEqual(['s1', 's3']);
    });
});

describe('useServerRailLayout — per account', () => {
    it('a cold account namespace (not yet ready) does NOT overwrite a real saved layout', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        readyUser = null; // record on disk, account not marked ready yet
        mount(A, ['s1', 's2']);
        act(() => { latest!.moveBy(serverKey('s1'), 1); });
        expect(store.get(serverRailOrderKey(A))).toBe(JSON.stringify(['s2', 's1']));
        expect(store.get(serverRailLayoutKey(A))).toBeUndefined();
    });

    it('two accounts on one device keep separate layouts; switching reloads, not merges', () => {
        store.set(serverRailOrderKey(A), JSON.stringify(['s2', 's1']));
        store.set(serverRailLayoutKey(B), JSON.stringify({ v: 2, items: [{ id: 'f', name: 'B stuff', color: null, servers: ['s3', 's1'] }] }));
        readyUser = A;
        mount(A, ['s1', 's2']);
        expect(order()).toEqual(['s2', 's1']);

        readyUser = B;
        rerender(B, ['s1', 's3']);
        expect(shape(latest!.layout)).toEqual(['[s3,s1]']);
        expect(store.get(serverRailOrderKey(A))).toBe(JSON.stringify(['s2', 's1'])); // untouched
        expect(writes).toEqual([]);
    });
});

describe('useServerRailLayout — operations', () => {
    it('drag-reorder persists the full reconciled layout for the ready account', () => {
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        act(() => { latest!.move(serverKey('s1'), serverKey('s3'), 'after'); });
        expect(order()).toEqual(['s2', 's3', 's1']);
        expect(JSON.parse(store.get(serverRailOrderKey(A))!)).toEqual(['s2', 's3', 's1']);
    });

    it('keyboard reorder clamps at the boundary as a no-op (no write)', () => {
        readyUser = A;
        mount(A, ['s1', 's2']);
        let moved = true;
        act(() => { moved = latest!.moveBy(serverKey('s1'), -1); });
        expect(moved).toBe(false);
        expect(store.get(serverRailLayoutKey(A))).toBeUndefined();
        act(() => { latest!.moveBy(serverKey('s1'), 1); });
        expect(order()).toEqual(['s2', 's1']);
    });

    it('folder lifecycle: create → rename → colour → add → remove → dissolve', () => {
        readyUser = A;
        mount(A, ['s1', 's2', 's3', 's4']);
        act(() => { latest!.createFolder('s2', 's4'); });
        const f = latest!.layout.items.find(it => it.kind === 'folder');
        expect(f && f.kind === 'folder').toBe(true);
        const id = (f as { kind: 'folder'; folder: { id: string } }).folder.id;
        act(() => { latest!.rename(id, '  Work   stuff '); });
        act(() => { latest!.setColor(id, 'flash'); });
        act(() => { latest!.addToFolder(id, 's1'); });
        expect(shape(latest!.layout)).toEqual(['[s2,s4,s1]', 's3']);
        expect(savedV2(A).items[0]).toMatchObject({ id, name: 'Work stuff', color: 'flash', servers: ['s2', 's4', 's1'] });
        act(() => { latest!.removeFromFolder('s4'); });
        expect(shape(latest!.layout)).toEqual(['[s2,s1]', 's4', 's3']);
        act(() => { latest!.removeFromFolder('s2'); }); // one left → dissolves into s1
        expect(shape(latest!.layout)).toEqual(['s1', 's2', 's4', 's3']);
    });

    it('two actions in one tick chain on the latest layout (no stale-snapshot revert)', () => {
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        act(() => {
            latest!.createFolder('s1', 's2');
            latest!.move(serverKey('s3'), serverKey('s1'), 'before'); // s1 is now inside a folder
        });
        // The second call saw the folder created by the first (s3 placement
        // falls through as a no-op on a missing top-level target) — and the
        // folder from the first call survived.
        expect(shape(latest!.layout)).toEqual(['[s1,s2]', 's3']);
        act(() => { latest!.move(serverKey('s3'), folderKey((latest!.layout.items[0] as { kind: 'folder'; folder: { id: string } }).folder.id), 'before'); });
        expect(shape(latest!.layout)).toEqual(['s3', '[s1,s2]']);
    });

    it('ungroup returns every server to the rail at the folder position', () => {
        store.set(serverRailLayoutKey(A), JSON.stringify({ v: 2, items: ['s1', { id: 'f', name: 'F', color: null, servers: ['s3', 's2'] }, 's4'] }));
        readyUser = A;
        mount(A, ['s1', 's2', 's3', 's4']);
        act(() => { latest!.ungroup('f'); });
        expect(shape(latest!.layout)).toEqual(['s1', 's3', 's2', 's4']);
    });

    it('leaving a server removes it from its folder (folder of two dissolves); a new server lands at the end, outside folders', () => {
        store.set(serverRailLayoutKey(A), JSON.stringify({ v: 2, items: [{ id: 'f', name: 'F', color: null, servers: ['s1', 's2'] }, 's3'] }));
        readyUser = A;
        mount(A, ['s1', 's2', 's3']);
        rerender(A, ['s2', 's3']); // left s1 (render-time reconcile)
        expect(shape(latest!.layout)).toEqual(['s2', 's3']);
        rerender(A, ['s2', 's3', 's9']); // joined s9
        expect(shape(latest!.layout)).toEqual(['s2', 's3', 's9']);
    });

    it('forget() persists the removal so a re-join does not resurrect the old folder slot', () => {
        store.set(serverRailLayoutKey(A), JSON.stringify({ v: 2, items: [{ id: 'f', name: 'F', color: null, servers: ['s1', 's2', 's3'] }, 's4'] }));
        readyUser = A;
        mount(A, ['s1', 's2', 's3', 's4']);
        act(() => { latest!.forget('s1'); });
        rerender(A, ['s2', 's3', 's4', 's1']); // re-joined
        expect(shape(latest!.layout)).toEqual(['[s2,s3]', 's4', 's1']);
    });

    it('positive control: without forget(), a still-saved server WOULD reappear in its folder on re-join', () => {
        store.set(serverRailLayoutKey(A), JSON.stringify({ v: 2, items: [{ id: 'f', name: 'F', color: null, servers: ['s1', 's2', 's3'] }, 's4'] }));
        readyUser = A;
        mount(A, ['s2', 's3', 's4']);
        rerender(A, ['s2', 's3', 's4', 's1']);
        expect(shape(latest!.layout)).toEqual(['[s1,s2,s3]', 's4']);
    });
});
