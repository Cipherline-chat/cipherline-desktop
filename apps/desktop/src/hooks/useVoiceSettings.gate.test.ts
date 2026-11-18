import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/secureLocalStore', () => {
    const mem = new Map<string, string>([['cipherline_voice_defaults_migrated_v1', '1']]);
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } };
});

import secureLocalStore from '../utils/secureLocalStore';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings, RETIRED_VOICE_SETTING_KEYS } from './useVoiceSettings';
import { INPUT_PROFILE_FIELDS, parseDeviceProfiles } from '../utils/audioDeviceProfiles';

const save = (v: unknown) => secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(v));

// The automatic voice gate was removed 2026-11-17 (owner: "leave out the auto part and go back to the way it was").
// The gate uses the saved voiceGateThreshold, as it did before 2026-11-11. A stored default of -45 now simply means
// a fixed -45 dBFS gate: exactly the pre-auto default, so a user who never touched the slider gets the old gate.
describe('voice gate: fixed threshold (automatic mode removed)', () => {
    it('a new install has no Automatic flag and a fixed -45 dBFS threshold', () => {
        expect('voiceGateAuto' in DEFAULT_VOICE_SETTINGS).toBe(false);
        expect(DEFAULT_VOICE_SETTINGS.voiceGateThreshold).toBe(-45);
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings().voiceGateThreshold).toBe(-45);
    });
    it('a saved Automatic flag (on or off) is dropped; the saved threshold is what the gate uses', () => {
        expect(RETIRED_VOICE_SETTING_KEYS).toContain('voiceGateAuto');
        save({ voiceGateAuto: true, voiceGateThreshold: -45 });
        let s = loadVoiceSettings() as unknown as Record<string, unknown>;
        expect('voiceGateAuto' in s).toBe(false);
        expect(s.voiceGateThreshold).toBe(-45);
        save({ voiceGateAuto: false, voiceGateThreshold: -33 });
        s = loadVoiceSettings() as unknown as Record<string, unknown>;
        expect('voiceGateAuto' in s).toBe(false);
        expect(s.voiceGateThreshold).toBe(-33);
    });
    it('per-device profiles no longer carry the flag; an old profile that has it keeps its threshold', () => {
        expect(INPUT_PROFILE_FIELDS).not.toContain('voiceGateAuto');
        const mk = (settings: Record<string, unknown>) => JSON.stringify({ v: 1, input: { mic: { label: 'Mic', settings } } });
        const old = parseDeviceProfiles(mk({ voiceGateAuto: true, voiceGateThreshold: -60 }), DEFAULT_VOICE_SETTINGS);
        expect(old!.input['mic'].settings).toMatchObject({ voiceGateThreshold: -60 });
        expect('voiceGateAuto' in old!.input['mic'].settings).toBe(false);
    });
});
