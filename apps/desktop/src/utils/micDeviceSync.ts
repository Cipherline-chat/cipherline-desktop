/**
 * Keeping the PUBLISHED microphone on the device the user asked for, including
 * "follow the system default" when the OS default changes mid-call.
 *
 * ── The bug this file exists to fix ─────────────────────────────────────────
 *
 * Reported on stable 1.0.20 (Windows 11 25H2): with the mic set to "Default",
 * switching the Windows default input (SoundSwitch, or Settings → Sound) left
 * the call transmitting from the OLD device — or from nothing — while the
 * Settings level and gate meters happily followed the new one. Selecting a
 * concrete device and then "Default" again fixed it.
 *
 * Root cause: the previous sync path asked LiveKit to re-target 'default' with
 * `room.switchActiveDevice('audioinput', 'default', false)`. In
 * livekit-client 2.18.8 that ends in `LocalTrack.setDeviceId('default')`
 * (LocalTrack.ts:244), whose first statement is:
 *
 *     if (this._constraints.deviceId === deviceId &&
 *         this._mediaStreamTrack.getSettings().deviceId === unwrapConstraint(deviceId))
 *       return true;
 *
 * LiveKit's createLocalTracks opens the call's mic with `{exact:'default'}`
 * (create.ts: "if the user passes a device id as a string, we default to exact
 * match"), so the FIRST OS-default change of a call does restart — `{exact:…}`
 * is not `===` 'default'. But that restart stores the plain string 'default'
 * as the constraint, and the capture reports `getSettings().deviceId ===
 * 'default'`. From then on 'default' → 'default' is a no-op that RETURNS TRUE:
 * nothing re-opened, and our verification (`deviceId === 'default'`) agreed it
 * had worked. Same after the user re-picks "Default", after a device_lost
 * fallback, and after LiveKit's own device-ended recovery
 * (`restartTrack({deviceId:'default'})`). Verified in headless Chromium 153
 * against the real livekit-client 2.18.8 LocalAudioTrack.
 *
 * Chromium's 'default' pseudo-device does NOT follow the OS default for an
 * already-open track: the track stays bound to the physical endpoint it opened
 * (and Windows may stop feeding it when the default moves). The only way to
 * follow is to call getUserMedia again. The Settings meters "worked" because
 * VoiceVideoSettings re-runs its own getUserMedia on every devicechange; the
 * call never did.
 *
 * The flip to a concrete device and back worked because `{exact:<id>}` and
 * then `'default'` are not `===` to the stored constraint, so both of those
 * setDeviceId calls really did restart.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 *
 *   1. When the target is 'default', re-acquire with `restartTrack()` and fresh
 *      constraints instead of trusting setDeviceId. restartTrack →
 *      LocalTrack.restart → getUserMedia → setMediaStreamTrack, which restarts
 *      the attached voice processor on the new capture and calls
 *      `sender.replaceTrack()` on the SAME RTCRtpSender: no unpublish, no
 *      renegotiation, and the E2EE frame cryptor (bound to the sender) stays.
 *      Mute is preserved: setMediaStreamTrack sets `enabled = !isMuted`.
 *   2. Detect a moved default from the 'default' row's groupId+label (two
 *      identical headsets share a label, never a groupId), and as a backstop
 *      from the live capture's own groupId disagreeing with the default row's.
 *   3. Read liveness from the RAW capture track. `LocalTrack.mediaStreamTrack`
 *      returns the processor's WebAudio output once rnnoise is attached, which
 *      is always 'live' and never muted — so the old `readyState === 'live'`
 *      check could never see a dead mic.
 *   4. Debounce devicechange bursts and coalesce syncs that land mid-restart.
 *   5. (Explicit picks, 2026-10) Verify the capture is on the picked device on
 *      every new publication and every track restart (`verify`), not only on
 *      devicechange: livekit-client's ended-recovery reopens the mic with
 *      `{deviceId:'default'}`, and a stale stored id makes the join's
 *      `{exact}` fail and fall back the same way — both used to leave the call
 *      on the default for good. A stale id is followed to the same device by
 *      groupId+label (deviceResolve.ts). A target that just failed is not
 *      retried by a verification pass (no restart → verify → restart loop).
 *
 * Decision logic is pure (`decideMicReacquire`) and the side-effecting part is
 * a small controller with injected dependencies, so both are unit-testable in
 * vitest's node environment.
 */

