import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/secureLocalStore', () => {
    const mem = new Map<string, string>([['cipherline_voice_defaults_migrated_v1', '1']]);
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } };
});

import secureLocalStore from '../utils/secureLocalStore';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings } from './useVoiceSettings';
import { INPUT_PROFILE_FIELDS, parseDeviceProfiles, pickProfileSettings } from '../utils/audioDeviceProfiles';

const save = (v: unknown) => secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(v));

describe('voice gate Automatic flag', () => {
    it('defaults to ON for a new install', () => {
        expect(DEFAULT_VOICE_SETTINGS.voiceGateAuto).toBe(true);
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings().voiceGateAuto).toBe(true);
    });
    it('MIGRATION: an old blob (-60, no flag) loads Automatic ON and keeps -60 as the manual value', () => {
        save({ voiceGate: true, voiceGateThreshold: -60 });
        const s = loadVoiceSettings();
        expect(s.voiceGateAuto).toBe(true);
        expect(s.voiceGateThreshold).toBe(-60);
    });
    it('CONTROL: a saved Automatic OFF is honoured (the migration is by absence, not unconditional)', () => {
        save({ voiceGateAuto: false, voiceGateThreshold: -33 });
        expect(loadVoiceSettings()).toMatchObject({ voiceGateAuto: false, voiceGateThreshold: -33 });
    });
    it('a non-boolean flag falls back to ON', () => {
        save({ voiceGateAuto: 'no', voiceGateThreshold: -33 });
        expect(loadVoiceSettings().voiceGateAuto).toBe(true);
    });
    it('toggling persists: a blob saved with the flag flipped reloads flipped', () => {
        save({ ...loadVoiceSettings(), voiceGateAuto: false });
        expect(loadVoiceSettings().voiceGateAuto).toBe(false);
        save({ ...loadVoiceSettings(), voiceGateAuto: true });
        expect(loadVoiceSettings().voiceGateAuto).toBe(true);
    });
    it('per-device profiles remember the flag; an old profile without it loads Automatic', () => {
        expect(INPUT_PROFILE_FIELDS).toContain('voiceGateAuto');
        expect(pickProfileSettings('input', { ...DEFAULT_VOICE_SETTINGS, voiceGateAuto: false }).voiceGateAuto).toBe(false);
        const mk = (settings: Record<string, unknown>) => JSON.stringify({ v: 1, input: { mic: { label: 'Mic', settings } } });
        const old = parseDeviceProfiles(mk({ voiceGateThreshold: -60 }), { ...DEFAULT_VOICE_SETTINGS, voiceGateAuto: false });
        expect(old!.input['mic'].settings).toMatchObject({ voiceGateAuto: true, voiceGateThreshold: -60 });
        const off = parseDeviceProfiles(mk({ voiceGateAuto: false, voiceGateThreshold: -33 }), DEFAULT_VOICE_SETTINGS);
        expect(off!.input['mic'].settings).toMatchObject({ voiceGateAuto: false, voiceGateThreshold: -33 });
    });
});
