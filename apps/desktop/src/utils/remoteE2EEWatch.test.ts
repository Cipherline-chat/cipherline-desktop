import { describe, it, expect, vi } from 'vitest';
import { Encryption_Type, RoomEvent } from 'livekit-client';
import {
    watchRemoteE2EE,
    snapshotRemoteEncryption,
    EMPTY_REMOTE_ENCRYPTION,
    type WatchableRoom,
    type WatchableParticipant,
    type WatchablePublication,
    type RemoteEncryptionSnapshot,
} from './remoteE2EEWatch';

const pub = (trackSid: string, encryption: number | undefined, source = 'camera'): WatchablePublication => ({
    trackSid,
    source,
    trackInfo: encryption === undefined ? undefined : { encryption },
});

const participant = (identity: string, pubs: WatchablePublication[]): WatchableParticipant => ({
    identity,
    trackPublications: new Map(pubs.map(p => [p.trackSid, p])),
});

/** Minimal fake Room with a real listener registry, so dispose is testable. */
const fakeRoom = (participants: WatchableParticipant[]) => {
    const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    const remoteParticipants = new Map(participants.map(p => [p.identity, p]));
    const room: WatchableRoom & {
        emit: (e: string) => void;
        listenerCount: () => number;
        addParticipant: (p: WatchableParticipant) => void;
        removeParticipant: (identity: string) => void;
    } = {
        remoteParticipants,
        on(event, listener) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener); return room; },
        off(event, listener) { listeners.get(event)?.delete(listener); return room; },
        emit(event) { for (const l of listeners.get(event) ?? []) l(); },
        listenerCount() { let n = 0; for (const s of listeners.values()) n += s.size; return n; },
        addParticipant(p) { remoteParticipants.set(p.identity, p); },
        removeParticipant(identity) { remoteParticipants.delete(identity); },
    };
    return room;
};

const GCM = Encryption_Type.GCM;
const NONE = Encryption_Type.NONE;

describe('snapshotRemoteEncryption', () => {
    it('reports nobody when every remote track is GCM', () => {
        const room = fakeRoom([
            participant('alice', [pub('t1', GCM), pub('t2', GCM, 'microphone')]),
            participant('bob', [pub('t3', GCM)]),
        ]);
        expect(snapshotRemoteEncryption(room)).toEqual(EMPTY_REMOTE_ENCRYPTION);
    });

    it('names a participant publishing a NONE track', () => {
        const room = fakeRoom([
            participant('alice', [pub('t1', GCM)]),
            participant('legacy', [pub('t2', NONE)]),
        ]);
        expect(snapshotRemoteEncryption(room)).toEqual({
            unencryptedIdentities: ['legacy'],
            anyUnencrypted: true,
        });
    });

    it('flags a participant whose tracks are MIXED — one plaintext track is enough', () => {
        // The realistic legacy shape is all-or-nothing, but a partial publish
        // must not be rounded down to "encrypted".
        const room = fakeRoom([participant('half', [pub('t1', GCM), pub('t2', NONE, 'microphone')])]);
        expect(snapshotRemoteEncryption(room).unencryptedIdentities).toEqual(['half']);
    });

    it('treats missing trackInfo as unencrypted, not as encrypted', () => {
        // Defensive: if the SDK ever hands us a publication without trackInfo
        // we must not silently call it safe.
        const room = fakeRoom([participant('unknown', [pub('t1', undefined)])]);
        expect(snapshotRemoteEncryption(room).anyUnencrypted).toBe(true);
    });

    it('does NOT flag a participant who publishes nothing (muted, camera off)', () => {
        // The load-bearing false-positive guard: silence is unknown, not unsafe.
        const room = fakeRoom([
            participant('silent', []),
            participant('alice', [pub('t1', GCM)]),
        ]);
        expect(snapshotRemoteEncryption(room)).toEqual(EMPTY_REMOTE_ENCRYPTION);
    });

    it('sorts identities so equal states are stable across Map ordering', () => {
        const room = fakeRoom([
            participant('zoe', [pub('t1', NONE)]),
            participant('adam', [pub('t2', NONE)]),
        ]);
        expect(snapshotRemoteEncryption(room).unencryptedIdentities).toEqual(['adam', 'zoe']);
    });

    it('ignores a CUSTOM-encrypted track — only the cipher we negotiate counts', () => {
        // Stricter than the SDK's own `!== NONE`. Over-reporting is the safe
        // direction for a warning; under-reporting is not.
        const custom = Encryption_Type.CUSTOM;
        const room = fakeRoom([participant('weird', [pub('t1', custom)])]);
        expect(snapshotRemoteEncryption(room).anyUnencrypted).toBe(true);
    });
});

