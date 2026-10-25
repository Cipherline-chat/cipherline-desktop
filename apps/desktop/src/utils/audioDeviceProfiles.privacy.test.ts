import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSettingsSnapshot } from './diagnostics/settingsSnapshot';
import { DEFAULT_VOICE_SETTINGS } from '../hooks/useVoiceSettings';

/**
 * Device labels ("Dawson's AirPods Pro") stay on the device. The per-device
 * profiles are never read by the diagnostics code, and the settings snapshot a
 * report carries keeps only scalars even when the voice settings it is handed
 * contain labels.
 */
describe('device labels never reach a diagnostic report', () => {
    it('the settings snapshot drops labels and ids from the voice settings', () => {
        const snap = buildSettingsSnapshot({
            voice: {
                ...DEFAULT_VOICE_SETTINGS,
                micDeviceId: 'id-secret-mic', speakerDeviceId: 'id-secret-out',
                micDeviceLabel: "Dawson's AirPods Pro", speakerDeviceLabel: "Dawson's AirPods Pro",
            } as never,
            devices: [{ kind: 'audioinput', deviceId: 'id-secret-mic' }],
        });
        const json = JSON.stringify(snap);
        expect(json).not.toMatch(/Dawson|AirPods|id-secret/);
    });

    it('no diagnostics source reads the per-device profile record', () => {
        const dir = join(__dirname, 'diagnostics');
        for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
            const text = readFileSync(join(dir, f), 'utf8');
            expect(text, f).not.toMatch(/audio_device_profiles|audioDeviceProfiles/);
        }
    });
});
