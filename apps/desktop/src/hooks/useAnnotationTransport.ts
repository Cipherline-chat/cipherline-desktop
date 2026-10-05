/**
 * useAnnotationTransport - binds annotationTransport's pure logic to a
 * LiveKit Room. This is the ONLY file in the feature that touches sockets.
 *
 * Outbound: subscribes to annotationStore and publishes the local user's
 * changes as `annot`-topic data messages. Inbound: listens to DataReceived,
 * decodes + validates through the codec, and applies under the transport's
 * authorization rule with the SFU-attested sender identity. Late joiners
 * ask each streamer for a snapshot of every video track they subscribe to;
 * a streamer answers only for its own tracks, only to the asker.
 *
 * Confidentiality is the SDK's data-channel E2EE (docs/video-annotation-
 * design.md, Transport): when the Room carries `encryption:` and E2EE has
 * actually been activated, livekit-client encrypts every publishData()
 * payload before it leaves the process and decrypts it on arrival. That part
 * works and is not ours to re-implement.
 *
 * What this hook NO LONGER does is second-guess it per packet. See the
 * `encryptionType` note on onData() below: on livekit-client 2.18.8 the
 * receiver cannot tell an encrypted packet from a plaintext one, so the
 * "refuse plaintext" rule that used to live here could only ever refuse
 * EVERYTHING. Authorization is unaffected — it has always been the
 * SFU-attested sender identity plus the owner's grant list, in
 * annotationTransport, and that is what keeps a peer from forging a grant.
 */
import { useEffect, useRef } from 'react';
import {
    RoomEvent, Track, ConnectionState,
    type Room, type RemoteParticipant, type RemoteTrackPublication, type RemoteTrack,
    type LocalTrackPublication, type LocalParticipant, type DataPacket_Kind,
    type TrackPublication, type Participant,
} from 'livekit-client';
import { annotationStore, trackKey } from '../utils/annotationStore';
import { encode, decode, chunkSnapshot, ANNOT_TOPIC, type AnnotMsg } from '../utils/annotationCodec';
import { PerSenderRateLimiter } from '../utils/annotationRate';
import {
    diffLocalForWire, applyRemote, applySnapshot, SnapshotAssembler, snapshotOf, grantsOf, ownerOf,
    type SentState, type ApplyResult,
} from '../utils/annotationTransport';
import { useNotificationPrefsSafe, DEFAULT_PREFS } from '../contexts/NotificationContext';
import { playSound } from '../utils/notificationSounds';

const VIDEO_SOURCES: ReadonlySet<string> = new Set([Track.Source.Camera, Track.Source.ScreenShare]);

