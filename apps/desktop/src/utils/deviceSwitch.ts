/**
 * Input-device switching: deciding HOW to ask, and VERIFYING what we got.
 *
 * ── The bug this file exists to fix ─────────────────────────────────────────
 *
 * Picking a microphone or camera from the control-bar right-click menu (or the
 * settings pane) persisted the choice, showed a "Switched to <device>" banner,
 * and captured from the OLD device. Three times reported, twice "fixed".
 *
 * Root cause, confirmed empirically against the Chromium build Electron ships
 * (headless Chromium 153, two PulseAudio virtual mics, 2026-09-06):
 *
 *   getUserMedia({ audio: { deviceId: "<CL_MicA id>" } })      → opened "Default"
 *   getUserMedia({ audio: { deviceId: {ideal: "<CL_MicA id>"}}}) → opened "Default"
 *   getUserMedia({ audio: { deviceId: {exact: "<CL_MicA id>"}}}) → opened "CL_MicA"
 *
 * Chromium treats a non-`exact` deviceId as purely advisory and, in practice,
 * ignores it — it opens the default device. ONLY `{exact: id}` actually selects
 * a device. And `livekit-client`'s `Room.switchActiveDevice(kind, id, exact)`
 * builds precisely those two shapes (`livekit-client@2.18.8`, Room.ts:1392):
 *
 *     const deviceConstraint = exact ? { exact: deviceId } : deviceId;
 *
 * Cipherline called it with `exact === false` for both mic and camera, so every
 * explicit device pick was a no-op at the capture layer.
 *
 * ── Why `exact:false` was chosen, and why that reasoning was half-right ──────
 *
 * `LocalTrack.restart()` stops the old MediaStreamTrack BEFORE calling
 * getUserMedia for the replacement, and has no rollback (LocalTrack.ts:344-402:
 * `this._mediaStreamTrack.stop()` then `await navigator.mediaDevices
 * .getUserMedia(...)`, with only a `finally { unlock() }`). So an unsatisfiable
 * `{exact:…}` leaves the mic permanently dead — published, apparently unmuted,
 * transmitting nothing. That hazard is real. The mistake was concluding that
 * `exact` must therefore never be used.
 *
 * The unsatisfiable case that actually bit was `{exact:'default'}` — Chromium
 * does not expose a synthetic `'default'` row on every setup, and it vanishes
 * transiently during the device-change storm while the OS re-enumerates. But an
 * explicitly-picked CONCRETE device id that we just saw in `enumerateDevices()`
 * is satisfiable by construction. So the rule is per-target, not global:
 *
 *   - "follow the system default" (`'default'`) → non-exact. Proven to work:
 *     `{deviceId:'default'}` opened "Default" and reported `deviceId:'default'`
 *     back. This is also the path that makes changing the OS default switch the
 *     call by itself — the track is bound to Chromium's follow-the-default
 *     virtual device and the OS re-routes underneath it, with no app code
 *     involved. That is why that path always worked while explicit picks never
 *     did; they are not the same mechanism.
 *   - a concrete device present in the current enumeration → exact. Satisfiable,
 *     and the only form Chromium honours.
 *
 * ── And then verify, because LiveKit already tells us ────────────────────────
 *
 * `switchActiveDevice` RETURNS a boolean, and `LocalTrack.setDeviceId` computes
 * it as `unwrapConstraint(deviceId) === this._mediaStreamTrack.getSettings()
 * .deviceId` — the library's own check that the switch landed. It does not
 * throw on failure; it resolves `false`. The old call sites discarded that
 * value, then unconditionally recorded the device as applied and showed a
 * success banner. That is what made the failure silent AND sticky: the
 * "applied" bookkeeping made subsequent passive syncs believe there was nothing
 * to do, and re-picking the same device from the menu is a React no-op (the
 * setting never changes), so the user could never retry.
 *
 * Everything here is pure and DOM-free so it is unit-testable — vitest in this
 * app runs in a `node` environment. The caller does the enumeration and the
 * `getSettings()` read.
 */

