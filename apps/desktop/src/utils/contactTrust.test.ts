import { describe, it, expect } from 'vitest';
import { deriveContactTrust, trustLabel, trustExplanation, pinsToTrustDevices } from './contactTrust';
import type { SenderVerdict } from './senderTrust';

const dev = (deviceId: string, verified: boolean) => ({ deviceId, verified });

describe('deriveContactTrust — mapping from senderTrust verdicts', () => {
    it('renders every warnable verdict as compromised, never as merely unverified', () => {
        // The whole point of the icon rework: these three are the shapes a
        // sender-identity forgery takes. Amber reads as "not got round to it".
        const warnable: SenderVerdict[] = ['key_changed', 'unrecognized_verified', 'unattributed'];
        for (const verdict of warnable) {
            const t = deriveContactTrust({ verdict, devices: [dev('d1', true)] });
            expect(t.level).toBe('compromised');
        }
    });

    it('keeps unrecognized_verified red even when every pinned device is verified', () => {
        // This is the case that would otherwise paint a forgery green: the pin
        // store is fully happy, and the ONLY evidence of the attack lives in
        // the verdict. A badge that deferred to the pin store here would lie.
        const t = deriveContactTrust({
            verdict: 'unrecognized_verified',
            devices: [dev('d1', true), dev('d2', true)],
            activeDeviceId: 'd1',
        });
        expect(t.level).toBe('compromised');
        expect(t.verdict).toBe('unrecognized_verified');
    });

    it('does not award green for a verdict of ok — ok is TOFU, not verification', () => {
        // `ok` means "pinned and unchanged". It does not mean the user ever
        // compared a safety number, and conflating the two would hand the
        // strongest badge in the app to plain trust-on-first-use.
        const t = deriveContactTrust({ verdict: 'ok', devices: [dev('d1', false)] });
        expect(t.level).toBe('unverified');
    });

    it('treats first_contact as unverified, not as a warning', () => {
        const t = deriveContactTrust({ verdict: 'first_contact', devices: [dev('d1', false)] });
        expect(t.level).toBe('unverified');
    });

    it('falls through to the pin store when there is no envelope verdict', () => {
        const t = deriveContactTrust({ verdict: null, devices: [dev('d1', true)] });
        expect(t.level).toBe('verified');
    });
});

describe('deriveContactTrust — multi-device aggregation', () => {
    it('is green only when every known device is verified', () => {
        const t = deriveContactTrust({ devices: [dev('d1', true), dev('d2', true), dev('d3', true)] });
        expect(t.level).toBe('verified');
        expect(t.verifiedCount).toBe(3);
        expect(t.deviceCount).toBe(3);
    });

    it('is NOT green when one of four devices is unverified', () => {
        // Everything sent into the conversation reaches the unverified device
        // too, so "3 of 4" is not the claim a green shield makes.
        const t = deriveContactTrust({
            devices: [dev('d1', true), dev('d2', true), dev('d3', true), dev('d4', false)],
            activeDeviceId: 'd1',
        });
        expect(t.level).toBe('partially_verified');
        expect(t.level).not.toBe('verified');
    });

    it('separates a verified active device from an unverified one', () => {
        const devices = [dev('d1', true), dev('d2', false)];
        expect(deriveContactTrust({ devices, activeDeviceId: 'd1' }).level).toBe('partially_verified');
        expect(deriveContactTrust({ devices, activeDeviceId: 'd2' }).level).toBe('unverified');
    });

    it('is partial, not unverified, for a contact-level view with some devices done', () => {
        // The verification modal and the chat header have no single device in
        // front of them. Reporting "Not verified" there while the modal lists
        // two green devices understates the user's own work and teaches them
        // the badge is not tracking it; the fraction in the label keeps the
        // claim precise without overstating it as green.
        const t = deriveContactTrust({ devices: [dev('d1', true), dev('d2', false)] });
        expect(t.level).toBe('partially_verified');
        expect(t.verifiedCount).toBe(1);
    });

    it('is unverified when NO device is verified, whatever the count', () => {
        expect(deriveContactTrust({ devices: [dev('d1', false), dev('d2', false)] }).level).toBe('unverified');
    });

    it('is unverifiable when there is nothing on record to compare against', () => {
        expect(deriveContactTrust({ devices: [] }).level).toBe('unverifiable');
    });

    it('does not report unverifiable when a warnable verdict exists without pins', () => {
        // An unattributed envelope from a contact we have never pinned is a
        // warning, not a shrug.
        const t = deriveContactTrust({ verdict: 'unattributed', devices: [] });
        expect(t.level).toBe('compromised');
    });
});

