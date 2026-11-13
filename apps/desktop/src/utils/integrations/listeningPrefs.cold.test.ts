import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    ready: false,
    waits: 0,
    data: new Map<string, string>(),
    release: (() => {}) as () => void,
    gate: Promise.resolve() as Promise<void>,
}));
vi.mock('../secureLocalStore', () => {
    const api = {
        getItem: (k: string) => (h.ready ? h.data.get(k) ?? null : null),
        setItem: (k: string, v: string) => { h.data.set(k, v); },
        isAccountReady: () => h.ready,
        whenAccountReady: () => { h.waits++; return h.gate; },
    };
    return { default: api, secureLocalStore: api };
});

import { getListeningPrefs, listeningShareKey, resetListeningPrefsCache, useListeningPrefs } from './listeningPrefs';

const UID = 'u1';

describe('listening prefs read before the account has loaded', () => {
    beforeEach(() => {
        h.ready = false;
        h.waits = 0;
        h.data.clear();
        h.gate = new Promise<void>(r => { h.release = r; });
        resetListeningPrefsCache();
        h.data.set(listeningShareKey(UID), '1');
    });

    it('a switch that is on does not stay stuck off once the records load', async () => {
        expect(getListeningPrefs(UID).share).toBe(false);
        h.ready = true;
        h.release();
        await h.gate;
        expect(getListeningPrefs(UID).share).toBe(true);
    });

    it('returns one stable object while cold, as useSyncExternalStore requires', () => {
        expect(getListeningPrefs(UID)).toBe(getListeningPrefs(UID));
        expect(typeof useListeningPrefs).toBe('function');
    });

    it('waits once, so an account that never becomes ready cannot loop', async () => {
        h.release();
        await h.gate;
        for (let i = 0; i < 5; i++) { getListeningPrefs(UID); await Promise.resolve(); }
        expect(h.waits).toBe(1);
        expect(getListeningPrefs(UID).share).toBe(false);
    });
});
