/**
 * notificationSounds — renderer-side audio playback for notification events.
 *
 * One persistent HTMLAudioElement is kept per category so concurrent arrivals
 * don't spawn dozens of parallel Audio instances. Each play() call restarts
 * the element from the start (natural behaviour for short alert sounds).
 *
 * Custom sounds are referenced by absolute file:// path supplied from the
 * notification prefs; bundled defaults are served by Vite's static server.
 *
 * ── Cues follow the call's output device ────────────────────────────────────
 *
 * Every element created here is registered with audioOutput, so it plays out
 * of the speaker the user picked rather than the system default.
 *
 * This is load-bearing, not a nicety. Remote call audio is played through Web
 * Audio, and the device it actually comes out of is the shared playback
 * AudioContext's sink (useParticipantAudio registers that context; see
 * audioOutput.ts's header). While nothing was setting that context's sink,
 * BOTH the voices and these cues came out of the system default — different
 * code paths, same device, so nothing looked wrong. Once the voices correctly
 * followed the user's chosen output device, these `new Audio()` elements were
 * the only thing left behind on the default: someone sitting in a call on a
 * headset heard every voice in the headset and every join/leave cue on
 * speakers they weren't wearing, i.e. not at all.
 *
 * Registering also covers later changes — onOutputDeviceChange() walks the
 * same registry, so switching devices mid-call re-points the cues along with
 * everything else.
 *
 * The same reasoning is why the settings "Test" preview lives here (see
 * previewSound) instead of being hand-rolled at the call site: a preview that
 * plays into a device the user isn't listening to reads as a broken sound
 * file, on the very page they opened to check that file.
 */
import { applyOutputDevice, unregisterOutputDeviceTarget } from './audioOutput';

export type SoundCategory =
    | 'message' | 'mention' | 'call' | 'join' | 'leave'
    | 'mute' | 'unmute' | 'deafen' | 'undeafen'
    | 'camera_on' | 'camera_off'
    // Added when three shipped sounds turned out to bypass this module
    // entirely via raw `new Audio()`: the outgoing ringback ignored
    // sounds_enabled outright (a fully muted user still got a 15s loop), and
    // the screenshare cues honoured the mute but not master_volume, so they
    // played at 100% no matter where the slider sat.
    | 'ringing' | 'screenshare_on' | 'screenshare_off'
    // Celebrations had no sound at all — confetti fell in silence.
    | 'celebration'
    // Keys being poked on the home deck — accompanies the visible reaction,
    // never IS the payoff (rule 12). Fires often, so it defaults quiet.
    | 'mascot'
    // Someone asked to draw on a video or screen you are sharing. The only
    // annotation event that needs a sound: a streamer is by definition looking
    // at the thing they are presenting, not at a dock, and the ask expires
    // unanswered after 60s. Rate-limited by construction — the store only
    // queues (and so only rings for) a person who is not already asking, not
    // already granted, and not inside their decline cooldown.
    | 'annotation_request'
    // Round two of the sound set. Social and housekeeping events that were
    // silent: a friend request arriving, it being accepted, a call ending
    // without you being the one who left, an invite landing, a message
    // pinned. All five are 'app' group (collapsed prefs) — none of them is
    // something a user tunes on its own.
    | 'friend_request' | 'friend_accepted' | 'call_ended' | 'invite' | 'pinned'
    // Someone pressed (or left) "Watch" on a screenshare YOU are publishing.
    // Fires for the streamer only — never for the viewer who clicked, and
    // never for the other people already watching. See
    // utils/screenShareViewers.ts for how the viewer set is derived and why
    // the first couple of seconds of a share are deliberately silent.
    | 'stream_viewer_join' | 'stream_viewer_leave';

export interface SoundCategoryPrefs {
    enabled: boolean;
    volume: number;   // 0..1
    file: string;     // e.g. './sounds/notification.wav' or absolute path
}

