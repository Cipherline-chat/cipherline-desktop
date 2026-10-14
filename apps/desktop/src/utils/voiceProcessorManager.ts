import { CipherlineVoiceProcessor, type VoiceProcessorCallbacks, RNNOISE_SAMPLE_RATE } from './voiceProcessor';
import type { VoiceSettings } from '../hooks/useVoiceSettings';
import { registerCtxForUnlock } from './audioUnlock';
import { voiceChainNeedsProcessor } from './voiceChain';

/**
 * Call-lifetime singleton owning the CipherlineVoiceProcessor.
 *
 * Why this exists: the mic used to be published RAW first, with the
 * processor attached later from an effect inside SidebarConference — a
 * component that gets unmounted and remounted mid-call whenever the call
 * portal target (#call-sidebar-root) moves (e.g. navigating between
 * servers). That remount destroyed the processor (closing its AudioContext
 * while its track was still live on the RTCRtpSender) and rebuilt a fresh
 * one, and the WINDOW BEFORE the very first attach — between LiveKit
 * publishing the raw mic and the SidebarConference effect running — was
 * exactly the "joined with no noise suppression" bug. Leaving and rejoining
 * "fixed" it only because a fresh join happened to land in a state where the
 * window had already closed by the time anyone was listening.
 *
 * This manager is created ONCE per call (keyed by the LiveKit token, which
 * is unique per call and stable for the whole CallPane mount) and attached
 * by CallPane's MicProcessorBridge the moment the mic publication exists
 * (bindMicTrack) — unless every per-user voice stage is off, in which case the
 * raw capture is published with no processor until a stage is turned on (see
 * "Attach / detach" below).
 *
 * NOT via `audioCaptureDefaults.processor`, though that looks like the
 * obvious pre-publish hook: livekit-client's module-level createLocalTracks()
 * calls track.setProcessor() BEFORE anything has given the track an
 * AudioContext, and LocalAudioTrack.setProcessor() hard-throws without one
 * ("Audio context needs to be set on LocalAudioTrack in order to enable
 * processors") — failing the entire join, not just NS. Verified broken
 * through livekit-client 2.22.1; shipped broken in 1.0.12-staging.92.
 * The bridge instead attaches on LocalTrackPublished (plus a scan of
 * already-published tracks), pre-seeding the track with
 * getGuardAudioContext() so the guard can never throw. The raw-publish
 * window this reopens is the few ms between publish and the event handler —
 * versus the old bug, which was an attach that could be delayed
 * indefinitely by portal remounts. SidebarConference mounting/unmounting as
 * the portal moves still never touches the processor — it just calls
 * updateSettings() on whatever's already running.
 *
 * Idempotent by callId: React StrictMode double-invokes memo factories in
 * dev, and getOrCreate() being a true memoized constructor (not "always
 * construct") means the second invocation returns the SAME processor rather
 * than leaking a duplicate AudioContext/Worker/WASM instance.
 */

interface ManagedProcessor {
    callId: string;
    processor: CipherlineVoiceProcessor;
}

let current: ManagedProcessor | null = null;

// Stable delegator callbacks handed to the CipherlineVoiceProcessor
// constructor. The actual callback implementations (which close over React
// state/toast functions) can change every render — routing through this
// indirection means CallPane can call updateCallbacks() on every render
// without ever needing to reconstruct the processor itself.
let latestCallbacks: VoiceProcessorCallbacks = {};

const stableCallbacks: VoiceProcessorCallbacks = {
    onVadProbability: (prob) => latestCallbacks.onVadProbability?.(prob),
    onInputLevel: (dbfs) => latestCallbacks.onInputLevel?.(dbfs),
    onNsAutoBypass: (active) => latestCallbacks.onNsAutoBypass?.(active),
    onNsStats: (stats) => latestCallbacks.onNsStats?.(stats),
    onNsUnavailable: () => latestCallbacks.onNsUnavailable?.(),
};

