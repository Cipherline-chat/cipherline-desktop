import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for LiveKit E2EE activation.
 *
 * This pins *registration*, not logic — the class of bug that let calls ship
 * unencrypted in the first place: the E2EE key provider was built, keyed and
 * unit-tested, and the one call that actually turns encryption on
 * (`Room.setE2EEEnabled(true)`) was never made. The activation logic itself
 * is covered by utils/e2eeActivation.test.ts; the on-the-wire proof lives in
 * docs/livekit-e2ee-activation-rollout.md. Same approach as
 * callsChannelKeyWiring.test.ts: CallPane has no render harness, and the
 * property here is "the activator is mounted inside the room", which a
 * text scan pins cheaply.
 */

const callPane = readFileSync(join(__dirname, 'CallPane.tsx'), 'utf8');

describe('CallPane activates LiveKit E2EE through the activator', () => {
    it('imports the real activator component (the module the render test exercises)', () => {
        expect(callPane).toMatch(/import \{ E2EEActivator \} from '\.\/E2EEActivator'/);
        expect(callPane).not.toContain('activateRoomE2EE(');
    });

    it('mounts <E2EEActivator> INSIDE <LiveKitRoom> so it sees the Room before connect', () => {
        const roomOpen = callPane.indexOf('<LiveKitRoom');
        const roomClose = callPane.indexOf('</LiveKitRoom>');
        const activator = callPane.indexOf('<E2EEActivator');
        expect(roomOpen).toBeGreaterThan(-1);
        expect(activator).toBeGreaterThan(roomOpen);
        expect(activator).toBeLessThan(roomClose);
    });

    it('the activator is driven by the same key that builds the encryption block', () => {
        // The `encryption:` block exists iff e2eeKeyB64 is truthy; the activator receives that
        // same value (expecting encryption iff it is non-empty), or a keyless call would be
        // failed / a keyed call would be left inactive.
        expect(callPane).toContain('keyB64={e2eeKeyB64}');
        expect(callPane).toMatch(/\.\.\.\(e2eeKeyB64 \? \{[\s\S]*?encryption: stableE2EEOptions\(/);
    });

    it('the activator is the ONLY thing that installs the key (no fire-and-forget setKey elsewhere)', () => {
        // The 2026-09-08 hardening: key install and activation live in one component, with the
        // install promise handed to activation. A second setKey() call site in CallPane would
        // reintroduce the "installed in one effect, checked in another" race by construction.
        expect(callPane).not.toContain('setKey(');
        expect(callPane).not.toContain('atob(');
    });

    it('activation failure leaves the call rather than continuing unencrypted', () => {
        const idx = callPane.indexOf('const failEncryption');
        expect(idx).toBeGreaterThan(-1);
        const body = callPane.slice(idx, idx + 900);
        expect(body).toContain('onDisconnect()');
        expect(body).toContain('describeE2EEActivationFailure(');
    });

    it('surfaces the SDK encryption errors instead of swallowing them', () => {
        expect(callPane).toMatch(/onEncryptionError=\{/);
    });

    it('no other code path flips encryption off', () => {
        expect(callPane).not.toContain('setE2EEEnabled(false)');
    });
});
