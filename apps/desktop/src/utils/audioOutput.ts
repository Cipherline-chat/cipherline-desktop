import secureLocalStore from './secureLocalStore';
import { hasRealDeviceInfo } from './audioInput';
import { findStoredDevice, type DeviceHint } from './deviceResolve';
import { logCallEvent } from './callEventLog';

/**
 * Centralized output-device (`setSinkId`) routing for every <audio> element
 * we attach inside the WebAudio playback chain.
 *
 * The original implementation in VoiceVideoSettings.tsx swept the entire
 * document with `document.querySelectorAll('audio')` whenever the speaker
 * device setting changed. That works for elements that already exist at the
 * moment the setting changes, but every chain rebuild (track replacement,
 * NS toggle, fullscreen ↔ normal layout flip, etc.) creates a fresh
 * <audio> element via `pub.track.attach()`. Those new elements never picked
 * up the user's chosen output device — they default to the system speaker.
 * Symptom users reported: "I changed to my headphones but Bob is still
 * coming out the speaker." That's the bug.
 *
 * Fix: every place we create an <audio> element (mic chain, screenshare-
 * audio chain) registers it here, and every output-device change is
 * applied to the registered set. When the chain tears down, we
 * unregister so we don't keep stale references after detach.
 *
 * ── The elements are NOT where the sound comes out ──────────────────────────
 *
 * That element sweep was necessary but never sufficient, and on its own it
 * routed nothing audible at all. Every remote participant's audio is played
 * through Web Audio, not through the element we attach: useParticipantAudio
 * attaches the track only to pull frames, sets `attachedEl.volume = 0`, and
 * routes the real signal `MediaStreamSource → gain → masterGain → limiter →
 * AudioContext.destination` (that muting is also why the Speaker Volume
 * slider had to become a master GainNode — see getMasterGain's comment).
 *
 * An `HTMLMediaElement.setSinkId` on a silent element changes where silence
 * plays. The audible sink is the shared AudioContext's, and until this file
 * also drove `AudioContext.setSinkId` nothing ever set it — so picking an
 * output device (from Settings OR the control-bar right-click menu) wrote
 * the setting, showed a "Switched to <device>" banner, and left every voice
 * in the call coming out of the system default. Contexts register the same
 * way elements do, and both are re-routed on every change.
 *
 * The element calls stay: Chromium wants the sink set on the element too for
 * echo cancellation to work against a non-default output (crbug 40252911),
 * which is the same reason livekit-client sets both even under webAudioMix.
 *
 * Since the A/V-sync change (useParticipantAudio "Playback path") the elements
 * ARE the audible playback again for most chains — the shared context only
 * carries per-user-NS / >100 % chains — so both registries are load-bearing.
 *
 * ── Every playback path, every time ──────────────────────────────────────────
 *
 *   - remote voices and screen-share audio: useParticipantAudio's attached
 *     <audio> elements (applyOutputDevice) and its shared context
 *     (registerOutputAudioContext);
 *   - UI sounds / ringback / the sound preview: notificationSounds (they follow
 *     the output device on purpose — a cue on speakers you aren't wearing is a
 *     cue you don't hear);
 *   - Settings "Listen to mic": its own context;
 *   - attachment players (FileViewer, pinned messages, the video lightbox):
 *     `ref={outputSinkRef}`;
 *   - Settings "Test speakers" (notificationSounds.testSpeakers): a fresh
 *     element plus a silent context probe, with the verdict shown.
 * Screen-share audio is not a separate path: it is a second chain in
 * useParticipantAudio and goes through the same element/shared-context calls.
 * The PCM-ring AudioContext in SidebarConference feeds a MediaStreamDestination
 * that is PUBLISHED, never played, so it is deliberately not registered.
 * New elements/contexts are routed at birth (getOutputDevice), live ones on
 * every change (onOutputDeviceChange), on every device change
 * (refreshOutputDevices — the pick unplugged → system default with one notice,
 * back → routed to it again) and after livekit-client re-points them
 * (reapplyOutputDevice). The setting is applied from useVoiceSettings, which
 * lives for the whole session — it used to be applied only from inside a call,
 * so a pick made in Settings outside a call left the mic monitor, sound
 * previews and notification sounds on the previous device until a call began.
 */

