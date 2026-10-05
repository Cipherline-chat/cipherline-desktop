import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same stand-in as audioOutput.test.ts: secureLocalStore is a synchronous
// facade over AES-GCM IndexedDB hydrated at boot, and unhydrated every read
// returns null — which would make getOutputDevice() always '' and quietly
// vacate every assertion below.
vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import type { SoundsPrefs, SoundCategory } from './notificationSounds';

/**
 * The regression these cover: call audio is played through Web Audio and comes
 * out of the shared playback AudioContext's sink, which follows the user's
 * chosen output device. The cue sounds in notificationSounds are plain
 * `new Audio()` elements. While nothing set the context's sink, both landed on
 * the system default and the split was invisible; once the voices correctly
 * followed the chosen device, the cues were left behind on the default —
 * someone in a call on a headset heard the voices and none of the join/leave
 * cues.
 *
 * Every `setSinkId` expectation below fails without the applyOutputDevice()
 * registration in notificationSounds.
 */

// Node environment: no DOM, no HTMLAudioElement. Record what the module builds.
interface FakeAudio {
    src: string;
    volume: number;
    currentTime: number;
    loop: boolean;
    setSinkId: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
}

let built: FakeAudio[] = [];
let sounds: typeof import('./notificationSounds');
let audioOutput: typeof import('./audioOutput');

/**
 * notificationSounds keeps ONE element per category in a module-level cache,
 * and audioOutput keeps module-level registries. Both have to be rebuilt per
 * case or the second test inherits the first test's elements and asserts
 * nothing.
 */
