import { describe, it, expect, vi } from 'vitest';
import { nearSignInBuildFlag, probeNearSignIn, probeNearTransfer } from './nearFlag';
import type { NearCapabilities } from '../types/near';

const caps = (available: boolean): NearCapabilities => ({ available, bluetooth: 'ready', lan: true, biometric: 'available', gate: 'hello' });

describe('proximity sign-in gate: default off, both conditions required', () => {
    it('the build flag is OFF unless VITE_NEAR_SIGNIN=1 is set (this test build does not set it)', () => {
        expect(nearSignInBuildFlag()).toBe(false);
    });
    it('flag off: never even asks the bridge', async () => {
        const nearProbe = vi.fn(async () => caps(true));
        expect(await probeNearSignIn({ nearProbe }, false)).toBeNull();
        expect(nearProbe).not.toHaveBeenCalled();
    });
    it('flag on, bridge available: enabled', async () => {
        expect(await probeNearSignIn({ nearProbe: async () => caps(true) }, true)).toMatchObject({ available: true });
    });
    it('flag on, bridge says "not available" (the Electron stub): today\'s sign-in', async () => {
        expect(await probeNearSignIn({ nearProbe: async () => caps(false) }, true)).toBeNull();
    });
    it('flag on, no member at all / rejects / malformed: today\'s sign-in, never a throw', async () => {
        expect(await probeNearSignIn({}, true)).toBeNull();
        expect(await probeNearSignIn(undefined, true)).toBeNull();
        expect(await probeNearSignIn({ nearProbe: async () => { throw new Error('boom'); } }, true)).toBeNull();
        expect(await probeNearSignIn({ nearProbe: async () => null as unknown as NearCapabilities }, true)).toBeNull();
    });
});

describe('local transfer gate: always on (VITE_NEAR_TRANSFER retired), only the helper decides', () => {
    it('there is no transfer build flag any more: the sign-in flag stays independent and off', () => {
        expect(nearSignInBuildFlag()).toBe(false);
    });
    it('helper available: enabled; not available / no member / rejects / malformed: null, never a throw', async () => {
        expect(await probeNearTransfer({ nearProbe: async () => caps(true) })).toMatchObject({ available: true });
        expect(await probeNearTransfer({ nearProbe: async () => caps(false) })).toBeNull();
        expect(await probeNearTransfer({})).toBeNull();
        expect(await probeNearTransfer(undefined)).toBeNull();
        expect(await probeNearTransfer({ nearProbe: async () => { throw new Error('boom'); } })).toBeNull();
        expect(await probeNearTransfer({ nearProbe: async () => null as unknown as NearCapabilities })).toBeNull();
    });
    it('asks the bridge without any build flag set', async () => {
        const nearProbe = vi.fn(async () => caps(true));
        await probeNearTransfer({ nearProbe });
        expect(nearProbe).toHaveBeenCalledTimes(1);
    });
});
