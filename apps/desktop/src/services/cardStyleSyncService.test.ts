import { describe, it, expect } from 'vitest';
import { frameOwnSlot } from '../utils/ownSlotSync';
import { classifyKvKey } from './backupRegistry';
import {
    CARD_STYLES_MAGIC, CARD_STYLES_SLOT, buildStylesPayload, emptyStyleState, sameStyleState, type StyleSyncState, type SyncStyleItem,
} from '../utils/cardStyleSync';
import {
    cardStylesRepublishReason, isSlotUnavailableError, publishCardStyles, pullCardStyles, type CardStyleSyncEnv,
} from './cardStyleSyncService';

const te = new TextEncoder();
const td = new TextDecoder();
const NOW = 1_800_000_000_000;
const st = (text = '#ffffff') => ({ v: 1 as const, text });
const item = (id: string, at: number, over: Partial<SyncStyleItem> = {}): SyncStyleItem =>
    ({ id, name: `n-${id}`, style: st(), created: over.created ?? at, at, ...over });

interface Slot { bytes: Uint8Array | null; rev: number }

/** One simulated device: its own local state, a shared slot, a fake wrap/unwrap addressed by device id. */
function device(me: string, slot: Slot, others: string[], init: StyleSyncState = emptyStyleState()) {
    const dev = { state: init, saves: 0, uploads: 0 };
    const env: CardStyleSyncEnv = {
        getSlotMeta: async () => (slot.bytes ? { backup_id: 'b', updated_at: `rev-${slot.rev}` } : null),
        downloadSlot: async () => slot.bytes,
        uploadSlot: async b => { dev.uploads++; slot.bytes = b; slot.rev++; },
        listOwnDeviceIds: async () => [me, ...others],
        fetchOwnDevices: async () => others.map(d => ({ device_id: d, spk_pub_b64: 'SPK' })),
        wrapToDevices: async (pt, devices) => `WRAPPED:${devices.map(d => d.device_id).join(',')}:${me}:${pt}`,
        unwrapFromEnvelope: async e => {
            if (!e.startsWith('WRAPPED:')) throw new Error('not addressed');
            const [, to, sender, ...rest] = e.split(':');
            if (!to.split(',').includes(me)) throw new Error('not addressed to this device');
            return { contentJson: rest.join(':'), senderDeviceId: sender };
        },
        generateContentKeyB64: async () => 'CK',
        encryptWithKey: async pt => te.encode(pt),
        decryptWithKey: async b => td.decode(b),
        loadLocalState: () => dev.state,
        saveLocalState: next => { dev.saves++; dev.state = next; },
        now: () => NOW,
        log: () => undefined,
    };
    return { dev, env };
}

const ids = (s: StyleSyncState) => s.items.map(i => i.id);
const B = NOW - 1_000_000;