const STORAGE_KEY = 'cipherline_speaker_device_id';

/** Live <audio> elements we'll re-route on output-device change. */
const liveAttached = new Set<HTMLMediaElement>();

/**
 * Live AudioContexts whose `destination` is real playback — i.e. the ones
 * that actually decide which physical device the user hears. Kept separate
 * from `liveAttached` because the API is different (`AudioContext.setSinkId`,
 * Chromium 110+) and because analysis-only contexts (VideoTile's speaking
 * detector, which never connects to `destination`) must NOT be registered:
 * re-pointing those does nothing useful and can needlessly restart them.
 */
const liveContexts = new Set<AudioContext>();

/** Elements registered through outputSinkRef (they live in the DOM, so they can be pruned by `isConnected`). */
const domBound = new WeakSet<HTMLMediaElement>();

/** `AudioContext.setSinkId` is newer than our TS lib target. `sinkId` is the
 *  read-back counterpart — the only way to learn where playback ACTUALLY goes,
 *  as opposed to where we asked for it to go. */
type SinkCapableContext = AudioContext & {
    setSinkId?: (id: string) => Promise<void>;
    sinkId?: string | MediaStreamAudioDestinationNode;
};

/** `HTMLMediaElement.setSinkId` and its read-back counterpart. */
type SinkCapableElement = HTMLMediaElement & {
    setSinkId?: (id: string) => Promise<void>;
    sinkId?: string;
};

// ── Every attempt is recorded ────────────────────────────────────────────────
//
// An output switch that fails is completely invisible: audio keeps coming out
// of wherever it already was, and there is no error anywhere the user (or a
// diagnostic report) can see. So EVERY setSinkId attempt - element or context,
// in a call or not - is recorded as one `audio_output_sink` call event
// (callEventLog.ts: memory only, scalar details, no ids, no labels):
//
//   target     element | context
//   ok         the promise resolved
//   landed     the read-back (`el.sinkId` / `ctx.sinkId`) equals what we asked
//              for - "resolved" is not evidence that sound moved
//   to_default the request was for the system default ('')
//   reason     birth | change | refresh | reapply | test - which code asked
//   error      DOMException name from the closed set below, 'none' on success
//
// The settings "Test speakers" button reads the same outcomes back, so the
// result is visible without a call.

export type SinkTarget = 'element' | 'context';
export type SinkReason = 'birth' | 'change' | 'refresh' | 'reapply' | 'test';
export type SinkErrorName =
    | 'NotAllowedError' | 'NotFoundError' | 'AbortError' | 'InvalidStateError'
    | 'NotSupportedError' | 'SecurityError' | 'TypeError' | 'OperationError'
    | 'unsupported' | 'not_applied' | 'other';

export interface SinkOutcome {
    /** The setSinkId promise resolved (and did not throw). */
    ok: boolean;
    /** The element/context reports the requested sink afterwards. */
    landed: boolean;
    error?: SinkErrorName;
}

const KNOWN_ERRORS: ReadonlySet<string> = new Set([
    'NotAllowedError', 'NotFoundError', 'AbortError', 'InvalidStateError',
    'NotSupportedError', 'SecurityError', 'TypeError', 'OperationError',
]);

/** A DOMException name reduced to a closed set - nothing from the message,
 *  which can echo a device id. */
export function sinkErrorName(err: unknown): SinkErrorName {
    const n = (err as { name?: unknown } | null)?.name;
    return typeof n === 'string' && KNOWN_ERRORS.has(n) ? (n as SinkErrorName) : 'other';
}