describe('watchRemoteE2EE', () => {
    it('fires immediately with current state, so joining a call in progress is correct', () => {
        const room = fakeRoom([participant('legacy', [pub('t1', NONE)])]);
        const seen: RemoteEncryptionSnapshot[] = [];
        watchRemoteE2EE(room, s => seen.push(s));
        expect(seen).toHaveLength(1);
        expect(seen[0].unencryptedIdentities).toEqual(['legacy']);
    });

    it('re-reports when a legacy participant joins mid-call', () => {
        const room = fakeRoom([participant('alice', [pub('t1', GCM)])]);
        const seen: RemoteEncryptionSnapshot[] = [];
        watchRemoteE2EE(room, s => seen.push(s));
        expect(seen[0].anyUnencrypted).toBe(false);

        room.addParticipant(participant('legacy', [pub('t9', NONE)]));
        room.emit(RoomEvent.TrackPublished);

        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual({ unencryptedIdentities: ['legacy'], anyUnencrypted: true });
    });

    it('clears when the legacy participant leaves', () => {
        const room = fakeRoom([participant('legacy', [pub('t1', NONE)])]);
        const seen: RemoteEncryptionSnapshot[] = [];
        watchRemoteE2EE(room, s => seen.push(s));

        room.removeParticipant('legacy');
        room.emit(RoomEvent.ParticipantDisconnected);

        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual(EMPTY_REMOTE_ENCRYPTION);
    });

    it('does not re-fire when nothing changed', () => {
        const room = fakeRoom([participant('alice', [pub('t1', GCM)])]);
        const onChange = vi.fn();
        watchRemoteE2EE(room, onChange);
        expect(onChange).toHaveBeenCalledTimes(1);

        room.emit(RoomEvent.TrackPublished);
        room.emit(RoomEvent.ParticipantConnected);
        room.emit(RoomEvent.TrackUnpublished);

        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('stops firing and removes every listener after dispose', () => {
        const room = fakeRoom([participant('alice', [pub('t1', GCM)])]);
        const onChange = vi.fn();
        const dispose = watchRemoteE2EE(room, onChange);
        expect(room.listenerCount()).toBeGreaterThan(0);

        dispose();
        expect(room.listenerCount()).toBe(0);

        room.addParticipant(participant('legacy', [pub('t9', NONE)]));
        room.emit(RoomEvent.TrackPublished);
        expect(onChange).toHaveBeenCalledTimes(1); // the initial seed only
    });

    it('dispose is idempotent', () => {
        const room = fakeRoom([]);
        const dispose = watchRemoteE2EE(room, () => {});
        dispose();
        expect(() => dispose()).not.toThrow();
        expect(room.listenerCount()).toBe(0);
    });

    it('a participant who unmutes into plaintext is caught at that moment', () => {
        // The realistic sequence: legacy peer joins muted (nothing to judge),
        // then unmutes and starts sending in the clear.
        const legacy = participant('legacy', []);
        const room = fakeRoom([legacy]);
        const seen: RemoteEncryptionSnapshot[] = [];
        watchRemoteE2EE(room, s => seen.push(s));
        expect(seen[0].anyUnencrypted).toBe(false);

        legacy.trackPublications.set('t1', pub('t1', NONE, 'microphone'));
        room.emit(RoomEvent.TrackPublished);

        expect(seen[1]).toEqual({ unencryptedIdentities: ['legacy'], anyUnencrypted: true });
    });
});
