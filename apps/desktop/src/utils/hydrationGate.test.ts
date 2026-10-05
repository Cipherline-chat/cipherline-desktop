import { describe, it, expect } from 'vitest';
import { isHydrationReady, shouldArmGateTimeout, CORE_LOADS } from './hydrationGate';

const none = { conversations: false, friends: false, servers: false };
const all = { conversations: true, friends: true, servers: true };

describe('hydration gate', () => {
    it('holds first paint until every core load settles', () => {
        expect(isHydrationReady({ settled: none, gateReleased: false })).toBe(false);
        expect(isHydrationReady({
            settled: { ...none, conversations: true }, gateReleased: false,
        })).toBe(false);
        expect(isHydrationReady({
            settled: { ...none, conversations: true, friends: true }, gateReleased: false,
        })).toBe(false);
        expect(isHydrationReady({ settled: all, gateReleased: false })).toBe(true);
    });

    // The friends fetch is the one that used to fail silently and leave the app
    // half-dead; make sure it genuinely gates rather than being decorative.
    it.each(CORE_LOADS)('waits on %s specifically', (load) => {
        const settled = { ...all, [load]: false };
        expect(isHydrationReady({ settled, gateReleased: false })).toBe(false);
    });

    it('opens on timeout so a dead network never strands the user', () => {
        expect(isHydrationReady({ settled: none, gateReleased: true })).toBe(true);
    });

    // "Settled" deliberately includes "gave up". A partly-populated app that
    // keeps retrying beats an indefinite skeleton.
    it('treats an exhausted load as settled, not as a reason to keep waiting', () => {
        expect(isHydrationReady({ settled: all, gateReleased: false })).toBe(true);
    });

    it('treats a missing entry as not settled', () => {
        expect(isHydrationReady({ settled: {}, gateReleased: false })).toBe(false);
        expect(isHydrationReady({ settled: { conversations: true }, gateReleased: false })).toBe(false);
    });

    describe('timeout arming', () => {
        it('arms while still waiting', () => {
            expect(shouldArmGateTimeout({ settled: none, gateReleased: false })).toBe(true);
        });

        it('does not arm once everything settled', () => {
            expect(shouldArmGateTimeout({ settled: all, gateReleased: false })).toBe(false);
        });

        it('does not arm once released', () => {
            expect(shouldArmGateTimeout({ settled: none, gateReleased: true })).toBe(false);
        });
    });
});