/** The follow-the-OS-default pseudo-device id, shared by audioinput/videoinput.
 *  Mirrors DEFAULT_AUDIO_INPUT_ID / DEFAULT_CAMERA_ID, which are kept in their
 *  own kind-scoped modules. */
const DEFAULT_DEVICE_ID = 'default';

/**
 * Should this switch be requested with an `exact` deviceId constraint?
 *
 * `true` for a concrete device we can currently see (the only form Chromium
 * honours, and satisfiable because we just enumerated it); `false` for the
 * follow-the-default pseudo-device and for anything we cannot find, where an
 * `exact` constraint would throw after LiveKit has already stopped the old
 * track.
 */
export function shouldUseExactConstraint(
    desiredId: string,
    available: readonly MediaDeviceInfo[],
): boolean {
    if (!desiredId || desiredId === DEFAULT_DEVICE_ID) return false;
    return available.some(d => d.deviceId === desiredId);
}

/**
 * Prefixes of MediaStreamTrack ids that are NOT capture devices.
 *
 * Blink mints a `MediaStreamAudioDestinationNode`'s output track with a source
 * named `"WebAudio-<uuid>"`, and `getSettings().deviceId` on that track reports
 * that name. Cipherline's mic path always ends in one of these: the rnnoise
 * graph in `voiceProcessor.ts` publishes
 * `destination.stream.getAudioTracks()[0]`. The camera equivalent is a
 * `canvas.captureStream()` track (`cameraProcessor.ts`), which reports no
 * deviceId at all.
 *
 * These ids can never match a row in `enumerateDevices()`, so treating one as
 * "the device we ended up on" produces both a false failure verdict and the
 * `labelFor` fallback rendering of it — which is exactly the reported
 * "Couldn't switch to System default — still using Device WebAudio".
 */
const SYNTHETIC_DEVICE_ID_PREFIXES = ['WebAudio'] as const;

/** Is this a processor-output track id rather than a real capture device? */
export function isSyntheticDeviceId(id: string | null | undefined): boolean {
    if (!id) return false;
    return SYNTHETIC_DEVICE_ID_PREFIXES.some(prefix => id.startsWith(prefix));
}

/**
 * The shape of `livekit-client`'s `LocalTrack` that device verification needs.
 * Structural rather than an import so this module stays DOM- and SDK-free and
 * can be unit-tested with plain objects.
 */
export interface CaptureTrackLike {
    /** LiveKit's processor-ignoring accessor: settings of the CAPTURING track. */
    getSourceTrackSettings?: () => MediaTrackSettings;
    /** Post-processor track — `processor?.processedTrack ?? _mediaStreamTrack`. */
    mediaStreamTrack?: { getSettings: () => MediaTrackSettings } | null;
}

/**
 * Read the id of the device a local track is actually CAPTURING from.
 *
 * `LocalTrack.mediaStreamTrack` is a getter that returns
 * `this.processor?.processedTrack ?? this._mediaStreamTrack`
 * (livekit-client 2.x). With a processor attached — which, in this app, is
 * always, once `MicProcessorBridge` has run — reading `getSettings()` off it
 * reports the PROCESSOR'S OUTPUT track, never the microphone. LiveKit exposes
 * `getSourceTrackSettings()` for exactly this ("settings of the capturing
 * mediastreamtrack source - ignoring processors"), so prefer it.
 *
 * Falls back to the post-processor track for robustness if a future SDK bump
 * drops that accessor, and returns `null` — "cannot tell" — rather than
 * handing back a synthesized id that would be mistaken for a device.
 */