beforeEach(async () => {
    built = [];
    class MockAudio implements FakeAudio {
        src = '';
        volume = 1;
        currentTime = 0;
        loop = false;
        setSinkId = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
        play = vi.fn(() => Promise.resolve());
        pause = vi.fn();
        constructor(src?: string) {
            if (src) this.src = src;
            built.push(this);
        }
    }
    (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;

    vi.resetModules();
    audioOutput = await import('./audioOutput');
    sounds = await import('./notificationSounds');
    // The mocked secureLocalStore outlives resetModules, so the device a
    // previous case picked would still be persisted here and every "no device
    // chosen" assertion would be testing the wrong starting state.
    audioOutput.onOutputDeviceChange('');
});

const prefs = (over: Partial<SoundsPrefs> = {}): SoundsPrefs => ({
    sounds_enabled: true,
    master_volume: 1,
    sounds: Object.fromEntries(
        (Object.keys(sounds.DEFAULT_SOUNDS) as SoundCategory[])
            .map(c => [c, { enabled: true, volume: 1, file: sounds.DEFAULT_SOUNDS[c] }]),
    ) as SoundsPrefs['sounds'],
    ...over,
});

describe('notificationSounds output-device routing', () => {
    it('plays a cue on the chosen output device, not the system default', () => {
        audioOutput.onOutputDeviceChange('headset-1');

        sounds.playSound('join', prefs());

        // The element the cue actually plays through must be pointed at the
        // same physical device the call audio is on.
        expect(built).toHaveLength(1);
        expect(built[0].setSinkId).toHaveBeenCalledWith('headset-1');
        expect(built[0].play).toHaveBeenCalled();
    });

    it('re-points an already-created cue element when the device changes mid-call', () => {
        // First cue of the session creates the per-category element while the
        // user is still on the default.
        sounds.playSound('leave', prefs());
        expect(built).toHaveLength(1);
        const el = built[0];
        expect(el.setSinkId).not.toHaveBeenCalled();

        // User switches to their headset while sitting in the call.
        audioOutput.onOutputDeviceChange('headset-1');

        expect(el.setSinkId).toHaveBeenCalledWith('headset-1');
    });

    it('keeps reusing the same element per category, still routed', () => {
        audioOutput.onOutputDeviceChange('headset-1');

        sounds.playSound('join', prefs());
        sounds.playSound('join', prefs());

        // One persistent element per category — the second play must not
        // create an unregistered element that escapes routing.
        expect(built).toHaveLength(1);
        expect(built[0].play).toHaveBeenCalledTimes(2);
        expect(built[0].setSinkId).toHaveBeenCalledWith('headset-1');
    });

    it('routes each category independently', () => {
        audioOutput.onOutputDeviceChange('headset-1');

        sounds.playSound('join', prefs());
        sounds.playSound('leave', prefs());

        expect(built).toHaveLength(2);
        for (const el of built) {
            expect(el.setSinkId).toHaveBeenCalledWith('headset-1');
        }
    });

    it('routes the looping ringback and unregisters it when stopped', () => {
        audioOutput.onOutputDeviceChange('headset-1');

        const stop = sounds.playLoopingSound('ringing', prefs());
        expect(built).toHaveLength(1);
        const el = built[0];
        expect(el.setSinkId).toHaveBeenCalledWith('headset-1');
        expect(el.loop).toBe(true);

        stop();
        el.setSinkId.mockClear();

        // Stopped elements must leave the registry, or every outgoing call
        // leaks a dead element that later device changes keep re-pointing.
        audioOutput.onOutputDeviceChange('headset-2');
        expect(el.setSinkId).not.toHaveBeenCalled();
    });

    it('creates no element at all when the cue is suppressed by prefs', () => {
        audioOutput.onOutputDeviceChange('headset-1');

        sounds.playSound('join', prefs({ sounds_enabled: false }));

        // Suppression must short-circuit before the element is built, so a
        // muted user never registers anything.
        expect(built).toHaveLength(0);
    });

    it('still plays on the system default when no device has been chosen', () => {
        sounds.playSound('join', prefs());

        expect(built).toHaveLength(1);
        // '' means "follow the system default", which a fresh element already
        // does — pushing it would be a pointless sink call.
        expect(built[0].setSinkId).not.toHaveBeenCalled();
        expect(built[0].play).toHaveBeenCalled();
    });
});

/**
 * The sibling regression, on the same wiring: the custom-sound "Test" button
 * on the notification settings page built a bare `new Audio(c.file)`. Nothing
 * bare follows the output device chosen in Voice & Video settings — only
 * elements registered with audioOutput do — so previewing a sound while
 * wearing a headset played it out of the system default speakers. The user
 * hears nothing and concludes the sound FILE is broken, on the very page they
 * opened to check it.
 *
 * Deliberately NOT mocking ./audioOutput: the whole defect is the wiring
 * between these two modules, so the assertions are on setSinkId actually
 * reaching the preview element.
 */
describe('previewSound', () => {
    it('routes the preview to the chosen output device', () => {
        audioOutput.onOutputDeviceChange('headset-1');

        sounds.previewSound('file:///sounds/custom.wav', 0.8);

        // Without applyOutputDevice this element is never registered and
        // setSinkId is never called — it plays on the system default.
        expect(built).toHaveLength(1);
        expect(built[0].setSinkId).toHaveBeenCalledWith('headset-1');
        expect(built[0].src).toBe('file:///sounds/custom.wav');
        expect(built[0].volume).toBe(0.8);
        expect(built[0].play).toHaveBeenCalled();
    });

    it('re-routes an existing preview element when the device changes later', () => {
        sounds.previewSound('file:///sounds/custom.wav', 1); // created on the default
        expect(built[0].setSinkId).not.toHaveBeenCalled();

        audioOutput.onOutputDeviceChange('headset-1');

        // Proves the element stayed in the registry rather than being a
        // fire-and-forget one-off.
        expect(built[0].setSinkId).toHaveBeenCalledWith('headset-1');
    });

    it('reuses one element so a new preview replaces the running one', () => {
        sounds.previewSound('file:///sounds/a.wav', 0.5);
        sounds.previewSound('file:///sounds/b.wav', 0.5);
        sounds.previewSound('file:///sounds/a.wav', 0.5);

        // A per-click element would be 3 here, and would grow the routing
        // registry by one stranded reference per click.
        expect(built).toHaveLength(1);
        expect(built[0].src).toBe('file:///sounds/a.wav');
        expect(built[0].play).toHaveBeenCalledTimes(3);
    });

    it('restarts the same file rather than no-op-ing on an unchanged src', () => {
        sounds.previewSound('file:///sounds/a.wav', 1);
        built[0].currentTime = 1.4; // pretend it played partway

        sounds.previewSound('file:///sounds/a.wav', 1);

        // Assigning an identical src does not reload; currentTime = 0 is what
        // makes the second click audibly restart the sound.
        expect(built[0].currentTime).toBe(0);
    });

    it('clamps volume to the range HTMLMediaElement accepts', () => {
        sounds.previewSound('file:///sounds/a.wav', 4);
        expect(built[0].volume).toBe(1);

        sounds.previewSound('file:///sounds/a.wav', -2);
        expect(built[0].volume).toBe(0);
    });

    it('ignores an empty file instead of constructing an element for it', () => {
        sounds.previewSound('', 1);
        expect(built).toHaveLength(0);
    });

    it('swallows a rejected play() (autoplay gate, no device, deleted file)', async () => {
        sounds.previewSound('file:///sounds/a.wav', 1);
        built[0].play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));

        expect(() => sounds.previewSound('file:///sounds/gone.wav', 1)).not.toThrow();
        await Promise.resolve();
    });

    it('does not share an element with the per-category cues', () => {
        // The preview is not keyed by category and must not clobber (or be
        // clobbered by) a real cue's element — otherwise auditioning a file
        // would leave the wrong src on, say, the 'message' element.
        sounds.playSound('message', prefs());
        sounds.previewSound('file:///sounds/custom.wav', 1);

        expect(built).toHaveLength(2);
        expect(built[0].src).toBe(sounds.DEFAULT_SOUNDS.message);
        expect(built[1].src).toBe('file:///sounds/custom.wav');
    });
});

