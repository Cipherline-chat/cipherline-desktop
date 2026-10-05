// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
const writes: string[] = [];
let readyUser: string | null = null;
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); writes.push(k); },
        removeItem: (k: string) => { store.delete(k); },
        isAccountReady: (u: string) => readyUser === u,
    };
    return { default: api, secureLocalStore: api };
});

import { useGameSettings, gameSettingsKey } from './useGameSettings';

const A = 'user-a', B = 'user-b';
type Hook = ReturnType<typeof useGameSettings>;
let latest: Hook | null = null;
let root: Root | null = null;
const Probe: React.FC<{ userId: string | null }> = ({ userId }) => {
    // eslint-disable-next-line react-hooks/globals -- test probe
    latest = useGameSettings(userId); return null;
};
const mount = (userId: string | null) => {
    root = createRoot(document.createElement('div'));
    act(() => { root!.render(React.createElement(Probe, { userId })); });
};
const rerender = (userId: string | null) => act(() => { root!.render(React.createElement(Probe, { userId })); });

beforeEach(() => { store.clear(); writes.length = 0; readyUser = null; latest = null; });
afterEach(() => { act(() => { root?.unmount(); }); root = null; });

describe('useGameSettings per account', () => {
    it('reads the account-scoped record and never writes on mount', () => {
        store.set(gameSettingsKey(A), JSON.stringify({ ignoredProcesses: ['solitaire'] }));
        readyUser = A;
        mount(A);
        expect(latest!.settings.ignoredProcesses).toEqual(['solitaire']);
        expect(writes).toEqual([]);                       // the old hook wrote back immediately
    });

    it('migrates from the legacy device-global record when the account has none, without touching it', () => {
        store.set('cipherline_game_settings', JSON.stringify({ ignoredProcesses: ['old-global'] }));
        readyUser = A;
        mount(A);
        expect(latest!.settings.ignoredProcesses).toEqual(['old-global']);
        expect(writes).toEqual([]);
        act(() => { latest!.addIgnoredProcess('Minesweeper'); });
        expect(store.get(gameSettingsKey(A))).toContain('minesweeper');
        expect(store.get('cipherline_game_settings')).toBe(JSON.stringify({ ignoredProcesses: ['old-global'] })); // legacy untouched
    });

    it("two accounts on one device keep separate lists; B's changes never reach A", () => {
        readyUser = A; mount(A);
        act(() => { latest!.addIgnoredProcess('a-game'); });
        readyUser = B; rerender(B);
        expect(latest!.settings.ignoredProcesses).toEqual([]);
        act(() => { latest!.addIgnoredProcess('b-game'); });
        expect(JSON.parse(store.get(gameSettingsKey(A))!).ignoredProcesses).toEqual(['a-game']);
        expect(JSON.parse(store.get(gameSettingsKey(B))!).ignoredProcesses).toEqual(['b-game']);
        readyUser = A; rerender(A);
        expect(latest!.settings.ignoredProcesses).toEqual(['a-game']);
    });

    it('refuses to persist into an account whose records are not loaded yet', () => {
        readyUser = null;                                  // rebind in flight
        mount(A);
        act(() => { latest!.addIgnoredProcess('x'); });
        expect(store.has(gameSettingsKey(A))).toBe(false);
    });
});