export function readCaptureDeviceId(track: CaptureTrackLike | null | undefined): string | null {
    if (!track) return null;
    try {
        const id = track.getSourceTrackSettings?.().deviceId;
        if (id && !isSyntheticDeviceId(id)) return id;
    } catch {
        // Fall through to the post-processor track below.
    }
    try {
        const id = track.mediaStreamTrack?.getSettings().deviceId;
        if (id && !isSyntheticDeviceId(id)) return id;
    } catch {
        // Nothing readable.
    }
    return null;
}

export type DeviceSwitchKind = 'mic' | 'camera';

export interface DeviceSwitchOutcome {
    kind: DeviceSwitchKind;
    /** What we asked for ('default' = follow the system default). */
    requestedId: string;
    requestedLabel: string;
    /** What is ACTUALLY live, read from getSettings() — never the request. */
    activeId: string | null;
    activeLabel: string | null;
    /** Did we actually end up on the requested device? */
    ok: boolean;
    usedExact: boolean;
    /** LiveKit accepted the constraint but deferred applying it — the track is
     *  muted (it restarts on unmute via `pendingDeviceChange`) or the camera is
     *  off (nothing published yet; the Room's capture default was updated and
     *  the next enable will use it). Not a failure. */
    deferred: boolean;
    deferredReason?: string;
    /** A live track exists but its capture device id could not be read, so the
     *  switch could be neither confirmed nor refuted. Treated as success: a
     *  banner we cannot justify is worse than no banner. */
    unverifiable: boolean;
    error?: string;
}

/** A device's display label with the same fallback used everywhere else. */
function labelFor(id: string | null, devices: readonly MediaDeviceInfo[]): string {
    if (!id) return '(none)';
    if (id === DEFAULT_DEVICE_ID) return 'System default';
    const d = devices.find(x => x.deviceId === id);
    return d?.label || `Device ${id.slice(0, 8)}`;
}

/**
 * Did we land on the device we asked for?
 *
 * The `'default'` case needs care. Chromium reports `getSettings().deviceId ===
 * 'default'` for a track opened against the follow-the-default pseudo-device
 * (verified in the same experiment), but other engines resolve it to the
 * concrete device's own id instead. Both are correct outcomes for "follow the
 * default", so accept either: the literal `'default'`, or the id of a device
 * sharing the default row's `groupId` (which is how Chromium pairs the
 * synthetic row with the real one it points at).
 */
function landedOnRequested(
    requestedId: string,
    activeId: string | null,
    devices: readonly MediaDeviceInfo[],
): boolean {
    if (!activeId) return false;
    if (activeId === requestedId) return true;
    if (requestedId !== DEFAULT_DEVICE_ID) return false;
    const defaultRow = devices.find(d => d.deviceId === DEFAULT_DEVICE_ID);
    if (!defaultRow) {
        // No synthetic default row on this platform, so "follow the default"
        // simply means "whatever getUserMedia chose with no device pinned".
        // There is nothing to compare against — anything live counts.
        return true;
    }
    return devices.some(d => d.deviceId === activeId && d.groupId === defaultRow.groupId);
}

/**
 * Build the outcome record for a completed switch attempt. Pure: the caller
 * supplies the post-switch `getSettings().deviceId` (or null when there is no
 * live track to read).
 */
