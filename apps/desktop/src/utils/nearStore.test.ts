import { describe, it, expect } from 'vitest';
import { createNearStore } from './nearStore';
import type { NearSnapshot } from '../types/near';

const s = (seq: number, state: NearSnapshot['state'] = 'idle'): NearSnapshot => ({ seq, role: null, state });
const flush = () => new Promise(r => setTimeout(r, 0));

describe('near store', () => {
    it('applies the initial state, then events in order; drops an older seq', async () => {
        let cb: (x: NearSnapshot) => void = () => undefined;
        const store = createNearStore({ nearGetState: async () => s(5), onNearState: c => { cb = c; return () => undefined; } });
        await flush();
        expect(store.getSnapshot()?.seq).toBe(5);
        cb(s(7, 'showing_code')); expect(store.getSnapshot()?.state).toBe('showing_code');
        cb(s(6, 'failed')); expect(store.getSnapshot()?.seq).toBe(7);
    });
    it('ignores malformed events and a missing bridge', async () => {
        let cb: (x: unknown) => void = () => undefined;
        const store = createNearStore({ onNearState: c => { cb = c as (x: unknown) => void; return () => undefined; } });
        cb(null); cb({ seq: 'x' }); cb('hi'); cb({ state: 'idle' });
        expect(store.getSnapshot()).toBeNull();
        expect(createNearStore(undefined).getSnapshot()).toBeNull();
    });
    it('a rejecting nearGetState is not fatal; subscribe/clear notify; dispose stops events', async () => {
        let cb: (x: NearSnapshot) => void = () => undefined;
        const store = createNearStore({ nearGetState: async () => { throw new Error('n/a'); }, onNearState: c => { cb = c; return () => undefined; } });
        await flush();
        let n = 0; store.subscribe(() => { n++; });
        cb(s(1)); store.clear();
        expect(n).toBe(2); expect(store.getSnapshot()).toBeNull();
        store.dispose(); cb(s(9)); expect(store.getSnapshot()).toBeNull();
    });
});
