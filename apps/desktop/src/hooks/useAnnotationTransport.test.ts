// @vitest-environment jsdom
/**
 * Regression test for a real incident report ("annotation doesn't work at
 * all — requesting doesn't work, other people can't see me annotate"):
 * useAnnotationTransport captured `me`/`roomId` ONCE, synchronously, when its
 * effect first ran. useRoomContext() hands child components the LiveKit Room
 * object as soon as <LiveKitRoom> mounts — well before room.connect()'s join
 * response arrives — and both room.localParticipant.identity and room.name
 * are populated FROM that join response. A capture-once read a moment too
 * early froze in '' for the entire call (the effect only re-runs on [room],
 * and finishing the handshake doesn't change that reference), so every
 * outgoing message was stamped with the wrong room/sender and every "is this
 * mine" check compared against ''.
 *
 * This is the one file in the feature that isn't pure-logic-testable (it's
 * the actual LiveKit binding), so it's exercised here through a real React
 * render against a minimal fake Room, rather than as a further vitest suite
 * for the already-covered pure transport/codec/store logic. Plain
 * React.createElement rather than JSX so this can stay a .test.ts file —
 * this repo's vitest config only picks up *.test.ts, and no .tsx component
 * test exists anywhere else to justify widening it just for this one case.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomEvent, Track, Encryption_Type } from 'livekit-client';
import { useAnnotationTransport } from './useAnnotationTransport';
import {
    annotationStore, trackKey, selectCanAnnotate, selectCanGrantAnnotation,
} from '../utils/annotationStore';
import { decode, encode, ANNOT_TOPIC, type AnnotMsg } from '../utils/annotationCodec';

/** Just enough of a LiveKit Room to drive the hook: identity/name mutable
 *  exactly like the real SDK (both are backed by the async join response),
 *  an EventEmitter for room.on/off, and a spy for publishData. */
function makeFakeRoom() {
    const emitter = new EventEmitter();
    const localParticipant = {
        identity: '', // pre-join: this is genuinely what the SDK reports
        publishData: vi.fn(async () => {}),
        /** What we are publishing; the hook mirrors this into the store.
         *  `isMuted` matters: turning a CAMERA off mutes its publication and
         *  leaves it in this map, where an unpublished screen share is
         *  removed from it. */
        trackPublications: new Map<string, { source: string; isMuted: boolean }>(),
    };
    return {
        name: '', // pre-join: same as above
        options: {},
        localParticipant,
        remoteParticipants: new Map(),
        emitter,
        on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
        off: (event: string, handler: (...args: any[]) => void) => emitter.off(event, handler),
    } as any;
}

type FakeRoom = ReturnType<typeof makeFakeRoom>;

/** Every annotation message the hook has published, decoded. */
function published(room: FakeRoom, roomId: string) {
    return room.localParticipant.publishData.mock.calls
        .map(([bytes]: [unknown]) => decode(Uint8Array.from(bytes as ArrayLike<number>), roomId))
        .filter(Boolean);
}

const Host: React.FC<{ room: any }> = ({ room }) => {
    useAnnotationTransport(room);
    return null;
};