export function buildSwitchOutcome(args: {
    kind: DeviceSwitchKind;
    requestedId: string;
    /** Post-switch `track.mediaStreamTrack.getSettings().deviceId`, or null when
     *  there is no live track (camera off / track muted and stopped). */
    activeId: string | null;
    devices: readonly MediaDeviceInfo[];
    usedExact: boolean;
    /** Track exists but is muted — LiveKit defers the restart to unmute. */
    muted?: boolean;
    /** No publication of this kind exists (camera off). */
    noPublication?: boolean;
    /** A publication exists but `readCaptureDeviceId` could not resolve a real
     *  capture device id for it — see the `unverifiable` field. */
    unverifiable?: boolean;
    error?: string;
}): DeviceSwitchOutcome {
    const {
        kind, requestedId, activeId, devices, usedExact,
        muted, noPublication, unverifiable, error,
    } = args;
    const base = {
        kind,
        requestedId,
        requestedLabel: labelFor(requestedId, devices),
        activeId,
        activeLabel: activeId ? labelFor(activeId, devices) : null,
        usedExact,
        unverifiable: false,
        error,
    };
    if (error) {
        return { ...base, ok: false, deferred: false };
    }
    if (noPublication) {
        return {
            ...base, ok: true, deferred: true,
            deferredReason: kind === 'camera'
                ? 'camera is off — applies when you turn it on'
                : 'no live track — applies when the track is created',
        };
    }
    if (muted) {
        return {
            ...base, ok: true, deferred: true,
            deferredReason: 'track is muted — applies when you unmute',
        };
    }
    if (unverifiable) {
        // Trust LiveKit rather than accuse it. This is the branch that keeps a
        // future SDK bump (one that drops getSourceTrackSettings) from
        // resurrecting the false "still using Device WebAudio" banner.
        return { ...base, ok: true, deferred: false, unverifiable: true };
    }
    return { ...base, ok: landedOnRequested(requestedId, activeId, devices), deferred: false };
}

/**
 * Is a switch actually needed, or are we already capturing from the device the
 * user asked for?
 *
 * The last clause is the one that matters at call start. `appliedId` begins as
 * `null` on every join while the Room has ALREADY opened the right microphone
 * (CallPane passes it as `audioCaptureDefaults.deviceId`), so a bare
 * `appliedId !== desiredId` test fired a completely redundant
 * `switchActiveDevice` on every single call — and `LocalTrack.restart()` stops
 * the live MediaStreamTrack before re-acquiring it, with no rollback. Verifying
 * against the device that is genuinely live removes that restart, and with it
 * the window where it can race the asynchronous processor attach.
 */
export function needsDeviceSwitch(args: {
    force: boolean;
    defaultMoved: boolean;
    trackAlive: boolean;
    /** Device our last successful switch targeted, or null if none yet. */
    appliedId: string | null;
    desiredId: string;
    /** Capture device currently live, from `readCaptureDeviceId`. */
    activeId: string | null;
    devices: readonly MediaDeviceInfo[];
}): boolean {
    const { force, defaultMoved, trackAlive, appliedId, desiredId, activeId, devices } = args;
    if (force || defaultMoved || !trackAlive) return true;
    if (appliedId === desiredId) return false;
    // No bookkeeping yet (or stale bookkeeping), but the hardware may already
    // be right — only restart the track if it genuinely is not.
    return !landedOnRequested(desiredId, activeId, devices);
}

/**
 * One structured line per switch attempt, reporting the ACTUAL post-switch
 * state rather than what was requested.
 *
 * This is the piece that turns the next report from "it doesn't work" into
 * evidence. Device labels are local hardware names printed to the local
 * console only — they never leave the machine and are not call metadata, so
 * this does not widen the logging surface the privacy rules constrain.
 */
export function formatDeviceSwitchLog(o: DeviceSwitchOutcome): string {
    const parts = [
        `[devices] ${o.kind} switch`,
        `requested=${o.requestedLabel} (${o.requestedId || "''"})`,
        `→ active=${o.activeLabel ?? '(no live track)'} (${o.activeId ?? 'null'})`,
        `ok=${o.ok}`,
        `exact=${o.usedExact}`,
    ];
    if (o.deferred) parts.push(`deferred=${o.deferredReason}`);
    if (o.error) parts.push(`err=${o.error}`);
    return parts.join(' ');
}

/** Short, user-facing phrasing for a failed switch. */
export function describeSwitchFailure(o: DeviceSwitchOutcome): string {
    const target = o.requestedLabel;
    if (o.error) return `Couldn't switch to ${target}: ${o.error}`;
    return `Couldn't switch to ${target} — still using ${o.activeLabel ?? 'the previous device'}.`;
}