/**
 * Get the processor for this call, creating it if this is the first call for
 * `callId`. Safe to call on every render of the memo that owns it — repeat
 * calls with the same callId are a no-op beyond returning the existing
 * instance.
 */
export function getOrCreate(callId: string, settings: VoiceSettings): CipherlineVoiceProcessor {
    if (current && current.callId === callId) {
        return current.processor;
    }
    // A different (or absent) callId than what's currently held means a new
    // call started without the previous one being torn down — shouldn't
    // happen given CallPane is keyed by call.id and always calls
    // destroyForCall() on unmount/disconnect, but don't leak if it does.
    if (current) {
        console.warn(
            '[voiceProcessorManager] getOrCreate called for a new callId while a ' +
            'previous processor was still live — destroying the stale one first.'
        );
        void current.processor.destroy();
        current = null;
    }
    // 100 ms level poll: in a call the level only feeds the ~1 Hz silence
    // watchdog (micLevelRegistry), never a visible meter.
    const processor = new CipherlineVoiceProcessor(settings, stableCallbacks, { levelPollMs: CALL_LEVEL_POLL_MS });
    current = { callId, processor };
    return processor;
}

/** onInputLevel cadence for the call processor (see getOrCreate). */
export const CALL_LEVEL_POLL_MS = 100;

/** Update the delegator callbacks' targets — cheap, call on every render. */
export function updateCallbacks(callbacks: VoiceProcessorCallbacks): void {
    latestCallbacks = callbacks;
}

/**
 * Forward a settings change to the live processor, if any. No-op if there is
 * none (e.g. before the processor has finished attaching, or after
 * teardown).
 *
 * Deliberately NOT keyed by callId, unlike getOrCreate/destroyForCall: the
 * caller (SidebarConference, an effect running inside <LiveKitRoom>) has no
 * easy access to the LiveKit token CallPane used as the key — only its own
 * `apiToken` prop, which is an unrelated REST bearer token. Since this app
 * only ever has one call/processor live at a time (see the module doc
 * comment), applying a settings update to "whatever processor currently
 * exists" is unambiguous and avoids prop-drilling the LiveKit token through
 * CallSidebarPortal for no other purpose.
 */
export function updateSettings(settings: VoiceSettings): void {
    latestSettings = { ...settings };
    current?.processor.updateSettings(settings);
    if (bound) scheduleReconcile();
}

// ── Attach / detach: a processor only while some stage needs one ────────────
//
// With every per-user stage off (no NS, gate, EQ, AGC; mic volume 100 %) the
// call publishes the RAW capture with no processor and no WebAudio graph.
// Turning any stage on mid-call attaches the processor; turning the last one
// off detaches it. Both go through LiveKit's setProcessor / stopProcessor,
// which swap the track on the SAME RTCRtpSender with replaceTrack(): no
// unpublish, no renegotiation, the E2EE frame transform bound to that sender
// stays, and mute (the raw capture's `enabled`) is untouched. Push-to-talk
// works on that same mute, so it is unaffected too.

/** The slice of livekit-client's LocalAudioTrack this manager drives. */
export interface ProcessorHostTrack {
    getProcessor(): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setProcessor(processor: any): Promise<void>;
    stopProcessor(): Promise<void>;
    setAudioContext(ctx: AudioContext | undefined): void;
}

interface BoundTrack {
    callId: string;
    track: ProcessorHostTrack;
    /** Wraps each attach/detach (CallPane passes trackActivity for the call log). */
    run: <T>(fn: () => Promise<T>) => Promise<T>;
}

let bound: BoundTrack | null = null;
let latestSettings: VoiceSettings | null = null;
let reconcileChain: Promise<void> = Promise.resolve();
let reconcileQueued = false;

/**
 * The call's published mic track. Called by CallPane's MicProcessorBridge on
 * every microphone publication (a reconnect republish or a fresh publish is a
 * new call to this); from then on the processor is attached or detached to
 * match the settings. Returns once the first reconcile has settled.
 */
