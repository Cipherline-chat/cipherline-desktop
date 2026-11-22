import { describe, it, expect } from 'vitest';
import { frameOwnSlot } from '../utils/ownSlotSync';
import {
    THEMES_MAGIC, emptyThemeState, sameThemeState, type SyncThemeItem, type ThemeSyncState,
} from '../utils/customThemeSync';
import {
    customThemesRepublishReason, isSlotUnavailableError, publishCustomThemes, pullCustomThemes, type CustomThemeSyncEnv,
} from './customThemeSyncService';
import { customThemeFromBase } from '../theme/customTheme';

const te = new TextEncoder();
const td = new TextDecoder();
const NOW = 1_800_000_000_000;
const B = NOW - 1_000_000;
const item = (id: string, at: number, name = `n-${id}`): SyncThemeItem =>
    ({ id, def: customThemeFromBase('dark', name), created: at, at });
interface Slot { bytes: Uint8Array | null; rev: number; missing?: boolean }

/** One simulated device (same fake transport as cardStyleSyncService.test.ts). */
function device(me: string, slot: Slot, others: string[], init: ThemeSyncState = emptyThemeState()) {
    const dev = { state: init, saves: 0, uploads: 0 };
    const unavailable = () => { if (slot.missing) throw Object.assign(new Error('400'), { response: { status: 400 } }); };
    const env: CustomThemeSyncEnv = {
        getSlotMeta: async () => { unavailable(); return slot.bytes ? { backup_id: 'b', updated_at: `rev-${slot.rev}` } : null; },
        downloadSlot: async () => slot.bytes,
        uploadSlot: async (b) => { unavailable(); dev.uploads++; slot.bytes = b; slot.rev++; },
        listOwnDeviceIds: async () => [me, ...others],
        fetchOwnDevices: async () => others.map((d) => ({ device_id: d, spk_pub_b64: 'SPK' })),
        wrapToDevices: async (pt, devices) => `WRAPPED:${devices.map((d) => d.device_id).join(',')}:${me}:${pt}`,
        unwrapFromEnvelope: async (e) => {
            const [, to, sender, ...rest] = e.split(':');
            if (!to.split(',').includes(me)) throw new Error('not addressed to this device');
            return { contentJson: rest.join(':'), senderDeviceId: sender };
        },
        generateContentKeyB64: async () => 'CK',
        encryptWithKey: async (pt) => te.encode(pt),
        decryptWithKey: async (b) => td.decode(b),
        loadLocalState: () => dev.state,
        saveLocalState: (next) => { dev.saves++; dev.state = next; },
        now: () => NOW,
        log: () => undefined,
    };
    return { dev, env };
}
const ids = (s: ThemeSyncState) => s.items.map((i) => i.id);

describe('themes own-device sync', () => {
    it('magic contract', () => { expect(THEMES_MAGIC).toBe('CLTHM1'); });

    it('publish -> pull: a second device gets the first device\'s themes; no echo afterwards', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const a = device('dA', slot, ['dB'], { items: [item('t1', B + 1, 'Ocean'), item('t2', B + 2, 'Rose')], tombstones: {} });
        const b = device('dB', slot, ['dA']);
        expect(await publishCustomThemes(a.env, 'dA')).not.toBeNull();
        const r1 = await pullCustomThemes(b.env, null);
        expect(r1.applied).toBe(true);
        expect(sameThemeState(b.dev.state, a.dev.state)).toBe(true);
        const r2 = await pullCustomThemes(b.env, null);
        expect(r2.applied).toBe(false);
        expect(b.dev.saves).toBe(1);
        expect(customThemesRepublishReason(r2.view, b.dev.state, ['dA', 'dB'], 'dB', NOW)).toBe('none');
    });

    it('a delete on one device reaches the other (tombstone), an older edit does not undo it', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const both = [item('t1', B + 1)];
        const a = device('dA', slot, ['dB'], { items: both, tombstones: {} });
        const b = device('dB', slot, ['dA'], { items: [{ ...item('t1', B + 1, 'edited'), at: B + 20 }], tombstones: {} });
        a.dev.state = { items: [], tombstones: { t1: B + 50 } };
        await publishCustomThemes(a.env, 'dA');
        await pullCustomThemes(b.env, null);
        expect(ids(b.dev.state)).toEqual([]);
        expect(b.dev.state.tombstones).toEqual({ t1: B + 50 });
    });

    it('a hostile blob changes nothing', async () => {
        const slot: Slot = { bytes: null, rev: 0 };
        const b = device('dB', slot, ['dA'], { items: [item('mine', B + 1)], tombstones: {} });
        const before = b.dev.state;
        for (const payload of [JSON.stringify({ v: 2, items: [], tombstones: {} }), '{nope', 'x'.repeat(200 * 1024)]) {
            slot.bytes = frameOwnSlot(THEMES_MAGIC, { v: 1, key_envelope_b64: `WRAPPED:dB:dA:${JSON.stringify({ k: 'CK' })}` }, te.encode(payload));
            slot.rev++;
            await expect(pullCustomThemes(b.env, null)).rejects.toThrow();
            expect(b.dev.state).toBe(before);
        }
    });

    it('an API without the slot answers 400: recognised as "not available yet", nothing local changes', async () => {
        const slot: Slot = { bytes: null, rev: 0, missing: true };
        const a = device('dA', slot, ['dB'], { items: [item('t1', B + 1)], tombstones: {} });
        const before = a.dev.state;
        const err = await pullCustomThemes(a.env, null).then(() => null, (e) => e);
        expect(isSlotUnavailableError(err)).toBe(true);
        const err2 = await publishCustomThemes(a.env, 'dA').then(() => null, (e) => e);
        expect(isSlotUnavailableError(err2)).toBe(true);
        expect(a.dev.state).toBe(before);
        // positive control: other failures are not mistaken for it
        expect(isSlotUnavailableError(Object.assign(new Error('x'), { response: { status: 500 } }))).toBe(false);
    });
});