/**
 * Optional failure callback - a `setSinkId` rejection used to be a silent
 * `console.warn`, invisible exactly when it mattered. Registered session-long
 * by useOutputDeviceNotices (which has toast access). It fires ONCE per
 * failure episode, not once per element: a call has a dozen routed targets
 * and a bad id fails all of them, which used to be a dozen identical toasts.
 * The latch re-arms when the user picks a device again, and when the pick
 * returns (see refreshOutputDevices).
 */
let onSinkFailure: ((err: unknown) => void) | null = null;
let failureNoticeArmed = true;

/** Register a callback for setSinkId failures - call with `null` to clear. */
export function setOutputDeviceFailureHandler(cb: ((err: unknown) => void) | null): void {
    onSinkFailure = cb;
}

function noteFailure(err: unknown): void {
    if (!onSinkFailure || !failureNoticeArmed) return;
    failureNoticeArmed = false;
    try { onSinkFailure(err); } catch { /* a notice must never break routing */ }
}

function finish(
    target: SinkTarget, reason: SinkReason, id: string, outcome: SinkOutcome, err?: unknown,
): SinkOutcome {
    logCallEvent('audio_output_sink', {
        target,
        ok: outcome.ok,
        landed: outcome.landed,
        to_default: id === '',
        reason,
        error: outcome.error ?? 'none',
    });
    if (outcome.error === 'unsupported') {
        console.warn(`[audioOutput] ${target} has no setSinkId`);
    } else if (!outcome.ok) {
        console.warn(`[audioOutput] ${target} setSinkId failed (${outcome.error}):`, err);
        noteFailure(err ?? new Error(outcome.error));
    } else if (!outcome.landed) {
        console.warn(`[audioOutput] ${target} setSinkId resolved but the sink did not change`);
        noteFailure(new Error('not_applied'));
    }
    return outcome;
}

/**
 * Concurrent setSinkId calls on ONE element/context are queued, so the last
 * request is the one that wins. The first call on an idle target is made
 * synchronously (callers and tests rely on that).
 */
const inflight = new WeakMap<object, Promise<SinkOutcome>>();
function serialize(target: object, run: () => Promise<SinkOutcome>): Promise<SinkOutcome> {
    const prev = inflight.get(target);
    const p = prev ? prev.then(run) : run();
    inflight.set(target, p);
    const clear = () => { if (inflight.get(target) === p) inflight.delete(target); };
    p.then(clear, clear);
    return p;
}

/** The persisted choice ('' = follow the system default). */
function storedOutputDevice(): string {
    try {
        return secureLocalStore.getItem(STORAGE_KEY) ?? '';
    } catch {
        return '';
    }
}

// ── Desired vs effective ─────────────────────────────────────────────────────
//
// `desired` is what the user picked (persisted). `effective` is what every
// element and context is actually pointed at: the pick while it is plugged in
// (followed to its new id if Windows re-enumerated it — see deviceResolve.ts),
// the system default while it is not. Keeping the two apart is what lets a
// headset that drops out (Bluetooth off, USB re-plug) come BACK: the old code
// adopted LiveKit's fallback as the new setting, so the pick was overwritten
// with 'default' the moment it vanished and never restored when it returned.

let desiredHint: DeviceHint | null = null;
/** null until something resolved it — the stored pick is used as-is until then. */
let effectiveId: string | null = null;
/** One fallback notice per disappearance; re-armed when the pick is back. */
let fallbackNoticeArmed = true;
let inFallback = false;
let onFallback: (() => void) | null = null;

/**
 * The output device id to route a NEW element or context to right now — the
 * resolved effective device, or the stored pick before anything resolved it.
 */
export function getOutputDevice(): string {
    return effectiveId ?? storedOutputDevice();
}

/**
 * Register the "your speakers are gone, using the default" notice (the call UI
 * does, for the length of a call; `null` clears). If the pick is ALREADY missing
 * when it registers — unplugged before the call started — it fires at once, so
 * the user still hears about it once.
 */