export function bindMicTrack(
    callId: string,
    track: ProcessorHostTrack,
    settings: VoiceSettings,
    run: BoundTrack['run'] = (fn) => fn(),
): Promise<void> {
    latestSettings = { ...settings };
    bound = { callId, track, run };
    return scheduleReconcile();
}

/** Serialised and coalesced: settings can change faster than LiveKit's
 *  trackChangeLock lets an attach finish, and only the latest state matters. */
function scheduleReconcile(): Promise<void> {
    if (reconcileQueued) return reconcileChain;
    reconcileQueued = true;
    reconcileChain = reconcileChain.then(async () => {
        reconcileQueued = false;
        await reconcile();
    }).catch((err) => {
        console.error('[voiceProcessorManager] attach/detach failed:', err);
    });
    return reconcileChain;
}

async function reconcile(): Promise<void> {
    const b = bound;
    const settings = latestSettings;
    if (!b || !settings) return;
    const attached = b.track.getProcessor();
    const need = voiceChainNeedsProcessor(settings);
    if (need) {
        if (attached) return; // ours (or one we must not replace) is already on
        // LocalAudioTrack.setProcessor() throws without an audioContext on the
        // track; the room's own may not exist yet — see getGuardAudioContext.
        if (!(b.track as unknown as { audioContext?: AudioContext }).audioContext) {
            b.track.setAudioContext(getGuardAudioContext());
        }
        const proc = getOrCreate(b.callId, settings);
        proc.updateSettings(settings);
        await b.run(() => b.track.setProcessor(proc));
        console.log('[voiceProcessorManager] voice processor attached to mic track');
        return;
    }
    if (!attached || attached !== current?.processor) return;
    try {
        // Destroys the processor (its graph, worklets, level timer) and puts
        // the raw capture back on the sender.
        await b.run(() => b.track.stopProcessor());
        console.log('[voiceProcessorManager] every voice stage is off — publishing the raw mic');
    } catch (err) {
        // stopProcessor destroys first and swaps the sender after; a failure in
        // between would leave the sender on a dead processed track (silence).
        // Put a processor back rather than risk that.
        console.error('[voiceProcessorManager] detach failed — re-attaching the processor:', err);
        const proc = getOrCreate(b.callId, settings);
        await b.run(() => b.track.setProcessor(proc));
        return;
    }
    // No processor → no level meter: don't leave the last reading standing in
    // for the silence watchdog (micLevelRegistry).
    latestCallbacks.onInputLevel?.(-Infinity);
}

/** Tear down the processor for this call. Safe to call even if it's already
 *  gone, or if `callId` doesn't match the currently-held one (no-op). */
export async function destroyForCall(callId: string): Promise<void> {
    if (bound?.callId === callId) bound = null;
    if (!current || current.callId !== callId) return;
    const toDestroy = current.processor;
    current = null;
    await toDestroy.destroy().catch(() => { /* best-effort */ });
}

/** For diagnostics (Phase 5) — the live processor for the current call, if any. */
export function getCurrentProcessor(): CipherlineVoiceProcessor | null {
    return current?.processor ?? null;
}

// ── Guard AudioContext ───────────────────────────────────────────────────────
// LocalAudioTrack.setProcessor() refuses to run without an audioContext on the
// track, but CipherlineVoiceProcessor treats the host context as optional and
// validates its sample rate anyway (falling back to its own when unusable).
// This lazy singleton exists purely to satisfy that guard deterministically —
// created at RNNOISE_SAMPLE_RATE so that when the processor DOES adopt it as
// the host context, it's already at the only rate RNNoise accepts. One per app
// lifetime (processor destroy() leaves host contexts open by design), and
// registered with the gesture-unlock registry like every other context here.
let guardCtx: AudioContext | null = null;
export function getGuardAudioContext(): AudioContext {
    if (!guardCtx || guardCtx.state === 'closed') {
        guardCtx = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: 'interactive' });
        if (guardCtx.state === 'suspended') {
            guardCtx.resume().catch(() => { /* retried by the gesture-unlock registry */ });
            registerCtxForUnlock(guardCtx);
        }
    }
    return guardCtx;
}
