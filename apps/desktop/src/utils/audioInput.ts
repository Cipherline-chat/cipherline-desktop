import { findStoredDevice, type DeviceHint } from './deviceResolve';

/**
 * Microphone capture — the single source of truth for HOW we open the mic and
 * WHICH device we open. Counterpart to audioOutput.ts (speaker/sink routing).
 *
 * Why this file exists: the mic settings were previously spelled out separately
 * in CallPane (the real call), VoiceVideoSettings (the settings-page level
 * meter) and implicitly again inside LiveKit's own track-restart paths. They had
 * already drifted (the settings meter ran with echoCancellation ON while calls
 * ran with it OFF), so the level you tuned your gate threshold against wasn't
 * the level you actually transmitted. Anything that opens a mic should go
 * through here: `micCaptureConstraints(echoCancellation)` is the one function
 * that decides every capture flag, so no site can disagree with another.
 */

/**
 * Chromium synthesises an `audioinput` entry with this exact id that FOLLOWS the
 * OS default device. It is NOT the same thing as "no deviceId constraint":
 *
 *   - omitting deviceId  → Chromium resolves the default ONCE, at capture time,
 *                          and the track stays bound to that physical device
 *                          even after the OS default changes.
 *   - deviceId 'default' → opens the current default. NOTE: an already-open
 *                          track does NOT follow a later OS default change
 *                          either (reported on Windows 11, 1.0.20) — following
 *                          it takes a fresh getUserMedia, which is what
 *                          micDeviceSync.ts does on devicechange.
 *
 * We persist '' in settings to mean "follow the system default" (a stable value
 * for the <select>), and resolve it to this id at every capture site.
 * livekit-client normalises a missing deviceId to this same string internally
 * (createLocalTracks → `internalOptions.audio.deviceId || 'default'`), so being
 * explicit keeps our idea of the active device and LiveKit's in agreement —
 * which matters because we compare against it when deciding whether a device
 * switch is actually needed.
 */
export const DEFAULT_AUDIO_INPUT_ID = 'default';

/**
 * How Cipherline wants the mic opened, minus the device id and minus echo
 * cancellation (that one is a user setting — see `micCaptureConstraints`).
 *
 * Browser noise suppression, AGC and voice isolation are OFF on purpose —
 * CipherlineVoiceProcessor does noise suppression (RNNoise), gating, EQ and
 * levelling itself, and stacking Chromium's AGC/NS on top of that
 * double-processes the signal (the classic symptom being a quiet mic getting
 * suppressed to near-silence by two gates in series). See voiceProcessor.ts for
 * the chain these feed.
 *
 * Re-asserted after every track restart — LiveKit's internal restart paths
 * (device ended, reconnect republish) rebuild constraints from a narrower set
 * and silently drop these, which would flip browser AEC/NS/AGC back to
 * Chromium's defaults mid-call. See the TrackEvent.Restarted handler in
 * SidebarConference.
 */
export const MIC_CAPTURE_BASE_CONSTRAINTS = {
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: 1,
    // Match the AudioContext rate in voiceProcessor so nothing has to resample
    // (a rate mismatch there shows up as pitch-shifted or crackly outgoing audio).
    // `ideal`, never `exact` — an unsatisfiable exact constraint fails the whole
    // getUserMedia call rather than degrading gracefully.
    sampleRate: { ideal: 48000 },
    // livekit-client's own capture defaults add `voiceIsolation: true`
    // (room/defaults.ts audioDefaults), which our audioCaptureDefaults used to
    // inherit: the CALL asked the platform for voice isolation (a system-level
    // noise suppressor where Chromium supports one) even with Cipherline's
    // noise suppression switched OFF, while the Settings mic test — a plain
    // getUserMedia — never did. Off, like the other two: "noise suppression
    // off" means the raw mic, and the meter tests what the call sends.
    voiceIsolation: false,
} satisfies MediaTrackConstraints & { voiceIsolation: boolean };

/**
 * Acoustic echo cancellation is ON by default (Settings -> Voice & Video).
 *
 * It is a user setting because it is the one stage with a cost for people who
 * do not need it: Chromium's AEC3 adaptive filter adds some CPU and can
 * slightly colour the voice, and with headphones there is no echo path to
 * remove.
 */
export const DEFAULT_ECHO_CANCELLATION = true;

/**
 * Coerce whatever was persisted (an older saved settings object has no field; a
 * hand-edited one could hold anything) to a boolean. Only an explicit boolean is
 * honoured, so a missing value gets the default.
 */