export function setOutputDeviceFallbackHandler(cb: (() => void) | null): void {
    onFallback = cb;
    if (cb && inFallback && fallbackNoticeArmed) {
        fallbackNoticeArmed = false;
        cb();
    }
}

/**
 * Register `el` as a live attached element AND apply the currently-persisted
 * output device to it. Call this immediately after `track.attach()`.
 *
 * `setSinkId` is wrapped because (a) older browsers / Linux Electron builds
 * may not implement it on HTMLMediaElement, and (b) it can reject if the
 * device just got unplugged — we don't want a setSinkId failure to cascade
 * through the chain build and break call audio entirely.
 */
export function applyOutputDevice(el: HTMLMediaElement): void {
    liveAttached.add(el);
    const id = getOutputDevice();
    if (!id) return; // empty string = system default; no setSinkId needed
    void routeElement(el, id, 'birth');
}

/**
 * Same as applyOutputDevice, but awaitable: the result is a verdict the
 * settings "Test speakers" button shows. With the system default ('') there is
 * nothing to route, which is reported as a success.
 */
export function applyOutputDeviceChecked(el: HTMLMediaElement, reason: SinkReason = 'test'): Promise<SinkOutcome> {
    liveAttached.add(el);
    const id = getOutputDevice();
    if (!id) return Promise.resolve({ ok: true, landed: true });
    return routeElement(el, id, reason);
}

/**
 * ref={outputSinkRef} for a <video>/<audio> that is part of the React tree and
 * plays sound the user can hear (attachment players). A plain function so it
 * is usable inside a .map(). A callback ref is also called with null on
 * unmount, which carries no element to unregister - so elements registered
 * here are pruned lazily once they are no longer in the document
 * (applyToAll).
 */
export function outputSinkRef(el: HTMLMediaElement | null): void {
    if (!el) return;
    // Sweep first: a chat that scrolls through many players must not keep every
    // unmounted one alive until the next device change.
    for (const other of liveAttached) {
        if (other !== el && domBound.has(other) && !other.isConnected) liveAttached.delete(other);
    }
    domBound.add(el);
    applyOutputDevice(el);
}

/** Stop tracking `el` — call this in the teardown path before detach. */
export function unregisterOutputDeviceTarget(el: HTMLMediaElement): void {
    liveAttached.delete(el);
}

/**
 * Register a playback AudioContext AND point it at the currently-persisted
 * output device. Call this immediately after constructing any context whose
 * graph reaches `ctx.destination` — that destination, not any <audio>
 * element, is what the user actually hears.
 *
 * Same '' convention as everywhere else: empty means "follow the system
 * default", which a freshly-constructed context already does, so there is
 * nothing to apply for it here (unlike `onOutputDeviceChange`, where '' is a
 * deliberate move BACK to the default and must be pushed).
 */
export function registerOutputAudioContext(ctx: AudioContext): void {
    liveContexts.add(ctx);
    const id = getOutputDevice();
    if (!id) return;
    void routeContext(ctx, id, 'birth');
}

/** Stop tracking `ctx` — call this before closing it. */
export function unregisterOutputAudioContext(ctx: AudioContext): void {
    liveContexts.delete(ctx);
}

/**
 * Persist the user's chosen device and route every live element and context to
 * it. Called by useVoiceSettings whenever the speaker setting changes (and once
 * at startup with the persisted pick), wherever the change came from — the
 * Settings pane or the call's right-click menu, in a call or not.
 *
 * `hint` is the picked device's label/groupId, used to follow it if its id
 * changes (see refreshOutputDevices).
 */
