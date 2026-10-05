import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomEvent, Encryption_Type } from 'livekit-client';
import {
    activateRoomE2EE, describeE2EEActivationFailure, installE2EEKey, DEFAULT_ACK_TIMEOUT_MS,
    type ActivatableRoom, type ActivatablePublication, type E2EEActivationFailure, type E2EEKeyInstaller,
} from './e2eeActivation';

/**
 * What these tests DO prove: the activation is called exactly once, before
 * anything else, only when a key is present; the call fails closed on every
 * path where the SDK could end up signalling GCM while not encrypting; and
 * the checks stay silent on a healthy call and after dispose.
 *
 * What they do NOT prove: that a single frame on the wire is encrypted. That
 * is a property of the SDK worker and the SFU, not of this module, and is
 * established separately (docs/livekit-e2ee-activation-rollout.md, Evidence)
 * against a real LiveKit server with an independent AES-GCM decrypt. Do not
 * read a green run here as "calls are encrypted".
 */

type Listener = (...args: unknown[]) => void;

class FakeRoom implements ActivatableRoom {
    options: { encryption?: unknown } = { encryption: { keyProvider: {}, worker: {} } };
    isE2EEEnabled = false;
    localParticipant = { identity: '', trackPublications: new Map<string, ActivatablePublication>() };
    setCalls: boolean[] = [];
    setImpl: (enabled: boolean) => Promise<void> = async () => {};
    private listeners = new Map<string, Set<Listener>>();

    setE2EEEnabled(enabled: boolean) { this.setCalls.push(enabled); return this.setImpl(enabled); }
    on(event: string, l: Listener) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(l); return this; }
    off(event: string, l: Listener) { this.listeners.get(event)?.delete(l); return this; }
    emit(event: string, ...args: unknown[]) { for (const l of [...(this.listeners.get(event) ?? [])]) l(...args); }
    listenerCount() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }

    /** The server's join response has landed: identity known, SDK emits SignalConnected. */
    signalConnected(identity = 'me') { this.localParticipant.identity = identity; this.emit(RoomEvent.SignalConnected); }
    /** The worker acknowledged `enable` for the local identity (what flips Room.isE2EEEnabled). */
    ackLocal() { this.isE2EEEnabled = true; this.emit(RoomEvent.ParticipantEncryptionStatusChanged, true, { isLocal: true }); }
    publish(sid: string, encryption: number, source = 'microphone') {
        const pub = { trackSid: sid, source, trackInfo: { encryption } };
        this.localParticipant.trackPublications.set(sid, pub);
        this.emit(RoomEvent.LocalTrackPublished, pub, this.localParticipant);
    }
}

