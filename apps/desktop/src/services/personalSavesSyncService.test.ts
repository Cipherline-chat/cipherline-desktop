import { describe, it, expect } from 'vitest';
import {
    pullSaves,
    publishSaves,
    savesRepublishReason,
    type SavesSyncEnv,
} from './personalSavesSyncService';
import { frameOwnSlot, type SlotView } from '../utils/ownSlotSync';
import { buildSavesPayload, emptySaves, SAVES_SNAPSHOT_MAGIC, type SavesState } from '../utils/personalSavesSync';

const te = new TextEncoder();
const td = new TextDecoder();
const C = 'c0ffee00-0000-4000-8000-000000000001';
const M1 = 'aaaaaaaa-0000-4000-8000-000000000001';

const withChannelSave = (m: string, at: number): SavesState =>
    ({ conversation: { pins: {}, ledger: {} }, channel: { pins: { [C]: [m] }, ledger: { [C]: { [m]: at } } } });

/**
 * Fake env: "encryption" is identity framing, and the key envelope is
 * `WRAPPED:<json>` addressed to everyone except a device named 'stranger'.
 * The real crypto and envelope format are proved by the cross-repo interop
 * harness (cipherline-mobile scripts/interop/own-slot-protocol.mjs).
 */
function makeEnv(opts: { me?: string; local?: SavesState; ownIds?: string[] | null; others?: string[] } = {}) {
    const me = opts.me ?? 'd1';
    let state = opts.local ?? emptySaves();
    const slot: { bytes: Uint8Array | null; rev: number } = { bytes: null, rev: 0 };
    const calls: string[] = [];
    const saves: { next: SavesState; prev: SavesState }[] = [];

    const env: SavesSyncEnv = {
        getSlotMeta: async () => (slot.bytes ? { backup_id: 'b', updated_at: `rev-${slot.rev}` } : null),
        downloadSlot: async () => { calls.push('download'); return slot.bytes; },
        uploadSlot: async (b) => { calls.push('upload'); slot.bytes = b; slot.rev++; },
        listOwnDeviceIds: async () => (opts.ownIds === undefined ? [me, ...(opts.others ?? ['d2'])] : opts.ownIds),
        fetchOwnDevices: async () => { calls.push('prekey_bundle'); return (opts.others ?? ['d2']).map(d => ({ device_id: d, spk_pub_b64: 'SPK' })); },
        wrapToDevices: async (pt, devices) => `WRAPPED:${devices.map(d => d.device_id).join(',')}:${pt}`,
        unwrapFromEnvelope: async (e) => {
            if (!e.startsWith('WRAPPED:')) throw new Error('not addressed');
            const [, to, ...rest] = e.split(':');
            if (!to.split(',').includes(me)) throw new Error('not addressed to this device');
            return { contentJson: rest.join(':'), senderDeviceId: 'publisher' };
        },
        generateContentKeyB64: async () => 'CK',
        encryptWithKey: async (pt) => te.encode(pt),
        decryptWithKey: async (b) => td.decode(b),
        loadLocalState: () => state,
        saveLocalState: (next, prev) => { saves.push({ next, prev }); state = next; },
        now: () => 1234,
        log: () => { },
    };
    return { env, slot, calls, saves, get state() { return state; } };
}

/** A slot as another of my devices ('d9') would have written it. */
function remoteSlot(state: SavesState, addressedTo: string[]): Uint8Array {
    const payload = JSON.stringify(buildSavesPayload(state, 1));
    return frameOwnSlot(SAVES_SNAPSHOT_MAGIC, { v: 1, key_envelope_b64: `WRAPPED:${addressedTo.join(',')}:${JSON.stringify({ k: 'CK' })}` }, te.encode(payload.padEnd(payload.length + 28)));
}