// ── Sound groups ─────────────────────────────────────────────────────────────
//
// Settings used to show one enable + file + volume row per category. Seventeen
// categories in, that page was a wall of sliders for things nobody tunes
// individually ("You unmute your mic", "Someone stops sharing"), which buried
// the five people actually care about.
//
// So categories are now grouped. 'primary' categories keep their own row;
// everything else collapses into ONE "App sounds" row with a single enable and
// a single volume.
//
// The default is deliberately 'app', and the override map below is deliberately
// PARTIAL rather than a total Record<SoundCategory, SoundGroup>. A total record
// would make every newly added category a compile error here, which sounds like
// a safety net but in practice just means whoever adds a category has to pick a
// group while thinking about something else. Defaulting to 'app' means a new
// cue joins the collapsed group silently and correctly — the overwhelmingly
// common case — and a category that genuinely deserves its own row opts in by
// adding one line.

export type SoundGroup = 'primary' | 'app';

/** The only group with collapsed, shared prefs. 'primary' has none — those
 *  categories are driven by their own per-category prefs, as before. */
export type CollapsedSoundGroup = 'app';

/**
 * Categories that earn their own settings row. Everything absent from this map
 * belongs to 'app' — see the note above; do NOT convert this to a total record.
 */
export const SOUND_GROUP_OVERRIDES: Partial<Record<SoundCategory, SoundGroup>> = {
    call:    'primary',   // incoming call
    ringing: 'primary',   // outgoing ringback
    message: 'primary',
    mention: 'primary',
    // Its own row rather than the collapsed 'app' family: this is a request
    // from another person that expires unanswered in 60s while the streamer is
    // by definition looking at what they're presenting, not at the dock. A cue
    // that carries a deadline has to be independently noticeable AND
    // independently silenceable — burying it under one shared "App sounds"
    // toggle would mean muting the app's chatter also mutes a person waiting
    // on you.
    annotation_request: 'primary',
};

export const DEFAULT_SOUND_GROUP: SoundGroup = 'app';

/** Which group a category belongs to. Accepts a plain string so persisted
 *  prefs from a future/rolled-back version can be classified without a cast. */
export function soundGroupOf(category: string): SoundGroup {
    return SOUND_GROUP_OVERRIDES[category as SoundCategory] ?? DEFAULT_SOUND_GROUP;
}

/** Every category that the "App sounds" row drives, in declaration order. */
export function categoriesInGroup(group: SoundGroup): SoundCategory[] {
    return (Object.keys(DEFAULT_SOUNDS) as SoundCategory[]).filter(c => soundGroupOf(c) === group);
}

export interface SoundGroupPrefs {
    enabled: boolean;
    volume: number;   // 0..1 — a SCALAR over each member's own volume, see resolve()
}

export interface SoundsPrefs {
    sounds_enabled: boolean;
    master_volume: number;
    sounds: Record<SoundCategory, SoundCategoryPrefs>;
    /**
     * Optional so that every existing caller which hand-builds a SoundsPrefs
     * literal keeps compiling, and so a prefs blob written by a version that
     * predates groups resolves to "no group gating" rather than to silence.
     */
    sound_groups?: Record<CollapsedSoundGroup, SoundGroupPrefs>;
}

// Default bundled sound mapping
export const DEFAULT_SOUNDS: Record<SoundCategory, string> = {
    message:      './sounds/notification.wav',
    mention:      './sounds/mention.wav',
    call:         './sounds/call_sound.wav',
    join:         './sounds/join_call_sound.wav',
    leave:        './sounds/leave_call.wav',
    mute:         './sounds/mute.wav',
    unmute:       './sounds/unmute.wav',
    deafen:       './sounds/deafen.wav',
    undeafen:     './sounds/undeafen.wav',
    camera_on:    './sounds/camera_on.wav',
    camera_off:   './sounds/camera_off.wav',
    ringing:          './sounds/ringing.wav',
    screenshare_on:   './sounds/screenshare_started.wav',
    screenshare_off:  './sounds/screenshare_ended.wav',
    celebration:      './sounds/success.wav',
    mascot:           './sounds/blub.wav',
    // subtle.wav is bundled and was used by nothing — a short, soft two-tone
    // knock, distinct from every cue above and from the OS default, which is
    // exactly what "someone is politely waiting on you" should sound like.
    annotation_request: './sounds/subtle.wav',
    friend_request:   './sounds/friend_request.wav',
    friend_accepted:  './sounds/friend_accepted.wav',
    call_ended:       './sounds/call_ended.wav',
    invite:           './sounds/invite.wav',
    pinned:           './sounds/pinned.wav',
    // "Pip" — a bespoke pair, chosen from four candidates. One tone bending
    // up (join) or down (leave) over a touch of low body; 300 ms, the
    // shortest cue in the set.
    //
    // Two properties were selected FOR, and both matter if these are ever
    // retuned:
    //   - Lowest energy above 4 kHz of the candidates (~3%), so it does not
    //     compete with speech while the streamer is mid-sentence.
    //   - The rise/fall is the whole signal. Everything else about the two
    //     files is identical, so "someone is watching" and "someone left" are
    //     told apart by direction alone and need no learning.
    // Deliberately NOT join_call_sound/leave_call: those fire in the same room
    // at the same moments, and a streamer cannot be asked to tell "someone
    // joined the call" from "someone started watching you" when both play the
    // identical sample.
    stream_viewer_join:  './sounds/stream_viewer_join.wav',
    stream_viewer_leave: './sounds/stream_viewer_leave.wav',
};

