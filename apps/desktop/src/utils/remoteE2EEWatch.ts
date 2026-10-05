/**
 * Per-remote-participant encryption observation.
 *
 * `e2eeActivation.ts` polices THIS device: it refuses to let the local
 * participant publish anything that isn't GCM, and ends the call if it ever
 * does. That check is deliberately fatal, and it is deliberately local-only.
 *
 * It is also only half the story, and the missing half was invisible.
 * livekit-client enables decryption PER REMOTE PARTICIPANT, from whatever
 * encryption the SFU reports for that peer's track:
 *
 *     // livekit-client.esm.mjs
 *     room.on(RoomEvent.TrackPublished, (pub, participant) =>
 *       this.setParticipantCryptorEnabled(
 *         pub.trackInfo.encryption !== Encryption_Type.NONE, participant.identity));
 *
 * and when a participant's cryptor is disabled the E2EE worker passes their
 * frames straight through:
 *
 *     // livekit-client.e2ee.worker.mjs — decodeFunction
 *     if (!this.isEnabled() || encodedFrame.data.byteLength === 0)
 *       return controller.enqueue(encodedFrame);
 *
 * So a participant on a build that predates call E2EE (shipped in 1.0.13)
 * sends audio and video the media server can read, while everyone else in the
 * same call stays encrypted. The call does not fail; it silently becomes
 * partly plaintext. Before this module, nothing anywhere observed that — the
 * in-call padlock is derived from local key state alone, so it stayed green.
 *
 * This is an OBSERVER, never a gate. It reports; it never disconnects, never
 * blocks a publication and never reaches into the Room. That split is the
 * whole design:
 *
 *   - Local plaintext is a REGRESSION. We control our own publications, so a
 *     non-GCM local track means our own activation failed, and the honest
 *     response is to stop talking. `e2eeActivation` fails the call.
 *   - Remote plaintext is an INTEROP FACT. The peer is running software we
 *     do not control and cannot upgrade. Refusing the call would make talking
 *     to anyone on an older build impossible, which is a worse outcome than
 *     telling both people the truth — especially while our builds are
 *     unsigned and macOS auto-update cannot complete, so "they'll have
 *     updated by now" is not a safe assumption.
 *
 * Hence: warn, name who, and let the humans decide.
 *
 * NOT-PUBLISHING IS NOT UNENCRYPTED. A participant who is muted with their
 * camera off publishes nothing, and nothing is exactly what we can honestly
 * say about their build. They count as unknown, not unsafe; the moment they
 * unmute, `TrackPublished` fires and they are classified for real. Treating
 * silence as a red flag would light the warning up in every ordinary call.
 */
import { Encryption_Type, RoomEvent } from 'livekit-client';

/** The slice of a remote publication this module reads. Structural so tests drive a fake. */
export interface WatchablePublication {
    trackSid: string;
    source: string;
    trackInfo?: { encryption?: number };
}

export interface WatchableParticipant {
    identity: string;
    trackPublications: Map<string, WatchablePublication>;
}

/** The slice of livekit-client's Room this module needs. */
export interface WatchableRoom {
    remoteParticipants: Map<string, WatchableParticipant>;
    on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
    off(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface RemoteEncryptionSnapshot {
    /**
     * Identities of remote participants with at least one track the SFU does
     * NOT report as GCM. Sorted, so equal states compare equal as strings and
     * a re-render is driven by a real change rather than by Map iteration
     * order.
     */
    unencryptedIdentities: string[];
    /** Convenience: `unencryptedIdentities.length > 0`. */
    anyUnencrypted: boolean;
}

export const EMPTY_REMOTE_ENCRYPTION: RemoteEncryptionSnapshot = {
    unencryptedIdentities: [],
    anyUnencrypted: false,
};

/**
 * Mirrors `e2eeActivation`'s local test exactly — GCM or it doesn't count.
 *
 * Note this is STRICTER than the SDK's own `!== NONE`. The SDK enables a
 * cryptor for anything non-NONE (including CUSTOM, which we never negotiate);
 * we only call a track encrypted if it is the cipher we actually use. Being
 * stricter can only over-report a participant as unencrypted, never under-
 * report one, which is the safe direction for a warning.
 */
const isGcm = (pub: WatchablePublication) => pub.trackInfo?.encryption === Encryption_Type.GCM;

/** True when this participant publishes at least one track and any of them isn't GCM. */
const isParticipantUnencrypted = (p: WatchableParticipant): boolean => {
    for (const pub of p.trackPublications.values()) {
        if (!isGcm(pub)) return true;
    }
    return false;
};

/** Pure: derive the snapshot from a Room's current remote roster. Exported for tests. */
export function snapshotRemoteEncryption(room: WatchableRoom): RemoteEncryptionSnapshot {
    const unencrypted: string[] = [];
    for (const p of room.remoteParticipants.values()) {
        if (isParticipantUnencrypted(p)) unencrypted.push(p.identity);
    }
    unencrypted.sort();
    return { unencryptedIdentities: unencrypted, anyUnencrypted: unencrypted.length > 0 };
}

const sameSnapshot = (a: RemoteEncryptionSnapshot, b: RemoteEncryptionSnapshot) =>
    a.unencryptedIdentities.length === b.unencryptedIdentities.length &&
    a.unencryptedIdentities.every((id, i) => id === b.unencryptedIdentities[i]);

/**
 * Watch `room` and call `onChange` whenever the set of unencrypted remote
 * participants changes. Fires once immediately with the current state, so a
 * caller that joins a call already in progress is correct without waiting for
 * an event.
 *
 * Returns a dispose function; after dispose, `onChange` never fires again.
 */
export function watchRemoteE2EE(
    room: WatchableRoom,
    onChange: (snapshot: RemoteEncryptionSnapshot) => void,
): () => void {
    let disposed = false;
    let last: RemoteEncryptionSnapshot = EMPTY_REMOTE_ENCRYPTION;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners: Array<[string, (...args: any[]) => void]> = [];

    const recompute = () => {
        if (disposed) return;
        const next = snapshotRemoteEncryption(room);
        if (sameSnapshot(next, last)) return;
        last = next;
        onChange(next);
    };

    // Every event that can change who is publishing what. `TrackPublished` /
    // `TrackUnpublished` are the remote-only variants (the local ones are
    // `LocalTrackPublished` / `LocalTrackUnpublished`, which are
    // `e2eeActivation`'s business, not ours).
    for (const event of [
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
    ] as string[]) {
        const listener = () => recompute();
        listeners.push([event, listener]);
        room.on(event, listener);
    }

    // Seed from the roster as it stands right now.
    last = snapshotRemoteEncryption(room);
    onChange(last);

    return () => {
        if (disposed) return;
        disposed = true;
        for (const [event, listener] of listeners) room.off(event, listener);
        listeners.length = 0;
    };
}
