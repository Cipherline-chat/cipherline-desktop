/**
 * Migration tests against the REAL DEFAULT_PREFS, using FROZEN snapshots of
 * what shipped versions actually wrote to disk.
 *
 * notificationPrefsMerge.test.ts covers the merge algebra with a small
 * stand-in fixture. This file covers the thing that stand-in can't: that the
 * real, whole prefs object still loads from a real, whole stored blob.
 *
 * Why it exists: a change to the prefs SHAPE has already shipped a crash. The
 * `sounds` record gained four categories, the hand-written merge wasn't
 * updated, and every account WITH saved prefs got `prefs.sounds.ringing ===
 * undefined` — which took the whole renderer down the moment the Notifications
 * settings page read `.enabled` off it. Fresh installs were fine (no stored
 * blob → pure defaults), which is exactly why it survived testing and reached
 * users as v1.0.12.
 *
 * So the blobs below are deliberately COPIES, not values derived from the
 * current code. A snapshot built from today's DEFAULT_PREFS would silently
 * follow every future shape change and prove nothing. These do not move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// NotificationContext → AuthContext → axios, which reads location.href at
// import time and dies in the node environment. Nothing here needs auth.
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ userId: null, isAuthenticated: false }),
}));
vi.mock('./secureLocalStore', () => ({
    default: { getItem: () => null, setItem: () => { /* noop */ }, removeItem: () => { /* noop */ } },
}));

import { mergeStoredPrefs, deriveSoundGroups } from './notificationPrefsMerge';
import type { SoundCategory } from './notificationSounds';

/**
 * v1.0.11-era blob: written BEFORE ringing / screenshare_on / screenshare_off /
 * celebration / mascot existed, and before sound_groups. This is the shape that
 * caused the crash.
 */
const PREFS_BLOB_V1_0_11 = {
    desktop_notifications_enabled: true,
    sounds_enabled: true,
    master_volume: 0.65,
    show_preview: 'full',
    quick_reply_enabled: true,
    keywords: ['standup'],
    dnd_manual: false,
    dnd_schedule: { enabled: true, start_minute: 1380, end_minute: 420, days: [1, 2, 3, 4, 5] },
    dnd_auto: {
        when_in_call: true,
        when_screensharing: true,
        when_in_game: false,
        when_status_dnd: true,
        when_status_away: false,
    },
    dnd_let_mentions_through: true,
    sounds: {
        message:    { enabled: true,  volume: 1.0,  file: './sounds/notification.wav' },
        mention:    { enabled: true,  volume: 1.0,  file: './sounds/mention.wav' },
        call:       { enabled: true,  volume: 1.0,  file: './sounds/call_sound.wav' },
        join:       { enabled: true,  volume: 0.7,  file: './sounds/join_call_sound.wav' },
        leave:      { enabled: true,  volume: 0.7,  file: './sounds/leave_call.wav' },
        mute:       { enabled: false, volume: 0.55, file: './sounds/mute.wav' },
        unmute:     { enabled: false, volume: 0.55, file: './sounds/unmute.wav' },
        deafen:     { enabled: true,  volume: 0.55, file: './sounds/deafen.wav' },
        undeafen:   { enabled: true,  volume: 0.55, file: './sounds/undeafen.wav' },
        camera_on:  { enabled: true,  volume: 0.55, file: './sounds/camera_on.wav' },
        camera_off: { enabled: true,  volume: 0.55, file: './sounds/camera_off.wav' },
    },
    custom_sounds: [],
    suppress_when_active_conv: true,
    suppress_when_window_focused: true,
    show_badge_count: true,
    flash_taskbar: false,
    badge_only_mentions: false,
    badge_includes_muted: false,
};

/**
 * v1.0.12-era blob: all sixteen categories, still no sound_groups, and the DND
 * defaults as they stood before 2026-09-06 — this user never opened the DND
 * section, so `when_in_call` / `dnd_let_mentions_through` are `true` only
 * because that's what the defaults were when some OTHER setting was saved.
 */
const PREFS_BLOB_V1_0_12 = {
    ...PREFS_BLOB_V1_0_11,
    sounds: {
        ...PREFS_BLOB_V1_0_11.sounds,
        ringing:         { enabled: true, volume: 0.7,  file: './sounds/ringing.wav' },
        screenshare_on:  { enabled: true, volume: 0.7,  file: './sounds/screenshare_started.wav' },
        screenshare_off: { enabled: true, volume: 0.7,  file: './sounds/screenshare_ended.wav' },
        celebration:     { enabled: true, volume: 0.6,  file: './sounds/success.wav' },
        mascot:          { enabled: true, volume: 0.35, file: './sounds/blub.wav' },
    },
};

