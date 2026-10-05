// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The hook side of per-device storage setup:
 *  - useDeviceStorageSetup must not decide before the account's records are
 *    hydrated (secure_local_store_account_rebind), adopts an existing install
 *    silently, and prompts a fresh one;
 *  - useRetentionPolicy must NOT write the freshly-loaded policy back on mount
 *    (that write used to stamp DEFAULT_POLICY onto every account and would
 *    now read as "this device already chose", suppressing the prompt), must
 *    still persist real user changes, and must reload when the prompt / a
 *    restore rewrites the record behind its back.
 * `.test.ts` + createElement because vitest only collects `*.test.ts`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mem = new Map<string, string>();
const writes: string[] = [];
let readyUser: string | null = null;
let releaseReady: () => void = () => {};
let readyPromise: Promise<void> = Promise.resolve();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    whenAccountReady: () => readyPromise,
    isAccountReady: (u: string) => !!u && readyUser === u,
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { useDeviceStorageSetup } = await import('./useDeviceStorageSetup');
const { useRetentionPolicy } = await import('./useRetentionPolicy');
const { RECOMMENDED_RETENTION } = await import('../utils/deviceStorageSetup');

const U = 'hook-user';
const POLICY_KEY = `cipherline_storage_policy_${U}`;
const MARKER_KEY = `cipherline_device_storage_setup_${U}`;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    mem.clear();
    writes.length = 0;
    readyUser = U;
    readyPromise = Promise.resolve();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function probeSetup(uid: string) {
    const out: { current: ReturnType<typeof useDeviceStorageSetup> | null } = { current: null };
    const Probe = () => { out.current = useDeviceStorageSetup(uid); return null; };
    act(() => root.render(React.createElement(Probe)));
    return out;
}

describe('useDeviceStorageSetup', () => {
    it('stays "checking" until the account is hydrated, then prompts a fresh device', async () => {
        readyUser = null;
        readyPromise = new Promise<void>(r => { releaseReady = () => { readyUser = U; r(); }; });
        const h = probeSetup(U);
        await flush();
        expect(h.current!.status).toBe('checking');
        await act(async () => { releaseReady(); await readyPromise; });
        await flush();
        expect(h.current!.status).toBe('prompt');
    });

    it('never decides from a cold namespace: records that land during hydration are honoured', async () => {
        // Cold: nothing readable yet. The marker "arrives" with hydration.
        readyUser = null;
        readyPromise = new Promise<void>(r => { releaseReady = () => { mem.set(MARKER_KEY, '{"v":1}'); readyUser = U; r(); }; });
        const h = probeSetup(U);
        await flush();
        await act(async () => { releaseReady(); await readyPromise; });
        await flush();
        expect(h.current!.status).toBe('done');
    });

    it('adopts an existing install silently and records the marker', async () => {
        mem.set(POLICY_KEY, JSON.stringify({ attachmentRetention: '24h', messageRetention: 'never' }));
        const h = probeSetup(U);
        await flush();
        expect(h.current!.status).toBe('done');
        expect(JSON.parse(mem.get(MARKER_KEY)!).how).toBe('existing-install');
    });

    it('complete() persists the choice and flips to done', async () => {
        const h = probeSetup(U);
        await flush();
        expect(h.current!.status).toBe('prompt');
        act(() => h.current!.complete({ ...RECOMMENDED_RETENTION }, 'recommended'));
        expect(h.current!.status).toBe('done');
        expect(JSON.parse(mem.get(POLICY_KEY)!).dmMessageRetention).toBe('1y');
    });
});

describe('useRetentionPolicy — persists user changes only', () => {
    function probePolicy(uid: string) {
        const out: { current: ReturnType<typeof useRetentionPolicy> | null } = { current: null };
        const Probe = () => { out.current = useRetentionPolicy(uid); return null; };
        act(() => root.render(React.createElement(Probe)));
        return out;
    }

    it('mounting on a device with no policy writes nothing (so the prompt still shows)', async () => {
        probePolicy(U);
        await flush();
        expect(writes.filter(k => k === POLICY_KEY)).toEqual([]);
        expect(mem.has(POLICY_KEY)).toBe(false);
    });

    it('POSITIVE CONTROL: a user change IS persisted', async () => {
        const h = probePolicy(U);
        await flush();
        act(() => h.current!.setMessageRetention('1mo'));
        await flush();
        expect(JSON.parse(mem.get(POLICY_KEY)!).messageRetention).toBe('1mo');
    });

    it('reloads when the record is rewritten behind its back (prompt save / restore)', async () => {
        const h = probePolicy(U);
        await flush();
        expect(h.current!.policy.dmMessageRetention).toBeUndefined();
        mem.set(POLICY_KEY, JSON.stringify({ messageRetention: 'never', attachmentRetention: 'never', dmMessageRetention: '6mo', savedMessageIds: ['s'] }));
        writes.length = 0;
        act(() => { window.dispatchEvent(new CustomEvent('cipherline:storage-policy-changed', { detail: { userId: U } })); });
        await flush();
        expect(h.current!.policy.dmMessageRetention).toBe('6mo');
        expect(h.current!.policy.savedMessageIds).toEqual(['s']);
        // Reloading is not a user change — no write-back.
        expect(writes).toEqual([]);
    });
});