import { DEFAULT_AUDIO_INPUT_ID, hasRealDeviceInfo, micDeviceConstraint, pickMicDeviceId } from './audioInput';
import type { DeviceHint } from './deviceResolve';
import {
    buildSwitchOutcome,
    readCaptureDeviceId,
    shouldUseExactConstraint,
    type CaptureTrackLike,
    type DeviceSwitchOutcome,
} from './deviceSwitch';
import { logCallEvent } from './callEventLog';

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Why a re-acquire happened. Short enum: it goes into the call event log. */
export type MicSwitchReason =
    | 'setting_changed'   // the user picked a device (or "Default")
    | 'silence'           // LiveKit detected digital silence on the capture
    | 'track_ended'       // the capture track ended (device yanked / driver reset)
    | 'track_muted'       // the OS stopped feeding the capture (source-side mute)
    | 'device_lost'       // an explicitly-picked device disappeared → default
    | 'default_changed'   // following the default, and the OS default moved
    | 'default_mismatch'  // following the default, but the capture is on another device
    | 'device_mismatch';  // the capture is not on the requested device

/** The bits of a raw capture MediaStreamTrack the decision needs. */
export interface RawCaptureTrackLike {
    readyState: MediaStreamTrackState | string;
    muted: boolean;
    getSettings: () => MediaTrackSettings;
    getConstraints?: () => MediaTrackConstraints;
    applyConstraints?: (c: MediaTrackConstraints) => Promise<void>;
    addEventListener?: (type: 'ended' | 'mute', fn: () => void) => void;
    removeEventListener?: (type: 'ended' | 'mute', fn: () => void) => void;
}

/** The slice of livekit-client's LocalAudioTrack this module touches. */
export interface MicTrackLike extends CaptureTrackLike {
    isMuted: boolean;
    restartTrack: (options?: MediaTrackConstraints) => Promise<void>;
    getProcessor?: () => unknown;
    /** LiveKit's stored copy of the constraints the track was opened with. It is
     *  what `restart()` (no args) and `stopProcessor()` re-apply, so a live
     *  change to a capture flag has to be written here too or the next
     *  processor stop / restart would quietly put the old value back. */
    constraints?: MediaTrackConstraints;
    /** livekit-client 2.x keeps the CAPTURE track here (TS-protected, a plain
     *  JS field at runtime). `mediaStreamTrack` is the processor's output. */
    _mediaStreamTrack?: RawCaptureTrackLike;
}

/**
 * The raw capture MediaStreamTrack behind a LiveKit local track — the one the
 * microphone actually feeds, not the voice processor's WebAudio output.
 *
 * Returns null when it cannot be read without risking the processed track
 * (which would make a dead mic look perfectly healthy).
 */
export function readCaptureTrack(track: MicTrackLike | null | undefined): RawCaptureTrackLike | null {
    if (!track) return null;
    const raw = track._mediaStreamTrack;
    if (raw && typeof raw.getSettings === 'function') return raw;
    // No private field (future SDK): the public getter is only the capture
    // track when no processor is attached.
    const hasProcessor = !!track.getProcessor?.();
    if (!hasProcessor && track.mediaStreamTrack) {
        return track.mediaStreamTrack as unknown as RawCaptureTrackLike;
    }
    return null;
}

/**
 * Identity of the device the OS currently calls "default": groupId + label of
 * Chromium's synthetic 'default' row. Label alone is not enough (two identical
 * USB headsets share "Microphone (USB Audio Device)"); groupId alone is not
 * reported on every platform. Null when there is no 'default' row.
 */
export function defaultDeviceSignature(inputs: readonly MediaDeviceInfo[]): string | null {
    const row = inputs.find(d => d.deviceId === DEFAULT_AUDIO_INPUT_ID);
    if (!row || (!row.label && !row.groupId)) return null;
    return `${row.groupId ?? ''}|${row.label ?? ''}`;
}

/**
 * Constraints for a forced re-acquire: whatever the capture was opened with
 * (so LiveKit's own capture defaults, e.g. `voiceIsolation`, carry over exactly
 * as they do on LiveKit's restart paths), then our capture constraints on top
 * (browser AEC/NS/AGC stay off), then the target device.
 */
