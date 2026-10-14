/**
 * The Voice & Video "end the call for everyone when I leave" default is gone
 * (it is a Calls CHANNEL setting now). Settings saved by a build that still had
 * it must load without error, and the dead key must not be carried or re-saved.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/secureLocalStore', () => {
    const mem = new Map<string, string>();
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import secureLocalStore from '../utils/secureLocalStore';
import {
    DEFAULT_VOICE_SETTINGS, RETIRED_VOICE_SETTING_KEYS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings,
} from './useVoiceSettings';

describe('the retired endCallOnCreatorLeaveDefault key', () => {
    it('is not part of the defaults any more', () => {
        expect(Object.keys(DEFAULT_VOICE_SETTINGS)).not.toContain('endCallOnCreatorLeaveDefault');
        expect(RETIRED_VOICE_SETTING_KEYS).toContain('endCallOnCreatorLeaveDefault');
    });

    it('a saved blob that still has it (true or false) loads fine, keeps everything else, and drops the key', () => {
        for (const old of [true, false]) {
            secureLocalStore.setItem(
                VOICE_SETTINGS_STORAGE_KEY,
                JSON.stringify({ noiseSuppression: false, micVolume: 130, endCallOnCreatorLeaveDefault: old }),
            );
            const s = loadVoiceSettings() as unknown as Record<string, unknown>;
            expect(s.noiseSuppression).toBe(false);
            expect(s.micVolume).toBe(130);
            expect('endCallOnCreatorLeaveDefault' in s).toBe(false);
        }
    });

    it('negative control: an unrelated saved key is NOT dropped (the sweep is only for retired keys)', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ eqEnabled: true, endCallOnCreatorLeaveDefault: true }));
        const s = loadVoiceSettings() as unknown as Record<string, unknown>;
        expect(s.eqEnabled).toBe(true);
        expect('endCallOnCreatorLeaveDefault' in s).toBe(false);
    });

    it('a blob without it (every new install) is untouched', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ micVolume: 90 }));
        expect(loadVoiceSettings().micVolume).toBe(90);
    });
});