// ── Default per-category enable/volume ──────────────────────────────────────
//
// The other half of NotificationContext's DEFAULT_PREFS.sounds entries
// (`{ enabled, volume, file }`) — paired with DEFAULT_SOUNDS above by
// buildDefaultSoundCategoryPrefs() so the seventeen file paths above are typed
// in exactly once. Before this, NotificationContext.tsx hand-duplicated every
// path a second time; the two lists could (and did, in effect) drift.
//
// The volumes follow a deliberate "frequency of use sets loudness" ladder:
// 1.0 for the attention cues (message/mention/call), 0.7 for peer actions
// (join/leave/ringing/screenshare — things a call participant does), 0.55 for
// self toggles (mute/unmute/deafen/undeafen/camera — the user's own frequent
// fiddling), 0.6 for celebration (rare, but shouldn't startle), and 0.35 for
// mascot (the single most frequent cue in the app, so it sits at the very
// bottom).
//
// A total Record<SoundCategory, ...> literal, not an Object.keys loop typed
// as string — so, like DEFAULT_SOUNDS above, a new SoundCategory with no
// entry here is a compile error rather than a silent runtime gap.
export const DEFAULT_SOUND_PREFS: Record<SoundCategory, { enabled: boolean; volume: number }> = {
    message: { enabled: true, volume: 1.0 },
    mention: { enabled: true, volume: 1.0 },
    call:    { enabled: true, volume: 1.0 },
    join:            { enabled: true, volume: 0.7 },
    leave:           { enabled: true, volume: 0.7 },
    // These three shipped for a long time as raw `new Audio()` calls that
    // never reached this module, so they had no entry here and played at
    // full volume regardless of the master slider. Same peer-action tier as
    // join/leave, so same 0.7.
    ringing:         { enabled: true, volume: 0.7 },
    screenshare_on:  { enabled: true, volume: 0.7 },
    screenshare_off: { enabled: true, volume: 0.7 },
    // Mic/camera toggles fire often, so they default quieter than the
    // attention-grabbing categories above — see the sound design doc's
    // "frequency of use sets loudness" rule.
    mute:       { enabled: true, volume: 0.55 },
    unmute:     { enabled: true, volume: 0.55 },
    deafen:     { enabled: true, volume: 0.55 },
    undeafen:   { enabled: true, volume: 0.55 },
    camera_on:  { enabled: true, volume: 0.55 },
    camera_off: { enabled: true, volume: 0.55 },
    // Rarest of all (once per account for most of them) — but a celebration
    // that startles isn't a celebration, so it sits below the
    // attention-grabbing tier rather than above it.
    celebration: { enabled: true, volume: 0.6 },
    // The most frequent cue in the app when someone's playing with Keys —
    // sits at the very bottom of the loudness ladder (frequency sets
    // loudness, sound-design doc).
    mascot: { enabled: true, volume: 0.35 },
    // Someone is waiting on a decision that expires in 60s, and the streamer
    // is looking at their shared content rather than at Cipherline — so this
    // sits on the top rung of the ladder with the other attention cues
    // (message/mention/call), not with the ambient peer actions.
    annotation_request: { enabled: true, volume: 1.0 },
    // Someone reaching out to you, and that reach being returned. Rare, and
    // both are genuinely good news, so they sit with the attention cues
    // rather than the ambient ones.
    friend_request:  { enabled: true, volume: 0.9 },
    friend_accepted: { enabled: true, volume: 0.9 },
    // The line closing on you — the far end hung up, or nobody answered.
    // Peer-action tier, same as join/leave, because that is what it is.
    call_ended:      { enabled: true, volume: 0.7 },
    // A door opening. Rare and worth noticing.
    invite:          { enabled: true, volume: 0.9 },
    // Housekeeping, and it can fire while you are reading. Sits with the
    // self-toggle tier, well down the ladder.
    pinned:          { enabled: true, volume: 0.55 },
    // Peer-action tier (0.7), same as join/leave/screenshare: something
    // another person did, worth knowing about, not worth interrupting the
    // thing you are presenting. NOT the 1.0 attention tier — unlike an
    // annotation request there is no deadline and nothing to answer.
    stream_viewer_join:  { enabled: true, volume: 0.7 },
    stream_viewer_leave: { enabled: true, volume: 0.7 },
};

