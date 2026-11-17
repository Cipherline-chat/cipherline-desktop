import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frameOwnSlot } from '../utils/ownSlotSync';
import { classifyKvKey } from './backupRegistry';
import {
    SERVER_RAIL_SNAPSHOT_MAGIC, MAX_FUTURE_SKEW_MS, buildRailPayload, parseRailPayload, publishServerRail, pullServerRail,
    serverRailRepublishReason, adoptRemoteRail, loadLocalRailSnapshot, serverRailLayoutKey, serverRailOrderKey,
    serverRailSyncTsKey, type RailSnapshot, type RailStore, type RailSyncEnv,
} from './serverRailSyncService';

const te = new TextEncoder();
const td = new TextDecoder();
const UID = 'u1';
const NOW = 1_800_000_000_000;

const layoutA = { v: 2, items: ['s1', { id: 'f1', name: 'Games', color: 'glow', servers: ['s2', 's3'] }] };
const layoutB = { v: 2, items: ['s3', 's1'] };

function memStore(init: Record<string, string> = {}): RailStore & { m: Map<string, string>; writes: string[] } {
    const m = new Map(Object.entries(init));
    const writes: string[] = [];
    return {
        m, writes,
        getItem: k => m.get(k) ?? null,
        setItem: (k, v) => { m.set(k, v); writes.push(k); },
        removeItem: k => { m.delete(k); },
    };
}

function makeEnv(store: ReturnType<typeof memStore>, opts: { me?: string; others?: string[] } = {}) {
    const me = opts.me ?? 'd1';
    const slot: { bytes: Uint8Array | null; rev: number } = { bytes: null, rev: 0 };
    const calls: string[] = [];
    let notified = 0;
    const env: RailSyncEnv = {
        getSlotMeta: async () => (slot.bytes ? { backup_id: 'b', updated_at: `rev-${slot.rev}` } : null),
        downloadSlot: async () => { calls.push('download'); return slot.bytes; },
        uploadSlot: async b => { calls.push('upload'); slot.bytes = b; slot.rev++; },
        listOwnDeviceIds: async () => [me, ...(opts.others ?? ['d2'])],
        fetchOwnDevices: async () => (opts.others ?? ['d2']).map(d => ({ device_id: d, spk_pub_b64: 'SPK' })),
        wrapToDevices: async (pt, devices) => `WRAPPED:${devices.map(d => d.device_id).join(',')}:${pt}`,
        unwrapFromEnvelope: async e => {
            if (!e.startsWith('WRAPPED:')) throw new Error('not addressed');
            const [, to, ...rest] = e.split(':');
            if (!to.split(',').includes(me)) throw new Error('not addressed to this device');
            return { contentJson: rest.join(':'), senderDeviceId: 'publisher' };
        },
        generateContentKeyB64: async () => 'CK',
        encryptWithKey: async pt => te.encode(pt),
        decryptWithKey: async b => td.decode(b),
        loadLocalState: () => loadLocalRailSnapshot(store, UID),
        mergeRemote: r => adoptRemoteRail(store, UID, r, () => { notified++; }),
        now: () => NOW,
        log: () => undefined,
    };
    return { env, slot, calls, notified: () => notified };
}

const remoteSlot = (snap: RailSnapshot, to: string[]) =>
    frameOwnSlot(SERVER_RAIL_SNAPSHOT_MAGIC, { v: 1, key_envelope_b64: `WRAPPED:${to.join(',')}:${JSON.stringify({ k: 'CK' })}` },
        te.encode(JSON.stringify(buildRailPayload(snap))));

// The API source only exists in the private monorepo; the public export (apps/desktop + packages/shared) skips the
// cross-repo case below and still runs every other test in this file.
const API_SLOTS_PATH = resolve(__dirname, '../../../api/src/history/backup-slots.ts');