/** What load() does: parse, merge over defaults, then migrate groups. */
async function loadFromBlob(blob: unknown) {
    const { DEFAULT_PREFS } = await import('../contexts/NotificationContext');
    const { soundGroupOf } = await import('./notificationSounds');
    // Round-trips through JSON exactly as secureLocalStore storage does.
    const parsed = JSON.parse(JSON.stringify(blob));
    return deriveSoundGroups(mergeStoredPrefs(DEFAULT_PREFS, parsed), parsed, soundGroupOf);
}

describe('loading prefs persisted by an older version', () => {
    for (const [label, blob] of [
        ['v1.0.11 (pre ringing/screenshare/celebration/mascot, pre groups)', PREFS_BLOB_V1_0_11],
        ['v1.0.12 (all categories, pre groups)', PREFS_BLOB_V1_0_12],
    ] as const) {
        describe(label, () => {
            it('produces a structurally complete prefs object', async () => {
                const { DEFAULT_PREFS } = await import('../contexts/NotificationContext');
                const prefs = await loadFromBlob(blob);

                // Every key the current shape has must be present and typed —
                // this is the assertion that would have caught the v1.0.12
                // renderer crash before it shipped.
                const asMap = prefs as unknown as Record<string, unknown>;
                for (const key of Object.keys(DEFAULT_PREFS)) {
                    expect(prefs, `missing ${key}`).toHaveProperty(key);
                    expect(asMap[key], key).not.toBeUndefined();
                }

                for (const cat of Object.keys(DEFAULT_PREFS.sounds) as SoundCategory[]) {
                    const s = prefs.sounds[cat];
                    expect(s, `sounds.${cat} missing`).toBeDefined();
                    expect(typeof s.enabled, `sounds.${cat}.enabled`).toBe('boolean');
                    expect(typeof s.volume,  `sounds.${cat}.volume`).toBe('number');
                    expect(typeof s.file,    `sounds.${cat}.file`).toBe('string');
                }

                for (const g of Object.keys(DEFAULT_PREFS.sound_groups) as (keyof typeof DEFAULT_PREFS.sound_groups)[]) {
                    expect(typeof prefs.sound_groups[g]?.enabled, `sound_groups.${g}.enabled`).toBe('boolean');
                    expect(typeof prefs.sound_groups[g]?.volume,  `sound_groups.${g}.volume`).toBe('number');
                }
            });

            it('keeps the values the user actually stored', async () => {
                const prefs = await loadFromBlob(blob);
                expect(prefs.master_volume).toBe(0.65);
                expect(prefs.keywords).toEqual(['standup']);
                expect(prefs.dnd_schedule).toEqual({
                    enabled: true, start_minute: 1380, end_minute: 420, days: [1, 2, 3, 4, 5],
                });
            });

            it('MIGRATION: a stored auto-DND value survives the default flipping to off', async () => {
                // The stored blob is a full snapshot — it holds an explicit
                // `true` for every field regardless of whether the user set it,
                // so "never touched" is indistinguishable from "chose the old
                // default". We resolve that ambiguity in favour of NOT changing
                // a live account's behaviour; only accounts with no stored blob
                // get the new defaults. See load()'s comment.
                const prefs = await loadFromBlob(blob);
                expect(prefs.dnd_auto.when_in_call).toBe(true);
                expect(prefs.dnd_let_mentions_through).toBe(true);
            });

            it('MIGRATION: the App sounds group is derived, and per-cue mutes are preserved', async () => {
                const prefs = await loadFromBlob(blob);
                // join/leave/deafen were on, so the group comes back on.
                expect(prefs.sound_groups.app.enabled).toBe(true);
                // Identity scalar — a migrated user's cues play at exactly the
                // volume they did before the group slider existed.
                expect(prefs.sound_groups.app.volume).toBe(1.0);
                // mute/unmute were individually off in the stored blob and stay
                // off; the group defaulting to on must not undo that.
                expect(prefs.sounds.mute.enabled).toBe(false);
                expect(prefs.sounds.unmute.enabled).toBe(false);
            });
        });
    }

    it('a user who had silenced every app cue does not get them all back', async () => {
        const silenced = {
            ...PREFS_BLOB_V1_0_12,
            sounds: Object.fromEntries(
                Object.entries(PREFS_BLOB_V1_0_12.sounds).map(([cat, s]) => [cat, { ...s, enabled: false }]),
            ),
        };
        const prefs = await loadFromBlob(silenced);
        expect(prefs.sound_groups.app.enabled).toBe(false);
    });

    it('...and a cue added AFTER they saved does not vote the group back on', async () => {
        // The stored blob enumerates the categories that existed when it was
        // written. Anything added since merges in at its own `enabled: true`
        // default, and if that counted toward the derivation, every future
        // category addition would silently un-mute everyone who had turned the
        // app cues off one by one. The derivation is about what the user was
        // HEARING, so only categories they actually stored get a vote.
        const silenced = {
            ...PREFS_BLOB_V1_0_12,
            sounds: Object.fromEntries(
                Object.entries(PREFS_BLOB_V1_0_12.sounds).map(([cat, s]) => [cat, { ...s, enabled: false }]),
            ),
        };
        const prefs = await loadFromBlob(silenced);
        // stream_viewer_join/leave (and any later addition) are in the app
        // group and default to enabled — they must not flip this.
        expect(prefs.sounds.stream_viewer_join.enabled).toBe(true);
        expect(prefs.sound_groups.app.enabled).toBe(false);
    });

    it('a blob with no sounds object at all still derives from every member', async () => {
        // Nothing to narrow by — fall back to the whole group rather than
        // deriving `false` from an empty intersection and silencing someone.
        const prefs = await loadFromBlob({ sounds_enabled: true });
        expect(prefs.sound_groups.app.enabled).toBe(true);
    });

    it('garbage on disk falls back rather than throwing', async () => {
        for (const junk of [null, 42, 'nope', [], { sounds: 'no' }, { dnd_auto: 7 }]) {
            await expect(loadFromBlob(junk)).resolves.toBeDefined();
        }
    });
});