const keyHolder = (n: number) => ({ getKeys: () => new Array(n).fill({}) });
// Microtask drain (fake timers are on, so a setTimeout-based flush would hang):
// setE2EEEnabled's promise and the module's `.then` settle within a few ticks.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('activateRoomE2EE', () => {
    let failures: E2EEActivationFailure[];
    let active: number;
    const handlers = () => ({ onFailure: (f: E2EEActivationFailure) => failures.push(f), onActive: () => { active++; } });

    beforeEach(() => { failures = []; active = 0; vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('pins the SDK values this module depends on', () => {
        // GCM is what the SFU records for an encrypted publication; NONE is what shipped.
        expect(Encryption_Type.GCM).toBe(1);
        expect(Encryption_Type.NONE).toBe(0);
    });

    it('calls setE2EEEnabled(true) exactly once, synchronously, before the room has an identity', () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        expect(room.setCalls).toEqual([true]);
        expect(room.localParticipant.identity).toBe(''); // i.e. pre-connect
        expect(failures).toEqual([]);
    });

    it('refuses to activate when the Room has no encryption block but a key was expected', () => {
        const room = new FakeRoom();
        room.options = {};
        activateRoomE2EE(room, keyHolder(1), handlers());
        expect(room.setCalls).toEqual([]);
        expect(failures).toEqual([{ kind: 'not_configured' }]);
    });

    it('refuses to activate with an empty key provider — never encrypt to a key peers do not have', () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(0), handlers());
        expect(room.setCalls).toEqual([]);
        expect(failures).toEqual([{ kind: 'no_key' }]);
    });

    it('becomes active only once BOTH the promise resolved and the worker acknowledged the local identity', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        expect(active).toBe(0); // promise resolved, no ack yet
        room.signalConnected();
        room.emit(RoomEvent.ParticipantEncryptionStatusChanged, true, { isLocal: false }); // a peer — not us
        expect(active).toBe(0);
        room.ackLocal();
        expect(active).toBe(1);
        expect(failures).toEqual([]);
    });

    it('a healthy call: GCM publications after activation never trip the check', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        room.signalConnected();
        room.ackLocal();
        room.publish('TR_1', Encryption_Type.GCM);
        room.publish('TR_2', Encryption_Type.GCM, 'screen_share');
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS * 2);
        expect(failures).toEqual([]);
    });

    it('fails closed when a local track is published WITHOUT GCM after activation', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        room.signalConnected();
        room.ackLocal();
        room.publish('TR_1', Encryption_Type.GCM);
        room.publish('TR_2', Encryption_Type.NONE, 'camera');
        expect(failures).toEqual([{ kind: 'plaintext_publication', trackSid: 'TR_2', source: 'camera' }]);
    });

    it('fails closed when a NONE publication is already standing at the moment of activation', async () => {
        const room = new FakeRoom();
        room.localParticipant.trackPublications.set('TR_0', { trackSid: 'TR_0', source: 'microphone', trackInfo: { encryption: Encryption_Type.NONE } });
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        room.signalConnected();
        room.ackLocal();
        expect(failures).toEqual([{ kind: 'plaintext_publication', trackSid: 'TR_0', source: 'microphone' }]);
        expect(active).toBe(0);
    });

    it('fails closed when setE2EEEnabled rejects', async () => {
        const room = new FakeRoom();
        const boom = new Error('republish failed');
        room.setImpl = async () => { throw boom; };
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        expect(failures).toEqual([{ kind: 'rejected', error: boom }]);
    });

    it('fails closed when the worker never acknowledges — clock starts at SignalConnected, not at activation', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS * 3); // still connecting: no identity, no clock
        expect(failures).toEqual([]);
        room.signalConnected();
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS - 1);
        expect(failures).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(failures).toEqual([{ kind: 'ack_timeout', afterMs: DEFAULT_ACK_TIMEOUT_MS }]);
    });

    it('an ack that arrives in time cancels the watchdog', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers(), { ackTimeoutMs: 500 });
        await flush();
        room.signalConnected();
        vi.advanceTimersByTime(100);
        room.ackLocal();
        vi.advanceTimersByTime(10_000);
        expect(failures).toEqual([]);
        expect(active).toBe(1);
    });

    it('treats a room that is already acknowledged as active (idempotent re-run on a live room)', async () => {
        const room = new FakeRoom();
        room.isE2EEEnabled = true;
        room.localParticipant.identity = 'me';
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        expect(room.setCalls).toEqual([true]); // still asked — the SDK short-circuits when nothing changes
        expect(active).toBe(1);
        room.publish('TR_9', Encryption_Type.NONE);
        expect(failures).toEqual([{ kind: 'plaintext_publication', trackSid: 'TR_9', source: 'microphone' }]);
    });

    it('a Disconnected event disposes silently — an ended call is not a failure', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        room.signalConnected();
        room.emit(RoomEvent.Disconnected);
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS * 2);
        expect(failures).toEqual([]);
        expect(room.listenerCount()).toBe(0);
    });

    it('dispose removes every listener and mutes every handler afterwards', async () => {
        const room = new FakeRoom();
        const dispose = activateRoomE2EE(room, keyHolder(1), handlers());
        expect(room.listenerCount()).toBeGreaterThan(0);
        dispose();
        expect(room.listenerCount()).toBe(0);
        await flush();
        room.signalConnected();
        room.ackLocal();
        room.publish('TR_1', Encryption_Type.NONE);
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS * 2);
        expect(failures).toEqual([]);
        expect(active).toBe(0);
    });

    it('reports at most one failure, then goes quiet', async () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(1), handlers());
        await flush();
        room.signalConnected();
        room.ackLocal();
        room.publish('TR_1', Encryption_Type.NONE);
        room.publish('TR_2', Encryption_Type.NONE);
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS * 2);
        expect(failures).toHaveLength(1);
        expect(room.listenerCount()).toBe(0);
    });
});