// React 18+'s act() checks this global before it will run without warning —
// unset by default outside a framework like React Testing Library that sets
// it for you.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useAnnotationTransport — identity/room read live, not captured once', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        annotationStore.reset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        container.remove();
        vi.restoreAllMocks();
    });

    it('publishes a local stroke stamped with the CURRENT identity/room, even though both were empty when the hook first mounted', async () => {
        const room = makeFakeRoom();

        // Mount while the room looks exactly like it does right after
        // <LiveKitRoom> renders and before connect() resolves.
        await act(async () => { root.render(React.createElement(Host, { room })); });

        // The join response lands. Nothing re-renders Host and `room` is the
        // same object reference throughout — this only reaches the hook if
        // it reads room.name / room.localParticipant.identity live rather
        // than from a value it closed over at mount.
        room.name = 'room-1';
        room.localParticipant.identity = 'alice';

        // The local user draws. VideoTile stamps `by` from a LIVE read of
        // localParticipant.identity too (a separate, already-correct path;
        // this test is specifically about the transport hook's OWN identity
        // tracking, not VideoTile's).
        const key = trackKey('alice', 'screen_share');
        await act(async () => {
            annotationStore.beginStroke(key, 'alice', { x: 0.5, y: 0.5 });
        });

        expect(room.localParticipant.publishData).toHaveBeenCalledTimes(1);
        const [bytes] = room.localParticipant.publishData.mock.calls[0];
        // Uint8Array.from(...) re-materializes the payload under whichever
        // Uint8Array constructor is in scope here — jsdom's TextEncoder
        // (used by encode() inside annotationCodec.ts, evaluated under this
        // file's @vitest-environment jsdom) hands back an instance from a
        // different realm than plain `Uint8Array`, which decode()'s own
        // `bytes instanceof Uint8Array` guard would otherwise reject as if
        // it weren't a byte array at all — a test-environment artifact,
        // not something that happens in the real single-realm renderer.
        const normalized = Uint8Array.from(bytes as unknown as ArrayLike<number>);
        // decode() itself enforces "a packet cannot cross rooms" (rejects if
        // the stamped room doesn't match the room passed in) — so this
        // assertion fails both if nothing was published AND if it was
        // published under the wrong (stale) room id.
        const msg = decode(normalized, 'room-1');
        expect(msg).toEqual(
            expect.objectContaining({ t: 'stroke.begin', room: 'room-1', track: key }),
        );
    });

    /**
     * Regression: "when the video stream closes the person still has
     * annotation ability and it has the little pencil icon".
     *
     * The store was doing the right thing — dropTrack clears the grants — but
     * the hook did it inside `silently`, which exists to stop us re-publishing
     * changes we merely MIRRORED from someone else. Suppressing the diff for a
     * track we OWN meant the clearing never reached the wire, and a grant list
     * is authoritative from its owner alone: every peer kept the last list we
     * sent, so the grantee still believed it could draw and every client kept
     * rendering the pencil beside their name.
     */
    describe('ending my own share clears its grants everywhere, not just locally', () => {
        const connect = async (room: FakeRoom) => {
            await act(async () => { root.render(React.createElement(Host, { room })); });
            room.name = 'room-1';
            room.localParticipant.identity = 'alice';
            room.localParticipant.trackPublications.set('sh', { source: Track.Source.ScreenShare, isMuted: false });
            await act(async () => {
                room.emitter.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.ScreenShare });
            });
        };

        it('publishes grant.revoke + an empty grant.list when the track is unpublished', async () => {
            const room = makeFakeRoom();
            await connect(room);
            const key = trackKey('alice', Track.Source.ScreenShare);

            await act(async () => { annotationStore.grant(key, 'bob'); });
            expect(annotationStore.getState().grants[key]).toEqual(['bob']);
            room.localParticipant.publishData.mockClear();

            // The share ends.
            room.localParticipant.trackPublications.clear();
            await act(async () => {
                room.emitter.emit(
                    RoomEvent.LocalTrackUnpublished,
                    { source: Track.Source.ScreenShare },
                    room.localParticipant,
                );
            });

            const msgs = published(room, 'room-1');
            expect(msgs).toContainEqual(
                expect.objectContaining({ t: 'grant.revoke', track: key, identity: 'bob' }),
            );
            expect(msgs).toContainEqual(
                expect.objectContaining({ t: 'grant.list', track: key, identities: [] }),
            );
            // ...and locally too, so our own badge goes at the same moment.
            expect(annotationStore.getState().grants[key]).toBeUndefined();
            expect(selectCanAnnotate('bob')(annotationStore.getState())).toBe(false);
        });

        it('a re-share of the same surface starts ungranted', async () => {
            const room = makeFakeRoom();
            await connect(room);
            const key = trackKey('alice', Track.Source.ScreenShare);
            await act(async () => { annotationStore.grant(key, 'bob'); });

            room.localParticipant.trackPublications.clear();
            await act(async () => {
                room.emitter.emit(RoomEvent.LocalTrackUnpublished, { source: Track.Source.ScreenShare }, room.localParticipant);
            });
            room.localParticipant.trackPublications.set('sh', { source: Track.Source.ScreenShare, isMuted: false });
            await act(async () => {
                room.emitter.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.ScreenShare });
            });

            expect(annotationStore.getState().grants[key] ?? []).toEqual([]);
            // The surface is grantable again, but only by a deliberate act.
            expect(selectCanGrantAnnotation('alice', 'bob')(annotationStore.getState())).toBe(true);
        });

        it('a peer leaving takes their grant on my surfaces with them, out loud', async () => {
            const room = makeFakeRoom();
            await connect(room);
            const key = trackKey('alice', Track.Source.ScreenShare);
            await act(async () => { annotationStore.grant(key, 'bob'); });
            room.localParticipant.publishData.mockClear();

            await act(async () => {
                room.emitter.emit(RoomEvent.ParticipantDisconnected, { identity: 'bob' });
            });

            expect(published(room, 'room-1')).toContainEqual(
                expect.objectContaining({ t: 'grant.list', track: key, identities: [] }),
            );
            expect(selectCanAnnotate('bob')(annotationStore.getState())).toBe(false);
        });

        it('mirrors what I publish into the store, so a menu can offer "Allow Annotating"', async () => {
            const room = makeFakeRoom();
            await connect(room);
            expect(annotationStore.getState().ownedSurfaces)
                .toEqual([trackKey('alice', Track.Source.ScreenShare)]);
            expect(selectCanGrantAnnotation('alice', 'bob')(annotationStore.getState())).toBe(true);
        });
    });

    /**
     * Regression: "when someone ends their screenshare the pencil icon goes
     * away for the people who had access to draw, but it doesn't do the same
     * for cameras."
     *
     * Both halves of the teardown above hang off TrackUnpublished — and a
     * camera never fires it. livekit-client's setTrackEnabled(source, false)
     * unpublishes ONLY the screen share ("screenshare cannot be muted,
     * unpublish instead"); every other source is `track.mute()`, which leaves
     * the publication sitting in trackPublications and emits TrackMuted. So the
     * screen-share half of the feature worked and the camera half had no path
     * to the code at all.
     */
    describe('turning my camera off clears its grants, exactly as ending a share does', () => {
        const CAM = trackKey('alice', Track.Source.Camera);
        /** Connect with a live camera publication (mutable `isMuted`, like the
         *  SDK's own). Returns the publication object the events carry. */
        const connectWithCamera = async (room: FakeRoom) => {
            await act(async () => { root.render(React.createElement(Host, { room })); });
            room.name = 'room-1';
            room.localParticipant.identity = 'alice';
            const pub = { source: Track.Source.Camera, isMuted: false };
            room.localParticipant.trackPublications.set('cam', pub);
            await act(async () => { room.emitter.emit(RoomEvent.LocalTrackPublished, pub); });
            return pub;
        };

        it('publishes grant.revoke + an empty grant.list when the camera is MUTED', async () => {
            const room = makeFakeRoom();
            const pub = await connectWithCamera(room);
            await act(async () => { annotationStore.grant(CAM, 'bob'); });
            expect(annotationStore.getState().grants[CAM]).toEqual(['bob']);
            room.localParticipant.publishData.mockClear();

            // Camera off. The publication STAYS — this is the whole distinction.
            pub.isMuted = true;
            await act(async () => {
                room.emitter.emit(RoomEvent.TrackMuted, pub, room.localParticipant);
            });
            expect(room.localParticipant.trackPublications.size).toBe(1);

            const msgs = published(room, 'room-1');
            expect(msgs).toContainEqual(
                expect.objectContaining({ t: 'grant.revoke', track: CAM, identity: 'bob' }),
            );
            expect(msgs).toContainEqual(
                expect.objectContaining({ t: 'grant.list', track: CAM, identities: [] }),
            );
            // ...and the pencil badge goes on every surface, ours included.
            expect(annotationStore.getState().grants[CAM]).toBeUndefined();
            expect(selectCanAnnotate('bob')(annotationStore.getState())).toBe(false);
        });

        it('a muted camera stops being a surface I can hand out at all', async () => {
            const room = makeFakeRoom();
            const pub = await connectWithCamera(room);
            expect(annotationStore.getState().ownedSurfaces).toEqual([CAM]);

            pub.isMuted = true;
            await act(async () => { room.emitter.emit(RoomEvent.TrackMuted, pub, room.localParticipant); });
            // The publication is still in the map; it just isn't a surface.
            expect(annotationStore.getState().ownedSurfaces).toEqual([]);
            expect(selectCanGrantAnnotation('alice', 'bob')(annotationStore.getState())).toBe(false);

            // Camera back on: grantable again, but ungranted — a revoke is a
            // revoke, and re-offering is a deliberate act.
            pub.isMuted = false;
            await act(async () => { room.emitter.emit(RoomEvent.TrackUnmuted, pub, room.localParticipant); });
            expect(annotationStore.getState().ownedSurfaces).toEqual([CAM]);
            expect(annotationStore.getState().grants[CAM] ?? []).toEqual([]);
            expect(selectCanGrantAnnotation('alice', 'bob')(annotationStore.getState())).toBe(true);
        });

        it('someone ELSE turning their camera off drops our mirror of their grants', async () => {
            const room = makeFakeRoom();
            await connectWithCamera(room);
            const bobCam = trackKey('bob', Track.Source.Camera);
            // Bob's published list, as mirrored on our client: carol may draw.
            await act(async () => { annotationStore.setGrantList(bobCam, ['carol']); });
            expect(selectCanAnnotate('carol')(annotationStore.getState())).toBe(true);
            room.localParticipant.publishData.mockClear();

            await act(async () => {
                room.emitter.emit(RoomEvent.TrackMuted, { source: Track.Source.Camera, isMuted: true }, { identity: 'bob' });
            });

            expect(annotationStore.getState().grants[bobCam]).toBeUndefined();
            expect(selectCanAnnotate('carol')(annotationStore.getState())).toBe(false);
            // Not our track, so we say nothing about it on the wire — only the
            // owner's own list is ever believed.
            expect(published(room, 'room-1')).toEqual([]);
        });

        it('muting the MICROPHONE touches nothing', async () => {
            const room = makeFakeRoom();
            await connectWithCamera(room);
            await act(async () => { annotationStore.grant(CAM, 'bob'); });
            room.localParticipant.publishData.mockClear();

            await act(async () => {
                room.emitter.emit(
                    RoomEvent.TrackMuted,
                    { source: Track.Source.Microphone, isMuted: true },
                    room.localParticipant,
                );
            });

            expect(annotationStore.getState().grants[CAM]).toEqual(['bob']);
            expect(annotationStore.getState().ownedSurfaces).toEqual([CAM]);
            expect(published(room, 'room-1')).toEqual([]);
        });
    });
});