describe('accounts with NO stored prefs get the new defaults', () => {
    it('auto-DND during calls, during games, and mentions-through are all off', async () => {
        const { DEFAULT_PREFS } = await import('../contexts/NotificationContext');
        // The three toggles changed on 2026-09-06. `when_in_game` was already
        // false and is asserted here so a well-meaning revert has to fail a
        // test rather than pass quietly.
        expect(DEFAULT_PREFS.dnd_auto.when_in_call).toBe(false);
        expect(DEFAULT_PREFS.dnd_auto.when_in_game).toBe(false);
        expect(DEFAULT_PREFS.dnd_let_mentions_through).toBe(false);
        // Unchanged on purpose: a toast on a shared screen leaks a private
        // message to everyone watching, and DND status is an explicit request.
        expect(DEFAULT_PREFS.dnd_auto.when_screensharing).toBe(true);
        expect(DEFAULT_PREFS.dnd_auto.when_status_dnd).toBe(true);
    });
});

/**
 * End-to-end on the thing the group could plausibly break: after migrating a
 * legacy blob, do the grouped cues still make a sound, at the same volume?
 */
describe('migrated prefs still play grouped cues audibly', () => {
    interface FakeAudio { src: string; volume: number; currentTime: number; loop: boolean }
    let built: FakeAudio[] = [];

    beforeEach(() => {
        built = [];
        class MockAudio {
            src = ''; volume = 1; currentTime = 0; loop = false;
            setSinkId = vi.fn(() => Promise.resolve());
            play = vi.fn(() => Promise.resolve());
            pause = vi.fn();
            constructor(src?: string) { if (src) this.src = src; built.push(this as unknown as FakeAudio); }
        }
        (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;
        vi.resetModules();
    });

    it('plays a grouped cue at exactly the pre-group volume', async () => {
        const prefs = await loadFromBlob(PREFS_BLOB_V1_0_12);
        const { playSound } = await import('./notificationSounds');

        playSound('join', prefs);

        expect(built).toHaveLength(1);
        // 0.7 (category) × 1.0 (group, the identity default) × 0.65 (master)
        expect(built[0].volume).toBeCloseTo(0.7 * 0.65, 10);
        expect(built[0].src).toBe('./sounds/join_call_sound.wav');
    });

    it('the group enable gates every member', async () => {
        const prefs = await loadFromBlob(PREFS_BLOB_V1_0_12);
        const { playSound } = await import('./notificationSounds');

        playSound('join', { ...prefs, sound_groups: { app: { enabled: false, volume: 1 } } });

        expect(built).toHaveLength(0);
    });

    it('the group volume scales members without touching the primary cues', async () => {
        const prefs = await loadFromBlob(PREFS_BLOB_V1_0_12);
        const { playSound } = await import('./notificationSounds');
        const halved = { ...prefs, sound_groups: { app: { enabled: true, volume: 0.5 } } };

        playSound('join', halved);      // grouped
        playSound('message', halved);   // primary — must be unaffected

        expect(built[0].volume).toBeCloseTo(0.7 * 0.5 * 0.65, 10);
        expect(built[1].volume).toBeCloseTo(1.0 * 0.65, 10);
    });
});
