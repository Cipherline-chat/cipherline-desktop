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
 * through here.
 */

/**
 * Chromium synthesises an `audioinput` entry with this exact id that FOLLOWS the
 * OS default device. It is NOT the same thing as "no deviceId constraint":
 *
 *   - omitting deviceId  → Chromium resolves the default ONCE, at capture time,
 *                          and the track stays bound to that physical device
 *                          even after the OS default changes.
 *   - deviceId 'default' → binds to the follow-the-default virtual device.
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
 * How Cipherline wants the mic opened, minus the device id.
 *
 * All three browser DSP stages are OFF on purpose — CipherlineVoiceProcessor
 * does noise suppression (RNNoise), gating, EQ and levelling itself, and
 * stacking Chromium's AGC/NS on top of that double-processes the signal (the
 * classic symptom being a quiet mic getting suppressed to near-silence by two
 * gates in series). See voiceProcessor.ts for the chain these feed.
 *
 * Re-asserted after every track restart — LiveKit's internal restart paths
 * (device ended, reconnect republish) rebuild constraints from a narrower set
 * and silently drop these, which would flip browser AEC/NS/AGC back on
 * mid-call. See the TrackEvent.Restarted handler in SidebarConference.
 */
export const MIC_CAPTURE_CONSTRAINTS = {
    autoGainControl: false,
    noiseSuppression: false,
    echoCancellation: false,
    channelCount: 1,
    // Match the AudioContext rate in voiceProcessor so nothing has to resample
    // (a rate mismatch there shows up as pitch-shifted or crackly outgoing audio).
    // `ideal`, never `exact` — an unsatisfiable exact constraint fails the whole
    // getUserMedia call rather than degrading gracefully.
    sampleRate: { ideal: 48000 },
} satisfies MediaTrackConstraints;

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
 */
export function pickMicDeviceId(
    stored: string | null | undefined,
    availableInputs: readonly MediaDeviceInfo[],
): string {
    if (stored && availableInputs.some(d => d.deviceId === stored)) return stored;
    return DEFAULT_AUDIO_INPUT_ID;
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
