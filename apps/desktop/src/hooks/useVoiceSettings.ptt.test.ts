import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/secureLocalStore', () => {
    const mem = new Map<string, string>([['cipherline_voice_defaults_migrated_v1', '1']]);
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } } };
});

import secureLocalStore from '../utils/secureLocalStore';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings } from './useVoiceSettings';

const save = (v: unknown) => secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(v));

describe('push-to-talk has NO default key', () => {
    it('a new install is unbound and off', () => {
        expect(DEFAULT_VOICE_SETTINGS.pushToTalkKey).toBeNull();
        expect(DEFAULT_VOICE_SETTINGS.pushToTalk).toBe(false);
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings()).toMatchObject({ pushToTalk: false, pushToTalkKey: null });
    });

    it('push-to-mute is off (unbound) by default and a saved key loads', () => {
        expect(DEFAULT_VOICE_SETTINGS.pushToMuteKey).toBeNull();
        save({ pushToMuteKey: 'f13' });
        expect(loadVoiceSettings().pushToMuteKey).toBe('f13');
        secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY);
        expect(loadVoiceSettings().pushToMuteKey).toBeNull();
    });

    it('a saved key always wins, Alt (chosen deliberately) included', () => {
        save({ pushToTalk: true, pushToTalkKey: 'ctrl+shift+v' });
        expect(loadVoiceSettings().pushToTalkKey).toBe('ctrl+shift+v');
        save({ pushToTalk: true, pushToTalkKey: 'alt' });
        expect(loadVoiceSettings().pushToTalkKey).toBe('alt');
    });

    it('PTT on with no key stays unbound (it no longer loads as Alt)', () => {
        save({ pushToTalk: true, pushToTalkKey: null });
        expect(loadVoiceSettings()).toMatchObject({ pushToTalk: true, pushToTalkKey: null });
        save({ pushToTalk: true, pushToTalkKey: '' });
        expect(loadVoiceSettings()).toMatchObject({ pushToTalk: true, pushToTalkKey: null });
        save({ pushToTalk: true });
        expect(loadVoiceSettings().pushToTalkKey).toBeNull();
    });
});
