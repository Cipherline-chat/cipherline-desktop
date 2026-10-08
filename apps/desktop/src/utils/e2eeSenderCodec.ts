/**
 * Tell LiveKit's E2EE worker which codec each of OUR video senders encodes.
 *
 * ── The bug this closes (camera 0.2 fps / black, staging 1.0.18-staging.141)
 *
 * The frame cryptor must know a frame's codec to know how many leading bytes
 * to leave in the clear (VP8: a 3/10-byte header; H.264/H.265: everything up
 * to the first slice's NAL header) — the receiver computes the same split
 * and uses the clear bytes as AES-GCM additional data, so any disagreement
 * fails authentication or, worse, encrypts bytes the RECEIVER's depacketizer
 * must read in the clear.
 *
 * livekit-client 2.18.8 gets that codec from a payload-type → codec map
 * (RTCEngine: the FIRST video m-section of the latest publisher ANSWER) and
 * otherwise from `videoCodec`, which it sets for receivers (trackInfo) but
 * NEVER for senders (E2EEManager.setupE2EESender passes `undefined`; only
 * Safari gets an `updateCodec` message). Once a remote participant publishes,
 * that first video m-section is a receive section whose codec list is what
 * LiveKit offers subscribers — and H.264 High's payload type is not in it.
 * From then on a High frame's codec is `undefined` and the cryptor GUESSES it
 * from the NAL headers (naluUtils.detectCodecFromNALUs), testing each NAL as
 * H.264 and then as H.265. An H.264 SPS/PPS with nal_ref_idc 1 (0x27/0x28 —
 * VideoToolbox), an SEI (0x06) or an access-unit delimiter (0x09) reads as an
 * H.265 SLICE header, so the clear prefix ends inside the SPS/SEI/AUD instead
 * of after the first slice header:
 *   - the frames that carry those NALs are mangled for the receiver (an
 *     encrypted SPS is dropped by its depacketizer; a mismatched prefix fails
 *     GCM and the frame is silently dropped);
 *   - everything that references them is undecodable;
 *   - the receiver asks for keyframes (~5/s), and only the frames that happen
 *     to have a clean layout get through: a sharp picture at a fraction of a
 *     frame per second, and a focus switch that waits for the next lucky
 *     keyframe.
 * The camera only started using H.264 High this round (claude/webcam-quality:
 * hardware High on NVIDIA-only PCs — the owner's RTX 2080 Ti — and wherever
 * Constrained Baseline is not hardware). Measured on the Mac mini with real
 * VideoToolbox encoders (Electron 43, livekit-client 2.18.8, LiveKit 1.9.12,
 * E2EE on): High camera + a peer who also publishes → 0 frames decoded, a
 * keyframe request every ~200 ms; same with E2EE off, or with the peer not
 * publishing → full frame rate.
 *
 * ── The fix
 *
 * After every local video publication (first publish, LiveKit's reconnect
 * republish, our make-before-break camera/share republishes) post LiveKit's
 * own `updateCodec` message — the one it sends for Safari — with the codec
 * the SFU accepted for that track. The worker then has `videoCodec` for the
 * sender and never has to guess (FrameCryptor.getUnencryptedBytes:
 * `getVideoCodec(frame) ?? this.videoCodec`). Nothing about the encryption
 * itself changes: same key, same cipher, same frames encrypted; only the
 * split point is now always the right one. Pinned against the installed
 * livekit-client source by e2eeSenderCodec.test.ts.
 */

/** The codecs LiveKit's worker understands (livekit-client VideoCodec). */
export type E2EEVideoCodec = 'vp8' | 'h264' | 'vp9' | 'av1' | 'h265';
const KNOWN: ReadonlySet<string> = new Set(['vp8', 'h264', 'vp9', 'av1', 'h265']);

/** 'video/H264' → 'h264' (livekit-client mimeTypeToVideoCodecString), or null. */
export function codecFromMime(mime: string | undefined | null): E2EEVideoCodec | null {
    if (typeof mime !== 'string') return null;
    const slash = mime.indexOf('/');
    const c = (slash >= 0 ? mime.slice(slash + 1) : mime).trim().toLowerCase();
    return KNOWN.has(c) ? c as E2EEVideoCodec : null;
}