export function resolveEchoCancellation(stored: unknown): boolean {
    return typeof stored === 'boolean' ? stored : DEFAULT_ECHO_CANCELLATION;
}

/**
 * The full capture constraints (minus deviceId) for a mic open — THE one place
 * `echoCancellation` is decided. Every site that opens or re-opens the mic (the
 * call's audioCaptureDefaults, the join-time warm-up, the Settings mic test,
 * micDeviceSync's re-acquires, the track-restart re-assert, the live toggle)
 * takes it from here.
 *
 * The value is the boolean `true`, not Chromium's newer string forms. Measured
 * on Chromium 153 (Linux, PulseAudio loopback rig): `true` cancels playback from
 * HTMLMediaElements (including WebRTC-backed ones) AND from Web Audio, whereas
 * `'remote-only'` cancels only the WebRTC path, and `'all'` is not in the
 * track's capabilities (`[true, false, "remote-only"]`; `{exact:'all'}` is an
 * OverconstrainedError). Our remote voices are played by an <audio> element or,
 * for per-user NS / boost above 100 %, through a shared AudioContext — and
 * screen-share audio the same way — so `true` is the only form covering both.
 */
export function micCaptureConstraints(echoCancellation: boolean = DEFAULT_ECHO_CANCELLATION) {
    return { ...MIC_CAPTURE_BASE_CONSTRAINTS, echoCancellation };
}

/**
 * The processing flags a track that is NOT a microphone capture should
 * advertise: a WebAudio-sourced track (the native screen-share audio ring)
 * reports all of them `true` regardless, and livekit-client announces them to
 * the SFU from getSettings(). Kept here so this module stays the only place a
 * literal `echoCancellation: false` exists.
 */
export const UNPROCESSED_TRACK_SETTINGS = {
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
} as const;

/**
 * Resolve a stored settings value to a device id usable as a getUserMedia
 * constraint. '' / null / undefined all mean "follow the system default".
 */
export function resolveMicDeviceId(stored: string | null | undefined): string {
    return stored ? stored : DEFAULT_AUDIO_INPUT_ID;
}

/**
 * Pick the device we should actually be capturing from, given what the user
 * asked for and what currently exists.
 *
 * An explicitly-chosen device wins, but ONLY while it still exists. Device ids
 * are per-origin salted and rotate (storage clear, profile change), and devices
 * get unplugged — so a stored id routinely outlives the thing it points at.
 * Falling back to the follow-the-default device is always better than pinning to
 * a device that is gone: a bare (non-exact) deviceId constraint does NOT throw
 * for a missing device, Chromium just silently opens a different mic, which is
 * how you end up transmitting from the wrong input with no error anywhere.
 *
 * A stored id that no longer exists but whose device is still plugged in under
 * a new id (same groupId+label, or a unique label — see deviceResolve.ts) is
 * followed to that device rather than dropped to the default.
 */
export function pickMicDeviceId(
    stored: string | null | undefined,
    availableInputs: readonly MediaDeviceInfo[],
    hint?: DeviceHint | null,
): string {
    if (!stored) return DEFAULT_AUDIO_INPUT_ID;
    return findStoredDevice(stored, hint, availableInputs).device?.deviceId ?? DEFAULT_AUDIO_INPUT_ID;
}

/**
 * The getUserMedia `deviceId` constraint that actually opens `id`.
 *
 * Chromium ignores a bare or `{ideal}` deviceId and opens the system default
 * (measured again on Electron 43 / Chromium 150 with two PulseAudio mics: bare
 * → default, ideal → default, exact → the picked mic; see deviceSwitch.ts for
 * the original experiment). So a concrete device must be asked for with
 * `{exact}`. The follow-the-default pseudo-device stays bare: `{exact:'default'}`
 * is unsatisfiable where Chromium exposes no 'default' row.
 */
export function micDeviceConstraint(id: string): ConstrainDOMString {
    return !id || id === DEFAULT_AUDIO_INPUT_ID ? DEFAULT_AUDIO_INPUT_ID : { exact: id };
}

/**
 * True once enumerateDevices() is returning real data rather than the
 * pre-permission placeholder list.
 *
 * Before mic permission is granted Chromium returns one entry per kind with an
 * empty deviceId AND an empty label. Any logic that diffs the device list (is
 * my device gone? did the default change?) has to ignore that list entirely or
 * it will act on garbage — e.g. concluding the user's device disappeared and
 * "helpfully" switching them off it.
 */
export function hasRealDeviceInfo(inputs: readonly MediaDeviceInfo[]): boolean {
    return inputs.some(d => d.deviceId !== '' && d.label !== '');
}
