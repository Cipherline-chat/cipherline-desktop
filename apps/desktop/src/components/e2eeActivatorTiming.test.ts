// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveKitRoom, useRoomContext } from '@livekit/components-react';
import { ExternalE2EEKeyProvider, RoomEvent, Encryption_Type } from 'livekit-client';
import { E2EEActivator } from './E2EEActivator';
import { activateRoomE2EE, type ActivatablePublication, type E2EEActivationFailure } from '../utils/e2eeActivation';

/**
 * Render-based regression test for the ORDER of "install the room key" and
 * "activate encryption" — the one property the source-scan in
 * e2eeActivationWiring.test.ts cannot see and the unit tests in
 * utils/e2eeActivation.test.ts deliberately fake away (their key holder is
 * pre-populated and synchronous).
 *
 * This mounts the REAL <E2EEActivator> inside the REAL <LiveKitRoom> from
 * @livekit/components-react (Room handed in via its `room` prop; it still
 * creates the context in an effect, gates children on it, and calls
 * `room.connect()` in a later effect of the same commit), with the REAL
 * ExternalE2EEKeyProvider whose `setKey()` does a genuine async WebCrypto
 * import — and, for determinism, a subclass whose derivation is HELD until
 * the test releases it. React's pipeline speed no longer decides the outcome.
 *
 * What it proves: activation is issued pre-connect, does not fail on an
 * empty provider while the key is in flight, becomes active only once the
 * key has actually landed, and fails closed if it never does. It also keeps
 * the shape that shipped in 9642128d — key installed by a fire-and-forget
 * effect in a parent, checked synchronously by a child — as a named case, so
 * the trap stays documented by a test that would catch its return.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (...args: unknown[]) => void;

/** Structural Room: what <LiveKitRoom> touches plus what activateRoomE2EE touches. */
class FakeRoom {
    options: { encryption?: unknown } = { encryption: { keyProvider: {}, worker: {} } };
    isE2EEEnabled = false;
    state = 'disconnected';
    localParticipant = {
        identity: '',
        trackPublications: new Map<string, ActivatablePublication>(),
        // <LiveKitRoom>'s own SignalConnected handler publishes through these.
        setMicrophoneEnabled: async () => {},
        setCameraEnabled: async () => {},
        setScreenShareEnabled: async () => {},
    };
    /** Every ordered call that matters: 'setE2EEEnabled' | 'connect'. */
    calls: string[] = [];
    private listeners = new Map<string, Set<Listener>>();

    setE2EEEnabled(enabled: boolean) { this.calls.push(`setE2EEEnabled(${enabled})`); return Promise.resolve(); }
    async connect() { this.calls.push('connect'); }
    async disconnect() {}
    on(event: string, l: Listener) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(l); return this; }
    off(event: string, l: Listener) { this.listeners.get(event)?.delete(l); return this; }
    emit(event: string, ...args: unknown[]) { for (const l of [...(this.listeners.get(event) ?? [])]) l(...args); }
    signalConnected(identity = 'me') { this.localParticipant.identity = identity; this.emit(RoomEvent.SignalConnected); }
    ackLocal() { this.isE2EEEnabled = true; this.emit(RoomEvent.ParticipantEncryptionStatusChanged, true, { isLocal: true }); }
    publish(sid: string, encryption: number, source = 'microphone') {
        const pub = { trackSid: sid, source, trackInfo: { encryption } };
        this.localParticipant.trackPublications.set(sid, pub);
        this.emit(RoomEvent.LocalTrackPublished, pub, this.localParticipant);
    }
}

/** The real provider, real derivation — but the async step is held until the test says go. */
class HeldKeyProvider extends ExternalE2EEKeyProvider {
    setKeyCalls = 0;
    private gate: Promise<void>;
    release!: () => void;
    constructor() {
        super();
        this.gate = new Promise<void>((r) => { this.release = r; });
    }
    async setKey(key: string | ArrayBuffer): Promise<void> {
        this.setKeyCalls++;
        await this.gate;
        return super.setKey(key);
    }
}

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const KEY2_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