describe('card_styles own-device sync', () => {
    it('slot name / magic / classification contract', () => {
        expect(CARD_STYLES_SLOT).toBe('card_styles');
        expect(CARD_STYLES_MAGIC).toBe('CLSTY1');
        expect(classifyKvKey('cipherline_card_styles_u1', 'u1')).toBe('include');
        expect(classifyKvKey('cipherline_card_styles_meta_u1', 'u1')).toBe('include');
        expect(classifyKvKey('cipherline_card_styles_sync_view_u1', 'u1')).toBe('exclude');
    });

    it('publish -> pull round trip: a second device ends up with the first device\'s styles', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const a = device('dA', slot, ['dB'], { items: [item('s1', B + 1), item('s2', B + 2)], tombstones: {} });
        const b = device('dB', slot, ['dA']);
        expect(await publishCardStyles(a.env, 'dA')).not.toBeNull();
        const res = await pullCardStyles(b.env, null);
        expect(res.applied).toBe(true);
        expect(ids(b.dev.state)).toEqual(['s1', 's2']);
        expect(sameStyleState(b.dev.state, a.dev.state)).toBe(true);
    });

    it('a freshly transferred device (empty, no stamps) pulls everything on its first run', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const a = device('dA', slot, ['dNew', 'dB'], { items: [item('s1', B + 1)], tombstones: { old: B + 5 } });
        await publishCardStyles(a.env, 'dA');
        const fresh = device('dNew', slot, ['dA', 'dB']);
        await pullCardStyles(fresh.env, null);
        expect(ids(fresh.dev.state)).toEqual(['s1']);
        expect(fresh.dev.state.tombstones).toEqual({ old: B + 5 });
    });

    it('no echo: pulling an unchanged slot, or one that adds nothing, writes nothing and publishes nothing', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const a = device('dA', slot, ['dB'], { items: [item('s1', B + 1)], tombstones: {} });
        const b = device('dB', slot, ['dA']);
        await publishCardStyles(a.env, 'dA');
        const r1 = await pullCardStyles(b.env, null);
        expect(b.dev.saves).toBe(1);
        const r2 = await pullCardStyles(b.env, r1.view);          // same updated_at: no download, no write
        expect(r2.applied).toBe(false);
        const r3 = await pullCardStyles(b.env, null);             // forced re-read: merge is a no-op
        expect(r3.applied).toBe(false);
        expect(b.dev.saves).toBe(1);
        expect(b.dev.uploads).toBe(0);
        // Anti-entropy is one-directional: B now equals the slot, so it has no reason to republish.
        expect(cardStylesRepublishReason(r3.view, b.dev.state, ['dA', 'dB'], 'dB', NOW)).toBe('none');
    });

    it('two devices edit offline: concurrent edit + delete converge on both after they sync', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const base = [item('keep', B + 1), item('del', B + 2), item('ren', B + 3)];
        const a = device('dA', slot, ['dB'], { items: base, tombstones: {} });
        const b = device('dB', slot, ['dA'], { items: base, tombstones: {} });
        // A deletes 'del' and adds 'newA'; B renames 'ren' and edits 'del' (older than A's delete).
        a.dev.state = { items: [base[0], base[2], item('newA', B + 100)], tombstones: { del: B + 50 } };
        b.dev.state = { items: [base[0], item('del', B + 40, { name: 'edited-del' }), item('ren', B + 60, { name: 'renamed' })], tombstones: {} };

        await publishCardStyles(a.env, 'dA');
        await pullCardStyles(b.env, null);        // B adopts A's delete (50 > 40) and keeps its newer rename
        await publishCardStyles(b.env, 'dB');
        await pullCardStyles(a.env, null);

        expect(sameStyleState(a.dev.state, b.dev.state)).toBe(true);
        expect(ids(a.dev.state)).toEqual(['keep', 'ren', 'newA']);
        expect(a.dev.state.items.find(i => i.id === 'ren')!.name).toBe('renamed');
        expect(a.dev.state.tombstones).toEqual({ del: B + 50 });
    });

    it('a hostile / oversize / unknown-version / foreign blob from "another device" changes nothing', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const b = device('dB', slot, ['dA'], { items: [item('mine', B + 1)], tombstones: {} });
        const before = b.dev.state;
        const frame = (payload: string, to = 'dB') => frameOwnSlot(CARD_STYLES_MAGIC,
            { v: 1, key_envelope_b64: `WRAPPED:${to}:dA:${JSON.stringify({ k: 'CK' })}` }, te.encode(payload));

        for (const payload of [
            JSON.stringify({ v: 2, items: [], tombstones: {} }),
            'x'.repeat(300 * 1024),
            '{not json',
            JSON.stringify({ v: 1, items: 'nope' }),
        ]) {
            slot.bytes = frame(payload); slot.rev++;
            await expect(pullCardStyles(b.env, null)).rejects.toThrow();
            expect(b.dev.state).toBe(before);
        }
        // Not addressed to this device: skipped silently, view marked unreadable, nothing applied.
        slot.bytes = frame(JSON.stringify(buildStylesPayload({ items: [item('x', B)], tombstones: {} }, NOW)), 'dC'); slot.rev++;
        const r = await pullCardStyles(b.env, null);
        expect(r.applied).toBe(false);
        expect(r.view?.state).toBeNull();
        // Hostile items inside a valid envelope are dropped one by one; the good one merges.
        slot.bytes = frame(JSON.stringify({
            v: 1, writtenAt: NOW,
            items: [
                { id: '../x', name: 'x', style: st(), created: 1, at: 1 },
                { id: 'evil', name: 'x', style: { v: 1, text: 'url(javascript:1)' }, created: 1, at: 1 },
                { id: 'good', name: 'Good', style: st(), created: B + 2, at: B + 2 },
            ],
            tombstones: {},
        })); slot.rev++;
        const r2 = await pullCardStyles(b.env, null);
        expect(r2.applied).toBe(true);
        expect(ids(b.dev.state)).toEqual(['mine', 'good']);
        expect(b.dev.state.items.find(i => i.id === 'mine')).toBeDefined(); // never wiped by the remote
    });

    it('older API (400 Unknown backup slot): publish surfaces a recognisable unavailable error and local state is untouched', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const a = device('dA', slot, ['dB'], { items: [item('s1', B + 1)], tombstones: {} });
        const err = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
        a.env.uploadSlot = async () => { throw err; };
        await expect(publishCardStyles(a.env, 'dA')).rejects.toSatisfy(isSlotUnavailableError);
        expect(ids(a.dev.state)).toEqual(['s1']);
        // pull against that API: the meta probe swallows the 400 and reads as "slot empty"
        a.env.getSlotMeta = async () => null;
        expect((await pullCardStyles(a.env, null)).applied).toBe(false);
        expect(isSlotUnavailableError(new Error('network'))).toBe(false);
        expect(isSlotUnavailableError({ response: { status: 500 } })).toBe(false);
    });

    it('nothing to publish, or no other device: no upload', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const empty = device('dA', slot, ['dB']);
        expect(await publishCardStyles(empty.env, 'dA')).toBeNull();
        const alone = device('dA', slot, [], { items: [item('s1', B + 1)], tombstones: {} });
        expect(await publishCardStyles(alone.env, 'dA')).toBeNull();
        expect(slot.bytes).toBeNull();
    });
});
