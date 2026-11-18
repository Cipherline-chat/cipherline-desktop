// @vitest-environment jsdom
/**
 * The sync hook end to end against a fake env: nothing runs before the account
 * store is ready (no write-on-mount), a user edit publishes after the debounce,
 * adopting a remote state does not echo, and an older API's 400 silences sync
 * (no console noise, no hot retry) while local styles keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    ready: false,
    resolveReady: null as null | (() => void),
    uploads: 0,
    metaCalls: 0,
    uploadError: null as unknown,
    setItems: [] as string[],
    hasStyles: false,
    saved: [] as unknown[],
}));

vi.mock('../utils/secureLocalStore', () => {
    const store = {
        isAccountReady: () => h.ready,
        whenAccountReady: () => new Promise<void>(res => { h.resolveReady = () => { h.ready = true; res(); }; }),
        getItem: () => null,
        setItem: (k: string) => { h.setItems.push(k); },
        removeItem: () => {},
    };
    return { default: store, secureLocalStore: store };
});

vi.mock('../services/cardStyleSyncEnv', () => ({
    createCardStyleSyncEnv: () => ({
        getSlotMeta: async () => { h.metaCalls++; return null; },
        downloadSlot: async () => null,
        uploadSlot: async () => { h.uploads++; if (h.uploadError) throw h.uploadError; },
        listOwnDeviceIds: async () => ['me', 'other'],
        fetchOwnDevices: async () => [{ device_id: 'other', spk_pub_b64: 'SPK' }],
        wrapToDevices: async () => 'ENV',
        unwrapFromEnvelope: async () => { throw new Error('n/a'); },
        generateContentKeyB64: async () => 'CK',
        encryptWithKey: async () => new Uint8Array(40),
        decryptWithKey: async () => '',
        loadLocalState: () => ({ items: h.hasStyles ? [{ id: 's1', name: 'n', style: { v: 1, text: '#ffffff' }, created: 1, at: 2 }] : [], tombstones: {} }),
        saveLocalState: () => {},
        now: () => Date.now(),
    }),
    getCardStylesView: () => null,
    setCardStylesView: () => {},
    loadLocalCardStyleState: () => ({ items: h.hasStyles ? [{ id: 's1', name: 'n', style: { v: 1, text: '#ffffff' }, created: 1, at: 2 }] : [], tombstones: { s1: 1 } }),
    saveCardStyleState: (_u: string, s: unknown) => { h.saved.push(s); return true; },
}));

import { useCardStyleSync, UNAVAILABLE_BACKOFF_MS } from './useCardStyleSync';
import { CARD_LIBRARY_CHANGED_EVENT, CARD_STYLE_USER_EDIT_EVENT } from './useCardStylePrefs';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const USER = 'u1';
let root: Root;
let host: HTMLDivElement;
const Probe: React.FC = () => { useCardStyleSync({ userId: USER, deviceId: 'me', token: 'tok' }); return null; };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const userEdit = () => act(async () => {
    h.hasStyles = true; window.dispatchEvent(new CustomEvent(CARD_STYLE_USER_EDIT_EVENT, { detail: { userId: USER } })); });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    h.ready = false; h.resolveReady = null; h.uploads = 0; h.metaCalls = 0; h.uploadError = null; h.setItems = []; h.hasStyles = false; h.saved = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useCardStyleSync', () => {
    it('does nothing until the account store is ready, then pulls once (no write-on-mount, no publish)', async () => {
        await act(async () => { root.render(React.createElement(Probe)); });
        await advance(10_000);
        expect(h.metaCalls).toBe(0);
        await act(async () => { h.resolveReady!(); });
        await advance(50);
        expect(h.metaCalls).toBeGreaterThan(0);
        expect(h.uploads).toBe(0);
        expect(h.setItems).toEqual([]);
    });

    it('a user edit publishes after the 3 s debounce; an adopted remote state (library-changed) does not', async () => {
        h.ready = true;
        await act(async () => { root.render(React.createElement(Probe)); });
        await advance(50);
        await act(async () => { window.dispatchEvent(new CustomEvent(CARD_LIBRARY_CHANGED_EVENT)); });
        await advance(10_000);
        expect(h.uploads).toBe(0);
        await userEdit();
        await advance(2_000);
        expect(h.uploads).toBe(0);
        await advance(1_500);
        expect(h.uploads).toBe(1);
    });

    it('older API: a 400 on publish is silent, local state untouched, and sync is not retried hot', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        h.ready = true;
        h.uploadError = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
        await act(async () => { root.render(React.createElement(Probe)); });
        await advance(50);
        await userEdit();
        await advance(3_500);
        expect(h.uploads).toBe(1);
        const metaAfterFirst = h.metaCalls;
        await userEdit(); await advance(3_500);
        await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
        await advance(10 * 60_000);
        expect(h.uploads).toBe(1);               // backed off: no further attempts
        expect(h.metaCalls).toBe(metaAfterFirst); // not even a probe
        expect(warn).not.toHaveBeenCalled();     // silent
        // After the backoff the API may have been deployed: try again.
        h.uploadError = null;
        // The unsent edit stayed dirty, so the first poll after the backoff retries it.
        await advance(UNAVAILABLE_BACKOFF_MS);
        expect(h.uploads).toBeGreaterThanOrEqual(2); // (the fake slot never reports content, so anti-entropy may add more)
        expect(h.setItems).toEqual([]);          // the hook itself never writes the store
    });

    it('a user backup restore / device transfer re-stamps the styles as newest, clears their tombstones, and publishes', async () => {
        h.ready = true;
        await act(async () => { root.render(React.createElement(Probe)); });
        await advance(50);
        h.hasStyles = true;
        await act(async () => { window.dispatchEvent(new CustomEvent(BACKUP_RESTORED_EVENT, { detail: { userId: USER } })); });
        const saved = h.saved[0] as { items: { at: number }[]; tombstones: Record<string, number> };
        expect(saved.items[0].at).toBe(Date.now());
        expect(saved.tombstones).toEqual({});
        await advance(3_500);
        expect(h.uploads).toBe(1);
    });

    it('another account\'s events are ignored', async () => {
        h.ready = true;
        await act(async () => { root.render(React.createElement(Probe)); });
        await advance(50);
        h.hasStyles = true;
        await act(async () => {
            window.dispatchEvent(new CustomEvent(CARD_STYLE_USER_EDIT_EVENT, { detail: { userId: 'someone-else' } }));
            window.dispatchEvent(new CustomEvent(BACKUP_RESTORED_EVENT, { detail: { userId: 'someone-else' } }));
        });
        await advance(5_000);
        expect(h.uploads).toBe(0);
        expect(h.saved).toEqual([]);
    });
});
