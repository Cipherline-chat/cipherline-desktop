import secureLocalStore from './secureLocalStore';
import { AUDIO_DEVICE_PROFILES_KEY_PREFIX } from './audioDeviceProfiles';

/**
 * One-time move of every existing user to the new voice defaults (owner
 * decision 2026-10-26): Light noise suppression, echo cancellation off.
 *
 * New installs already start there (DEFAULT_VOICE_SETTINGS), but the voice
 * settings blob is written on first mount, so nearly every existing user had
 * the OLD defaults (Strong, echo on) saved and could not be told apart from
 * someone who chose them. The owner chose to switch everyone once; anyone who
 * wants Strong / echo back picks it again and it sticks (the marker stops this
 * from ever running twice on this device).
 *
 * Covers the global settings blob AND every remembered per-device input
 * profile (audioDeviceProfiles), which would otherwise re-apply the old values
 * the next time that microphone is selected.
 */
export const VOICE_DEFAULTS_MIGRATION_KEY = 'cipherline_voice_defaults_migrated_v1';
export const VOICE_SETTINGS_KEY_FOR_MIGRATION = 'cipherline_voice_settings';

type Store = Pick<typeof secureLocalStore, 'getItem' | 'setItem' | 'keysWithPrefix'>;

function rewrite(store: Store, key: string, fn: (v: Record<string, unknown>) => boolean): void {
    const raw = store.getItem(key);
    if (!raw) return;
    try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object' && fn(v)) store.setItem(key, JSON.stringify(v));
    } catch { /* unreadable record: leave it */ }
}

const applyNew = (s: Record<string, unknown>): boolean => {
    s.noiseSuppressionMode = 'light';
    s.echoCancellation = false;
    return true;
};

export function migrateVoiceDefaults(store: Store = secureLocalStore): void {
    try {
        if (store.getItem(VOICE_DEFAULTS_MIGRATION_KEY) === '1') return;
        rewrite(store, VOICE_SETTINGS_KEY_FOR_MIGRATION, applyNew);
        for (const key of store.keysWithPrefix(AUDIO_DEVICE_PROFILES_KEY_PREFIX)) {
            rewrite(store, key, (profiles) => {
                const input = profiles.input as Record<string, { settings?: Record<string, unknown> }> | undefined;
                if (!input || typeof input !== 'object') return false;
                for (const p of Object.values(input)) if (p?.settings && typeof p.settings === 'object') applyNew(p.settings);
                return true;
            });
        }
        store.setItem(VOICE_DEFAULTS_MIGRATION_KEY, '1');
    } catch { /* store not ready / locked: retried on the next load */ }
}