describe('pullSaves', () => {
    it('an empty slot yields no view and touches nothing', async () => {
        const t = makeEnv();
        const r = await pullSaves(t.env, null);
        expect(r).toMatchObject({ applied: false, view: null });
        expect(t.calls).toEqual([]);
    });

    it('does not download when the slot revision is the one already seen', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSlot(withChannelSave(M1, 5), ['d1']);
        t.slot.rev = 3;
        const seen: SlotView<SavesState> = { updatedAt: 'rev-3', recipients: ['d1'], publisher: 'd9', state: emptySaves() };
        const r = await pullSaves(t.env, seen);
        expect(r.view).toBe(seen);
        expect(t.calls).toEqual([]);
    });

    it('merges a channel save made on another device into local state', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSlot(withChannelSave(M1, 5), ['d1']);
        const r = await pullSaves(t.env, null);
        expect(r.applied).toBe(true);
        expect(t.state.channel.pins[C]).toEqual([M1]);
        expect(r.view).toMatchObject({ publisher: 'publisher', state: withChannelSave(M1, 5) });
        expect(t.saves[0].prev).toEqual(emptySaves());
    });

    it('a snapshot not addressed to this device is not merged, and the view says so (state null)', async () => {
        const t = makeEnv({ me: 'newphone' });
        t.slot.bytes = remoteSlot(withChannelSave(M1, 5), ['d1', 'd2']);
        const r = await pullSaves(t.env, null);
        expect(r.applied).toBe(false);
        expect(t.saves).toHaveLength(0);
        expect(r.view).toMatchObject({ state: null, publisher: null });
    });

    it('a local unsave newer than the remote save survives the pull', async () => {
        const local: SavesState = { conversation: { pins: {}, ledger: {} }, channel: { pins: {}, ledger: { [C]: { [M1]: 50 } } } };
        const t = makeEnv({ local });
        t.slot.bytes = remoteSlot(withChannelSave(M1, 5), ['d1']);
        const r = await pullSaves(t.env, null);
        expect(r.applied).toBe(false);
        expect(t.state.channel.pins[C]).toBeUndefined();
    });

    it('a malformed body throws, and local state is left alone', async () => {
        const t = makeEnv();
        t.slot.bytes = frameOwnSlot(SAVES_SNAPSHOT_MAGIC, { v: 1, key_envelope_b64: `WRAPPED:d1:${JSON.stringify({ k: 'CK' })}` }, te.encode('{"v":1'.padEnd(40)));
        await expect(pullSaves(t.env, null)).rejects.toThrow();
        expect(t.saves).toHaveLength(0);
    });
});

describe('publishSaves', () => {
    it('a single-device account publishes nothing and claims no prekeys', async () => {
        const t = makeEnv({ local: withChannelSave(M1, 5), ownIds: ['d1'] });
        expect(await publishSaves(t.env, 'd1')).toBeNull();
        expect(t.calls).toEqual([]);
    });

    it('uploads a snapshot a second device can merge (A → B round trip)', async () => {
        const a = makeEnv({ me: 'd1', local: withChannelSave(M1, 5), others: ['d2'] });
        const view = await publishSaves(a.env, 'd1');
        expect(view).toMatchObject({ publisher: 'd1', state: withChannelSave(M1, 5) });
        expect(a.calls).toEqual(['prekey_bundle', 'upload']);

        const b = makeEnv({ me: 'd2' });
        b.slot.bytes = a.slot.bytes;
        await pullSaves(b.env, null);
        expect(b.state.channel.pins[C]).toEqual([M1]);
    });

    it('never wraps to itself', async () => {
        const t = makeEnv({ me: 'd1', local: withChannelSave(M1, 5), others: ['d1', 'd2'] });
        await publishSaves(t.env, 'd1');
        const header = td.decode(t.slot.bytes!.subarray(10, 10 + new DataView(t.slot.bytes!.buffer).getUint32(6, false)));
        expect(JSON.parse(header).key_envelope_b64.split(':')[1]).toBe('d2');
    });
});

describe('savesRepublishReason', () => {
    const v = (state: SavesState | null, recipients: string[] | null): SlotView<SavesState> =>
        ({ updatedAt: 'r', recipients, publisher: 'd1', state });

    it('first device with saves and an empty slot publishes', () => {
        expect(savesRepublishReason(null, withChannelSave(M1, 5), ['d1', 'd2'], 'd1')).toBe('slot-empty');
    });
    it('a new phone that is not addressed makes an existing device republish', () => {
        expect(savesRepublishReason(v(withChannelSave(M1, 5), ['d2']), withChannelSave(M1, 5), ['d1', 'd2', 'phone'], 'd2')).toBe('device-missing');
    });
    it('an up-to-date, fully-addressed slot needs nothing', () => {
        expect(savesRepublishReason(v(withChannelSave(M1, 5), ['d2']), withChannelSave(M1, 5), ['d1', 'd2'], 'd2')).toBe('none');
    });
    it('a slot that lost our newer unsave (concurrent overwrite) is behind', () => {
        const local: SavesState = { conversation: { pins: {}, ledger: {} }, channel: { pins: {}, ledger: { [C]: { [M1]: 9 } } } };
        expect(savesRepublishReason(v(withChannelSave(M1, 5), ['d2']), local, null, 'd2')).toBe('slot-behind');
    });
});
