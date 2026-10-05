import { describe, it, expect } from 'vitest';
import {
    initialLivenessState,
    onAckReceived,
    onHeartbeatSent,
    shouldForceReconnect,
    HEARTBEAT_INTERVAL_MS,
    MISSED_HEARTBEATS_BEFORE_DEAD,
} from './socketLiveness';

const T0 = 1_000_000;

describe('socket liveness', () => {
    describe('the old-server guard', () => {
        // This is the one that matters most. A client newer than the server it
        // talks to would never see an ACK; without this guard it would declare
        // every healthy socket dead after 30s and reconnect in a loop forever.
        it('never force-reconnects a connection that has never been ACKed', () => {
            const s = initialLivenessState();
            expect(shouldForceReconnect(s, T0)).toBe(false);
            expect(shouldForceReconnect(s, T0 + 60_000)).toBe(false);
            expect(shouldForceReconnect(s, T0 + 86_400_000)).toBe(false);   // a full day
        });

        it('still never force-reconnects it after many heartbeats go out', () => {
            let s = initialLivenessState();
            for (let i = 1; i <= 20; i++) s = onHeartbeatSent(s, T0 + i * HEARTBEAT_INTERVAL_MS);
            expect(shouldForceReconnect(s, T0 + 21 * HEARTBEAT_INTERVAL_MS)).toBe(false);
        });
    });

    describe('once the server has proven it answers', () => {
        it('tolerates a single missed ACK', () => {
            const s = onAckReceived(initialLivenessState(), T0);
            expect(shouldForceReconnect(s, T0 + HEARTBEAT_INTERVAL_MS + 1)).toBe(false);
        });

        it('declares the socket dead after the allowed misses', () => {
            const s = onAckReceived(initialLivenessState(), T0);
            const past = T0 + HEARTBEAT_INTERVAL_MS * MISSED_HEARTBEATS_BEFORE_DEAD + 1;
            expect(shouldForceReconnect(s, past)).toBe(true);
        });

        it('is not tripped exactly at the boundary', () => {
            const s = onAckReceived(initialLivenessState(), T0);
            const exact = T0 + HEARTBEAT_INTERVAL_MS * MISSED_HEARTBEATS_BEFORE_DEAD;
            expect(shouldForceReconnect(s, exact)).toBe(false);
        });

        it('a late ACK rescues the connection', () => {
            let s = onAckReceived(initialLivenessState(), T0);
            const late = T0 + HEARTBEAT_INTERVAL_MS * 1.9;
            expect(shouldForceReconnect(s, late)).toBe(false);
            s = onAckReceived(s, late);
            expect(shouldForceReconnect(s, late + HEARTBEAT_INTERVAL_MS)).toBe(false);
        });

        // The reported scenario: laptop sleeps for an hour, TCP is half-open,
        // readyState still says OPEN. Silence must be read as death.
        it('detects the socket that slept through a suspend', () => {
            const s = onAckReceived(initialLivenessState(), T0);
            expect(shouldForceReconnect(s, T0 + 60 * 60 * 1000)).toBe(true);
        });
    });

    describe('timing budget', () => {
        // Must beat the server's 45s zombie watchdog, or the server force-
        // offlines the user (tearing down any active call) before the client
        // has even started reconnecting.
        it('gives up before the server watchdog fires at 45s', () => {
            expect(HEARTBEAT_INTERVAL_MS * MISSED_HEARTBEATS_BEFORE_DEAD).toBeLessThan(45_000);
        });
    });

    describe('state transitions', () => {
        it('starts with nothing recorded', () => {
            const s = initialLivenessState();
            expect(s).toEqual({ everAcked: false, lastAckAt: null, lastHeartbeatSentAt: null });
        });

        it('latches everAcked permanently', () => {
            let s = onAckReceived(initialLivenessState(), T0);
            s = onHeartbeatSent(s, T0 + 1000);
            expect(s.everAcked).toBe(true);
        });

        it('does not mutate the input state', () => {
            const s = initialLivenessState();
            const next = onAckReceived(s, T0);
            expect(s.everAcked).toBe(false);
            expect(next.everAcked).toBe(true);
        });
    });
});