export function restartConstraints(
    raw: RawCaptureTrackLike | null,
    capture: MediaTrackConstraints,
    deviceId: ConstrainDOMString,
): MediaTrackConstraints {
    let current: MediaTrackConstraints = {};
    try { current = raw?.getConstraints?.() ?? {}; } catch { /* a dead track may refuse */ }
    return { ...current, ...capture, deviceId };
}

export interface MicReacquireInput {
    /** Caller-supplied reason for a forced pass (setting change, silence). */
    force: MicSwitchReason | null;
    /** Stored setting ('' = follow the default). */
    setting: string;
    /** Resolved target from pickMicDeviceId (never '' — 'default' or an id). */
    desiredId: string;
    /** Is there a published mic track at all? */
    hasTrack: boolean;
    /** Raw capture state, or null when it cannot be read. */
    capture: { readyState: string; muted: boolean; groupId: string | null } | null;
    /** Device id the last successful pass targeted (null = none yet). */
    appliedId: string | null;
    /** Default signature at the last successful acquire while following the default. */
    appliedDefaultSig: string | null;
    /** Default signature right now. */
    currentDefaultSig: string | null;
    /** groupId of the 'default' row right now, if any. */
    defaultGroupId: string | null;
    /** False once a re-acquire proved capture-groupId vs default-groupId is not
     *  comparable on this platform — the mismatch signal is then ignored. */
    groupCheckTrusted: boolean;
    /** From readCaptureDeviceId — what the capture reports as its deviceId. */
    activeId: string | null;
    /** Did we land on the requested device (deviceSwitch.needsDeviceSwitch's test)? */
    onRequested: boolean;
    /** Is the published track muted? A concrete-device switch on a muted track
     *  is deferred by LiveKit to the unmute, so the capture legitimately sits on
     *  the old device until then. */
    trackMuted?: boolean;
    /** A re-acquire toward `desiredId` already failed since the last device
     *  change / setting change: don't retry it on a mere verification pass
     *  (that would loop restart → verify → restart). */
    suppressMismatch?: boolean;
}

export interface MicReacquireDecision {
    reacquire: boolean;
    reason: MicSwitchReason | null;
}

/**
 * Should the published mic be re-acquired, and why? Pure.
 *
 * Order matters: a dead capture is fixed whatever else is true; the
 * default-following checks only apply while the target IS the default.
 */
export function decideMicReacquire(i: MicReacquireInput): MicReacquireDecision {
    const yes = (reason: MicSwitchReason): MicReacquireDecision => ({ reacquire: true, reason });
    if (i.force) return yes(i.force);
    if (i.hasTrack && i.capture) {
        if (i.capture.readyState !== 'live') return yes('track_ended');
        if (i.capture.muted) return yes('track_muted');
    }
    const followingDefault = i.desiredId === DEFAULT_AUDIO_INPUT_ID;
    if (followingDefault && i.setting && i.appliedId !== DEFAULT_AUDIO_INPUT_ID) {
        // An explicit pick that no longer exists: pickMicDeviceId already
        // resolved it to the default; move the call there.
        return yes('device_lost');
    }
    if (followingDefault && i.hasTrack) {
        if (i.appliedDefaultSig && i.currentDefaultSig && i.appliedDefaultSig !== i.currentDefaultSig) {
            return yes('default_changed');
        }
        const g = i.capture?.groupId;
        if (i.groupCheckTrusted && g && i.defaultGroupId && g !== i.defaultGroupId) {
            return yes('default_mismatch');
        }
    }
    const no: MicReacquireDecision = { reacquire: false, reason: null };
    // A picked device whose capture is verifiably somewhere else, even though
    // our bookkeeping says it was applied. This is not hypothetical: when a
    // capture ends (driver reset, sleep, another app grabbing the device),
    // livekit-client's own recovery restarts the mic with
    // `{deviceId:'default'}` (LocalParticipant.handleTrackEnded) — the call
    // then sat on the system default for good, because `appliedId === desired`
    // ended the check right here. Only for a concrete pick: the
    // follow-the-default case has its own checks above.
    const elsewhere = !followingDefault && i.hasTrack && !i.trackMuted
        && i.activeId !== null && !i.onRequested;
    if (i.appliedId === i.desiredId && !elsewhere) return no;
    if (i.appliedId !== i.desiredId && i.onRequested) return no;
    if (i.suppressMismatch) return no;
    return yes('device_mismatch');
}

