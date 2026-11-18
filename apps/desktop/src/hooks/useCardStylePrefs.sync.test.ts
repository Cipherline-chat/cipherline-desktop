// @vitest-environment jsdom
/**
 * "My styles" user actions stamp the library for sync (created/at, tombstone on
 * delete) and announce a USER edit; reading and the cold-store guard write nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const USER = 'u1';
const mem = new Map<string, string>();
const gate = vi.hoisted(() => ({ ready: true }));
vi.mock('../utils/secureLocalStore', () => {
    const store = {
        isAccountReady: () => gate.ready,
        whenAccountReady: async () => {},
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        removeItem: (k: string) => { mem.delete(k); },
    };
    return { default: store, secureLocalStore: store };
});

import { useCardStyleLibrary, CARD_STYLE_USER_EDIT_EVENT, readCardStyleLibrary } from './useCardStylePrefs';
import { parseStyleMeta, cardStyleMetaKey } from '../utils/cardStyleSync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useCardStyleLibrary>;
const Probe: React.FC = () => { api = useCardStyleLibrary(USER); return null; };
const meta = () => parseStyleMeta(mem.get(cardStyleMetaKey(USER)), Date.now());
const edits: unknown[] = [];
const onEdit = (e: Event) => edits.push((e as CustomEvent).detail);

beforeEach(async () => {
    mem.clear(); edits.length = 0; gate.ready = true;
    window.addEventListener(CARD_STYLE_USER_EDIT_EVENT, onEdit);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(Probe)); });
});
afterEach(() => { window.removeEventListener(CARD_STYLE_USER_EDIT_EVENT, onEdit); act(() => root.unmount()); host.remove(); });

describe('useCardStyleLibrary stamps for sync', () => {
    it('mount writes nothing', () => {
        expect(mem.size).toBe(0);
        expect(edits).toEqual([]);
    });

    it('save / rename / remove stamp created, bump at, and leave a tombstone; each announces a user edit', async () => {
        let id = '';
        await act(async () => { id = api.save('Warm', { v: 1, text: '#ffefd2' })!.id; });
        expect(meta().stamps[id].created).toBe(meta().stamps[id].at);
        const created = meta().stamps[id];
        await act(async () => { api.rename(id, 'Warmer'); });
        expect(meta().stamps[id].created).toBe(created.created);
        expect(meta().stamps[id].at).toBeGreaterThan(created.at);
        expect(readCardStyleLibrary(USER)[0].name).toBe('Warmer');
        await act(async () => { api.remove(id); });
        expect(readCardStyleLibrary(USER)).toEqual([]);
        expect(meta().stamps[id]).toBeUndefined();
        expect(meta().tombstones[id]).toBeGreaterThan(created.at);
        expect(edits).toEqual([{ userId: USER }, { userId: USER }, { userId: USER }]);
    });

    it('editing a legacy (unstamped) library materialises stamps without reordering it', async () => {
        mem.set(`cipherline_card_styles_${USER}`, JSON.stringify({ v: 1, items: [
            { id: 'b', name: 'B', style: { v: 1, text: '#ffffff' } }, { id: 'a', name: 'A', style: { v: 1, text: '#ffffff' } },
        ] }));
        await act(async () => { api.rename('a', 'A2'); });
        const m = meta();
        expect(m.stamps.b.created).toBeLessThan(m.stamps.a.created);
        expect(readCardStyleLibrary(USER).map(e => e.id)).toEqual(['b', 'a']);
    });

    it('a cold account store refuses the write and announces nothing', async () => {
        gate.ready = false;
        await act(async () => { expect(api.save('X', { v: 1, text: '#ffffff' })).toBeNull(); });
        expect(mem.size).toBe(0);
        expect(edits).toEqual([]);
    });
});
