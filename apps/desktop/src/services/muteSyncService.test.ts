import { describe, it, expect } from 'vitest';
import { frameOwnSlot } from '../utils/ownSlotSync';
import {
    MUTES_MAGIC, emptyMuteState, liveMuteMap, muteStateFor, sameMuteState, unmuteState, type MuteState,
} from '../utils/muteSync';
import { isSlotUnavailableError, mutesRepublishReason, publishMutes, pullMutes, type MuteSyncEnv } from './muteSyncService';

const te = new TextEncoder();
const td = new TextDecoder();
const A = '11111111-1111-4111-8111-111111111111';   // a channel
const B = '22222222-2222-4222-8222-222222222222';   // a DM conversation
const C = '33333333-3333-4333-8333-333333333333';   // a server
interface Slot { bytes: Uint8Array | null; rev: number; missing?: boolean; nudges: Array<{ slot: string; updated_at: string }> }

/**
 * One simulated device against a fake server shared through `slot`. After a successful upload the fake
 * server "nudges" the other devices (what the real server does with own_slot:changed): `onNudge` pulls.
 */
function device(me: string, slot: Slot, others: string[], clock: { t: number }, init: MuteState = emptyMuteState()) {
    const dev = { state: init, saves: 0, uploads: 0, view: null as Awaited<ReturnType<typeof pullMutes>>['view'], online: true };
    const unavailable = () => { if (slot.missing) throw Object.assign(new Error('400'), { response: { status: 400 } }); };
    const env: MuteSyncEnv = {
        getSlotMeta: async () => { unavailable(); return slot.bytes ? { backup_id: 'b', updated_at: `rev-${slot.rev}` } : null; },
        downloadSlot: async () => slot.bytes,
        uploadSlot: async (b) => { unavailable(); dev.uploads++; slot.bytes = b; slot.rev++; slot.nudges.push({ slot: 'mutes', updated_at: `rev-${slot.rev}` }); },
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
        now: () => clock.t,
        log: () => undefined,
    };
    /** A nudge arrived: pull (the hook's onNudge -> run()). */
    const onNudge = async () => { const r = await pullMutes(env, dev.view); dev.view = r.view; return r; };
    /** A local USER edit, then the debounced publish. */
    const edit = async (f: (s: MuteState, t: number) => MuteState) => { dev.state = f(dev.state, clock.t); return publishMutes(env, me); };
    return { dev, env, onNudge, edit };
}
const live = (d: { dev: { state: MuteState } }, t: number) => Object.keys(liveMuteMap(d.dev.state, t)).sort();