describe('activateRoomE2EE with keyReady (the key is being installed asynchronously)', () => {
    let failures: E2EEActivationFailure[];
    let active: number;
    const handlers = () => ({ onFailure: (f: E2EEActivationFailure) => failures.push(f), onActive: () => { active++; } });
    /** A holder whose key "lands" only when the test says so, mirroring the provider's async setKey(). */
    const deferredKey = () => {
        let keys = 0;
        let resolve!: () => void; let reject!: (e: unknown) => void;
        const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        return { holder: { getKeys: () => new Array(keys).fill({}) }, promise, land: () => { keys = 1; resolve(); }, settleEmpty: () => resolve(), reject };
    };

    beforeEach(() => { failures = []; active = 0; vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('does NOT fail on an empty provider at call time; activates immediately (pre-connect) anyway', () => {
        const room = new FakeRoom();
        const k = deferredKey();
        activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        expect(failures).toEqual([]);
        expect(room.setCalls).toEqual([true]);
        expect(room.localParticipant.identity).toBe('');
    });

    it('becomes active only once the promise resolved, the worker acked AND the key has landed', async () => {
        const room = new FakeRoom();
        const k = deferredKey();
        activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        await flush();
        room.signalConnected();
        room.ackLocal();
        expect(active).toBe(0); // everything but the key
        k.land();
        await flush();
        expect(active).toBe(1);
        expect(failures).toEqual([]);
    });

    it('the key landing before the ack is fine too — order between the three is irrelevant', async () => {
        const room = new FakeRoom();
        const k = deferredKey();
        activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        k.land();
        await flush();
        expect(active).toBe(0);
        room.signalConnected();
        room.ackLocal();
        expect(active).toBe(1);
    });

    it('fails closed (no_key) when keyReady settles but getKeys() is still empty — the promise is never trusted alone', async () => {
        const room = new FakeRoom();
        const k = deferredKey();
        activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        k.settleEmpty();
        await flush();
        expect(failures).toEqual([{ kind: 'no_key' }]);
        expect(room.listenerCount()).toBe(0);
    });

    it('fails closed (no_key) when keyReady rejects', async () => {
        const room = new FakeRoom();
        const k = deferredKey();
        activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        k.reject(new Error('bad base64'));
        await flush();
        expect(failures).toEqual([{ kind: 'no_key' }]);
    });

    it('fails closed (no_key) when the worker acked but the key never lands by the ack watchdog', async () => {
        const room = new FakeRoom();
        const k = deferredKey();
        activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        await flush();
        room.signalConnected();
        room.ackLocal();
        vi.advanceTimersByTime(DEFAULT_ACK_TIMEOUT_MS);
        expect(failures).toEqual([{ kind: 'no_key' }]);
        expect(active).toBe(0);
    });

    it('a late-landing key after dispose is silent', async () => {
        const room = new FakeRoom();
        const k = deferredKey();
        const dispose = activateRoomE2EE(room, k.holder, handlers(), { keyReady: k.promise });
        dispose();
        k.land();
        await flush();
        room.signalConnected();
        room.ackLocal();
        expect(failures).toEqual([]);
        expect(active).toBe(0);
    });

    it('an already-resolved keyReady on a live, acknowledged room (re-run) goes active after a tick', async () => {
        const room = new FakeRoom();
        room.isE2EEEnabled = true;
        room.localParticipant.identity = 'me';
        activateRoomE2EE(room, keyHolder(1), handlers(), { keyReady: Promise.resolve() });
        await flush();
        expect(active).toBe(1);
    });

    it('without keyReady the synchronous precondition is unchanged (empty provider → no_key immediately)', () => {
        const room = new FakeRoom();
        activateRoomE2EE(room, keyHolder(0), handlers());
        expect(room.setCalls).toEqual([]);
        expect(failures).toEqual([{ kind: 'no_key' }]);
    });
});

describe('installE2EEKey', () => {
    const installer = (opts: { landsKey?: boolean; rejectWith?: unknown } = { landsKey: true }) => {
        let keys = 0;
        const calls: ArrayBuffer[] = [];
        const kp: E2EEKeyInstaller = {
            getKeys: () => new Array(keys).fill({}),
            setKey: async (key) => { calls.push(key); if (opts.rejectWith) throw opts.rejectWith; if (opts.landsKey) keys = 1; },
        };
        return { kp, calls };
    };

    it('decodes base64 to the exact bytes and resolves once getKeys() reports the key', async () => {
        const { kp, calls } = installer();
        const raw = new Uint8Array([1, 2, 3, 250, 251, 252]);
        await installE2EEKey(kp, Buffer.from(raw).toString('base64'));
        expect(calls).toHaveLength(1);
        expect(new Uint8Array(calls[0])).toEqual(raw);
    });

    it('rejects when setKey resolves but the provider still holds nothing', async () => {
        const { kp } = installer({ landsKey: false });
        await expect(installE2EEKey(kp, Buffer.from([1]).toString('base64'))).rejects.toThrow(/holds no key/);
    });

    it('rejects on malformed base64 without calling setKey', async () => {
        const { kp, calls } = installer();
        await expect(installE2EEKey(kp, '%%%')).rejects.toBeTruthy();
        expect(calls).toHaveLength(0);
    });

    it('propagates a setKey rejection', async () => {
        const boom = new Error('derivation failed');
        const { kp } = installer({ rejectWith: boom });
        await expect(installE2EEKey(kp, Buffer.from([1]).toString('base64'))).rejects.toBe(boom);
    });
});

describe('describeE2EEActivationFailure', () => {
    it('never offers a plaintext fallback or blames the user', () => {
        const kinds: E2EEActivationFailure[] = [
            { kind: 'not_configured' }, { kind: 'no_key' }, { kind: 'rejected', error: 1 },
            { kind: 'ack_timeout', afterMs: 1 }, { kind: 'plaintext_publication', trackSid: 'x', source: 'y' },
        ];
        for (const k of kinds) {
            const text = describeE2EEActivationFailure(k);
            expect(text.length).toBeGreaterThan(20);
            expect(text.toLowerCase()).not.toMatch(/unencrypted call|continue anyway|without encryption\?|your fault/);
        }
    });
});
