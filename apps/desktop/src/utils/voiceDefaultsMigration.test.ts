import { describe, it, expect } from 'vitest';
import { migrateVoiceDefaults, VOICE_DEFAULTS_MIGRATION_KEY, VOICE_SETTINGS_KEY_FOR_MIGRATION } from './voiceDefaultsMigration';
import { AUDIO_DEVICE_PROFILES_KEY_PREFIX } from './audioDeviceProfiles';

function memStore(init: Record<string, string> = {}) {
    const m = new Map(Object.entries(init));
    return {
        m,
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => { m.set(k, v); },
        keysWithPrefix: (p: string) => [...m.keys()].filter(k => k.startsWith(p)),
    };
}

describe('migrateVoiceDefaults (one-time: Light NS, echo off)', () => {
    it('switches the saved blob and every remembered input profile, then never runs again', () => {
        const prof = AUDIO_DEVICE_PROFILES_KEY_PREFIX + 'u1';
        const s = memStore({
            [VOICE_SETTINGS_KEY_FOR_MIGRATION]: JSON.stringify({ noiseSuppressionMode: 'strong', echoCancellation: true, micVolume: 80 }),
            [prof]: JSON.stringify({ v: 1, input: { a: { settings: { noiseSuppressionMode: 'strong', echoCancellation: true } } }, output: {} }),
        });
        migrateVoiceDefaults(s);
        const blob = JSON.parse(s.getItem(VOICE_SETTINGS_KEY_FOR_MIGRATION)!);
        expect(blob).toMatchObject({ noiseSuppressionMode: 'light', echoCancellation: false, micVolume: 80 });
        expect(JSON.parse(s.getItem(prof)!).input.a.settings).toMatchObject({ noiseSuppressionMode: 'light', echoCancellation: false });
        expect(s.getItem(VOICE_DEFAULTS_MIGRATION_KEY)).toBe('1');
        // A user who picks Strong again afterwards keeps it.
        s.setItem(VOICE_SETTINGS_KEY_FOR_MIGRATION, JSON.stringify({ noiseSuppressionMode: 'strong', echoCancellation: true }));
        migrateVoiceDefaults(s);
        expect(JSON.parse(s.getItem(VOICE_SETTINGS_KEY_FOR_MIGRATION)!)).toMatchObject({ noiseSuppressionMode: 'strong', echoCancellation: true });
    });

    it('a fresh install with nothing saved just sets the marker', () => {
        const s = memStore();
        migrateVoiceDefaults(s);
        expect(s.getItem(VOICE_SETTINGS_KEY_FOR_MIGRATION)).toBeNull();
        expect(s.getItem(VOICE_DEFAULTS_MIGRATION_KEY)).toBe('1');
    });
});