/**
 * Sound groups. The settings page collapsed a dozen cue rows into one "App
 * sounds" enable + volume; these cover the half of that which lives at
 * playback, where getting it wrong means either a silent app or a settings
 * toggle that does nothing.
 */
describe('sound groups', () => {
    const grouped = (over: Partial<SoundsPrefs> = {}): SoundsPrefs =>
        prefs({ sound_groups: { app: { enabled: true, volume: 1 } }, ...over });

    it('classifies the five attention cues as primary and everything else as app', () => {
        // annotation_request joined this list deliberately (see
        // SOUND_GROUP_OVERRIDES): it carries a 60s deadline set by another
        // person, so it has to be silenceable on its own rather than only
        // together with the app's ambient chatter.
        for (const cat of ['call', 'ringing', 'message', 'mention', 'annotation_request'] as SoundCategory[]) {
            expect(sounds.soundGroupOf(cat), cat).toBe('primary');
        }
        for (const cat of ['join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen',
            'camera_on', 'camera_off', 'screenshare_on', 'screenshare_off',
            'celebration', 'mascot'] as SoundCategory[]) {
            expect(sounds.soundGroupOf(cat), cat).toBe('app');
        }
    });

    it('a category nobody has classified falls into App sounds, not into limbo', () => {
        // The point of the PARTIAL override map: a category added later lands
        // somewhere sensible without anyone remembering to edit the grouping.
        // Belonging to no group would mean it ignores the only enable the
        // settings page still shows for it.
        //
        // These names are deliberately ones that are NOT in SoundCategory. This
        // test used to use 'annotation_request' as its hypothetical future cue;
        // that cue has since shipped AND been classified 'primary' on purpose,
        // which would have quietly turned this into an assertion about a real
        // category's real grouping rather than about the fallback.
        expect(sounds.soundGroupOf('some_future_cue')).toBe('app');
        expect(sounds.soundGroupOf('')).toBe('app');
    });

    it('categoriesInGroup covers every category exactly once across both groups', () => {
        const all = Object.keys(sounds.DEFAULT_SOUNDS).sort();
        const split = [...sounds.categoriesInGroup('primary'), ...sounds.categoriesInGroup('app')].sort();
        expect(split).toEqual(all);
    });

    it('the group enable silences its members', () => {
        sounds.playSound('join', grouped({ sound_groups: { app: { enabled: false, volume: 1 } } }));
        expect(built).toHaveLength(0);
    });

    it('the group enable does NOT silence primary categories', () => {
        sounds.playSound('message', grouped({ sound_groups: { app: { enabled: false, volume: 1 } } }));
        expect(built).toHaveLength(1);
    });

    it('the group volume scales a member rather than replacing its volume', () => {
        // The per-category ladder (mascot quieter than join) has to survive one
        // shared slider, so the group multiplies instead of overriding.
        const p = grouped({ sound_groups: { app: { enabled: true, volume: 0.5 } } });
        p.sounds.join.volume = 0.7;
        p.master_volume = 1;

        sounds.playSound('join', p);

        expect(built[0].volume).toBeCloseTo(0.7 * 0.5, 10);
    });

    it('a member muted individually stays muted even with the group on', () => {
        const p = grouped();
        p.sounds.join.enabled = false;
        sounds.playSound('join', p);
        expect(built).toHaveLength(0);
    });

    it('prefs with no sound_groups at all behave exactly as before groups existed', () => {
        // Legacy blobs, and any call site still handing over a partial
        // SoundsPrefs, must not be gated into silence by a missing field.
        const p = prefs();
        p.master_volume = 1;
        p.sounds.join.volume = 0.7;

        sounds.playSound('join', p);

        expect(built).toHaveLength(1);
        expect(built[0].volume).toBeCloseTo(0.7, 10);
    });

    it('the looping ringback is primary, so the App sounds group cannot mute it', () => {
        const stop = sounds.playLoopingSound('ringing', grouped({
            sound_groups: { app: { enabled: false, volume: 0 } },
        }));
        expect(built).toHaveLength(1);
        stop();
    });
});

