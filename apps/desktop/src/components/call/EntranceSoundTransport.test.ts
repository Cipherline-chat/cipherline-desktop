// @vitest-environment jsdom
/**
 * The LiveKit binding of custom entrance sounds, driven through a real React
 * render against two fake Rooms joined by a fake SFU that forwards
 * publishData to the addressed peers (same approach as
 * hooks/useAnnotationTransport.test.ts). The pure rules (crypto, reassembly,
 * planner) have their own suites; this proves the wiring: who is sent what,
 * when, under which key, and that the receiver ends up with the sound.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomEvent, ConnectionState } from 'livekit-client';

// jsdom's crypto has no subtle; the app runs on the platform WebCrypto.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const state = vi.hoisted(() => ({
    room: null as unknown,
    personalization: {} as Record<string, string | null>,
    own: null as null | { id: string; bytes: Uint8Array },
    ownListeners: new Set<() => void>(),
}));

vi.mock('@livekit/components-react', () => ({ useRoomContext: () => state.room }));
vi.mock('../../utils/callPersonalizationStore', () => ({
    useCallPersonalization: (uid: string | null) => ({ ring_color: null, entrance_sound: uid ? state.personalization[uid] ?? null : null, theme: null }),
    freshCallPersonalization: async (uid: string) => ({ ring_color: null, entrance_sound: state.personalization[uid] ?? null, theme: null }),
    getCallPersonalization: (uid: string) => ({ ring_color: null, entrance_sound: state.personalization[uid] ?? null, theme: null }),
}));
vi.mock('../../utils/customEntranceSound/ownStore', () => ({
    ownEntranceSound: () => ({
        current: () => (state.own ? { id: state.own.id, size: state.own.bytes.length, durationMs: 1000, at: 1 } : null),
        read: async () => state.own?.bytes ?? null,
        subscribe: (cb: () => void) => { state.ownListeners.add(cb); return () => state.ownListeners.delete(cb); },
    }),
}));
vi.mock('../../utils/customEntranceSound/browser', () => ({
    decodeSound: async () => ({ channels: [Float32Array.from({ length: 4800 }, (_, i) => 0.2 * Math.sin(i / 7))], sampleRate: 48_000 }),
}));

const { EntranceSoundTransport } = await import('./EntranceSoundTransport');
const { receivedSounds } = await import('../../utils/customEntranceSound/receivedCache');
const { contentIdOf } = await import('../../utils/customEntranceSound/identity');
const { ENTRANCE_SOUND_TOPIC } = await import('../../utils/customEntranceSound/wire');
const { EBML_MAGIC } = await import('../../utils/customEntranceSound/constants');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

interface Sent { from: string; payload: Uint8Array; topic?: string; to?: string[] }

/** A tiny SFU: rooms by identity, publishData forwarded to the addressed peers. */
function makeSfu() {
    const rooms = new Map<string, ReturnType<typeof makeRoom>>();
    const sent: Sent[] = [];
    function makeRoom(identity: string) {
        const emitter = new EventEmitter();
        const room = {
            state: ConnectionState.Connected,
            options: {},
            remoteParticipants: new Map<string, { identity: string }>(),
            localParticipant: {
                identity,
                publishData: vi.fn(async (payload: Uint8Array, opts: { topic?: string; destinationIdentities?: string[] }) => {
                    sent.push({ from: identity, payload, topic: opts.topic, to: opts.destinationIdentities });
                    for (const [id, r] of rooms) {
                        if (id === identity) continue;
                        if (opts.destinationIdentities && !opts.destinationIdentities.includes(id)) continue;
                        r.emitter.emit(RoomEvent.DataReceived, payload, { identity }, undefined, opts.topic);
                    }
                }),
            },
            emitter,
            on: (e: string, h: (...a: unknown[]) => void) => emitter.on(e, h),
            off: (e: string, h: (...a: unknown[]) => void) => emitter.off(e, h),
        };
        rooms.set(identity, room);
        return room;
    }
    /** `who` joins: everybody already there sees ParticipantConnected. */
    function join(who: string) {
        const r = rooms.get(who)!;
        for (const [id, other] of rooms) {
            if (id === who) continue;
            r.remoteParticipants.set(id, { identity: id });
            other.remoteParticipants.set(who, { identity: who });
            other.emitter.emit(RoomEvent.ParticipantConnected, { identity: who });
        }
    }
    return { rooms, sent, makeRoom, join };
}

function webm(n: number): Uint8Array {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 17 + 3) & 0xff);
    b.set(EBML_MAGIC, 0);
    return b;
}

const mounted: Root[] = [];
function mount(room: unknown, keyB64: string) {
    state.room = room;
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => { root.render(React.createElement(EntranceSoundTransport, { keyB64 })); });
    mounted.push(root);
    return root;
}

/** Real timers: the send debounce is 150 ms and the crypto runs on the platform. */
const sleep = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
/** Wait (bounded) for an expectation to hold. */
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 8_000, interval: 50 });
/** For "nothing happens" checks: comfortably past the debounce + a full send. */
const quiet = () => sleep(800);

