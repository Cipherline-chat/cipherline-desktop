import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/secureLocalStore', () => {
    const mem = new Map<string, string>([['cipherline_voice_defaults_migrated_v1', '1']]);
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } };
});

import secureLocalStore from '../utils/secureLocalStore';
import { VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings } from './useVoiceSettings';

const save = (v: unknown) => secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(v));

describe('audioEngine: the new engine is the only engine (owner, 2026-11-20)', () => {
    it('nothing saved: v2', () => {
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings().audioEngine).toBe('v2');
    });
    it('a blob saved before the setting existed, or saved as legacy, loads as v2', () => {
        save({ noiseSuppression: true, noiseSuppressionMode: 'strong', micVolume: 100 });
        expect(loadVoiceSettings().audioEngine).toBe('v2');
        save({ audioEngine: 'legacy' });
        expect(loadVoiceSettings().audioEngine).toBe('v2');
    });
    it('v2 survives a reload; a junk value is v2 too', () => {
        save({ audioEngine: 'v2' });
        expect(loadVoiceSettings().audioEngine).toBe('v2');
        for (const junk of ['v3', 2, null, true, {}]) {
            save({ audioEngine: junk });
            expect(loadVoiceSettings().audioEngine).toBe('v2');
        }
    });
    it("moving to v2 does not reset anyone's explicit choices", () => {
        save({ audioEngine: 'legacy', noiseSuppression: false, noiseSuppressionMode: 'strong', volumeNormalization: false, echoCancellation: true, echoCancellationAuto: false, pushToTalk: true, pushToTalkKey: 'F8', micVolume: 130, speakerVolume: 150, eqEnabled: true, eqBands: [1, 2, 3, 4, 5], voiceGateManual: true, voiceGateManualDb: -40 });
        expect(loadVoiceSettings()).toMatchObject({
            audioEngine: 'v2', noiseSuppression: false, noiseSuppressionMode: 'strong', volumeNormalization: false, echoCancellation: true,
            echoCancellationAuto: false, pushToTalk: true, pushToTalkKey: 'F8', micVolume: 130, speakerVolume: 150, eqEnabled: true,
            eqBands: [1, 2, 3, 4, 5], voiceGateManual: true, voiceGateManualDb: -40,
        });
    });
    it('a fresh install: noise suppression on in Light, manual gate off, auto gain on', () => {
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings()).toMatchObject({ audioEngine: 'v2', noiseSuppression: true, noiseSuppressionMode: 'light', voiceGateManual: false, volumeNormalization: true });
    });
});

describe('manual gate persistence', () => {
    it('a blob from before the manual gate existed loads with it OFF, whatever the legacy gate said (auto gate included)', () => {
        save({ audioEngine: 'v2', voiceGate: true, voiceGateThreshold: -45, voiceGateAuto: true });
        const s = loadVoiceSettings();
        expect(s.voiceGateManual).toBe(false);
        expect(s.voiceGateManualDb).toBe(-55);
        expect('voiceGateAuto' in s).toBe(false);
    });
    it('on + threshold survive a reload; junk is off / clamped', () => {
        save({ voiceGateManual: true, voiceGateManualDb: -48 });
        expect(loadVoiceSettings()).toMatchObject({ voiceGateManual: true, voiceGateManualDb: -48 });
        for (const junk of ['true', 1, null, {}]) {
            save({ voiceGateManual: junk });
            expect(loadVoiceSettings().voiceGateManual).toBe(false);
        }
        save({ voiceGateManualDb: -500 });
        expect(loadVoiceSettings().voiceGateManualDb).toBe(-80);
        save({ voiceGateManualDb: 'x' });
        expect(loadVoiceSettings().voiceGateManualDb).toBe(-55);
    });
});