/**
 * Every bundled cue must actually exist in `public/`.
 *
 * DEFAULT_SOUNDS is a map of strings, so nothing in the type system or in any
 * other test notices when a path is wrong — a typo, a renamed asset, or a
 * category pointed at a file that was never committed all produce the same
 * runtime symptom: `new Audio(src)` resolves, `play()` rejects with a media
 * error, and `playSound` swallows it by design (see its own catch, which is
 * there so a missing device can't break call audio). The cue is simply silent,
 * and silence is exactly what a disabled cue looks like.
 *
 * This is the only check that distinguishes the two.
 */
describe('bundled sound assets', () => {
    it('every DEFAULT_SOUNDS path resolves to a file in public/', async () => {
        const { existsSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const missing: string[] = [];
        for (const [cat, src] of Object.entries(sounds.DEFAULT_SOUNDS)) {
            // './sounds/x.wav' is a runtime URL relative to the app root, which
            // Vite serves out of public/. Strip the leading './' to get the
            // repo path.
            const file = resolve(__dirname, '../../public', src.replace(/^\.\//, ''));
            if (!existsSync(file)) missing.push(`${cat} -> ${src}`);
        }
        expect(missing).toEqual([]);
    });

    it('is a non-vacuous check — a made-up path is reported', async () => {
        // Positive control. Without this, a DEFAULT_SOUNDS that somehow came
        // back empty, or a path-resolution mistake that made every candidate
        // "exist", would leave the assertion above passing on nothing.
        const { existsSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        expect(Object.keys(sounds.DEFAULT_SOUNDS).length).toBeGreaterThan(10);
        expect(existsSync(resolve(__dirname, '../../public/sounds/definitely_not_a_real_cue.wav'))).toBe(false);
    });

    it('the stream-viewer cues are their own bespoke assets, not placeholders', () => {
        // These two shipped pointing at subtle.wav / blub.wav while the real
        // pair was being designed. Both of those are real cues used elsewhere,
        // so the placeholder state passed the existence check above — it needs
        // naming separately or it can quietly come back.
        expect(sounds.DEFAULT_SOUNDS.stream_viewer_join).toBe('./sounds/stream_viewer_join.wav');
        expect(sounds.DEFAULT_SOUNDS.stream_viewer_leave).toBe('./sounds/stream_viewer_leave.wav');
        expect(sounds.DEFAULT_SOUNDS.stream_viewer_join)
            .not.toBe(sounds.DEFAULT_SOUNDS.stream_viewer_leave);
    });
});
