// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveKitRoom } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { E2EEActivator } from './E2EEActivator';
import { KEYRING_ATTR, RotatingKeyProvider, ringIndexForEpoch } from '../utils/e2eeKeyRing';

/**
 * <E2EEActivator> + the key ring: the roster decides the SEND index, the
 * capability attribute is advertised only once a key with an epoch is held,
 * and an install without an epoch stays on the legacy index-0 path.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (...args: unknown[]) => void;
class FakeRoom {
    options = { encryption: { keyProvider: {}, worker: {} } };
    isE2EEEnabled = false;
    state = 'disconnected';
    remoteParticipants = new Map<string, { identity: string; attributes: Record<string, string> }>();
    attrWrites: Array<Record<string, string>> = [];
    localParticipant = {
        identity: '',
        trackPublications: new Map(),
        setMicrophoneEnabled: async () => {}, setCameraEnabled: async () => {}, setScreenShareEnabled: async () => {},
        setAttributes: async (a: Record<string, string>) => { this.attrWrites.push(a); },
    };
    private listeners = new Map<string, Set<Listener>>();
    setE2EEEnabled() { return Promise.resolve(); }
    async connect() {}
    async disconnect() {}
    on(e: string, l: Listener) { (this.listeners.get(e) ?? this.listeners.set(e, new Set()).get(e)!).add(l); return this; }
    off(e: string, l: Listener) { this.listeners.get(e)?.delete(l); return this; }
    emit(e: string, ...a: unknown[]) { for (const l of [...(this.listeners.get(e) ?? [])]) l(...a); }
}

const b64 = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString('base64');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let container: HTMLDivElement;
let root: Root;

const mount = async (room: FakeRoom, kp: RotatingKeyProvider, keyB64: string, keyEpoch?: number) => {
    await act(async () => {
        root.render(React.createElement(LiveKitRoom, { room: room as never, token: 'jwt', serverUrl: 'ws://sfu.test', connect: true },
            React.createElement(E2EEActivator, { keyProvider: kp, keyB64, keyEpoch, onFailure: () => {} })));
    });
    await act(async () => { await sleep(30); });
};

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    for (const m of ['warn', 'log', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

describe('<E2EEActivator> key ring', () => {
    it('advertises cl.ekr only once connected AND holding an epoch-bearing key', async () => {
        const room = new FakeRoom();
        await mount(room, new RotatingKeyProvider({ switchDelayMs: 20 }), b64(1), 1);
        expect(room.attrWrites).toEqual([]);                  // not connected yet
        room.state = 'connected';
        await act(async () => { room.emit(RoomEvent.Connected); });
        expect(room.attrWrites).toEqual([{ [KEYRING_ATTR]: '1' }]);
        await act(async () => { room.emit(RoomEvent.Reconnected); });
        expect(room.attrWrites).toHaveLength(2);              // re-asserted after a reconnect
    });

    it('an install WITHOUT an epoch (Calls channel / unconfirmed key) never advertises and stays on index 0', async () => {
        const room = new FakeRoom();
        room.state = 'connected';
        const kp = new RotatingKeyProvider({ switchDelayMs: 20 });
        await mount(room, kp, b64(1), undefined);
        await act(async () => { room.emit(RoomEvent.Connected); });
        expect(room.attrWrites).toEqual([]);
        expect(kp.ringCapable).toBe(false);
        expect(kp.currentSendIndex).toBe(0);
    });

    it('a remote without the attribute pins the sender to index 0; when everyone advertises it moves to the slot; a legacy join moves it back', async () => {
        const room = new FakeRoom();
        room.state = 'connected';
        room.remoteParticipants.set('old', { identity: 'old', attributes: {} });
        const kp = new RotatingKeyProvider({ switchDelayMs: 20 });
        await mount(room, kp, b64(1), 4);
        await act(async () => { await sleep(60); });
        expect(kp.currentSendIndex).toBe(0);                  // legacy peer present

        room.remoteParticipants.set('old', { identity: 'old', attributes: { [KEYRING_ATTR]: '1' } });
        await act(async () => { room.emit(RoomEvent.ParticipantAttributesChanged, { [KEYRING_ATTR]: '1' }, room.remoteParticipants.get('old')); await sleep(40); });
        expect(kp.currentSendIndex).toBe(ringIndexForEpoch(4));

        room.remoteParticipants.set('mobile', { identity: 'mobile', attributes: {} });
        await act(async () => { room.emit(RoomEvent.ParticipantConnected, room.remoteParticipants.get('mobile')); });
        expect(kp.currentSendIndex).toBe(0);                  // immediate

        room.remoteParticipants.delete('mobile');
        await act(async () => { room.emit(RoomEvent.ParticipantDisconnected, { identity: 'mobile' }); await sleep(20); });
        expect(kp.currentSendIndex).toBe(ringIndexForEpoch(4));
    });
});