export function onOutputDeviceChange(deviceId: string, hint?: DeviceHint | null): void {
    try {
        secureLocalStore.setItem(STORAGE_KEY, deviceId);
    } catch {
        /* storage quota; non-fatal */
    }
    desiredHint = hint ?? null;
    effectiveId = deviceId;
    inFallback = false;
    fallbackNoticeArmed = true;
    failureNoticeArmed = true; // a new pick is a new episode
    // '' means "system default" and must still be pushed to the live elements:
    // setSinkId('') resets an element to the default sink. Returning early here
    // (the old behaviour) persisted the choice but left every already-attached
    // element pinned to the previously-selected device, so switching from
    // headphones back to "Default Speakers" mid-call did nothing audible until
    // the chain happened to be rebuilt — the output-side twin of the mic
    // default-device bug.
    applyToAll(deviceId, 'change');
}

// ── Is the stored pick a real, current device? ───────────────────────────────
//
// One `audio_output_pick` call event per CHANGE of (result, listed-count), so a
// devicechange storm does not fill the log. `result`:
//   default      nothing picked - following the system default
//   exact        the stored id is in the current list
//   group_label  the id changed (Windows re-enumeration), found by groupId+label
//   label        found by label alone
//   none         not in the list - the pick is unplugged/stale, playing on the default
//   synthetic    the stored id is literally 'default'/'communications', which is
//                never what a pick should be (Chromium's alias rows)
// `count` is how many audiooutput rows the enumeration returned. No ids, no labels.
const SYNTHETIC_OUTPUT_IDS: ReadonlySet<string> = new Set(['default', 'communications']);
let lastPickNote = '';
function notePick(result: 'default' | 'exact' | 'group_label' | 'label' | 'none' | 'synthetic', count: number): void {
    const key = `${result}/${count}`;
    if (key === lastPickNote) return;
    lastPickNote = key;
    logCallEvent('audio_output_pick', { result, count });
}

/**
 * Re-resolve the pick against the current output list — call on startup and on
 * every `devicechange`. The pick present (or present under a new id): route to
 * it. The pick gone: route to the system default, tell the user once, and keep
 * the pick — when it comes back, the next call here routes to it again.
 */
export function refreshOutputDevices(outputs: readonly MediaDeviceInfo[]): void {
    // Pre-permission Chromium hands back one blank placeholder per kind.
    // Concluding "your device is gone" from that list would drop the user off a
    // perfectly live device.
    if (!hasRealDeviceInfo(outputs)) return;
    const desired = storedOutputDevice();
    let next = '';
    if (desired) {
        const { device, match } = findStoredDevice(desired, desiredHint, outputs);
        notePick(SYNTHETIC_OUTPUT_IDS.has(desired) ? 'synthetic' : match, outputs.length);
        if (device) {
            next = device.deviceId;
            inFallback = false;
            fallbackNoticeArmed = true;
            failureNoticeArmed = true;
        } else {
            inFallback = true;
            if (fallbackNoticeArmed && onFallback) {
                fallbackNoticeArmed = false;
                onFallback();
            }
        }
    } else {
        notePick('default', outputs.length);
        inFallback = false;
    }
    if (next === getOutputDevice()) return;
    console.info(`[devices] output pick ${next ? 'resolved' : 'unavailable — using the system default'}`);
    effectiveId = next;
    applyToAll(next, 'refresh');
}

/**
 * Point every registered element and context at the effective device again.
 * livekit-client can re-point remote audio elements on its own (its
 * `selectDefaultDevices()` calls `switchActiveDevice('audiooutput', …)` when it
 * decides the active output vanished, which sets the sink on every element a
 * remote track is attached to — i.e. on the elements that ARE the audible
 * playback since the A/V-sync change). Its view of "active" is not ours, so its
 * reroute is undone here rather than adopted.
 */
export function reapplyOutputDevice(): void {
    applyToAll(getOutputDevice(), 'reapply');
}

function applyToAll(deviceId: string, reason: SinkReason): void {
    for (const el of [...liveAttached]) {
        // A DOM-bound element that has left the document is gone for good.
        if (domBound.has(el) && !el.isConnected) { liveAttached.delete(el); continue; }
        void routeElement(el, deviceId, reason);
    }
    // The AudioContexts whose destination is real playback.
    for (const ctx of liveContexts) void routeContext(ctx, deviceId, reason);
}