beforeEach(() => {
    receivedSounds.clear();
    state.personalization = {};
    state.own = null;
    state.ownListeners.clear();
});
afterEach(() => {
    for (const r of mounted.splice(0)) act(() => r.unmount());
});

describe('EntranceSoundTransport', () => {
    it('a joiner sends their sound, sealed, to the people already there, who verify and cache it', async () => {
        const bytes = webm(20_000);
        const id = await contentIdOf(bytes);
        state.own = { id, bytes };
        state.personalization = { alice: `custom:${id}` };
        const sfu = makeSfu();
        const bob = sfu.makeRoom('bob');
        mount(bob, KEY);
        const alice = sfu.makeRoom('alice');
        sfu.join('alice');
        // Alice mounts her own transport after connecting (mount picks up who is there).
        state.room = alice;
        const host = document.createElement('div');
        const root = createRoot(host);
        mounted.push(root);
        act(() => { root.render(React.createElement(EntranceSoundTransport, { keyB64: KEY })); });
        await until(() => expect(receivedSounds.has(id)).toBe(true));

        const fromAlice = sfu.sent.filter(s => s.from === 'alice');
        expect(fromAlice.length).toBe(3); // 20 KB = 3 chunks
        for (const s of fromAlice) {
            expect(s.topic).toBe(ENTRANCE_SOUND_TOPIC);
            expect(s.to).toEqual(['bob']);
            // Sealed: the WebM magic + body never appear on the wire.
            expect(Array.from(s.payload.subarray(35, 35 + 4))).not.toEqual(Array.from(EBML_MAGIC));
        }
        expect(receivedSounds.get(id)?.bytes).toEqual(bytes);
    });

    it('sends to each newcomer once (dedupe), and nothing to people who already have it', async () => {
        const bytes = webm(500);
        const id = await contentIdOf(bytes);
        state.own = { id, bytes };
        state.personalization = { alice: `custom:${id}` };
        const sfu = makeSfu();
        const alice = sfu.makeRoom('alice');
        mount(alice, KEY);
        sfu.makeRoom('bob');
        sfu.join('bob');
        await until(() => expect(sfu.sent.map(s => s.to)).toEqual([['bob']]));
        alice.emitter.emit(RoomEvent.ParticipantConnected, { identity: 'bob' }); // a duplicate event
        await quiet();
        expect(sfu.sent.length).toBe(1);
        await sleep(1_000); // past the planner's 1 s gap between bursts
        sfu.makeRoom('cat');
        sfu.join('cat');
        await until(() => expect(sfu.sent.map(s => s.to)).toEqual([['bob'], ['cat']]));
    });

    it('mounted before the join response (no identity yet): sends once Connected fires', async () => {
        const bytes = webm(500);
        const id = await contentIdOf(bytes);
        state.own = { id, bytes };
        state.personalization = { alice: `custom:${id}` };
        const sfu = makeSfu();
        sfu.makeRoom('bob');
        const alice = sfu.makeRoom('alice');
        alice.localParticipant.identity = '';
        (alice as { state: ConnectionState }).state = ConnectionState.Connecting;
        mount(alice, KEY);
        await quiet();
        expect(sfu.sent.length).toBe(0);
        alice.localParticipant.identity = 'alice';
        sfu.join('alice');
        (alice as { state: ConnectionState }).state = ConnectionState.Connected;
        act(() => { alice.emitter.emit(RoomEvent.Connected); });
        await until(() => expect(sfu.sent.map(s => s.to)).toEqual([['bob']]));
        expect(receivedSounds.has(id)).toBe(false); // bob mounted no transport in this test
    });

    it('sends nothing without a call key', async () => {
        const bytes = webm(500);
        const id = await contentIdOf(bytes);
        state.own = { id, bytes };
        state.personalization = { alice: `custom:${id}` };
        const sfu = makeSfu();
        const alice = sfu.makeRoom('alice');
        mount(alice, '');
        sfu.makeRoom('bob');
        sfu.join('bob');
        await quiet();
        expect(sfu.sent.length).toBe(0);
    });

    it('sends nothing when this device does not hold the sound your profile points at', async () => {
        const bytes = webm(500);
        state.own = { id: await contentIdOf(bytes), bytes };
        state.personalization = { alice: `custom:${'f'.repeat(32)}` };
        const sfu = makeSfu();
        mount(sfu.makeRoom('alice'), KEY);
        sfu.makeRoom('bob');
        sfu.join('bob');
        await quiet();
        expect(sfu.sent.length).toBe(0);
    });

    it('a receiver with a different call key caches nothing', async () => {
        const bytes = webm(500);
        const id = await contentIdOf(bytes);
        state.own = { id, bytes };
        state.personalization = { alice: `custom:${id}` };
        const sfu = makeSfu();
        mount(sfu.makeRoom('bob'), btoa(String.fromCharCode(...new Uint8Array(32).fill(6))));
        const alice = sfu.makeRoom('alice');
        sfu.join('alice');
        mount(alice, KEY);
        await until(() => expect(sfu.sent.length).toBe(1));
        await quiet();
        expect(receivedSounds.has(id)).toBe(false);
    });
});
