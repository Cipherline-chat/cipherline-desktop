import { describe, it, expect } from 'vitest';
import { DisconnectReason } from 'livekit-client';
import { mapDisconnectReasonToUserMessage, isRecoverableDisconnect } from './callDisconnectReasons';

// Every numeric value LiveKit's protobuf enum defines, independent of the
// TS enum object's own key iteration order/quirks — this is what actually
// pins "every DisconnectReason maps to something deliberate."
const ALL_REASON_VALUES = Object.values(DisconnectReason).filter(
    (v): v is DisconnectReason => typeof v === 'number',
);

describe('mapDisconnectReasonToUserMessage', () => {
    it('has a distinct entry for every DisconnectReason enum value — no silent catch-all', () => {
        expect(ALL_REASON_VALUES.length).toBeGreaterThan(0); // sanity: the enum actually has values
        for (const reason of ALL_REASON_VALUES) {
            const msg = mapDisconnectReasonToUserMessage(reason);
            expect(msg.title).toBeTruthy();
            expect(msg.message).toBeTruthy();
            expect(['info', 'warning', 'error']).toContain(msg.kind);
        }
    });

    it('falls back to a generic-but-present message for an undefined reason', () => {
        const msg = mapDisconnectReasonToUserMessage(undefined);
        expect(msg.title).toBeTruthy();
        expect(msg.message).toBeTruthy();
    });

    it('gives distinct copy for the cases that matter most to this audit', () => {
        // Kicked by a moderator should not read like "the call ended" generically.
        const removed = mapDisconnectReasonToUserMessage(DisconnectReason.PARTICIPANT_REMOVED);
        expect(removed.title.toLowerCase()).toContain('removed');

        // The duplicate-identity fallback (multi-device answer race, Phase H)
        // should read as "answered elsewhere," not as an error.
        const dup = mapDisconnectReasonToUserMessage(DisconnectReason.DUPLICATE_IDENTITY);
        expect(dup.kind).toBe('info');
        expect(dup.message.toLowerCase()).toContain('other device');

        // A genuine reconnect-exhausted case should read as an actionable error.
        const signalClose = mapDisconnectReasonToUserMessage(DisconnectReason.SIGNAL_CLOSE);
        expect(signalClose.kind).toBe('error');
    });

    it('gives every value a unique (title, message) pair — catches accidental copy-paste collisions', () => {
        const seen = new Set<string>();
        for (const reason of ALL_REASON_VALUES) {
            const msg = mapDisconnectReasonToUserMessage(reason);
            const key = `${msg.title}::${msg.message}`;
            // UNKNOWN_REASON and the undefined-fallback are allowed to share
            // copy with each other (both are legitimately "no more specific
            // info available") — everything else should be distinguishable.
            if (reason === DisconnectReason.UNKNOWN_REASON) continue;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });
});

describe('isRecoverableDisconnect', () => {
    it('treats network/transient failures as recoverable', () => {
        expect(isRecoverableDisconnect(DisconnectReason.SIGNAL_CLOSE)).toBe(true);
        expect(isRecoverableDisconnect(DisconnectReason.CONNECTION_TIMEOUT)).toBe(true);
        expect(isRecoverableDisconnect(DisconnectReason.SERVER_SHUTDOWN)).toBe(true);
        expect(isRecoverableDisconnect(DisconnectReason.MEDIA_FAILURE)).toBe(true);
    });

    it('treats definitively terminal reasons as not recoverable', () => {
        expect(isRecoverableDisconnect(DisconnectReason.PARTICIPANT_REMOVED)).toBe(false);
        expect(isRecoverableDisconnect(DisconnectReason.USER_REJECTED)).toBe(false);
        expect(isRecoverableDisconnect(DisconnectReason.ROOM_DELETED)).toBe(false);
        expect(isRecoverableDisconnect(DisconnectReason.CLIENT_INITIATED)).toBe(false);
        expect(isRecoverableDisconnect(DisconnectReason.DUPLICATE_IDENTITY)).toBe(false);
    });

    it('treats an undefined reason as not recoverable (nothing to retry against)', () => {
        expect(isRecoverableDisconnect(undefined)).toBe(false);
    });
});