describe('server_rail own-device sync', () => {
    it.skipIf(!existsSync(API_SLOTS_PATH))('slot name is on the API allow-list, the magic is CLRAIL1, and the env binds that slot', () => {
        const api = readFileSync(API_SLOTS_PATH, 'utf8');
        expect(api).toMatch(/BACKUP_SLOTS = \[[^\]]*'server_rail'/);
        expect(SERVER_RAIL_SNAPSHOT_MAGIC).toBe('CLRAIL1');
        const svc = readFileSync(resolve(__dirname, 'serverRailSyncService.ts'), 'utf8');
        expect(svc).toMatch(/SERVER_RAIL_SLOT = 'server_rail'/);
        const env = readFileSync(resolve(__dirname, 'serverRailSyncEnv.ts'), 'utf8');
        expect(env).toMatch(/createOwnSlotEnv\(auth, SERVER_RAIL_SLOT\)/);
    });

    it('payload is exactly {"v":1,"updatedAt":N,"layout":{...}} and round-trips', () => {
        const snap: RailSnapshot = { updatedAt: 1234, layout: layoutA };
        const json = JSON.stringify(buildRailPayload(snap));
        expect(json).toBe(`{"v":1,"updatedAt":1234,"layout":${JSON.stringify(layoutA)}}`);
        expect(parseRailPayload(json, NOW)).toEqual(snap);
    });

    it('rejects malformed payloads instead of coercing them', () => {
        const bad = [
            '{"v":2,"updatedAt":5,"layout":{"items":[]}}',
            '{"v":1,"updatedAt":"5","layout":{"items":[]}}',
            '{"v":1,"updatedAt":0,"layout":{"items":[]}}',
            '{"v":1,"updatedAt":1.5,"layout":{"items":[]}}',
            '{"v":1,"updatedAt":5}',
            '{"v":1,"updatedAt":5,"layout":{"items":"x"}}',
            '[]', 'null',
            `{"v":1,"updatedAt":${NOW + MAX_FUTURE_SKEW_MS + 1},"layout":{"items":[]}}`,
        ];
        for (const b of bad) expect(() => parseRailPayload(b, NOW), b).toThrow();
        expect(() => parseRailPayload(`{"v":1,"updatedAt":${NOW + MAX_FUTURE_SKEW_MS},"layout":{"items":[]}}`, NOW)).not.toThrow();
    });

    it('publishes the stored layout verbatim, framed with CLRAIL1, to the other devices only', async () => {
        const store = memStore({ [serverRailLayoutKey(UID)]: JSON.stringify(layoutA), [serverRailSyncTsKey(UID)]: '5000' });
        const t = makeEnv(store);
        const view = await publishServerRail(t.env, 'd1');
        expect(view).toMatchObject({ publisher: 'd1', recipients: null });
        expect(td.decode(t.slot.bytes!.subarray(0, 7))).toBe('CLRAIL1');
        const body = td.decode(t.slot.bytes!);
        expect(body).toContain('WRAPPED:d2:');
        expect(body).toContain(`{"v":1,"updatedAt":5000,"layout":${JSON.stringify(layoutA)}}`);
    });

    it('publishes nothing when this device never had a layout, or has no other device', async () => {
        const empty = makeEnv(memStore());
        expect(await publishServerRail(empty.env, 'd1')).toBeNull();
        expect(empty.slot.bytes).toBeNull();
        const solo = makeEnv(memStore({ [serverRailLayoutKey(UID)]: JSON.stringify(layoutA) }), { others: [] });
        expect(await publishServerRail(solo.env, 'd1')).toBeNull();
        expect(solo.slot.bytes).toBeNull();
    });

    it('pull: a NEWER remote layout replaces local through the restore path and notifies once', async () => {
        const store = memStore({ [serverRailLayoutKey(UID)]: JSON.stringify(layoutA), [serverRailSyncTsKey(UID)]: '1000' });
        const t = makeEnv(store);
        t.slot.bytes = remoteSlot({ updatedAt: 2000, layout: layoutB }, ['d1']);
        const r = await pullServerRail(t.env, null);
        expect(r.applied).toBe(true);
        expect(JSON.parse(store.m.get(serverRailLayoutKey(UID))!)).toEqual(layoutB);
        // legacy flat order is written alongside, exactly as useServerRailLayout does
        expect(JSON.parse(store.m.get(serverRailOrderKey(UID))!)).toEqual(['s3', 's1']);
        expect(store.m.get(serverRailSyncTsKey(UID))).toBe('2000');
        expect(t.notified()).toBe(1);
    });

    it('LWW: a STALE or equal remote never overwrites newer local state', async () => {
        const store = memStore({ [serverRailLayoutKey(UID)]: JSON.stringify(layoutA), [serverRailSyncTsKey(UID)]: '3000' });
        const t = makeEnv(store);
        t.slot.bytes = remoteSlot({ updatedAt: 2000, layout: layoutB }, ['d1']);
        expect((await pullServerRail(t.env, null)).applied).toBe(false);
        t.slot.bytes = remoteSlot({ updatedAt: 3000, layout: layoutB }, ['d1']);
        t.slot.rev++;
        expect((await pullServerRail(t.env, null)).applied).toBe(false);
        expect(JSON.parse(store.m.get(serverRailLayoutKey(UID))!)).toEqual(layoutA);
        expect(t.notified()).toBe(0);
        expect(store.writes).toEqual([]);
    });

    it('a pre-feature layout (no timestamp) loses to any real snapshot; no layout at all adopts one', async () => {
        const legacy = memStore({ [serverRailLayoutKey(UID)]: JSON.stringify(layoutA) });
        expect(loadLocalRailSnapshot(legacy, UID).updatedAt).toBe(1);
        const t = makeEnv(legacy);
        t.slot.bytes = remoteSlot({ updatedAt: 10, layout: layoutB }, ['d1']);
        expect((await pullServerRail(t.env, null)).applied).toBe(true);

        const fresh = memStore();
        const t2 = makeEnv(fresh);
        t2.slot.bytes = remoteSlot({ updatedAt: 10, layout: layoutB }, ['d1']);
        expect((await pullServerRail(t2.env, null)).applied).toBe(true);
        expect(JSON.parse(fresh.m.get(serverRailLayoutKey(UID))!)).toEqual(layoutB);
    });

    it('NO ECHO: after adopting a remote layout the local snapshot equals the slot, so nothing is republished', async () => {
        const store = memStore({ [serverRailLayoutKey(UID)]: JSON.stringify(layoutA), [serverRailSyncTsKey(UID)]: '1000' });
        const t = makeEnv(store);
        t.slot.bytes = remoteSlot({ updatedAt: 2000, layout: layoutB }, ['d1', 'd2']);
        const r = await pullServerRail(t.env, null);
        expect(r.applied).toBe(true);
        expect(serverRailRepublishReason(r.view, t.env.loadLocalState(), ['d1', 'd2'], 'd1')).toBe('none');
        // and the apply path never touched the "user changed it" bookkeeping beyond the adopted stamp
        expect(store.m.get(serverRailSyncTsKey(UID))).toBe('2000');
    });

    it('anti-entropy: empty slot + local layout republishes; a slot older than local republishes; a device the slot misses republishes', () => {
        const local: RailSnapshot = { updatedAt: 5000, layout: layoutA };
        expect(serverRailRepublishReason(null, local, ['d1', 'd2'], 'd1')).toBe('slot-empty');
        expect(serverRailRepublishReason(null, { updatedAt: 0, layout: null }, ['d1', 'd2'], 'd1')).toBe('none');
        const older = { updatedAt: 'r', recipients: ['d2'], publisher: 'd2', state: { updatedAt: 4000, layout: layoutB } };
        expect(serverRailRepublishReason(older, local, ['d1', 'd2'], 'd1')).toBe('slot-behind');
        const same = { updatedAt: 'r', recipients: ['d1'], publisher: 'd1', state: local };
        expect(serverRailRepublishReason(same, local, ['d1', 'd2', 'd3'], 'd1')).toBe('device-missing');
        // a slot NEWER than local is not a reason (the pull adopts it)
        const newer = { updatedAt: 'r', recipients: ['d1', 'd2'], publisher: 'd2', state: { updatedAt: 9000, layout: layoutB } };
        expect(serverRailRepublishReason(newer, local, ['d1', 'd2'], 'd1')).toBe('none');
    });

    it('apply path: unknown / left servers are stored raw (reconcile trims at render), duplicates are normalised, junk is dropped', () => {
        const store = memStore();
        const messy = { v: 2, items: ['gone', 's1', 's1', { id: 'f', name: '  Hi ', color: 'nope', servers: ['s2'] }, 7] };
        expect(adoptRemoteRail(store, UID, { updatedAt: 50, layout: messy }, () => undefined)).toBe(true);
        expect(JSON.parse(store.m.get(serverRailLayoutKey(UID))!)).toEqual({ v: 2, items: ['gone', 's1', 's2'] });
        expect(JSON.parse(store.m.get(serverRailOrderKey(UID))!)).toEqual(['gone', 's1', 's2']);
    });

    it('an unreadable snapshot (not addressed to us) is skipped and never downloaded again at the same revision', async () => {
        const t = makeEnv(memStore());
        t.slot.bytes = remoteSlot({ updatedAt: 9, layout: layoutB }, ['d5']);
        const r = await pullServerRail(t.env, null);
        expect(r).toMatchObject({ applied: false, view: { state: null } });
        t.calls.length = 0;
        await pullServerRail(t.env, r.view);
        expect(t.calls).toEqual([]);
    });

    it('registry: the sync bookkeeping keys are classified EXCLUDED, the layout keys stay included', () => {
        expect(classifyKvKey(serverRailSyncTsKey(UID), UID)).toBe('exclude');
        expect(classifyKvKey(`cipherline_server_rail_sync_view_${UID}`, UID)).toBe('exclude');
        expect(classifyKvKey(serverRailLayoutKey(UID), UID)).toBe('include');
    });
});