/** Test seam: forget the resolved state (module state outlives a test). */
export function __resetOutputRoutingForTests(): void {
    desiredHint = null;
    effectiveId = null;
    fallbackNoticeArmed = true;
    failureNoticeArmed = true;
    inFallback = false;
    onFallback = null;
    lastPickNote = '';
    liveAttached.clear();
    liveContexts.clear();
}

/**
 * Point ONE element at `id` and record the outcome. `setSinkId` is wrapped
 * because (a) a build without it must not break the chain, and (b) it can
 * reject if the device was just unplugged - a failure here must never cascade
 * into the playback chain that called us.
 */
function routeElement(el: HTMLMediaElement, id: string, reason: SinkReason): Promise<SinkOutcome> {
    return serialize(el, async () => {
        const e = el as SinkCapableElement;
        if (typeof e.setSinkId !== 'function') {
            return finish('element', reason, id, { ok: false, landed: false, error: 'unsupported' });
        }
        // Already there (a second routing pass over a long-lived element):
        // nothing to do, nothing to report.
        if (e.sinkId === id) return { ok: true, landed: true };
        try {
            await e.setSinkId(id);
        } catch (err) {
            return finish('element', reason, id, { ok: false, landed: false, error: sinkErrorName(err) }, err);
        }
        const actual = e.sinkId;
        // A runtime that reports no read-back cannot contradict the promise.
        const landed = typeof actual !== 'string' || actual === id;
        return finish('element', reason, id, { ok: true, landed, error: landed ? undefined : 'not_applied' });
    });
}

/**
 * Context counterpart of routeElement. Wrapped the same way and for the same
 * reasons, plus a synchronous catch: unlike the element method, the context
 * one can throw a TypeError *synchronously* for an id that isn't a known
 * sink, and a throw here runs inside chain-build code that must not fail the
 * call.
 */
function routeContext(ctx: AudioContext, id: string, reason: SinkReason): Promise<SinkOutcome> {
    return serialize(ctx, async () => {
        const c = ctx as SinkCapableContext;
        if (typeof c.setSinkId !== 'function') {
            // pre-Chromium-110 / non-Chromium UA
            return finish('context', reason, id, { ok: false, landed: false, error: 'unsupported' });
        }
        if (typeof c.sinkId === 'string' && c.sinkId === id) return { ok: true, landed: true };
        try {
            await c.setSinkId(id);
        } catch (err) {
            return finish('context', reason, id, { ok: false, landed: false, error: sinkErrorName(err) }, err);
        }
        const actual = c.sinkId;
        const landed = typeof actual !== 'string' || actual === id;
        const line =
            `[devices] output switch requested=${id || "'' (system default)"} `
            + `-> active=${typeof actual === 'string' ? (actual || "'' (system default)") : '(unknown)'} ok=${landed}`;
        if (landed) console.info(line); else console.warn(line);
        return finish('context', reason, id, { ok: true, landed, error: landed ? undefined : 'not_applied' });
    });
}

/**
 * Silent check that an AudioContext can be pointed at the picked device: a
 * throwaway context, never connected to anything, set to the sink and closed.
 * The "Test speakers" button runs it next to the audible element test so both
 * paths (elements and contexts) are exercised and recorded.
 */
export async function probeContextSink(reason: SinkReason = 'test'): Promise<SinkOutcome> {
    const id = getOutputDevice();
    if (!id) return { ok: true, landed: true };
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
    if (!Ctor) return finish('context', reason, id, { ok: false, landed: false, error: 'unsupported' });
    let ctx: AudioContext | null = null;
    try {
        ctx = new Ctor();
        return await routeContext(ctx, id, reason);
    } catch (err) {
        return finish('context', reason, id, { ok: false, landed: false, error: sinkErrorName(err) }, err);
    } finally {
        try { await ctx?.close(); } catch { /* already closed */ }
    }
}
