import secureLocalStore from './secureLocalStore';
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

/** `AudioContext.setSinkId` is newer than our TS lib target. `sinkId` is the
 *  read-back counterpart — the only way to learn where playback ACTUALLY goes,
 *  as opposed to where we asked for it to go. */
type SinkCapableContext = AudioContext & {
    setSinkId?: (id: string) => Promise<void>;
    sinkId?: string | MediaStreamAudioDestinationNode;
};

/**
 * Structured diagnostic for an output switch, mirroring deviceSwitch.ts's line
 * for mic/camera. Reads back `AudioContext.sinkId` rather than reporting the
 * requested id — an output switch is completely invisible when it fails (audio
 * simply keeps coming out of wherever it already was), so "we called setSinkId"
 * was never evidence that anything moved.
 *
 * `''` is the legitimate value for "system default", so it is not treated as a
 * missing read.
 */
function reportSinkResult(requested: string, ctx: AudioContext): void {
    const actual = (ctx as SinkCapableContext).sinkId;
    const actualId = typeof actual === 'string' ? actual : '(MediaStreamDestination)';
    const ok = actualId === requested;
    const line =
        `[devices] output switch requested=${requested || "'' (system default)"} `
        + `→ active=${actualId || "'' (system default)"} ok=${ok}`;
    if (ok) console.info(line); else console.warn(line);
}

/**
 * Optional failure callback — a `setSinkId` rejection used to be a silent
 * `console.warn`. That was invisible when it mattered most: if the active
 * output device disappears mid-call, LiveKit's own internal
 * `selectDefaultDevices()` auto-reroutes existing <audio> elements to a
 * fallback device, but any NEW element created afterward (a chain rebuild —
 * NS toggle, fullscreen flip, new participant, track replace) read the
 * STALE persisted device id here and failed to route to it silently,
 * leaving that one participant's audio on a different physical output than
 * everyone else with zero indication anything had gone wrong. Registered by
 * SidebarConference (which has toast access) while a call is active; left
 * unregistered elsewhere (e.g. the Settings preview) keeps this a no-op —
 * console.warn still fires either way.
 */
let onSinkFailure: ((err: unknown) => void) | null = null;

/** Register a callback for setSinkId failures — call with `null` to clear. */
export function setOutputDeviceFailureHandler(cb: ((err: unknown) => void) | null): void {
    onSinkFailure = cb;
}

