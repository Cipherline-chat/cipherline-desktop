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

describe('VoiceVideoSettings — the camera preview follows the picked camera', () => {
    it('opens through openCameraPreview ({exact}), not a bare id (an ideal Chromium ignores)', () => {
        expect(src).toMatch(/openCameraPreview\(deviceId, c => navigator\.mediaDevices\.getUserMedia\(c\)\)/);
        expect(src).not.toMatch(/deviceId: deviceId \|\| undefined/);
    });

    it('restarts when the pick changes, and when the hardware changes under it', () => {
        expect(src).toMatch(/\}, \[deviceId, active, reopenTick\]\);/);
        expect(src).toMatch(/addEventListener\('devicechange', onDeviceChange\)/);
        expect(src).toMatch(/addEventListener\('ended'/);
    });

    it('keeps a pick that is not plugged in visible in the picker instead of blanking it', () => {
        expect(src).toMatch(/makeDeviceOptions\(videoDevices, 'Default Camera', settings\.cameraDeviceId, undefined\)/);
    });

    it('the call is opened with the same stored pick (LiveKit wraps a string deviceId in {exact})', () => {
        const call = readFileSync(join(here, 'CallPane.tsx'), 'utf8');
        expect(call).toMatch(/useState\(\(\) => voice\?\.settings\.cameraDeviceId \|\| undefined\)/);
        expect(call).toMatch(/videoCaptureDefaults: \{[^}]*deviceId: initialCameraDeviceId,/s);
    });
});

describe('VoiceVideoSettings — the manual noise gate is the only gate (the automatic voice gate and the engine switch are gone, 2026-11-20)', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const vv = readFileSync(join(dir, 'VoiceVideoSettings.tsx'), 'utf8');
    const list = readFileSync(join(dir, 'settings', 'AudioDeviceList.tsx'), 'utf8');
    it('no separate Automatic toggle row any more', () => {
        expect(vv).not.toMatch(/label="Automatic"/);
        expect(list).not.toMatch(/label="Automatic"/);
    });
    it('no Manual chip and no voiceGateAuto anywhere in the gate UI', () => {
        expect(vv).not.toMatch(/voiceGateAuto/);
        expect(list).not.toMatch(/voiceGateAuto/);
        expect(vv).not.toMatch(/>\s*Manual\s*<\/ClButton>/);
        expect(list).not.toMatch(/>\s*Manual\s*<\/ClButton>/);
    });
    it('the noise gate slider is shown under its row only while the gate is on', () => {
        expect(vv).toMatch(/<\/Row>\s*\{settings\.voiceGateManual === true && \(\s*<div className="vv-gate-drop"[^>]*>\s*<GateSlider\s+show="track"/);
        expect(vv).toMatch(/<GateSlider\s+show="readout"/);
    });
    it('no engine switch, no beta wording, no old Voice gate / Activity threshold anywhere', () => {
        for (const src of [vv, list]) {
            expect(src).not.toMatch(/Audio engine|New \(beta\)|New audio engine|label="Voice gate"|Activity threshold|setAudioEngine|setVoiceGateThreshold|voice\.setVoiceGate\b/);
        }
        expect(list).not.toMatch(/vv-gate-drop/);
    });
});
