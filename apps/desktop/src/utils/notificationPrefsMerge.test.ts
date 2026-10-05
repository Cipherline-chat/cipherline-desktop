import { describe, it, expect } from 'vitest';
import { mergeStoredPrefs, deriveSoundGroups } from './notificationPrefsMerge';

// Stand-in for DEFAULT_PREFS — includes a "newly added" category (`ringing`)
// the way the real defaults gained ringing/screenshare_on/screenshare_off/
// celebration after users had already saved prefs without them.
const defaults = {
    sounds_enabled: true,
    master_volume: 0.8,
    dnd_schedule: { enabled: false, days: [0, 1, 2] },
    dnd_auto: { when_in_call: true },
    sounds: {
        message: { enabled: true, volume: 1.0, file: './a.wav' },
        ringing: { enabled: true, volume: 0.7, file: './b.wav' },
        join:    { enabled: true, volume: 0.7, file: './c.wav' },
        mute:    { enabled: true, volume: 0.55, file: './d.wav' },
    },
    sound_groups: {
        app: { enabled: true, volume: 1.0 },
    },
};

// Stand-in for soundGroupOf: message/ringing get their own row, the rest
// collapse into 'app'. Mirrors the real default-to-'app' rule.
const groupOf = (cat: string) => (cat === 'message' || cat === 'ringing' ? 'primary' : 'app');

describe('mergeStoredPrefs', () => {
    it('REGRESSION: stored prefs predating a category still yield a complete sounds object', () => {
        // The laptop crash: saved prefs from before `ringing` existed. The old
        // hand-enumerated merge dropped it → prefs.sounds.ringing was
        // undefined → NotificationsTab crashed the renderer on open.
        const old = { sounds: { message: { enabled: false, volume: 0.5, file: './mine.wav' } } };
        const merged = mergeStoredPrefs(defaults, old);
        expect(merged.sounds.ringing).toEqual({ enabled: true, volume: 0.7, file: './b.wav' });
        expect(merged.sounds.message).toEqual({ enabled: false, volume: 0.5, file: './mine.wav' });
    });

    it('every default category survives regardless of stored shape', () => {
        for (const parsed of [undefined, null, {}, { sounds: null }, { sounds: {} }, 'garbage', 42]) {
            const merged = mergeStoredPrefs(defaults, parsed);
            expect(Object.keys(merged.sounds).sort()).toEqual(['join', 'message', 'mute', 'ringing']);
            for (const cat of Object.values(merged.sounds)) {
                expect(typeof cat.enabled).toBe('boolean');
                expect(typeof cat.volume).toBe('number');
                expect(typeof cat.file).toBe('string');
            }
        }
    });

    it('stored keys unknown to the defaults are dropped from sounds (no zombie categories)', () => {
        const merged = mergeStoredPrefs(defaults, {
            sounds: { removed_category: { enabled: true, volume: 1, file: './x.wav' } },
        });
        expect((merged.sounds as Record<string, unknown>).removed_category).toBeUndefined();
    });

    it('nested dnd objects merge per-key (new fields pick up defaults)', () => {
        const merged = mergeStoredPrefs(defaults, { dnd_schedule: { enabled: true } });
        expect(merged.dnd_schedule).toEqual({ enabled: true, days: [0, 1, 2] });
        expect(merged.dnd_auto).toEqual({ when_in_call: true });
    });

    it('top-level scalars from storage win over defaults', () => {
        const merged = mergeStoredPrefs(defaults, { master_volume: 0.2, sounds_enabled: false });
        expect(merged.master_volume).toBe(0.2);
        expect(merged.sounds_enabled).toBe(false);
    });

    it('sound_groups is completed from the defaults the same way sounds is', () => {
        // Same class of bug as the category crash: a blob written before a
        // group existed must not come back with `sound_groups.app` undefined,
        // or the settings page reads `.enabled` off it and takes the renderer.
        for (const parsed of [{}, { sound_groups: null }, { sound_groups: {} }, 'garbage']) {
            const merged = mergeStoredPrefs(defaults, parsed);
            expect(merged.sound_groups.app).toEqual({ enabled: true, volume: 1.0 });
        }
    });

    it('a stored group merges per-key rather than replacing the whole group', () => {
        const merged = mergeStoredPrefs(defaults, { sound_groups: { app: { volume: 0.25 } } });
        expect(merged.sound_groups.app).toEqual({ enabled: true, volume: 0.25 });
    });
});

describe('deriveSoundGroups', () => {
    const merge = (parsed: unknown) => deriveSoundGroups(mergeStoredPrefs(defaults, parsed), parsed, groupOf);

    it('a blob predating groups derives the group from what the user was hearing', () => {
        // Every app-group member was on, so the group comes back on and
        // nothing the user could hear before goes silent.
        const merged = merge({ sounds: { join: { enabled: true }, mute: { enabled: true } } });
        expect(merged.sound_groups.app.enabled).toBe(true);
    });

    it('a user who had muted every member individually stays muted', () => {
        const merged = merge({ sounds: { join: { enabled: false }, mute: { enabled: false } } });
        expect(merged.sound_groups.app.enabled).toBe(false);
    });

    it('any member still audible turns the group on, and the muted member STAYS muted', () => {
        const merged = merge({ sounds: { join: { enabled: true }, mute: { enabled: false } } });
        expect(merged.sound_groups.app.enabled).toBe(true);
        // The per-category flag is still AND-ed in at playback, so preserving
        // it is what keeps a deliberate single-cue mute from being undone by a
        // group that defaults to on.
        expect(merged.sounds.mute.enabled).toBe(false);
        expect(merged.sounds.join.enabled).toBe(true);
    });

    it('primary categories never influence the group', () => {
        // message/ringing are outside the group; muting them must not drag the
        // whole "App sounds" row off with them.
        const merged = merge({
            sounds: {
                message: { enabled: false }, ringing: { enabled: false },
                join: { enabled: true }, mute: { enabled: true },
            },
        });
        expect(merged.sound_groups.app.enabled).toBe(true);
    });

    it('an explicitly persisted group is left exactly alone', () => {
        // Once a version that knows about groups has written the field, the
        // value is the user's own choice — deriving over it would silently
        // re-enable a group they turned off.
        const merged = merge({
            sound_groups: { app: { enabled: false, volume: 0.4 } },
            sounds: { join: { enabled: true }, mute: { enabled: true } },
        });
        expect(merged.sound_groups.app).toEqual({ enabled: false, volume: 0.4 });
    });

    it('derivation never invents a volume — only the enable is inferred', () => {
        const merged = merge({ sounds: { join: { enabled: false }, mute: { enabled: false } } });
        expect(merged.sound_groups.app.volume).toBe(1.0);
    });

    it('survives junk in place of sound_groups without throwing', () => {
        for (const parsed of [undefined, null, 42, 'garbage', { sound_groups: 'nope' }, { sounds: null }]) {
            expect(() => merge(parsed)).not.toThrow();
            expect(typeof merge(parsed).sound_groups.app.enabled).toBe('boolean');
        }
    });
});