/**
 * Pairs DEFAULT_SOUND_PREFS with DEFAULT_SOUNDS into the complete
 * `{ enabled, volume, file }` shape NotificationContext's DEFAULT_PREFS.sounds
 * needs. The only place the two maps are joined, so adding a category is:
 * (1) add it to the SoundCategory union above, (2) add its file to
 * DEFAULT_SOUNDS and its enabled/volume to DEFAULT_SOUND_PREFS (both right
 * here) — NotificationContext.tsx needs no further edit, it derives.
 */
export function buildDefaultSoundCategoryPrefs(): Record<SoundCategory, SoundCategoryPrefs> {
    const out = {} as Record<SoundCategory, SoundCategoryPrefs>;
    for (const category of Object.keys(DEFAULT_SOUND_PREFS) as SoundCategory[]) {
        out[category] = { ...DEFAULT_SOUND_PREFS[category], file: DEFAULT_SOUNDS[category] };
    }
    return out;
}

const elements: Partial<Record<SoundCategory, HTMLAudioElement>> = {};

function getOrCreate(category: SoundCategory): HTMLAudioElement {
    if (!elements[category]) {
        const el = new Audio();
        // Route to the chosen speaker at birth, and stay in the registry so
        // later device changes re-point it. These elements are permanent (one
        // per category, reused for the life of the renderer), so there is no
        // teardown path to unregister from.
        applyOutputDevice(el);
        elements[category] = el;
    }
    return elements[category]!;
}

/**
 * Resolve a category to the file and volume it should actually play at, or
 * null when it must stay silent. Every playback path goes through this —
 * that's the whole point of the module, and three call sites had grown their
 * own `new Audio()` around it.
 *
 * Three gates, all AND-ed: the master `sounds_enabled`, the group's enable
 * (grouped categories only), and the category's own enable. The group is a
 * gate on top of the category rather than a replacement for it, which is what
 * makes the migration lossless — a user who had muted `join` individually
 * before the group row existed stays muted rather than being un-muted by a
 * group that defaults to on.
 *
 * Volume works the same way: the group volume is a SCALAR over the category's
 * own volume, not a substitute for it. That keeps the deliberate loudness
 * ladder (mascot 0.35 < mute 0.55 < join 0.7) intact under one slider, and it
 * makes the group's 1.0 default byte-for-byte identical to the pre-group
 * behaviour, so nobody's cues change volume on upgrade.
 */
function resolve(category: SoundCategory, prefs?: SoundsPrefs | null): { file: string; vol: number } | null {
    if (prefs && !prefs.sounds_enabled) return null;

    const group = soundGroupOf(category);
    // 'primary' has no collapsed prefs — indexing with it would be undefined
    // anyway, but the guard keeps the intent readable.
    const grp = group === 'primary' ? undefined : prefs?.sound_groups?.[group];
    if (grp && !grp.enabled) return null;

    const cat = prefs?.sounds[category];
    if (cat && !cat.enabled) return null;

    const file  = cat?.file  ?? DEFAULT_SOUNDS[category];
    const catVol = cat?.volume ?? 1.0;
    const groupVol = grp?.volume ?? 1.0;
    const masterVol = prefs?.master_volume ?? 0.8;
    const vol = Math.min(1, Math.max(0, catVol * groupVol * masterVol));

    return vol === 0 ? null : { file, vol };
}

