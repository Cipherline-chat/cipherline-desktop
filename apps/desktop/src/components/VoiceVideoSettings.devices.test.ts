import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source pins for the Voice & Video pane (a .tsx with no unit seam in vitest's
 * node environment). Each pins a fix for the owner's two reports:
 *   - "set my input device to something other than the default, it just
 *     ignores it and uses the default";
 *   - "the noise gate doesn't work when noise suppression is turned off".
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'VoiceVideoSettings.tsx'), 'utf8');

describe('VoiceVideoSettings — the mic test opens the PICKED mic', () => {
    it('opens with micDeviceConstraint ({exact} for a pick), not the bare id Chromium ignores', () => {
        expect(src).toMatch(/deviceId: micDeviceConstraint\(id\)/);
        expect(src).not.toMatch(/deviceId: resolveMicDeviceId\(deviceId\)/);
    });

    it('resolves the pick against the device list with its stored label/groupId first', () => {
        expect(src).toMatch(/const target = await resolvePreviewMic\(deviceId, settingsRef\.current\)/);
        expect(src).toMatch(/pickMicDeviceId\(stored, inputs, micHintOf\(s\)\)/);
    });

    it('never resets a pick to "Default" because it is momentarily absent — heals a re-enumerated id instead', () => {
        expect(src).not.toMatch(/setMicDeviceId\(''\)/);
        expect(src).not.toMatch(/setSpeakerDeviceId\(''\)/);
        expect(src).toMatch(/if \(device && match !== 'exact'\) voice\.setMicDeviceId\(device\.deviceId, device\)/);
        expect(src).toMatch(/if \(device && match !== 'exact'\) voice\.setSpeakerDeviceId\(device\.deviceId, device\)/);
    });

    it('records the picked device (label/groupId) with its id from both pickers', () => {
        expect(src).toMatch(/onChange=\{pickFrom\(inputDevices, settings\.micDeviceId, voice\.setMicDeviceId\)\}/);
        expect(src).toMatch(/onChange=\{pickFrom\(outputDevices, settings\.speakerDeviceId, voice\.setSpeakerDeviceId\)\}/);
    });
});

describe('VoiceVideoSettings — the gate meter is the gate', () => {
    it("the threshold slider shows the gate's own detector level and state, not the end-of-chain level", () => {
        expect(src).toMatch(/level=\{gateLevel\.db\}/);
        expect(src).toMatch(/open=\{gateLevel\.open\}/);
        expect(src).toMatch(/onGateLevel: \(db, open\) => setGateLevel\(\{ db, open \}\)/);
        expect(src).toMatch(/\{ gateMeterMs: GATE_METER_REPORT_MS \}/);
    });
});
