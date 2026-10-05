/**
 * Own-device ledger: the decision table in docs/ghost-device.md §7.5, which is
 * normative for the mobile port. Every row below is one row of that table,
 * numbered to match, so a port can be checked line by line.
 *
 * Plus the storage rules the pure table cannot express: never baseline from a
 * cold store, never re-baseline over unreadable bytes, never create from a
 * partial listing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = new Map<string, string>();
let ready = true;
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        isAccountReady: (uid: string) => ready && !!uid,
    },
}));

const L = await import('./ownDeviceLedger');
const {
    applyObservation, assessOwnDeviceSet, applyConfirm, applyReject, applyReviewed,
    deriveAlerts, ownRowsFromDirectory, codeMayBeShown, MAX_OWN_DEVICES,
} = L;
type OwnLedger = import('./ownDeviceLedger').OwnLedger;

const S = { deviceId: 'self', pub: 'PS' };
const T0 = 1_000;
const row = (device_id: string, pub: string) => ({ device_id, pub });

function ledgerOf(entries: [string, string, string][]): OwnLedger {
    const devices: OwnLedger['devices'] = {};
    for (const [id, status, pub] of entries) {
        devices[id] = { pub, status: status as never, first_seen: T0, ...(status === 'baseline' ? { reviewed: false } : {}) };
    }
    return { v: 1, created_at: T0, devices };
}

beforeEach(() => { mem.clear(); ready = true; L._resetSession(); });

describe('§7.5 decision table', () => {
    it('#1 no ledger + complete listing → baseline, self confirmed, verdict ok', () => {
        const next = applyObservation(null, S, [row('self', 'PS'), row('b', 'PB')], true, T0)!;
        expect(next.devices.self).toMatchObject({ status: 'confirmed', pub: 'PS' });
        expect(next.devices.b).toMatchObject({ status: 'baseline', pub: 'PB', reviewed: false });
        expect(assessOwnDeviceSet(next, [row('self', 'PS'), row('b', 'PB')], S).kind).toBe('ok');
    });

    it('#2 no ledger + PARTIAL listing → no ledger is created; every non-self row is unconfirmed', () => {
        expect(applyObservation(null, S, [row('b', 'PB')], false, T0)).toBeNull();
        const v = assessOwnDeviceSet(null, [row('self', 'PS'), row('b', 'PB')], S);
        expect(v.kind).toBe('unconfirmed');
        // Positive control for the partial rule: the SAME rows, complete, do create one.
        expect(applyObservation(null, S, [row('b', 'PB')], true, T0)).not.toBeNull();
    });

    it('#3 THE GHOST: a device appearing after the baseline is pending and withholds the code', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const rows = [row('self', 'PS'), row('b', 'PB'), row('g', 'PG')];
        const next = applyObservation(base, S, rows, true, T0 + 1)!;
        expect(next.devices.g).toMatchObject({ status: 'pending', pub: 'PG' });
        const v = assessOwnDeviceSet(next, rows, S);
        expect(v.kind).toBe('unconfirmed');
        if (v.kind === 'unconfirmed') expect(v.unconfirmed.map(d => d.device_id)).toEqual(['g']);
        expect(codeMayBeShown(v)).toBe(false);
        // Control: without the ghost row the same ledger is fine.
        expect(assessOwnDeviceSet(next, [row('self', 'PS'), row('b', 'PB')], S).kind).toBe('ok');
    });

    it('#4 the legitimate new device: one confirmation and the code is available again', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const rows = [row('self', 'PS'), row('b', 'PB'), row('g', 'PG')];
        const seen = applyObservation(base, S, rows, true, T0 + 1)!;
        const confirmed = applyConfirm(seen, 'g', 'PG', T0 + 2);
        expect(confirmed.devices.g).toMatchObject({ status: 'confirmed', pub: 'PG', first_seen: T0 + 1 });
        expect(assessOwnDeviceSet(confirmed, rows, S).kind).toBe('ok');
    });

    it('#5 a known own device presenting a different key: pin kept, verdict own_key_changed', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const rows = [row('self', 'PS'), row('b', 'PX')];
        const next = applyObservation(base, S, rows, true, T0 + 1)!;
        expect(next.devices.b.pub).toBe('PB');
        const v = assessOwnDeviceSet(next, rows, S);
        expect(v.kind).toBe('own_key_changed');
        if (v.kind === 'own_key_changed') expect(v.changed.map(d => d.device_id)).toEqual(['b']);
    });

    it('#6 this device listed with a key it does not hold → self_key_mismatch (the substitution variant)', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS']]);
        const rows = [row('self', 'PX')];
        const next = applyObservation(base, S, rows, true, T0 + 1)!;
        expect(next.devices.self.pub).toBe('PS');
        expect(assessOwnDeviceSet(next, rows, S).kind).toBe('self_key_mismatch');
    });

    it('#7 this device missing from the listing → self_missing (code withheld)', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const v = assessOwnDeviceSet(applyObservation(base, S, [row('b', 'PB')], true, T0 + 1), [row('b', 'PB')], S);
        expect(v.kind).toBe('self_missing');
        expect(codeMayBeShown(v)).toBe(false);
    });

    it('#8 a device dropping out of a complete listing is marked gone, not deleted', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const next = applyObservation(base, S, [row('self', 'PS')], true, T0 + 5)!;
        expect(next.devices.b).toMatchObject({ gone_at: T0 + 5, pub: 'PB' });
        expect(assessOwnDeviceSet(next, [row('self', 'PS')], S).kind).toBe('ok');
        // Reappears: gone mark cleared, status untouched.
        const back = applyObservation(next, S, [row('self', 'PS'), row('b', 'PB')], true, T0 + 6)!;
        expect(back.devices.b.gone_at).toBeUndefined();
        expect(back.devices.b.status).toBe('baseline');
    });

    it('#9 a PARTIAL listing (own rows in /conversations/:id/devices) still records a ghost', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const next = applyObservation(base, S, [row('b', 'PB'), row('g', 'PG')], false, T0 + 1)!;
        expect(next.devices.g).toMatchObject({ status: 'pending' });
        // Partial never marks anything gone.
        expect(next.devices.b.gone_at).toBeUndefined();
    });

    it('#10 rejected stays unconfirmed while it is still listed', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB'], ['g', 'pending', 'PG']]);
        const rejected = applyReject(base, 'g', 'PG', T0 + 1);
        expect(rejected.devices.g.status).toBe('rejected');
        const v = assessOwnDeviceSet(rejected, [row('self', 'PS'), row('b', 'PB'), row('g', 'PG')], S);
        expect(v.kind).toBe('unconfirmed');
    });
});

describe('priority and edge rules', () => {
    it('self_key_mismatch outranks everything else', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB']]);
        const v = assessOwnDeviceSet(base, [row('self', 'PX'), row('b', 'PBX'), row('g', 'PG')], S);
        expect(v.kind).toBe('self_key_mismatch');
    });

    it('a listing never re-pins this device, and the self record follows the LOCAL key', () => {
        const base = ledgerOf([['self', 'confirmed', 'OLD']]);
        const next = applyObservation(base, { deviceId: 'self', pub: 'NEW' }, [row('self', 'SERVER')], true, T0)!;
        expect(next.devices.self.pub).toBe('NEW');
    });

    it('duplicate and malformed rows are ignored rather than trusted', () => {
        const next = applyObservation(null, S, [
            row('self', 'PS'), row('b', 'PB'), row('b', 'PB2'),
            { device_id: '', pub: 'x' }, { device_id: 'c', pub: '' },
            null as unknown as { device_id: string; pub: string },
        ], true, T0)!;
        expect(Object.keys(next.devices).sort()).toEqual(['b', 'self']);
        expect(next.devices.b.pub).toBe('PB');
    });

    it(`the store is capped at ${MAX_OWN_DEVICES} records, and an uncapped extra still withholds the code`, () => {
        const many = Array.from({ length: MAX_OWN_DEVICES + 10 }, (_, i) => row(`d${i}`, `P${i}`));
        const base = ledgerOf([['self', 'confirmed', 'PS']]);
        const next = applyObservation(base, S, many, true, T0)!;
        expect(Object.keys(next.devices).length).toBeLessThanOrEqual(MAX_OWN_DEVICES + 1);
        const v = assessOwnDeviceSet(next, [row('self', 'PS'), ...many], S);
        expect(v.kind).toBe('unconfirmed');
    });

    it('applyReviewed marks only baseline records', () => {
        const base = ledgerOf([['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB'], ['g', 'pending', 'PG']]);
        const r = applyReviewed(base);
        expect(r.devices.b.reviewed).toBe(true);
        expect(r.devices.g.reviewed).toBeUndefined();
    });
});

describe('deriveAlerts (the Dashboard banner)', () => {
    it('reports new, key-changed and still-listed rejected devices; baseline only as a review', () => {
        const ledger = ledgerOf([
            ['self', 'confirmed', 'PS'], ['b', 'baseline', 'PB'], ['k', 'confirmed', 'PK'],
            ['g', 'pending', 'PG'], ['r', 'rejected', 'PR'],
        ]);
        const out = deriveAlerts(ledger, S, [row('self', 'PS'), row('b', 'PB'), row('k', 'PK2'), row('g', 'PG'), row('r', 'PR')]);
        expect(out.alerts.map(a => `${a.device_id}:${a.kind}`).sort()).toEqual(['g:new', 'k:key_changed', 'r:rejected_still_listed']);
        expect(out.unreviewedBaseline).toEqual(['b']);
        expect(out.selfKeyMismatch).toBe(false);
    });

    it('flags a self key mismatch', () => {
        const out = deriveAlerts(ledgerOf([['self', 'confirmed', 'PS']]), S, [row('self', 'PX')]);
        expect(out.selfKeyMismatch).toBe(true);
    });

    it('no ledger → nothing to say (the boot fetch has not run yet)', () => {
        expect(deriveAlerts(null, S, [row('g', 'PG')])).toEqual({ alerts: [], selfKeyMismatch: false, unreviewedBaseline: [] });
    });
});

describe('ownRowsFromDirectory', () => {
    const ME = 'me';
    it('identity_keys for me is complete', () => {
        const r = ownRowsFromDirectory([{ device_id: 'a', identity_key_pub_b64: 'PA' }], ME, '/v1/keys/identity_keys?user_id=me', ME);
        expect(r).toEqual({ rows: [{ device_id: 'a', pub: 'PA' }], complete: true });
    });
    it('identity_keys for someone else says nothing about me', () => {
        expect(ownRowsFromDirectory([{ device_id: 'a', identity_key_pub_b64: 'PA' }], 'bob', '/v1/keys/identity_keys?user_id=bob', ME)).toBeNull();
    });
    it('conversation devices: only my rows, partial', () => {
        const r = ownRowsFromDirectory([
            { user_id: ME, device_id: 'a', identity_pub_b64: 'PA' },
            { user_id: 'bob', device_id: 'b', identity_pub_b64: 'PB' },
        ], null, '/v1/conversations/c1/devices?claim_otp=1', ME);
        expect(r).toEqual({ rows: [{ device_id: 'a', pub: 'PA' }], complete: false });
    });
    it('other directory URLs are ignored', () => {
        expect(ownRowsFromDirectory([{ user_id: ME, device_id: 'a', identity_pub_b64: 'PA' }], null, '/v1/servers/s/members/me/devices', ME)).toBeNull();
    });
});

describe('storage rules', () => {
    const ME = 'me-user';

    it('a cold (not-ready) store is never baselined', () => {
        ready = false;
        expect(L.observeOwnDevices(ME, S, [row('self', 'PS'), row('g', 'PG')], true)).toBe(false);
        expect(mem.size).toBe(0);
        expect(L.loadOwnLedger(ME)).toBeUndefined();
        // Control: once ready, the same call creates it.
        ready = true;
        expect(L.observeOwnDevices(ME, S, [row('self', 'PS'), row('g', 'PG')], true)).toBe(true);
        expect(L.loadOwnLedger(ME)?.devices.g.status).toBe('baseline');
    });

    it('unreadable bytes on disk are not overwritten by a fresh baseline', () => {
        mem.set(L.ledgerKey(ME), '{not json');
        expect(L.observeOwnDevices(ME, S, [row('self', 'PS'), row('g', 'PG')], true)).toBe(false);
        expect(mem.get(L.ledgerKey(ME))).toBe('{not json');
    });

    it('end to end through the store: baseline, ghost alarm, confirm clears it', () => {
        L.observeOwnDevices(ME, S, [row('self', 'PS'), row('b', 'PB')], true, T0);
        expect(L.currentOwnAlerts(ME, S).alerts).toEqual([]);
        L.observeOwnDevices(ME, S, [row('b', 'PB'), row('g', 'PG')], false, T0 + 1);
        expect(L.currentOwnAlerts(ME, S).alerts.map(a => a.device_id)).toEqual(['g']);
        const heard: string[] = [];
        const off = L.subscribeOwnLedger(uid => heard.push(uid));
        L.confirmOwnDevice(ME, 'g', 'PG');
        off();
        expect(heard).toEqual([ME]);
        expect(L.currentOwnAlerts(ME, S).alerts).toEqual([]);
    });
});