let container: HTMLDivElement;
let root: Root;
let failures: E2EEActivationFailure[];
let active: number;

const mountActivator = async (room: FakeRoom, keyProvider: ExternalE2EEKeyProvider, keyB64: string) => {
    await act(async () => {
        root.render(
            React.createElement(LiveKitRoom, { room: room as never, token: 'jwt', serverUrl: 'ws://sfu.test', connect: true },
                React.createElement(E2EEActivator, {
                    keyProvider, keyB64,
                    onFailure: (f: E2EEActivationFailure) => failures.push(f),
                    onActive: () => { active++; },
                })),
        );
    });
};

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    failures = [];
    active = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
});

describe('<E2EEActivator> orders key install before activation', () => {
    it('activates pre-connect on an EMPTY provider while the key is still deriving, and becomes active only once it has landed', async () => {
        const room = new FakeRoom();
        const kp = new HeldKeyProvider();
        await mountActivator(room, kp, KEY_B64);

        // The key is genuinely not there yet — and that is not a failure.
        expect(kp.setKeyCalls).toBe(1);
        expect(kp.getKeys()).toHaveLength(0);
        expect(failures).toEqual([]);
        // Activation was still issued in the child effect, BEFORE the wrapper's connect effect.
        expect(room.calls).toEqual(['setE2EEEnabled(true)', 'connect']);

        // The worker acks and the SDK promise resolved — still not active: no key yet.
        await act(async () => { room.signalConnected(); room.ackLocal(); });
        await flush();
        expect(active).toBe(0);
        expect(failures).toEqual([]);

        // The derivation completes → the key is visible → active, and publications are policed.
        await act(async () => { kp.release(); });
        await flush();
        expect(kp.getKeys()).toHaveLength(1);
        expect(active).toBe(1);
        expect(failures).toEqual([]);
        await act(async () => { room.publish('TR_1', Encryption_Type.GCM); });
        expect(failures).toEqual([]);
        await act(async () => { room.publish('TR_2', Encryption_Type.NONE, 'camera'); });
        expect(failures).toEqual([{ kind: 'plaintext_publication', trackSid: 'TR_2', source: 'camera' }]);
    });

    it('with the real provider and no artificial hold, a keyed mount goes active (the everyday path)', async () => {
        const room = new FakeRoom();
        const kp = new ExternalE2EEKeyProvider();
        await mountActivator(room, kp, KEY_B64);
        await flush();
        await act(async () => { room.signalConnected(); room.ackLocal(); });
        await flush();
        expect(kp.getKeys()).toHaveLength(1);
        expect(active).toBe(1);
        expect(failures).toEqual([]);
        expect(room.calls).toEqual(['setE2EEEnabled(true)', 'connect']);
    });

    it('fails closed (no_key) when the derivation settles but the provider still holds nothing', async () => {
        const room = new FakeRoom();
        const kp = new ExternalE2EEKeyProvider();
        // A provider whose setKey "succeeds" without installing anything — the promise alone is never trusted.
        vi.spyOn(kp, 'setKey').mockResolvedValue(undefined);
        await mountActivator(room, kp, KEY_B64);
        await flush();
        expect(failures).toEqual([{ kind: 'no_key' }]);
        expect(active).toBe(0);
    });

    it('fails closed (no_key) on a malformed key rather than activating', async () => {
        const room = new FakeRoom();
        const kp = new ExternalE2EEKeyProvider();
        await mountActivator(room, kp, '%%not-base64%%');
        await flush();
        expect(failures).toEqual([{ kind: 'no_key' }]);
        expect(active).toBe(0);
    });

    it('a key rotation re-installs the key WITHOUT re-running activation', async () => {
        const room = new FakeRoom();
        const kp = new ExternalE2EEKeyProvider();
        const setKey = vi.spyOn(kp, 'setKey');
        await mountActivator(room, kp, KEY_B64);
        await flush();
        await act(async () => { room.signalConnected(); room.ackLocal(); });
        await flush();
        expect(active).toBe(1);

        await mountActivator(room, kp, KEY2_B64); // same Room, new key
        await flush();
        expect(setKey).toHaveBeenCalledTimes(2);
        expect(room.calls.filter((c) => c.startsWith('setE2EEEnabled'))).toHaveLength(1);
        expect(active).toBe(1);
        expect(failures).toEqual([]);
    });

    it('a keyless mount installs nothing and activates nothing — logged, not failed', async () => {
        const room = new FakeRoom();
        const kp = new ExternalE2EEKeyProvider();
        const setKey = vi.spyOn(kp, 'setKey');
        await mountActivator(room, kp, '');
        await flush();
        await act(async () => { room.signalConnected(); });
        expect(setKey).not.toHaveBeenCalled();
        expect(room.calls).toEqual(['connect']);
        expect(failures).toEqual([]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no room key'));
    });

    it('a key that arrives AFTER a keyless mount activates the live room, in order', async () => {
        // No caller does this today (Dashboard never updates e2ee_key_b64 after mount), but the
        // component must not depend on that: this is exactly the case where "parent installs,
        // child checks" ran the child first.
        const room = new FakeRoom();
        const kp = new HeldKeyProvider();
        await mountActivator(room, kp, '');
        await act(async () => { room.signalConnected(); });
        await mountActivator(room, kp, KEY_B64);
        expect(kp.setKeyCalls).toBe(1);
        expect(failures).toEqual([]);
        expect(room.calls).toEqual(['connect', 'setE2EEEnabled(true)']);
        await act(async () => { room.ackLocal(); kp.release(); });
        await flush();
        expect(active).toBe(1);
        expect(failures).toEqual([]);
    });
});

describe('the shape that shipped in 9642128d (parent installs the key, child snapshots getKeys())', () => {
    /** CallPane@9642128d, reduced to its two effects; activateRoomE2EE called without keyReady. */
    const LegacyActivator = ({ keyProvider }: { keyProvider: ExternalE2EEKeyProvider }) => {
        const room = useRoomContext();
        React.useEffect(() => activateRoomE2EE(room as never, keyProvider, {
            onFailure: (f) => failures.push(f),
            onActive: () => { active++; },
        }), [room, keyProvider]);
        return null;
    };
    const LegacyPane = ({ room, keyProvider, keyB64 }: { room: FakeRoom; keyProvider: ExternalE2EEKeyProvider; keyB64: string }) => {
        React.useEffect(() => {
            const bin = atob(keyB64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            keyProvider.setKey(bytes.buffer); // fire-and-forget, as shipped
        }, [keyB64, keyProvider]);
        return React.createElement(LiveKitRoom, { room: room as never, token: 'jwt', serverUrl: 'ws://sfu.test', connect: true },
            React.createElement(LegacyActivator, { keyProvider }));
    };

    it('fails closed with no_key the moment setKey() takes longer than one React commit', async () => {
        const room = new FakeRoom();
        const kp = new HeldKeyProvider();
        await act(async () => { root.render(React.createElement(LegacyPane, { room, keyProvider: kp, keyB64: KEY_B64 })); });
        expect(kp.setKeyCalls).toBe(1);
        expect(failures).toEqual([{ kind: 'no_key' }]);
        expect(room.calls).toEqual(['connect']); // never even activated
        await act(async () => { kp.release(); });
        await flush();
        expect(active).toBe(0);
    });

    // The counterpart — "and passes when the browser settles the derivation first" — is
    // deliberately NOT asserted here: under act() React flushes the second commit
    // synchronously, i.e. faster than any real browser, so this shape fails even with the
    // real provider in Node. The real-browser behaviour (Chromium 153 settles a raw HKDF
    // import within a microtask, so the shipped shape passed 5/5 there) is recorded in the
    // hardening commit message, not asserted by a test that would be lying about timing.
});