describe('trust copy', () => {
    it('states the actual fraction in the partial label', () => {
        const t = deriveContactTrust({
            devices: [dev('d1', true), dev('d2', false), dev('d3', false)],
            activeDeviceId: 'd1',
        });
        expect(trustLabel(t)).toBe('Partly verified (1/3)');
    });

    it('names the contact and the shortfall in the partial explanation', () => {
        const t = deriveContactTrust({
            devices: [dev('d1', true), dev('d2', false)],
            activeDeviceId: 'd1',
        });
        const text = trustExplanation(t, 'Dawson');
        expect(text).toContain('Dawson');
        expect(text).toContain('1 of');
        expect(text).toContain('2 devices');
        // Must not assume a single device is in view — the same string is shown
        // on the contact-level modal header, where there isn't one.
        expect(text).not.toContain('This device');
    });

    it('never claims verification in the unverified explanation', () => {
        const t = deriveContactTrust({ devices: [dev('d1', false)] });
        const text = trustExplanation(t, 'Dawson').toLowerCase();
        expect(text).toContain('never confirmed');
        expect(text).not.toMatch(/\bis verified\b/);
    });

    it('gives each warnable verdict its own label, not one shared "warning"', () => {
        // The label is the whole badge for a screen-reader user — the tooltip
        // that carries the distinction is only announced while it is open. Three
        // different events that need three different responses must not collapse
        // into one string.
        const labels = (['key_changed', 'unrecognized_verified', 'unattributed'] as SenderVerdict[])
            .map(verdict => trustLabel(deriveContactTrust({ verdict, devices: [dev('d1', false)] })));
        expect(new Set(labels).size).toBe(3);
        for (const l of labels) expect(l).not.toBe('Identity warning');
    });

    it('never tells the user to click — the badge owns that, and is not always clickable', () => {
        // The same explanation renders on the incoming-call badge, which has no
        // click target. `TrustBadge` appends "Click to open verification." only
        // when it was given an onClick; a second instruction baked in here both
        // duplicated it there and lied on the call screen.
        const all = [
            deriveContactTrust({ devices: [dev('d1', true)] }),
            deriveContactTrust({ devices: [dev('d1', true), dev('d2', false)] }),
            deriveContactTrust({ devices: [dev('d1', false)] }),
            deriveContactTrust({ devices: [] }),
            deriveContactTrust({ verdict: 'key_changed', devices: [dev('d1', false)] }),
        ];
        for (const t of all) {
            expect(trustExplanation(t, 'Dawson').toLowerCase()).not.toContain('click');
        }
    });

    it('produces a non-empty label and explanation for every level', () => {
        const cases = [
            deriveContactTrust({ devices: [dev('d1', true)] }),
            deriveContactTrust({ devices: [dev('d1', true), dev('d2', false)], activeDeviceId: 'd1' }),
            deriveContactTrust({ devices: [dev('d1', false)] }),
            deriveContactTrust({ devices: [] }),
            deriveContactTrust({ verdict: 'key_changed', devices: [dev('d1', false)] }),
        ];
        const levels = cases.map(c => c.level);
        expect(new Set(levels).size).toBe(5);
        for (const c of cases) {
            expect(trustLabel(c).length).toBeGreaterThan(0);
            expect(trustExplanation(c, 'Dawson').length).toBeGreaterThan(0);
        }
    });
});

// ── G1 migration: legacy verification is its own calm level ────────────────
describe('deriveContactTrust — pre-v2 (legacy) verification', () => {
    const legacyDev = (deviceId: string) => ({ deviceId, verified: true, legacy: true });

    it('all devices verified but one legacy is verified_legacy: not green', () => {
        const t = deriveContactTrust({ devices: [dev('d1', true), legacyDev('d2')] });
        expect(t.level).toBe('verified_legacy');
        expect(t.verifiedCount).toBe(2);
    });

    it('control: the same set with no legacy vouch IS green', () => {
        expect(deriveContactTrust({ devices: [dev('d1', true), dev('d2', true)] }).level).toBe('verified');
    });

    it('legacy never outranks a warnable verdict', () => {
        expect(deriveContactTrust({ verdict: 'key_changed', devices: [legacyDev('d1')] }).level).toBe('compromised');
    });

    it('legacy does not change partial coverage', () => {
        expect(deriveContactTrust({ devices: [legacyDev('d1'), dev('d2', false)] }).level).toBe('partially_verified');
    });

    it('is labelled calmly: not "Not verified", not a warning', () => {
        const t = deriveContactTrust({ devices: [legacyDev('d1')] });
        expect(trustLabel(t)).toBe('Re-check suggested');
        const why = trustExplanation(t, 'Alice');
        expect(why).toMatch(/strengthened/);
        expect(why).not.toMatch(/never confirmed|does not check out|intercept/i);
    });

    it('pinsToTrustDevices derives legacy from the record, so no caller can drop it', () => {
        expect(pinsToTrustDevices({
            a: { verified: true },            // pre-v2
            b: { verified: true, sv: 2 },     // current
            c: { verified: false },           // never verified: not "legacy"
        })).toEqual([
            { deviceId: 'a', verified: true,  legacy: true },
            { deviceId: 'b', verified: true,  legacy: false },
            { deviceId: 'c', verified: false, legacy: false },
        ]);
    });
});
