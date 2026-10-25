import { useEffect, useMemo, useRef, useState } from 'react';
import { RoomEvent, ConnectionState, type Room, type RemoteParticipant } from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import { freshCallPersonalization, getCallPersonalization, useCallPersonalization } from '../../utils/callPersonalizationStore';
import { customContentId } from '../../utils/customEntranceSound/constants';
import { ownEntranceSound } from '../../utils/customEntranceSound/ownStore';
import { receivedSounds } from '../../utils/customEntranceSound/receivedCache';
import { EntranceSoundReceiver } from '../../utils/customEntranceSound/receiver';
import { EntranceSendPlanner } from '../../utils/customEntranceSound/sendPlanner';
import { ENTRANCE_SOUND_TOPIC, deriveEntranceKey, sealSound } from '../../utils/customEntranceSound/wire';
import { decodeSound } from '../../utils/customEntranceSound/browser';

/** Coalesce a burst of joins into one send. */
const SEND_DEBOUNCE_MS = 150;
/** A second look after connecting, in case the roster filled in after the Connected event. */
const CONNECT_BACKSTOP_MS = 1_500;

/**
 * Custom entrance sounds, device to device inside the call. Renders nothing.
 * Must live inside <LiveKitRoom>.
 *
 * SEND: when this device is connected and YOUR server personalization says
 * `custom:<id>` and this device holds that sound (utils/customEntranceSound/
 * ownStore.ts), it is sent - sealed under a key derived from the call key
 * (utils/customEntranceSound/wire.ts) - to every peer that does not have it
 * yet: everyone present when you connect, then each person who joins. Deduped
 * and rate-limited by sendPlanner.ts. No call key, no send.
 *
 * RECEIVE: packets on ENTRANCE_SOUND_TOPIC go through receiver.ts (rate
 * limit, AES-GCM, bounded reassembly, hash == advertised id == the sender's
 * server personalization, decode, listener gain) into the in-memory cache that
 * useEntranceSounds plays from.
 *
 * `keyB64` is CallPane's current room key (the same one LiveKit's key provider
 * gets); it may rotate mid-call.
 */
export function EntranceSoundTransport({ keyB64 }: { keyB64: string }): null {
    const room = useRoomContext() as Room | undefined;
    // The entrance-sound key for the CURRENT call key (re-derived on rotation).
    const keyPromise = useMemo<Promise<CryptoKey | null>>(
        () => (keyB64 ? deriveEntranceKey(keyB64).catch(() => null) : Promise.resolve(null)),
        [keyB64],
    );
    const keyRef = useRef(keyPromise);
    // Your identity is only known once the join response lands; re-render then,
    // so your own cosmetics are registered for the batched read.
    const [, setConnectedTick] = useState(0);
    const me = room?.localParticipant?.identity ?? '';
    const mine = useCallPersonalization(me || null);
    const myId = customContentId(mine.entrance_sound);
    const [ownTick, setOwnTick] = useState(0);
    useEffect(() => ownEntranceSound().subscribe(() => setOwnTick(n => n + 1)), []);

    // ── receive ─────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!room) return;
        const receiver = new EntranceSoundReceiver({
            key: () => keyRef.current,
            expectedId: async sender => customContentId((await freshCallPersonalization(sender)).entrance_sound),
            decode: decodeSound,
            cache: receivedSounds,
        });
        const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
            if (topic !== ENTRANCE_SOUND_TOPIC || !participant) return;
            void receiver.onPacket(participant.identity, payload).catch(() => { /* no sound */ });
        };
        const onLeft = (p: RemoteParticipant) => receiver.forget(p.identity);
        room.on(RoomEvent.DataReceived, onData);
        room.on(RoomEvent.ParticipantDisconnected, onLeft);
        return () => {
            room.off(RoomEvent.DataReceived, onData);
            room.off(RoomEvent.ParticipantDisconnected, onLeft);
            receiver.reset();
        };
    }, [room]);

    // ── send ────────────────────────────────────────────────────────────────
    const [planner] = useState(() => new EntranceSendPlanner());
    const kick = useRef<() => void>(() => {});

    useEffect(() => {
        if (!room) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let backstop: ReturnType<typeof setTimeout> | null = null;
        let sending = false;

        const run = async () => {
            timer = null;
            if (disposed || room.state !== ConnectionState.Connected) return;
            if (sending) { schedule(300); return; } // a join during a send is picked up right after it
            const self = room.localParticipant.identity;
            // Read at send time, not from the last render: what your profile says NOW.
            const id = self ? customContentId(getCallPersonalization(self).entrance_sound) : null;
            const peers = [...room.remoteParticipants.values()].map(p => p.identity);
            if (!id || !self || peers.length === 0) return;
            const store = ownEntranceSound();
            if (store.current()?.id !== id) return; // this device does not hold the sound you chose
            const plan = planner.plan(peers, id);
            if (!plan) return;
            if ('retryInMs' in plan) { schedule(plan.retryInMs); return; }
            const key = await keyRef.current;
            if (!key || disposed) return; // never send without the call key
            const bytes = await store.read();
            if (!bytes || disposed) return;
            sending = true;
            try {
                const packets = await sealSound(key, id, bytes, self);
                for (const pkt of packets) {
                    if (disposed) return;
                    await room.localParticipant.publishData(pkt, {
                        reliable: true, topic: ENTRANCE_SOUND_TOPIC, destinationIdentities: plan.to,
                    });
                }
                planner.markSent(plan.to, id);
            } catch (err) {
                console.warn('[entrance-sound] send failed:', err);
            } finally {
                sending = false;
            }
        };
        const schedule = (ms = SEND_DEBOUNCE_MS) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { void run(); }, Math.max(0, ms));
        };
        kick.current = () => schedule();
        const onJoin = () => schedule();
        const onConnected = () => {
            setConnectedTick(n => n + 1);
            schedule();
            if (backstop) clearTimeout(backstop);
            backstop = setTimeout(() => schedule(), CONNECT_BACKSTOP_MS);
        };
        const onLeft = (p: RemoteParticipant) => planner.left(p.identity);
        room.on(RoomEvent.Connected, onConnected);
        room.on(RoomEvent.ParticipantConnected, onJoin);
        room.on(RoomEvent.ParticipantDisconnected, onLeft);
        if (room.state === ConnectionState.Connected) schedule();
        return () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            if (backstop) clearTimeout(backstop);
            kick.current = () => {};
            room.off(RoomEvent.Connected, onConnected);
            room.off(RoomEvent.ParticipantConnected, onJoin);
            room.off(RoomEvent.ParticipantDisconnected, onLeft);
        };
    }, [room, planner]);

    // Your sound (or which one this device holds) changed mid-call, or the key
    // arrived / rotated: refresh what the async paths read, and try again.
    useEffect(() => {
        keyRef.current = keyPromise;
        kick.current();
    }, [myId, ownTick, keyPromise]);

    return null;
}

export default EntranceSoundTransport;