describe('mutes own-device sync (two devices, fake server)', () => {
    const fresh = () => ({ slot: { bytes: null, rev: 0, nudges: [] } as Slot, clock: { t: 1_800_000_000_000 } });

    it('magic contract', () => { expect(MUTES_MAGIC).toBe('CLMUT1'); });

    it('device A mutes -> nudge -> device B has it; no echo back', async () => {
        const { slot, clock } = fresh();
        const a = device('dA', slot, ['dB'], clock), b = device('dB', slot, ['dA'], clock);
        await a.edit((s, t) => muteStateFor(s, A, 'forever', t));
        expect(slot.nudges).toHaveLength(1);
        const r = await b.onNudge();
        expect(r.applied).toBe(true);
        expect(live(b, clock.t)).toEqual([A]);
        expect((await b.onNudge()).applied).toBe(false);          // same revision: nothing downloaded or merged
        expect(b.dev.saves).toBe(1);
    });

    it('covers every scope in one record: channel, DM conversation and server', async () => {
        const { slot, clock } = fresh();
        const a = device('dA', slot, ['dB'], clock), b = device('dB', slot, ['dA'], clock);
        await a.edit((s, t) => muteStateFor(muteStateFor(muteStateFor(s, A, '1h', t), B, '24h', t), C, 'forever', t));
        await b.onNudge();
        expect(live(b, clock.t)).toEqual([A, B, C]);
    });

    it('an unmute on B propagates back to A (tombstone), and an old copy cannot revive it', async () => {
        const { slot, clock } = fresh();
        const a = device('dA', slot, ['dB'], clock), b = device('dB', slot, ['dA'], clock);
        await a.edit((s, t) => muteStateFor(s, B, 'forever', t));
        await b.onNudge();
        clock.t += 1000;
        await b.edit((s, t) => unmuteState(s, B, t));
        const r = await a.onNudge();
        expect(r.applied).toBe(true);
        expect(live(a, clock.t)).toEqual([]);
        expect(sameMuteState(a.dev.state, b.dev.state)).toBe(true);
        // A republishing its (now merged) state does not bring the mute back on B.
        await a.edit((s) => s);
        await b.onNudge();
        expect(live(b, clock.t)).toEqual([]);
    });

    it('concurrent edits of one id on two offline devices converge to the same winner on both', async () => {
        const { slot, clock } = fresh();
        const a = device('dA', slot, ['dB'], clock), b = device('dB', slot, ['dA'], clock);
        await a.edit((s, t) => muteStateFor(s, A, '1h', t));
        await b.onNudge();
        clock.t += 5000;
        // Both go offline and edit: A unmutes, B re-mutes for 8 h (later stamp).
        a.dev.state = unmuteState(a.dev.state, A, clock.t);
        clock.t += 2000;
        b.dev.state = muteStateFor(b.dev.state, A, '8h', clock.t);
        await publishMutes(a.env, 'dA');
        await b.onNudge();                    // B merges A's older unmute: B's newer mute wins
        await publishMutes(b.env, 'dB');
        await a.onNudge();
        expect(live(a, clock.t)).toEqual([A]);
        expect(live(b, clock.t)).toEqual([A]);
        expect(sameMuteState(a.dev.state, b.dev.state)).toBe(true);
    });

    it('an offline device catches up from the slot on its next pull (nudges it missed do not matter)', async () => {
        const { slot, clock } = fresh();
        const a = device('dA', slot, ['dB'], clock), b = device('dB', slot, ['dA'], clock);
        await a.edit((s, t) => muteStateFor(s, A, 'forever', t));
        clock.t += 1000;
        await a.edit((s, t) => muteStateFor(s, C, '8h', t));
        clock.t += 1000;
        await a.edit((s, t) => unmuteState(s, A, t));
        const r = await b.onNudge();           // first contact after being offline for all three edits
        expect(r.applied).toBe(true);
        expect(live(b, clock.t)).toEqual([C]);
    });

    it('expiry is judged at read time on the receiving device', async () => {
        const { slot, clock } = fresh();
        const a = device('dA', slot, ['dB'], clock), b = device('dB', slot, ['dA'], clock);
        await a.edit((s, t) => muteStateFor(s, A, '15m', t));
        clock.t += 16 * 60_000;                // B only looks after the mute ran out
        await b.onNudge();
        expect(live(b, clock.t)).toEqual([]);
    });

    it('a hostile or newer-format blob changes nothing local', async () => {
        const { slot, clock } = fresh();
        const b = device('dB', slot, ['dA'], clock, muteStateFor(emptyMuteState(), A, 'forever', clock.t));
        const before = b.dev.state;
        for (const payload of [JSON.stringify({ v: 3, mutes: {} }), '{nope', 'x'.repeat(300 * 1024)]) {
            slot.bytes = frameOwnSlot(MUTES_MAGIC, { v: 1, key_envelope_b64: `WRAPPED:dB:dA:${JSON.stringify({ k: 'CK' })}` }, te.encode(payload));
            slot.rev++;
            await expect(pullMutes(b.env, null)).rejects.toThrow();
            expect(b.dev.state).toBe(before);
        }
    });

    it('an API without the slot (400): recognised as unavailable, local mutes untouched', async () => {
        const { slot, clock } = fresh();
        slot.missing = true;
        const a = device('dA', slot, ['dB'], clock, muteStateFor(emptyMuteState(), A, 'forever', clock.t));
        let err: unknown;
        try { await publishMutes(a.env, 'dA'); } catch (e) { err = e; }
        expect(isSlotUnavailableError(err)).toBe(true);
        expect(live(a, clock.t)).toEqual([A]);
    });

    it('a single-device account publishes nothing, and a new device later triggers anti-entropy', async () => {
        const { slot, clock } = fresh();
        const solo = device('dA', slot, [], clock, muteStateFor(emptyMuteState(), A, 'forever', clock.t));
        expect(await publishMutes(solo.env, 'dA')).toBeNull();
        expect(slot.nudges).toHaveLength(0);
        expect(mutesRepublishReason(null, solo.dev.state, ['dA', 'dB'], 'dA', clock.t)).not.toBe('none');
    });
});