/** Read the persisted speaker device id, or '' for the system default. */
export function getOutputDevice(): string {
    try {
        return secureLocalStore.getItem(STORAGE_KEY) ?? '';
    } catch {
        return '';
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
    setSinkIdSafe(el, id);
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
    setContextSinkIdSafe(ctx, id);
}

/** Stop tracking `ctx` — call this before closing it. */
export function unregisterOutputAudioContext(ctx: AudioContext): void {
    liveContexts.delete(ctx);
}

/**
 * Persist the user's chosen device and route every live element to it.
 * Called by VoiceVideoSettings when the user picks a different output
 * device. Replaces the brittle `document.querySelectorAll('audio')` sweep.
 */
export function onOutputDeviceChange(deviceId: string): void {
    try {
        secureLocalStore.setItem(STORAGE_KEY, deviceId);
    } catch {
        /* storage quota; non-fatal */
    }
    // '' means "system default" and must still be pushed to the live elements:
    // setSinkId('') resets an element to the default sink. Returning early here
    // (the old behaviour) persisted the choice but left every already-attached
    // element pinned to the previously-selected device, so switching from
    // headphones back to "Default Speakers" mid-call did nothing audible until
    // the chain happened to be rebuilt — the output-side twin of the mic
    // default-device bug.
    for (const el of liveAttached) setSinkIdSafe(el, deviceId);
    // The one that's actually audible — see this file's header.
    for (const ctx of liveContexts) setContextSinkIdSafe(ctx, deviceId);
}

/**
 * Should a LiveKit `ActiveDeviceChanged('audiooutput', …)` event be adopted as
 * our new speaker setting?
 *
 * ── Why this predicate has to exist ─────────────────────────────────────────
 *
 * We never call `room.switchActiveDevice('audiooutput', …)` — deliberately, see
 * the note at the call site in SidebarConference. The consequence is that
 * livekit-client's `localParticipant.activeDeviceMap` is seeded with
 * `'audiooutput' -> 'default'` (LocalParticipant's constructor) and, for us,
 * stays there forever. Its `selectDefaultDevices()` reads that map to decide
 * whether the user is "following the OS default", so it concludes they always
 * are — and on every `devicechange` it helpfully emits
 * `ActiveDeviceChanged('audiooutput', <the new default>)`.
 *
 * The old handler adopted that unconditionally, which broke two cases:
 *
 *   1. User is following the system default (our setting is ''). LiveKit emits
 *      a CONCRETE device id, we stored it, and "follow the system default"
 *      silently became "pinned to whatever was default at that moment."
 *   2. User explicitly picked a device. Plugging in a headset fires
 *      devicechange, LiveKit emits the new default, and their explicit choice
 *      was overwritten — at exactly the moment they were most likely to be
 *      choosing an output device on purpose.
 *
 * But the handler also does something genuinely necessary that must survive:
 * when the picked device DISAPPEARS mid-call, LiveKit reroutes existing audio
 * elements to a fallback and we need to adopt that, or our persisted id stays
 * pointed at dead hardware and every later chain rebuild fails to route.
 *
 * So the discriminator is not "did the default move" but "is the user's
 * explicit pick still there?" — the same shape as `resolveMicDeviceId`'s
 * stored-device-still-available check on the input side, and the same spirit as
 * `syncMicDevice`'s `defaultMoved`, which likewise only auto-follows the OS
 * default while `desired` IS the default.
 *
 * Pure and DOM-free so it is unit-testable; the caller does the enumeration.
 */
export function shouldAdoptOutputReroute(
    currentSetting: string,
    rerouteDeviceId: string,
    availableOutputs: readonly MediaDeviceInfo[],
): boolean {
    // Already where we want to be.
    if (rerouteDeviceId === currentSetting) return false;
    // '' = "follow the system default". The browser already does that on its
    // own, so there is nothing to rescue — and adopting a concrete id here is
    // precisely what turned default-following into a silent pin (case 1).
    if (currentSetting === '') return false;
    // Pre-permission Chromium hands back one blank placeholder per kind.
    // Concluding "your device is gone" from that list would drop the user off a
    // perfectly live device — the same trap audioInput.ts's callers guard.
    if (!availableOutputs.some(d => d.deviceId !== '' && d.label !== '')) return false;
    // The explicit pick is still available: LiveKit is merely reporting that
    // the OS default moved underneath us, which is none of our business while
    // the user is pinned to a specific device (case 2).
    if (availableOutputs.some(d => d.deviceId === currentSetting)) return false;
    // Explicit pick is gone. Adopt LiveKit's fallback as the new source of
    // truth — the case this handler was originally written for.
    return true;
}

function setSinkIdSafe(el: HTMLMediaElement, id: string): void {
    const fn = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (typeof fn !== 'function') return;
    fn.call(el, id).catch((err: unknown) => {
        console.warn('[audioOutput] setSinkId failed:', err);
        onSinkFailure?.(err);
    });
}

/**
 * Context counterpart of setSinkIdSafe. Wrapped the same way and for the same
 * reasons, plus a synchronous try/catch: unlike the element method, the
 * context one rejects the whole call with a TypeError *synchronously* for an
 * id that isn't a known sink, and a throw here runs inside chain-build code
 * that must not fail the call.
 */
function setContextSinkIdSafe(ctx: AudioContext, id: string): void {
    const fn = (ctx as SinkCapableContext).setSinkId;
    if (typeof fn !== 'function') return; // pre-Chromium-110 / non-Chromium UA
    const fail = (err: unknown) => {
        console.warn('[audioOutput] AudioContext.setSinkId failed:', err);
        onSinkFailure?.(err);
    };
    try {
        const p = fn.call(ctx, id);
        // Defensive: the spec returns a promise, but don't assume it.
        if (p && typeof p.then === 'function') {
            p.then(() => reportSinkResult(id, ctx)).catch(fail);
        } else {
            reportSinkResult(id, ctx);
        }
    } catch (err) {
        fail(err);
    }
}