// ── Narrow shapes (structural, testable with fakes) ────────────────────────

export interface CodecPinTrack {
    kind?: string;
    /** What the E2EE manager keys the sender's cryptor by (setupE2EESender). */
    mediaStreamID?: string;
    /** LocalVideoTrack.codec — set by LiveKit at publish (after any server fallback). */
    codec?: string;
}

export interface CodecPinPublication {
    kind?: string;
    track?: CodecPinTrack;
    trackInfo?: { mimeType?: string; codecs?: readonly { mimeType?: string }[] };
}

export interface CodecPinWorker {
    postMessage(msg: unknown): void;
}

/** The `updateCodec` message LiveKit's worker handles (e2ee/types.ts UpdateCodecMessage). */
export interface UpdateCodecMessage {
    kind: 'updateCodec';
    data: { trackId: string; codec: E2EEVideoCodec; participantIdentity: string };
}

/**
 * The codec a published local VIDEO track is actually encoded with, or null
 * (audio, not yet known, unknown codec). The server's answer (trackInfo)
 * wins over the client's request (track.codec): it is what got negotiated.
 */
export function publishedVideoCodec(pub: CodecPinPublication): E2EEVideoCodec | null {
    const kind = pub.kind ?? pub.track?.kind;
    if (kind !== 'video') return null;
    return codecFromMime(pub.trackInfo?.codecs?.[0]?.mimeType)
        ?? codecFromMime(pub.trackInfo?.mimeType)
        ?? codecFromMime(pub.track?.codec);
}

/** The message to post for one publication, or null when there is nothing to pin. */
export function codecPinMessage(pub: CodecPinPublication, participantIdentity: string): UpdateCodecMessage | null {
    const trackId = pub.track?.mediaStreamID;
    const codec = publishedVideoCodec(pub);
    if (!trackId || !codec || !participantIdentity) return null;
    return { kind: 'updateCodec', data: { trackId, codec, participantIdentity } };
}

export interface CodecPinRoom {
    localParticipant: {
        identity: string;
        trackPublications: Map<string, CodecPinPublication> | { values(): Iterable<CodecPinPublication> };
    };
    on(event: 'localTrackPublished', cb: (pub: CodecPinPublication) => void): unknown;
    off(event: 'localTrackPublished', cb: (pub: CodecPinPublication) => void): unknown;
}

/**
 * Pin the codec of every local video publication, now and on each new one.
 * `worker` null/undefined (E2EE not configured) → no-op. Never throws: a
 * failed post leaves LiveKit's own behaviour, which is what we had before.
 * Returns the uninstall.
 */
export function installE2EESenderCodecPin(
    room: CodecPinRoom,
    worker: CodecPinWorker | null | undefined,
    log: (m: string) => void = () => {},
): () => void {
    if (!worker) return () => {};
    const pinned = new Map<string, E2EEVideoCodec>();
    const pin = (pub: CodecPinPublication) => {
        try {
            const msg = codecPinMessage(pub, room.localParticipant.identity);
            if (!msg) return;
            // Re-post when the codec changed (a republish keeps the trackId only
            // if it reuses the MediaStream); otherwise once is enough.
            if (pinned.get(msg.data.trackId) === msg.data.codec) return;
            worker.postMessage(msg);
            pinned.set(msg.data.trackId, msg.data.codec);
            log(`[E2EE] sender codec pinned: ${msg.data.codec}`);
        } catch { /* a missing pin is LiveKit's default behaviour, never fatal */ }
    };
    for (const pub of room.localParticipant.trackPublications.values()) pin(pub);
    const onPublished = (pub: CodecPinPublication) => pin(pub);
    room.on('localTrackPublished', onPublished);
    return () => { room.off('localTrackPublished', onPublished); };
}

/** The E2EE worker a Room was built with (Room.options.encryption / legacy e2ee), if any. */
export function e2eeWorkerOf(room: { options?: { encryption?: { worker?: unknown }; e2ee?: { worker?: unknown } } }): CodecPinWorker | null {
    const w = room.options?.encryption?.worker ?? room.options?.e2ee?.worker;
    return w && typeof (w as CodecPinWorker).postMessage === 'function' ? w as CodecPinWorker : null;
}