/**
 * Regression: "requesting to annotate no longer works, and granting someone
 * annotate from the right-click menu no longer works either" — both reported
 * against the first build in which server Calls channels carry an E2EE key.
 *
 * Neither of those touches the API. `grant.request` (the ask) and
 * `grant.grant` + `grant.list` (the offer) are annot-topic LiveKit DATA
 * packets, so anything that eats an inbound data packet takes out both at
 * once, silently, with a clean server log.
 *
 * What ate them, ROUND ONE (2026-09-08): the hook's fail-closed rule read
 * `!!room.options.encryption` — "was an encryption option passed" — as its
 * proxy for "this build encrypts its data packets", and the option went true
 * in every server call as soon as Calls channels got a key, while nothing
 * had yet called `Room.setE2EEEnabled(true)`. Narrowing it to
 * `isE2EEEnabled && options.encryption` made the check dormant again.
 *
 * What ate them, ROUND TWO (2026-09-13, the same two symptoms verbatim):
 * <E2EEActivator> landed, `isE2EEEnabled` finally went true for real, and the
 * narrowed check fired — on everything. The whole premise was wrong: the
 * receiver never gets a GCM stamp for a publishData payload at all. The check
 * is gone; see the block below and the `_encryptionType` note in the hook.
 *
 * These pin the two independent inputs (is the option present, is encryption
 * actually active) against the delivery that actually has to keep working.
 */