/**
 * A trailing-edge debounce with injectable timers. SoundSwitch (and plugging
 * in one headset) fire several devicechange events in quick succession; each
 * re-acquire stops the live capture, so one per burst is the goal.
 */
export function createDebouncer(
    fn: () => void,
    ms: number,
    timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): { trigger: () => void; cancel: () => void } {
    let handle: ReturnType<typeof setTimeout> | null = null;
    return {
        trigger() {
            if (handle !== null) timers.clearTimeout(handle);
            handle = timers.setTimeout(() => { handle = null; fn(); }, ms);
        },
        cancel() {
            if (handle !== null) timers.clearTimeout(handle);
            handle = null;
        },
    };
}

// ── Controller ───────────────────────────────────────────────────────────────

/** Debounce for devicechange / capture mute / ended. Short enough that the new
 *  default is on the wire within ~1 s; long enough to swallow a burst. */
export const MIC_DEVICE_DEBOUNCE_MS = 300;

export interface MicDeviceSyncDeps {
    enumerateDevices: () => Promise<MediaDeviceInfo[]>;
    /** The published microphone track, or null. */
    getMicTrack: () => MicTrackLike | null;
    /** room.switchActiveDevice('audioinput', id, exact). */
    switchActiveDevice: (deviceId: string, exact: boolean) => Promise<unknown>;
    /** Stored micDeviceId setting ('' = follow the system default). */
    getSetting: () => string;
    /** Label/groupId recorded with the setting, to follow a pick whose id
     *  changed (see deviceResolve.ts). */
    getSettingHint?: () => DeviceHint | null;
    /** Capture constraints (micCaptureConstraints) — re-sent on every restart
     *  so browser NS/AGC can never sneak back on, and echoCancellation always
     *  carries the CURRENT setting. A function, so a setting changed mid-call is
     *  picked up by the next re-acquire (default-follow, device recovery)
     *  instead of the value from when the call was joined. */
    captureConstraints: MediaTrackConstraints | (() => MediaTrackConstraints);
    /** Every completed attempt (console line / error state lives in the caller). */
    onOutcome?: (outcome: DeviceSwitchOutcome, reason: MicSwitchReason) => void;
    /** An explicitly-picked mic vanished and the call moved to the default. */
    onFellBackToDefault?: () => void;
    /** Both the switch and the widest recovery failed — the mic is dead. */
    onUnrecoverable?: (err: unknown) => void;
    /** Recovery (after a throw) put the call back on the default device. */
    onRecovered?: () => void;
    timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
    debounceMs?: number;
    /** Clock for the enforcement cooldown (tests). */
    now?: () => number;
}

/**
 * How `applyCapture` ended.
 *   unchanged — the live capture already reports the wanted flags; nothing done;
 *   restarted — it did not, so the capture was re-opened with fresh constraints;
 *   no_track  — nothing is published (the next open uses the current value);
 *   deferred  — a device sync is mid-flight; the check runs when it finishes;
 *   cooldown  — an enforcement restart ran moments ago and the flags STILL do
 *               not match (the platform will not honour them): not retried, so
 *               a restart -> Restarted -> restart loop cannot form;
 *   failed    — the restart threw.
 */
export type CaptureApplyResult = 'unchanged' | 'restarted' | 'no_track' | 'deferred' | 'cooldown' | 'failed';

/** Minimum gap between two enforcement restarts (see `cooldown`). */
export const CAPTURE_ENFORCE_COOLDOWN_MS = 10_000;

/** Resolve the (possibly lazy) capture constraints. */
function resolveCapture(c: MediaTrackConstraints | (() => MediaTrackConstraints)): MediaTrackConstraints {
    return typeof c === 'function' ? c() : c;
}

/**
 * Point the Room's own capture defaults at the current echo-cancellation
 * setting. They were frozen at join, and a mic track created LATER (joined
 * muted and unmuted afterwards; setMicrophoneEnabled after an unpublish) is
 * opened from them. `room.options` is livekit-client's public, mutable options
 * object — the same one LocalParticipant reads at track-creation time.
 */