export function useAnnotationTransport(room: Room | null | undefined): void {
    // Read through a ref: the effect below runs once per Room, so capturing
    // prefs by value would freeze whatever they were when the call started.
    // The `Safe` variant because this hook's only use of prefs is one optional
    // cue — a missing provider must cost the sound, not the call.
    const notif = useNotificationPrefsSafe();
    const notifRef = useRef(notif);
    // Written in an effect, not during render: the ref is only ever READ from
    // an async socket callback, so being one commit behind is harmless, and
    // touching a ref mid-render is the thing react-hooks/refs exists to stop.
    useEffect(() => { notifRef.current = notif; }, [notif]);

    useEffect(() => {
        if (!room) return;
        // NOT captured once here: `room.localParticipant.identity` and
        // `room.name` are both populated from the server's join response,
        // which arrives asynchronously after connect() — useRoomContext()
        // hands child components the Room object as soon as <LiveKitRoom>
        // mounts, well before that response lands. A `const me = ...`/`const
        // roomId = ...` snapshotted here at effect-setup time could freeze in
        // an empty string for the ENTIRE call (the effect only re-runs on
        // `[room]`, and connecting doesn't change that reference) — every
        // outgoing message stamped with the wrong room, every inbound
        // "is this mine" check comparing against '', which is how a real
        // report of "requests and drawing don't reach anyone" traced back to
        // here. Read both fresh at each point of use instead; they self-heal
        // the moment the SDK fills them in.
        const me = () => room.localParticipant.identity;
        const roomId = () => room.name;
        // Say so, once per Room, when encryption is CONFIGURED but never
        // became ACTIVE. That gap is invisible from the outside — media and
        // data both silently travel in the clear while every surface reports
        // an E2EE call. Cheap, once, and it fails no call.
        //
        // Evaluated when the Room CONNECTS, never at effect-setup time. This
        // hook mounts with <LiveKitRoom>'s children, before connect(), when
        // `isE2EEEnabled` is necessarily still false: the worker can only be
        // told to enable once the join response has filled in the local
        // identity (SignalConnected), and `Connected` follows that only after
        // the peer connection is up, by which point the worker's in-process
        // ack has long since flipped the flag on every healthy path. A check
        // at mount therefore printed once per room on EVERY call, activated
        // or not, and could not tell the two apart — useless as the signal
        // that activation (utils/e2eeActivation.ts) actually took. Checked
        // at Connected it fires only when activation genuinely did not
        // happen; that same state also trips the activator's own ack
        // watchdog, which is what ENDS the call — this is the observation,
        // not the enforcement. `Connected` fires once per Room (a reconnect
        // emits Reconnected) and the listener removes itself, so the warning
        // is one-time either way. If the Room is already connected when this
        // effect runs (a remount mid-call) the event will not come again, so
        // evaluate immediately instead — same check, same once.
        const encryptionConfigured = () => !!(room.options as { encryption?: unknown }).encryption;
        const warnIfConfiguredButInactive = () => {
            room.off(RoomEvent.Connected, warnIfConfiguredButInactive);
            if (!room.isE2EEEnabled && encryptionConfigured()) {
                console.warn('[annotation] room connected with `encryption:` configured but Room.isE2EEEnabled is false — data packets (and media frames) are NOT encrypted; E2EE activation did not take effect on this Room');
            }
        };
        if (room.state === ConnectionState.Connected) warnIfConfiguredButInactive();
        else room.on(RoomEvent.Connected, warnIfConfiguredButInactive);

        const sent: SentState = new Map();
        const assembler = new SnapshotAssembler();
        let prev = annotationStore.getState();
        let snapshotSeq = 0;
        let disposed = false;
        let suppressDiff = false;

        const publish = async (msgs: AnnotMsg[], to?: string[]) => {
            for (const m of msgs) {
                if (disposed) return;
                try {
                    await room.localParticipant.publishData(encode(m), {
                        reliable: true,
                        topic: ANNOT_TOPIC,
                        ...(to ? { destinationIdentities: to } : {}),
                    });
                } catch (err) {
                    console.warn('[annot] publish failed:', err);
                }
            }
        };

        // -- outbound ---------------------------------------------------------
        const unsubscribe = annotationStore.subscribe(() => {
            const next = annotationStore.getState();
            if (suppressDiff) { prev = next; return; }
            const msgs = diffLocalForWire(prev, next, me(), roomId(), sent);
            prev = next;
            if (msgs.length) void publish(msgs);
        });

        /** Mutate the store without narrating it to the room - used when a
         *  track is gone and every peer has already dropped it themselves. */
        const silently = (fn: () => void) => {
            suppressDiff = true;
            try { fn(); } finally { suppressDiff = false; prev = annotationStore.getState(); }
        };

        const requestSnapshot = (identity: string, source: string) =>
            void publish([{ t: 'snapshot.request', room: roomId(), track: trackKey(identity, source) }], [identity]);

        /**
         * Mirror the Room's own publications into the store, so the right-click
         * menus know what we are sharing and can offer "Allow Annotating"
         * without every menu site learning about LiveKit. Recomputed wholesale
         * rather than nudged per event: `identity` is empty until the join
         * response lands (see the note above), so a key built too early would
         * be wrong forever - re-deriving it costs a couple of map reads.
         */
        const syncOwnedSurfaces = () => {
            const id = me();
            const keys: string[] = [];
            if (id) {
                for (const pub of room.localParticipant.trackPublications.values()) {
                    // `!pub.isMuted` is load-bearing, not defensive. Turning a
                    // CAMERA off does not unpublish it — livekit-client mutes
                    // the track and leaves the publication in place (only
                    // screen share is unpublished, because "screenshare cannot
                    // be muted"). Without this check a camera that is off still
                    // counted as a surface we publish, so the right-click menu
                    // went on offering "Allow Annotating on your video" for a
                    // camera nobody could see.
                    if (VIDEO_SOURCES.has(pub.source) && !pub.isMuted) keys.push(trackKey(id, pub.source));
                }
            }
            annotationStore.setOwnedSurfaces(keys);
        };

        /** The cue for "someone is waiting on you". Prefs (master switch, this
         *  category's own toggle, volume, output device) are all playSound's
         *  job - never a raw Audio element. */
        const playRequestCue = () => {
            // The WHOLE prefs object, not a hand-picked subset: playSound also
            // consults `sound_groups`, and rebuilding a partial literal here
            // would silently drop any gate added to it later. (Moot while
            // annotation_request is a 'primary' category — those have no
            // collapsed group prefs — but the next category to move groups
            // shouldn't have to remember this call site.)
            playSound('annotation_request', notifRef.current?.prefs ?? DEFAULT_PREFS);
        };

        // -- inbound ----------------------------------------------------------
        // Per-sender budget (design doc: ~60/s sustained). Over budget is
        // dropped before decode, so a flood costs us a map lookup, not parsing.
        const limiter = new PerSenderRateLimiter();
        /**
         * RoomEvent.DataReceived's 5th argument, `encryptionType`, is
         * DELIBERATELY NOT DESTRUCTURED below, and must stay that way until
         * livekit-client is upgraded past the bug described here. Do not
         * reintroduce a "refuse anything not stamped GCM" check.
         *
         * The intent was sound and symmetric: if this build encrypts its own
         * data packets, refuse a peer's plaintext ones. It is unimplementable
         * on livekit-client 2.18.8, because the SDK does not tell the receiver
         * which it got. `RTCEngine.sendDataPacket` encrypts the payload and
         * then wraps it as
         *
         *     new EncryptedPacket({ encryptedValue, iv, keyIndex })
         *
         * (dist/livekit-client.esm.mjs:21495-21507) — note the absence of
         * `encryptionType`, a proto3 enum field that therefore serializes as
         * its zero value, `Encryption_Type.NONE`. The receive path then
         * decrypts and re-emits with that same unset field verbatim
         * (`this.emit(EngineEvent.DataPacketReceived, newDp,
         * dp.value.value.encryptionType)`, :20451), and the plaintext branch
         * emits a hardcoded `Encryption_Type.NONE` (:20457). Both branches
         * arrive at RoomEvent.DataReceived as NONE: a correctly encrypted
         * packet and a plaintext one are INDISTINGUISHABLE here. (Data
         * STREAMS do stamp it — streamText/streamBytes set `encryptionType`
         * on the header, :22644/:22773 — which is why the field looks
         * trustworthy at a glance. publishData, which is what we use, does
         * not.)
         *
         * So `weEncryptDataPackets() && encryptionType !== GCM` reduced to
         * `weEncryptDataPackets()` — a kill switch, not a check. It stayed
         * dormant only because nothing in this app had ever called
         * `Room.setE2EEEnabled(true)`; the moment <E2EEActivator> started
         * activating encryption for real, every annot-topic packet in every
         * keyed call was dropped by its receiver. That is the whole of
         * "requesting annotation stopped working, as well as right-clicking
         * someone's name and giving them the ability" — grant.request and
         * grant.grant/grant.list ride this one channel, so one dropped packet
         * type takes out both directions at once, silently, with a clean
         * server log.
         *
         * Nothing security-relevant rests on its removal. Confidentiality is
         * still the SDK's, and it is genuinely on: the packets ARE encrypted
         * on the wire. Authorization was never this check's job — a stroke is
         * accepted only from the track's owner or someone on the owner's
         * published grant list, and grant messages only from the owner, all
         * keyed to the SFU-attested `participant.identity` (annotationTransport
         * applyRemote/isAllowed). A peer who lacks the room key can therefore
         * still only forge grants on their OWN tracks, which is no
         * authority at all.
         *
         * `RemoteParticipant.isEncrypted` was considered as a working
         * substitute and rejected: it is
         * `trackPublications.size > 0 && every(pub => pub.isEncrypted)`
         * (:26039), so a peer whose publications have not reached us yet reads
         * as "not encrypting" — it would reintroduce exactly this outage as an
         * intermittent one.
         *
         * If a future livekit-client populates `encryption_type` on
         * EncryptedPacket, this can be re-armed as originally written; the
         * decision-table tests in useAnnotationTransport.test.ts are the place
         * to flip.
         */
        const onData = (
            payload: Uint8Array,
            participant?: RemoteParticipant,
            _kind?: DataPacket_Kind,
            topic?: string,
            // 5th arg — `encryptionType?: Encryption_Type` — intentionally
            // not taken. See the block above before adding it back.
        ) => {
            if (topic !== ANNOT_TOPIC) return;
            // No participant = server-originated. Nobody granted the server.
            if (!participant) return;
            if (!limiter.allow(participant.identity)) return; // over budget: drop, never queue
            const msg = decode(payload, roomId());
            if (!msg) return;
            const sender = participant.identity;
            switch (msg.t) {
                case 'snapshot.request':
                    if (ownerOf(msg.track) !== me()) return;
                    void publish(chunkSnapshot(roomId(), msg.track, ++snapshotSeq, snapshotOf(msg.track), grantsOf(msg.track)), [sender]);
                    return;
                case 'snapshot': {
                    const complete = assembler.push(msg, sender);
                    if (complete) silently(() => { applySnapshot(msg.track, sender, complete.strokes, complete.identities); });
                    return;
                }
                default: {
                    // Stroke AND grant messages. Grant changes we mirror must
                    // not be re-published as ours: they are not for tracks
                    // we own, and diffLocalForWire only publishes those.
                    let res: ApplyResult | undefined;
                    silently(() => { res = applyRemote(msg, sender, me()); });
                    // A NEW person asking to draw on something of ours is the
                    // one annotation event that happens while the owner is
                    // looking somewhere else entirely, so it gets a sound.
                    if (res?.queuedRequest) playRequestCue();
                }
            }
        };

        // -- lifecycle: tracks appearing and disappearing ----------------------
        const onTrackSubscribed = (_track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
            if (VIDEO_SOURCES.has(pub.source)) requestSnapshot(p.identity, pub.source);
        };
        const onTrackUnpublished = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
            if (VIDEO_SOURCES.has(pub.source)) silently(() => annotationStore.dropTrack(trackKey(p.identity, pub.source)));
        };
        /**
         * OUR share or camera ended. Deliberately NOT `silently`.
         *
         * This is the whole of the "they still have the pencil after I stopped
         * sharing" bug: dropTrack does clear the grants, but suppressing the
         * diff meant the clearing was never narrated, and a grant list is only
         * ever believed from the track's OWNER. So every peer kept the list we
         * had last published - the grantee's client still thought it could
         * draw, every other client still rendered the pencil badge beside
         * their name (selectCanAnnotate looks across all grant lists, so one
         * stale entry anywhere lights it), and a re-share of the same
         * `identity|source` key walked straight back into those stale grants
         * without anyone asking again.
         *
         * Letting the diff run turns the same mutation into the `grant.revoke`
         * + empty `grant.list` that every peer already knows how to apply, so
         * the badge clears everywhere and a re-share starts from nothing.
         */
        const dropOwnSurface = (key: string) => {
            for (const k of [...sent.keys()]) if (k.startsWith(key + ' ')) sent.delete(k);
            annotationStore.dropTrack(key);
            syncOwnedSurfaces();
        };
        const onLocalTrackUnpublished = (pub: LocalTrackPublication, p: LocalParticipant) => {
            if (!VIDEO_SOURCES.has(pub.source)) return;
            dropOwnSurface(trackKey(p.identity, pub.source));
        };
        const onLocalTrackPublished = (pub: LocalTrackPublication) => {
            if (VIDEO_SOURCES.has(pub.source)) syncOwnedSurfaces();
        };
        /**
         * A CAMERA being turned off, which is a MUTE and not an unpublish.
         *
         * livekit-client's `setTrackEnabled(source, false)` unpublishes only
         * the screen share ("screenshare cannot be muted, unpublish instead");
         * for every other source it calls `track.mute()`, which leaves the
         * publication in `trackPublications` and fires TrackMuted, never
         * TrackUnpublished. That asymmetry is the whole of "the pencil goes
         * away when someone stops sharing their screen but not when they turn
         * their camera off": the teardown above was only ever reachable by the
         * screen-share half.
         *
         * Same treatment as an unpublish, and deliberately NOT `silently` for
         * our own track: letting the diff run turns dropTrack's mutation into
         * the `grant.revoke` + empty `grant.list` that clears the badge on
         * every client, since a grant list is only ever believed from the
         * track's owner.
         *
         * NO GRACE PERIOD, deliberately. A grant is a permission over a video
         * surface, and a permission whose surface is gone should fail closed
         * immediately — the same way the screen-share path already behaves, and
         * parity with screen share is exactly what was asked for. The case a
         * grace would protect (a blink during a camera device switch) does not
         * arise here: a device switch leaves the publication un-muted and
         * merely trackless, which is precisely the distinction pickNextFocus's
         * `isStreamLive` had to draw for the focused view. Buying that
         * non-case a window would cost a second timer and a stretch of time
         * where the pencil badge claims access to a camera that is off.
         */
        const onTrackMuted = (pub: TrackPublication, p: Participant) => {
            if (!VIDEO_SOURCES.has(pub.source)) return;
            const key = trackKey(p.identity, pub.source);
            if (p.identity === me()) dropOwnSurface(key);
            // Someone else's camera went off: drop our mirror of their track.
            // Their client narrates the revoke too, but a receiver that also
            // drops it locally clears the strokes and the badge even if the
            // owner is on an older build.
            else silently(() => annotationStore.dropTrack(key));
        };
        /** Their camera came back. Only OUR surfaces need re-registering; the
         *  grants stayed revoked, which is the point of revoking them. */
        const onTrackUnmuted = (pub: TrackPublication, p: Participant) => {
            if (VIDEO_SOURCES.has(pub.source) && p.identity === me()) syncOwnedSurfaces();
        };
        const onParticipantDisconnected = (p: RemoteParticipant) => {
            limiter.forget(p.identity);
            silently(() => {
                annotationStore.dropTrack(trackKey(p.identity, Track.Source.Camera));
                annotationStore.dropTrack(trackKey(p.identity, Track.Source.ScreenShare));
            });
            // Their grants on OUR surfaces are ours to withdraw, and they are
            // stale the moment they leave: narrate it (not `silently`) so
            // everyone drops the badge, and so a rejoin under the same identity
            // has to ask again rather than inheriting yesterday's yes.
            annotationStore.revokeAllFrom(me(), p.identity);
        };

        room.on(RoomEvent.DataReceived, onData);
        // Requests lapse after REQUEST_TTL_MS on both sides; a slow tick is
        // plenty. The same tick is the safety net for stroke expiry and for
        // the owned-surface mirror: the in-app overlay's rAF prunes points
        // while a tile is mounted, but strokes must still age out when nobody
        // is rendering that track, and `identity` may only have arrived after
        // the local tracks were published.
        const expiryTick = setInterval(() => {
            silently(() => annotationStore.expireRequests());
            annotationStore.expireLasers();
            syncOwnedSurfaces();
        }, 1000);
        room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
        room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
        room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
        room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
        room.on(RoomEvent.TrackMuted, onTrackMuted);
        room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);
        room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
        syncOwnedSurfaces();

        // We may have joined late: ask for the state of every video track we
        // are already subscribed to.
        for (const p of room.remoteParticipants.values()) {
            for (const pub of p.trackPublications.values()) {
                if (pub.isSubscribed && VIDEO_SOURCES.has(pub.source)) requestSnapshot(p.identity, pub.source);
            }
        }

        return () => {
            disposed = true;
            unsubscribe();
            clearInterval(expiryTick);
            room.off(RoomEvent.DataReceived, onData);
            room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
            room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
            room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
            room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
            room.off(RoomEvent.TrackMuted, onTrackMuted);
            room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
            room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
            room.off(RoomEvent.Connected, warnIfConfiguredButInactive);
        };
    }, [room]);
}