describe('useAnnotationTransport — an encrypting room must still deliver', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        annotationStore.reset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // An accepted grant.request plays the "someone is waiting on you"
        // cue, and jsdom has no HTMLMediaElement.play — which floods the
        // reporter with "Not implemented" stacks on precisely the cases that
        // PASS. Stub it so the signal stays readable; the cue itself has its
        // own coverage in notificationSounds.
        vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        container.remove();
        vi.restoreAllMocks();
    });

    /** Alice, sharing her screen, in a room configured however the case wants. */
    const connect = async (
        room: FakeRoom,
        opts: { encryption?: boolean; isE2EEEnabled?: boolean } = {},
    ) => {
        if (opts.encryption) room.options = { encryption: { keyProvider: {}, worker: {} } };
        room.isE2EEEnabled = !!opts.isE2EEEnabled;
        await act(async () => { root.render(React.createElement(Host, { room })); });
        room.name = 'room-1';
        room.localParticipant.identity = 'alice';
        room.localParticipant.trackPublications.set('sh', { source: Track.Source.ScreenShare, isMuted: false });
        await act(async () => {
            room.emitter.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.ScreenShare });
        });
    };

    const ALICE_SCREEN = trackKey('alice', Track.Source.ScreenShare);
    const BOB_SCREEN = trackKey('bob', Track.Source.ScreenShare);

    /** Deliver one annot-topic packet from `sender`, stamped as given. */
    const deliver = async (
        room: FakeRoom,
        msg: AnnotMsg,
        sender: string,
        encryptionType: Encryption_Type,
    ) => {
        await act(async () => {
            room.emitter.emit(
                RoomEvent.DataReceived,
                // Re-materialized under this file's Uint8Array for the same
                // realm reason the published() helper above documents: the
                // encoder hands back an instance decode()'s `instanceof`
                // guard would otherwise reject. A test-environment artifact —
                // in the real renderer the payload arrives off the wire.
                Uint8Array.from(encode(msg)),
                { identity: sender },
                undefined,
                ANNOT_TOPIC,
                encryptionType,
            );
        });
    };

    // Symptom 1: someone asks to draw on our screen share.
    const ask = (): AnnotMsg => ({ t: 'grant.request', room: 'room-1', track: ALICE_SCREEN });
    // Symptom 2: the streamer offers US access from their right-click menu.
    // `grant.grant` carries the offer; the `grant.list` right behind it is the
    // authoritative state every client (including the grantee's badge) reads.
    const offer = (): AnnotMsg => ({ t: 'grant.list', room: 'room-1', track: BOB_SCREEN, identities: ['alice'] });

    describe('no encryption configured at all (a pre-E2EE server call)', () => {
        it('accepts a plaintext ask', async () => {
            const room = makeFakeRoom();
            await connect(room);
            await deliver(room, ask(), 'bob', Encryption_Type.NONE);
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toEqual(['bob']);
        });
    });

    describe('encryption CONFIGURED but not active — the state every E2EE call is in today', () => {
        it('accepts a plaintext ask, because our own packets are plaintext too', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: false });
            await deliver(room, ask(), 'bob', Encryption_Type.NONE);
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toEqual(['bob']);
        });

        it('accepts a plaintext grant, so "Allow Annotating" reaches the grantee', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: false });
            await deliver(room, offer(), 'bob', Encryption_Type.NONE);
            expect(selectCanAnnotate('alice')(annotationStore.getState())).toBe(true);
        });

        // The "configured but inactive" warning is the acceptance signal for
        // E2EE activation (utils/e2eeActivation.ts): its ABSENCE on a keyed
        // call is what says activation took. That only works if it is judged
        // after the Room connects — at mount, before connect(), isE2EEEnabled
        // is false on every call, activated or not.
        const INACTIVE_WARNING = expect.stringContaining('Room.isE2EEEnabled is false');
        const inactiveWarnings = () =>
            (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
                .filter(([msg]) => typeof msg === 'string' && msg.includes('Room.isE2EEEnabled is false'));

        it('says out loud, once the room has CONNECTED, that encryption is configured but inactive', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: false });
            // Not yet: before connect the flag is false on every call.
            expect(console.warn).not.toHaveBeenCalledWith(INACTIVE_WARNING);

            await act(async () => { room.emitter.emit(RoomEvent.Connected); });
            expect(console.warn).toHaveBeenCalledWith(INACTIVE_WARNING);
        });

        it('stays silent when activation landed before the room connected — the pass signal', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: false });
            // The worker acks for our identity (SignalConnected → enable →
            // ack) before the peer connection completes, exactly as the SDK
            // sequences it.
            room.isE2EEEnabled = true;
            await act(async () => { room.emitter.emit(RoomEvent.Connected); });
            expect(console.warn).not.toHaveBeenCalledWith(INACTIVE_WARNING);
        });

        it('warns once per Room, however many times Connected is seen', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: false });
            await act(async () => { room.emitter.emit(RoomEvent.Connected); });
            await act(async () => { room.emitter.emit(RoomEvent.Connected); });
            expect(inactiveWarnings()).toHaveLength(1);
        });

        it('evaluates immediately when mounted onto a Room that is ALREADY connected (a mid-call remount)', async () => {
            const room = makeFakeRoom();
            room.state = 'connected';
            await connect(room, { encryption: true, isE2EEEnabled: false });
            expect(console.warn).toHaveBeenCalledWith(INACTIVE_WARNING);
        });

        it('never warns when no encryption was configured, connected or not', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: false, isE2EEEnabled: false });
            await act(async () => { room.emitter.emit(RoomEvent.Connected); });
            expect(console.warn).not.toHaveBeenCalledWith(INACTIVE_WARNING);
        });
    });

    /**
     * REGRESSION (2026-09-13): "the ability to request annotation stopped
     * working, as well as right clicking someone's name and giving them
     * ability without them requesting. none of it works."
     *
     * These four cases used to assert the OPPOSITE — a plaintext-stamped
     * packet dropped, a GCM-stamped one accepted — and they passed, because
     * the harness stamps `encryptionType` by hand. The renderer does not:
     * livekit-client 2.18.8's `sendDataPacket` builds its EncryptedPacket
     * WITHOUT `encryptionType`, so the proto3 enum serializes as its zero
     * value and the receiver is handed `Encryption_Type.NONE` for a packet
     * that was genuinely encrypted and decrypted — identical to what the
     * plaintext branch emits. Verified against the installed SDK:
     *
     *     new DataPacket({ value: { case: 'encryptedPacket',
     *       value: new EncryptedPacket({ encryptedValue, iv, keyIndex }) } })
     *     → toBinary() → fromBinary() → value.encryptionType === 0 (NONE)
     *
     * So `encryptionType !== GCM` was true for EVERY packet a real peer could
     * send, and the "fail closed" branch was a kill switch on the whole
     * feature the moment <E2EEActivator> made `isE2EEEnabled` true for real.
     * The GCM cases below are kept because a future SDK may start stamping
     * it; the NONE cases are the ones that describe production.
     *
     * See the `_encryptionType` block in useAnnotationTransport.ts for why the
     * check cannot be re-armed against this SDK version, and what to do if a
     * later one fixes it.
     */
    describe('encryption ACTIVE — packets must still get through', () => {
        it('accepts an ask stamped NONE, which is what an ENCRYPTED packet arrives as', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: true });
            await deliver(room, ask(), 'bob', Encryption_Type.NONE);
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toEqual(['bob']);
        });

        it('accepts a grant stamped NONE, so "Allow Annotating" reaches the grantee', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: true });
            await deliver(room, offer(), 'bob', Encryption_Type.NONE);
            expect(selectCanAnnotate('alice')(annotationStore.getState())).toBe(true);
        });

        it('accepts a GCM-stamped ask', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: true });
            await deliver(room, ask(), 'bob', Encryption_Type.GCM);
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toEqual(['bob']);
        });

        it('accepts a GCM-stamped grant', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: true });
            await deliver(room, offer(), 'bob', Encryption_Type.GCM);
            expect(selectCanAnnotate('alice')(annotationStore.getState())).toBe(true);
        });

        it('keeps delivering after encryption comes up mid-call', async () => {
            const room = makeFakeRoom();
            // Mount in the state the SDK is genuinely in right after
            // <LiveKitRoom> renders: options carry `encryption:`, but the
            // worker has not yet acknowledged it for our identity.
            await connect(room, { encryption: true, isE2EEEnabled: false });
            await deliver(room, ask(), 'bob', Encryption_Type.NONE);
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toEqual(['bob']);

            // Activation lands. Nothing re-renders Host and `room` is the same
            // reference. This is the exact transition that broke the feature:
            // the packets look no different afterwards, and must not start
            // being dropped.
            annotationStore.reset();
            room.isE2EEEnabled = true;
            await deliver(room, ask(), 'bob', Encryption_Type.NONE);
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toEqual(['bob']);
        });

        it('still refuses a packet with no participant — an unattributable sender', async () => {
            const room = makeFakeRoom();
            await connect(room, { encryption: true, isE2EEEnabled: true });
            await act(async () => {
                room.emitter.emit(
                    RoomEvent.DataReceived,
                    Uint8Array.from(encode(ask())),
                    undefined,
                    undefined,
                    ANNOT_TOPIC,
                    Encryption_Type.NONE,
                );
            });
            expect(annotationStore.getState().requests[ALICE_SCREEN]).toBeUndefined();
        });
    });
});