export function setRoomEchoCancellation(
    room: { options?: { audioCaptureDefaults?: MediaTrackConstraints } } | null | undefined,
    echoCancellation: boolean,
): void {
    const defaults = room?.options?.audioCaptureDefaults;
    if (defaults) defaults.echoCancellation = echoCancellation;
}

/** The three processing flags Chromium reports back through getSettings(). */
const PROCESSING_FLAGS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;

/**
 * Which of the wanted processing flags the live capture does not report. Pure.
 *
 * Why this compares getSettings() rather than trusting a prior
 * `applyConstraints`: measured on Chromium 153 (Electron 43 is Chromium 150,
 * same audio stack), `applyConstraints({echoCancellation|noiseSuppression|
 * autoGainControl})` on an open capture RECORDS the constraint
 * (`getConstraints()` changes) but leaves `getSettings()` — and the audio —
 * exactly as it was. The only way to change one is a fresh getUserMedia.
 * Only an explicit boolean is compared; an unreported flag (some platforms
 * omit one) is not treated as a mismatch.
 */
export function captureFlagMismatches(raw: RawCaptureTrackLike | null, wanted: MediaTrackConstraints): string[] {
    if (!raw) return [];
    let settings: MediaTrackSettings = {};
    try { settings = raw.getSettings(); } catch { return []; }
    const bad: string[] = [];
    for (const k of PROCESSING_FLAGS) {
        const want = wanted[k];
        const have = settings[k];
        if (typeof want === 'boolean' && typeof have === 'boolean' && want !== have) bad.push(k);
    }
    return bad;
}

export interface MicDeviceSync {
    /** Run a pass now. `force` = re-acquire regardless, with this reason. */
    sync: (force?: MicSwitchReason | null) => Promise<void>;
    /** Debounced pass — wire devicechange here. */
    schedule: () => void;
    /** Record what is live right now without switching (call start). */
    seed: () => Promise<void>;
    /**
     * Debounced check that the published capture is on the device we want —
     * wire it to a new mic publication (join, reconnect republish) and to every
     * track restart (ours or livekit-client's). Unlike `schedule`, it does not
     * retry a target that just failed.
     */
    verify: () => void;
    /**
     * Make the live capture report the current capture constraints' processing
     * flags (echo cancellation toggled mid-call; or livekit-client re-opened the
     * mic with Chromium's defaults). A no-op when it already does. Otherwise a
     * `restartTrack` with fresh constraints — NOT `applyConstraints`, which
     * Chromium ignores for these flags (see captureFlagMismatches) — on the same
     * sender, so no unpublish, the E2EE cryptor stays bound, mute is kept
     * (setMediaStreamTrack sets `enabled = !isMuted`) and the attached voice
     * processor is restarted on the new capture.
     */
    applyCapture: () => Promise<CaptureApplyResult>;
    /** Note that the caller already applied this device (setting mount). */
    setApplied: (id: string | null) => void;
    /** Watch the current raw capture for ended/mute (re-call after a restart). */
    watchCapture: () => void;
    dispose: () => void;
    /** Test/diagnostic view of the internal bookkeeping. */
    state: () => { appliedId: string | null; appliedDefaultSig: string | null; groupCheckTrusted: boolean; busy: boolean };
}

