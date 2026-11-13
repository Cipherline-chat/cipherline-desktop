import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/secureLocalStore', () => {
    // Already past the one-time voice-defaults migration: these cover the loader itself.
    const mem = new Map<string, string>([['cipherline_voice_defaults_migrated_v1', '1']]);
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import secureLocalStore from '../utils/secureLocalStore';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings } from './useVoiceSettings';

const save = (v: unknown) => secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(v));

describe('noiseSuppressionMode (Strong = RNNoise, Light = Speex)', () => {
    it('defaults to Light for a new install (nothing saved)', () => {
        expect(DEFAULT_VOICE_SETTINGS.noiseSuppressionMode).toBe('light');
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings().noiseSuppressionMode).toBe('light');
    });

    it('an existing user who saved Strong (the old default) stays on Strong', () => {
        save({ ...DEFAULT_VOICE_SETTINGS, noiseSuppressionMode: 'strong' });
        expect(loadVoiceSettings().noiseSuppressionMode).toBe('strong');
    });

    it('settings saved before the mode existed load as Strong (what they were on), everything else kept', () => {
        save({ noiseSuppression: true, micVolume: 120 });
        const s = loadVoiceSettings();
        expect(s.noiseSuppressionMode).toBe('strong');
        expect(s.micVolume).toBe(120);
    });

    it('a saved Light choice survives a reload', () => {
        save({ ...DEFAULT_VOICE_SETTINGS, noiseSuppressionMode: 'light' });
        expect(loadVoiceSettings().noiseSuppressionMode).toBe('light');
    });

    it.each(['LIGHT', 'speex', '', null, 3, {}])('a garbage saved value (%j) falls back to Strong rather than leaving no engine', (bad) => {
        save({ ...DEFAULT_VOICE_SETTINGS, noiseSuppressionMode: bad });
        expect(loadVoiceSettings().noiseSuppressionMode).toBe('strong');
    });
});