/**
 * Play the sound for `category`, respecting the user's prefs.
 * If `prefs` is null/undefined, uses a default low-volume play for safety.
 */
export function playSound(category: SoundCategory, prefs?: SoundsPrefs | null): void {
    const r = resolve(category, prefs);
    if (!r) return;

    const el = getOrCreate(category);
    try {
        el.src    = r.file;
        el.volume = r.vol;
        el.currentTime = 0;
        el.play().catch(() => { /* ignore — user gesture or no audio device */ });
    } catch { /* ignore */ }
}

/**
 * One-shot audition of an arbitrary sound file at an explicit volume, for the
 * "Test" buttons on the notification settings page. Unlike playSound this is
 * deliberately NOT keyed by category and does NOT consult prefs: the custom-
 * sound list previews files that aren't assigned to any category yet, and the
 * point of the button is to hear the file, not to rehearse whether the app
 * would currently choose to play it.
 *
 * ONE reused element, like the per-category ones above and unlike
 * playLoopingSound's per-play element:
 *
 *  - It makes "a new preview replaces the running one" fall out for free —
 *    clicking Test on a second sound cuts the first off, which is what the
 *    button means. playLoopingSound needs a fresh element for the opposite
 *    reason (a 15s ringback must NOT be cut short by an unrelated one-shot),
 *    so its lifecycle doesn't transfer here.
 *  - It stays registered with audioOutput for the life of the renderer, so
 *    there is no unregister and nothing to leak — a per-click element would
 *    have to be unregistered on `ended`, and any play that never reaches
 *    `ended` (autoplay gate, missing device, deleted file) would strand a dead
 *    reference in the routing registry, growing it one entry per click.
 */
export function previewSound(file: string, volume: number): void {
    if (!file) return;
    const el = getOrCreatePreview();
    try {
        el.src = file;
        el.volume = Math.min(1, Math.max(0, volume));
        el.currentTime = 0; // same file twice in a row wouldn't restart otherwise
        el.play().catch(() => { /* ignore — autoplay gate, no device, missing file */ });
    } catch { /* ignore */ }
}

let previewEl: HTMLAudioElement | undefined;

function getOrCreatePreview(): HTMLAudioElement {
    if (!previewEl) {
        previewEl = new Audio();
        applyOutputDevice(previewEl);
    }
    return previewEl;
}

/**
 * Start a looping sound (the outgoing ringback is the only one) and return a
 * stop function. Uses a dedicated element rather than the shared per-category
 * one so a long loop can't be cut short by an unrelated one-shot of the same
 * category, and so stopping is unambiguous.
 *
 * Returns a no-op stopper when the sound is suppressed, so callers can always
 * call the result unconditionally in an effect cleanup.
 */
export function playLoopingSound(category: SoundCategory, prefs?: SoundsPrefs | null): () => void {
    const r = resolve(category, prefs);
    if (!r) return () => { /* suppressed — nothing to stop */ };

    let el: HTMLAudioElement;
    try {
        el = new Audio(r.file);
        el.loop = true;
        el.volume = r.vol;
        // Same reason as getOrCreate: the ringback has to come out of the
        // headset the call is on. Unlike the per-category elements this one is
        // per-play, so the stopper below unregisters it — otherwise every
        // outgoing call would leak a dead element into the routing registry.
        applyOutputDevice(el);
        el.play().catch(() => { /* autoplay gate or no audio device */ });
    } catch {
        return () => { /* couldn't start — nothing to stop */ };
    }

    return () => {
        try {
            el.pause();
            el.currentTime = 0;
            el.loop = false;
        } catch { /* ignore */ } finally {
            unregisterOutputDeviceTarget(el);
        }
    };
}