export function createMicDeviceSync(deps: MicDeviceSyncDeps): MicDeviceSync {
    const timers = deps.timers ?? globalThis;
    let appliedId: string | null = null;
    let appliedDefaultSig: string | null = null;
    let groupCheckTrusted = true;
    /** Target of the last failed re-acquire; cleared by a device change, a
     *  setting change, or a success. See MicReacquireInput.suppressMismatch. */
    let failedTarget: string | null = null;
    const hint = () => deps.getSettingHint?.() ?? null;
    let busy = false;
    let pending = false;
    /** applyCapture() arrived mid-sync: run it when the sync finishes. */
    let capturePending = false;
    /** The last enforcement restart: when, and for which wanted flags. */
    let lastEnforce: { at: number; sig: string } | null = null;
    const now = deps.now ?? (() => Date.now());
    let disposed = false;
    let watched: { track: RawCaptureTrackLike; fn: () => void } | null = null;

    const debouncer = createDebouncer(() => { void sync(null); }, deps.debounceMs ?? MIC_DEVICE_DEBOUNCE_MS, timers);

    const groupOf = (raw: RawCaptureTrackLike | null): string | null => {
        try { return raw?.getSettings().groupId || null; } catch { return null; }
    };

    function unwatch() {
        if (!watched) return;
        watched.track.removeEventListener?.('ended', watched.fn);
        watched.track.removeEventListener?.('mute', watched.fn);
        watched = null;
    }

    function watchCapture() {
        const raw = readCaptureTrack(deps.getMicTrack());
        if (watched?.track === raw) return;
        unwatch();
        if (!raw?.addEventListener) return;
        const fn = () => debouncer.trigger();
        raw.addEventListener('ended', fn);
        raw.addEventListener('mute', fn);
        watched = { track: raw, fn };
    }

    /**
     * Keep LiveKit's stored copy of the capture constraints in step with the
     * wanted flags. `restart()` with no args (setDeviceId, a device switch) and
     * `stopProcessor()` re-apply THAT copy, so without this a toggle made
     * mid-call is undone by the next device switch.
     */
    function syncStoredConstraints(track: MicTrackLike | null, wanted: MediaTrackConstraints) {
        const stored = track?.constraints;
        if (!stored) return;
        try {
            for (const k of PROCESSING_FLAGS) if (typeof wanted[k] === 'boolean') stored[k] = wanted[k];
        } catch { /* frozen / foreign object: the restart paths pass fresh constraints anyway */ }
    }

    async function applyCapture(): Promise<CaptureApplyResult> {
        if (disposed) return 'no_track';
        if (busy) { capturePending = true; return 'deferred'; }
        const track = deps.getMicTrack();
        const raw = readCaptureTrack(track);
        if (!track || !raw) return 'no_track';
        const wanted = resolveCapture(deps.captureConstraints);
        syncStoredConstraints(track, wanted);
        const bad = captureFlagMismatches(raw, wanted);
        if (bad.length === 0) return 'unchanged';
        const sig = PROCESSING_FLAGS.map(k => String(wanted[k])).join(',');
        if (lastEnforce && lastEnforce.sig === sig && now() - lastEnforce.at < CAPTURE_ENFORCE_COOLDOWN_MS) {
            console.warn('[Mic] capture still reports', bad.join(', '), 'after a restart - leaving it as is');
            return 'cooldown';
        }
        lastEnforce = { at: now(), sig };
        try {
            // The device the capture is on RIGHT NOW (what Chromium reports),
            // else the one we last applied, else the default: a restart for an
            // unrelated flag must never hop devices. (A capture that sits on the
            // wrong device is verify()'s business, not this path's.)
            let current: string | undefined;
            try { current = raw.getSettings().deviceId || undefined; } catch { /* dead track */ }
            await track.restartTrack(restartConstraints(
                raw, wanted, micDeviceConstraint(current ?? appliedId ?? DEFAULT_AUDIO_INPUT_ID),
            ));
        } catch (err) {
            console.warn('[Mic] capture restart failed:', err);
            logEcho(wanted.echoCancellation, bad.includes('echoCancellation'), false);
            return 'failed';
        }
        // The cooldown exists only for a platform that will NOT honour the flags.
        // When the restart worked, forget it: a later, unrelated narrow reopen by
        // livekit-client (device ended seconds after a toggle) must still be fixed.
        if (captureFlagMismatches(readCaptureTrack(deps.getMicTrack()), wanted).length === 0) lastEnforce = null;
        logEcho(wanted.echoCancellation, bad.includes('echoCancellation'), true);
        return 'restarted';
    }

    async function seed() {
        try {
            const inputs = (await deps.enumerateDevices()).filter(d => d.kind === 'audioinput');
            if (!hasRealDeviceInfo(inputs)) return;
            if (pickMicDeviceId(deps.getSetting(), inputs, hint()) === DEFAULT_AUDIO_INPUT_ID && !appliedDefaultSig) {
                appliedDefaultSig = defaultDeviceSignature(inputs);
            }
        } catch { /* the first sync records it instead */ }
        watchCapture();
    }

    /** Point the published mic at `desired` — and actually re-open it. */
    async function reacquire(desired: string, useExact: boolean) {
        const before = readCaptureTrack(deps.getMicTrack());
        // livekit-client restarts a concrete-device switch with ITS stored copy
        // of the constraints: make sure that copy carries the current setting.
        syncStoredConstraints(deps.getMicTrack(), resolveCapture(deps.captureConstraints));
        // Always tell the Room: it updates audioCaptureDefaults (used by any
        // later LiveKit-initiated republish) and, for a concrete id or a
        // change of constraint, really restarts the track.
        await deps.switchActiveDevice(desired, useExact);
        if (desired !== DEFAULT_AUDIO_INPUT_ID) return;
        const track = deps.getMicTrack();
        if (!track) return;
        const after = readCaptureTrack(track);
        if (after && after !== before && after.readyState === 'live') return; // it did restart
        // 'default' → 'default': setDeviceId short-circuits (see header), so
        // nothing was re-opened. Force a fresh getUserMedia. Fresh constraints,
        // not LiveKit's stored ones, which its own recovery paths narrow.
        await track.restartTrack(restartConstraints(after, resolveCapture(deps.captureConstraints), DEFAULT_AUDIO_INPUT_ID));
    }

    async function sync(force: MicSwitchReason | null = null): Promise<void> {
        if (disposed) return;
        if (busy) { pending = true; return; }
        busy = true;
        if (force) failedTarget = null;
        let reason: MicSwitchReason | null = null;
        let desired = DEFAULT_AUDIO_INPUT_ID;
        try {
            const inputs = (await deps.enumerateDevices()).filter(d => d.kind === 'audioinput');
            // Pre-permission placeholders: acting on them would "lose" the device.
            if (!hasRealDeviceInfo(inputs)) return;

            const setting = deps.getSetting();
            desired = pickMicDeviceId(setting, inputs, hint());
            const track = deps.getMicTrack();
            const raw = readCaptureTrack(track);
            const currentDefaultSig = defaultDeviceSignature(inputs);
            const defaultRow = inputs.find(d => d.deviceId === DEFAULT_AUDIO_INPUT_ID);
            const activeId = readCaptureDeviceId(track);

            const followingDefault = desired === DEFAULT_AUDIO_INPUT_ID;
            if (followingDefault && !appliedDefaultSig) appliedDefaultSig = currentDefaultSig;

            // Only comparable where Chromium pairs the 'default' row with the
            // real device it points at (shared groupId — Windows, macOS). Where
            // the row has a groupId of its own (PulseAudio's "Default"), a
            // capture can never match it, so the backstop must stay silent.
            const defaultGroupPaired = !!defaultRow?.groupId && inputs.some(
                d => d.deviceId !== DEFAULT_AUDIO_INPUT_ID && d.groupId === defaultRow.groupId,
            );
            // An explicit pick that has vanished: whatever trigger got us here
            // (its capture ending usually comes first), the user is told once.
            const lostPick = !!setting && followingDefault && appliedId !== DEFAULT_AUDIO_INPUT_ID;

            const decision = decideMicReacquire({
                force,
                setting,
                desiredId: desired,
                hasTrack: !!track,
                capture: raw ? { readyState: raw.readyState, muted: raw.muted, groupId: groupOf(raw) } : null,
                appliedId,
                appliedDefaultSig,
                currentDefaultSig,
                defaultGroupId: defaultGroupPaired ? defaultRow!.groupId : null,
                groupCheckTrusted,
                activeId,
                onRequested: landedOn(desired, activeId, inputs),
                trackMuted: !!track?.isMuted,
                suppressMismatch: failedTarget === desired,
            });
            if (!decision.reacquire) {
                appliedId = desired;
                return;
            }
            reason = decision.reason;

            const useExact = shouldUseExactConstraint(desired, inputs);
            const wasMuted = !!track?.isMuted;
            await reacquire(desired, useExact);

            const liveTrack = deps.getMicTrack();
            const liveRaw = readCaptureTrack(liveTrack);
            const liveId = readCaptureDeviceId(liveTrack);
            const outcome = buildSwitchOutcome({
                kind: 'mic',
                requestedId: desired,
                activeId: liveId,
                devices: inputs,
                usedExact: useExact,
                // A muted track is restarted too on the default path (it is
                // never deferred there), so "muted" only means deferred for a
                // concrete target, which LiveKit applies on unmute.
                muted: wasMuted && !followingDefault,
                noPublication: !liveTrack,
                unverifiable: !!liveTrack && liveId === null,
            });

            if (followingDefault && defaultGroupPaired && liveRaw && outcome.ok) {
                // If a fresh default capture STILL disagrees with the default
                // row's groupId, the two are not comparable on this platform:
                // stop using that signal rather than restarting on every event.
                const g = groupOf(liveRaw);
                if (g && defaultRow?.groupId && g !== defaultRow.groupId) groupCheckTrusted = false;
            }

            deps.onOutcome?.(outcome, reason!);
            logSwitch(reason!, followingDefault, outcome.ok);
            if (!outcome.ok) {
                // Not recorded as applied — that is what made the old failure sticky.
                appliedId = outcome.activeId;
                failedTarget = desired;
                return;
            }
            appliedId = desired;
            failedTarget = null;
            appliedDefaultSig = followingDefault ? currentDefaultSig : null;
            if (lostPick) deps.onFellBackToDefault?.();
        } catch (err) {
            console.warn('[Mic] device switch failed — attempting recovery:', err);
            failedTarget = desired;
            // Widest possible re-acquire: the old capture may already be stopped
            // (LocalTrack.restart stops it before getUserMedia, no rollback).
            try {
                const track = deps.getMicTrack();
                if (track) {
                    await track.restartTrack(restartConstraints(
                        readCaptureTrack(track), resolveCapture(deps.captureConstraints), { ideal: DEFAULT_AUDIO_INPUT_ID },
                    ));
                    appliedId = DEFAULT_AUDIO_INPUT_ID;
                    appliedDefaultSig = null;
                    logSwitch(reason ?? 'track_ended', true, true);
                    deps.onRecovered?.();
                }
            } catch (recoveryErr) {
                logSwitch(reason ?? 'track_ended', desired === DEFAULT_AUDIO_INPUT_ID, false);
                deps.onUnrecoverable?.(recoveryErr);
            }
        } finally {
            busy = false;
            if (!disposed) watchCapture();
            if (capturePending && !disposed) {
                capturePending = false;
                void applyCapture();
            }
            if (pending && !disposed) {
                pending = false;
                // Re-evaluates from scratch; a no-op if nothing changed, so it can't spin.
                timers.setTimeout(() => { void sync(null); }, 0);
            }
        }
    }

    return {
        sync,
        // A device change is new information: a target that failed may work now.
        schedule: () => { if (!disposed) { failedTarget = null; debouncer.trigger(); } },
        verify: () => { if (!disposed) debouncer.trigger(); },
        seed,
        applyCapture,
        setApplied: (id) => { appliedId = id; },
        watchCapture,
        dispose: () => { disposed = true; debouncer.cancel(); unwatch(); },
        state: () => ({ appliedId, appliedDefaultSig, groupCheckTrusted, busy }),
    };
}

/** Same acceptance rule as deviceSwitch's landedOnRequested. */
function landedOn(desired: string, activeId: string | null, devices: readonly MediaDeviceInfo[]): boolean {
    return buildSwitchOutcome({ kind: 'mic', requestedId: desired, activeId, devices, usedExact: false }).ok;
}

/** One call-event entry per re-acquire. Reason enum + a boolean only — never a
 *  device id or label (labels can carry a person's name). */
function logSwitch(reasonValue: MicSwitchReason, toDefault: boolean, ok: boolean) {
    const verdictValue = ok ? 'ok' : 'failed';
    logCallEvent('mic_device_switch', { reason: reasonValue, to_default: toDefault, verdict: verdictValue });
}

/** One call-event entry per capture-flag enforcement: the wanted echo-cancellation
 *  value, whether echo cancellation was among the flags that differed, ok|failed.
 *  Booleans and an enum only. */
function logEcho(on: boolean | ConstrainBoolean | undefined, changed: boolean, ok: boolean) {
    const verdictValue = ok ? 'ok' : 'failed';
    logCallEvent('mic_echo_cancellation', { on: on === true, changed, verdict: verdictValue });
}
