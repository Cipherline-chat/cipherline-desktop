/**
 * Cipherline remote-participant audio playback.
 *
 * What this owns: ONE audio chain per (participant identity, source) — mic
 * and screenshare-audio handled separately. The chain is created on first
 * acquire, refcounted across all callers, torn down when the last caller
 * releases. Multiple tiles rendering the same participant ALL share the
 * same chain; previously each tile built its own MediaStreamSource → Gain
 * → ctx.destination triplet, and Web Audio summed them at the destination —
 * which is exactly the "doubled audio in fullscreen grid" symptom.
 *
 * Where N>1 acquirers happen:
 *   - Sidebar VideoTile + fullscreen VideoTile (same camera, two views)
 *   - Sidebar VideoTile + focused VideoTile + thumbnail VideoTile
 *   - ScreenShareGate + camera VideoTile (same participant)
 *   - ParticipantCard in audio-strip + any other tile
 *
 * Refcounted shared-chain semantics:
 *   - acquireMicChain / acquireSSAudioChain: returns existing chain or builds a
 *     new one. Increments refCount.
 *   - releaseMicChain / releaseSSAudioChain: decrements refCount; tears down
 *     when it hits 0.
 *   - If a caller acquires with different nsEnabled or a replaced track, the
 *     chain rebuilds its internals IN PLACE (Map entry stays valid, all
 *     concurrent acquirers transparently continue against the new internals,
 *     refCount preserved).
 *   - The chain's GainNode is the single point of volume / mute control —
 *     each useEffect that watches volume/mute writes idempotently to it.
 *     Multiple callers all write the same persistent volume value (it comes
 *     from usePersistentVolume which is per-participant), so writes don't
 *     fight.
 *
 * Lifecycle correctness:
 *   - Local participant is skipped (no self-monitor playback).
 *   - Screenshare-audio chain is gated on screenShareSubscribed AND defensively
 *     calls setSubscribed(false) when the caller hasn't opted in — this
 *     undoes LiveKit's autoSubscribe default, so we don't even decode the
 *     track until the user clicks Watch.
 *   - Per-participant noise suppression: if any caller flips nsEnabled, the
 *     chain rebuilds. Since usePersistentNsEnabled is a single source of
 *     truth per identity, callers always pass the same value — no thrashing.
 */
import secureLocalStore from '../utils/secureLocalStore';
import { useEffect, useRef } from 'react';
import { Participant, RemoteParticipant, RemoteTrackPublication, Track } from 'livekit-client';
import RNNoiseWorker from '../workers/rnnoise.worker?worker';
// Loaded on demand (~4.8 MB of vendored WASM glue) — see rnnoiseSources.ts.
import { loadInlineRnnoiseWorkletSource, loadRnnoiseWorkletSource } from '../utils/rnnoiseSources';
import { RNNOISE_SAMPLE_RATE, isUsableRnnoiseContext, RNNOISE_COMP_GAIN } from '../utils/voiceProcessor';
import { applyOutputDevice, unregisterOutputDeviceTarget, registerOutputAudioContext } from '../utils/audioOutput';
import { workletModuleUrl, forgetWorkletModuleUrl } from '../utils/workletModuleUrl';

// ── Shared AudioContext ─────────────────────────────────────────────────────
let sharedAudioCtx: AudioContext | null = null;
// Promise that resolves once a per-participant RNNoise processor is
// registered on the shared AudioContext. Any acquire that needs to construct
// an AudioWorkletNode must await this — otherwise the constructor races the
// addModule() and Chromium throws InvalidStateError ("AudioWorklet does not
// have a valid AudioContext"), which is exactly the symptom seen with 3+
// participants in a call (each new acquireMicChain attempted to construct a
// node before the module had finished registering).
let workletRegistered: Promise<void> | null = null;
// Phase 3 (reliability audit): which RNNoise design actually registered on
// the shared context — decided ONCE, at first getSharedAudioContext() call,
// then reused for every participant for the life of this context (rather
// than re-deciding per acquire, which would be wasteful and could leave
// different participants on inconsistent designs). 'inline' = RNNoise WASM
// runs synchronously inside the worklet itself (rnnoiseInWorkletSource.ts);
// 'worker' = the original design, a dedicated Worker per participant
// (rnnoise.worker.ts) feeding the worklet via MessageChannel. See
// voiceProcessor.ts's module doc comment for the full rationale — this
// mirrors the exact same try-inline-then-fall-back logic used there.
let sharedRnnoiseMode: 'inline' | 'worker' | null = null;
export const getSharedAudioContext = (): AudioContext | null => {
    if (!sharedAudioCtx) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        // 48 kHz matches WebRTC/Opus decode rate — no resampling needed for RNNoise
        if (AudioCtx) {
            sharedAudioCtx = new AudioCtx({ sampleRate: RNNOISE_SAMPLE_RATE });
            // THE playback sink for the whole call. Every participant chain
            // ends at this context's destination (the <audio> elements we
            // attach are muted — see buildMicInternals), so this, not those
            // elements, is what has to follow the user's speaker choice.
            // Without this registration `setSinkId` only ever moved silence
            // around and picking an output device changed nothing audible.
            registerOutputAudioContext(sharedAudioCtx);
            // Unlike the local mic chain (voiceProcessor), this context is ours
            // alone and is always constructed with an explicit rate, so it can't
            // inherit the hardware default the way LiveKit's does. Assert anyway:
            // the RNNoise worklet slices fixed 480-sample frames and would
            // silently produce garbage rather than fail if the UA ignored us.
            if (!isUsableRnnoiseContext(sharedAudioCtx.sampleRate)) {
                console.error(
                    `[ParticipantAudio] AudioContext is ${sharedAudioCtx.sampleRate} Hz, not ` +
                    `${RNNOISE_SAMPLE_RATE} Hz — per-participant noise suppression will be inaccurate.`
                );
            }
            // Eagerly register the worklet once. addModule itself is idempotent
            // (DOMException on re-register is harmless), but caching the
            // promise lets every later acquire await ONE resolution rather
            // than firing addModule N times with N races.
            // One Blob URL per source for the session, shared with the mic
            // processor's — see utils/workletModuleUrl.ts. The (large) source
            // text itself is loaded on demand — see rnnoiseSources.ts.
            const addModuleFromSource = (processorName: string, source: string) =>
                sharedAudioCtx!.audioWorklet.addModule(workletModuleUrl(processorName, source))
                    .catch((err) => { forgetWorkletModuleUrl(processorName); throw err; });
            workletRegistered = loadInlineRnnoiseWorkletSource()
                .then(source => addModuleFromSource('rnnoise-inline-worklet', source))
                .then(() => { sharedRnnoiseMode = 'inline'; })
                .catch((inlineErr) => {
                    console.warn(
                        '[ParticipantAudio] In-worklet RNNoise unavailable, falling back to the ' +
                        'Worker-fed design:', inlineErr
                    );
                    return loadRnnoiseWorkletSource().then(source => addModuleFromSource('rnnoise-worklet', source))
                        .then(() => { sharedRnnoiseMode = 'worker'; })
                        .catch(() => { /* already registered or transient — second await re-throws if real */ });
                });
        }
    }
    return sharedAudioCtx;
};

// ── Perceptual gain curve ───────────────────────────────────────────────────
// The slider maps slider-value → linear gain via a power curve. Pure linear
// (`gain = slider`) feels broken to users because human loudness perception
// is logarithmic — a slider sweep from 0.5 → 1.0 sounds tiny while 0 → 0.5
// drops off a cliff. With exponent 1.5:
//
//   slider 0.5 → gain ≈ 0.354 (≈ -9 dB)
//   slider 1.0 → gain  = 1.000 ( 0 dB, baseline unchanged)
//   slider 2.0 → gain ≈ 2.828 (≈ +9 dB) — meaningful boost, not a tiny nudge
//   slider 4.0 → gain ≈ 8.000 (≈ +18 dB) — rescue genuinely quiet peers
const PER_USER_GAIN_EXPONENT = 1.5;
const sliderToGain = (slider: number): number => Math.pow(Math.max(0, slider), PER_USER_GAIN_EXPONENT);

// ── Master incoming-volume gain ─────────────────────────────────────────────
// Every per-participant chain feeds into this single master gain instead of
// connecting straight to ctx.destination. That lets the Settings → Speaker
// Volume slider act as an actual master volume — previously it manipulated
// HTMLAudioElement.volume, which is a no-op when the element is muted (and
// it always is in our setup, since we play audio through WebAudio). Storage
// uses the same numeric range as useVoiceSettings.speakerVolume (0..200).
const MASTER_GAIN_STORAGE_KEY = 'cipherline_master_speaker_volume';
const MASTER_GAIN_EXPONENT = 1.5; // same perceptual curve as per-user
let masterGain: GainNode | null = null;

function readPersistedMasterSlider(): number {
    try {
        const v = secureLocalStore.getItem(MASTER_GAIN_STORAGE_KEY);
        if (v === null) return 100;
        const n = parseFloat(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(300, n)) : 100;
    } catch {
        return 100;
    }
}

function masterSliderToGain(slider: number): number {
    // Slider is 0..200 (matches Settings UI). Convert to 0..2.0 then apply
    // perceptual curve so 100 → 1.0 (unity), 200 → ~2.83 (≈ +9 dB).
    return Math.pow(Math.max(0, slider) / 100, MASTER_GAIN_EXPONENT);
}

// ── Master-bus limiter ───────────────────────────────────────────────────
// Safety net on the receive side: sender-side AGC (voiceProcessor.ts) now
// normalizes everyone's outgoing level, but that's a per-sender, best-effort
// slow adaptation — a sender who just joined (AGC still converging), has AGC
// off, or simply has a hot mic can still hand us a loud signal, and multiple
// participants' gains sum at the master bus regardless. Previously there was
// NO limiting anywhere on playback; this is a fast, mostly-transparent
// ceiling so a loud moment can't clip/distort at the OS mixer, without
// audibly squashing normal conversation (threshold is well above typical
// speech levels — it only engages on genuine peaks).
let masterLimiter: DynamicsCompressorNode | null = null;

function getMasterLimiter(ctx: AudioContext): DynamicsCompressorNode {
    if (!masterLimiter) {
        masterLimiter = ctx.createDynamicsCompressor();
        masterLimiter.threshold.value = -6;   // dBFS — only catches genuine peaks
        masterLimiter.knee.value = 0;         // hard knee — a limiter, not a leveller
        masterLimiter.ratio.value = 20;       // effectively brick-wall above threshold
        masterLimiter.attack.value = 0.001;   // 1ms — fast enough to catch transients
        masterLimiter.release.value = 0.1;    // 100ms — recovers quickly between peaks
        masterLimiter.connect(ctx.destination);
    }
    return masterLimiter;
}

export function getMasterGain(ctx: AudioContext): GainNode {
    if (!masterGain) {
        masterGain = ctx.createGain();
        masterGain.gain.value = masterSliderToGain(readPersistedMasterSlider());
        masterGain.connect(getMasterLimiter(ctx));
    }
    return masterGain;
}

/** Settings calls this when the speaker-volume slider moves. */
export function setMasterVolume(slider: number): void {
    try { secureLocalStore.setItem(MASTER_GAIN_STORAGE_KEY, String(slider)); } catch { /* quota */ }
    if (!sharedAudioCtx || !masterGain) return;
    const t = sharedAudioCtx.currentTime;
    const g = masterGain.gain;
    const cv = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(cv, t);
    g.setTargetAtTime(masterSliderToGain(slider), t, 0.01);
}

/**
 * Auto-resume the AudioContext after the first user gesture. Chrome / Electron
 * suspend the context when it's created without a gesture (cold app launch
 * before the user clicks anything), and our `await ctx.resume()` inside
 * acquireMicChain can fail silently — leaving every participant inaudible
 * until the user happens to cause another resume. Dashboard registers a
 * one-shot global listener that calls this so the resume is guaranteed.
 */
export function unlockAudioContext(): void {
    const ctx = sharedAudioCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        ctx.resume().catch((err) => {
            console.warn('[audio] context resume failed:', err);
        });
    }
}

// ── Per-user persisted volume read ──────────────────────────────────────────
// usePersistentVolume in VideoTile.tsx writes to the same key; reading here
// lets the chain rebuild path apply the user's chosen value to the freshly
// created gain node BEFORE returning, eliminating the race where the volume
// effect runs against an old / not-yet-built gain node. Default 1.0 matches
// usePersistentVolume's default.
function readPersistedPerUserVolume(identity: string, type: 'mic' | 'screen'): number {
    try {
        const v = secureLocalStore.getItem(`cipherline_vol_${type}_${identity}`);
        if (v === null) return 1;
        const n = parseFloat(v);
        return Number.isFinite(n) ? Math.max(0, n) : 1;
    } catch {
        return 1;
    }
}

// ── Mic chain store ─────────────────────────────────────────────────────────
interface MicChain {
    refCount: number;
    track: MediaStreamTrack;        // identity check for track replacement
    nsEnabled: boolean;             // identity check for NS rebuild
    pub: RemoteTrackPublication;
    attachedEl: HTMLMediaElement;   // silent <audio> needed to activate the track
    src: MediaStreamAudioSourceNode;
    gain: GainNode;                 // EXTERNAL volume/mute control surface
    nsWorklet?: AudioWorkletNode;
    nsWorker?: Worker;
}
const micChains = new Map<string, MicChain>();
// Per-identity in-flight build/rebuild promises. Without this, two concurrent
// acquireMicChain calls for the same identity (which happens whenever layout
// changes mount overlapping tiles — focus switch in fullscreen, fullscreen
// toggle going back to normal, sidebar↔grid VideoTile transitions) BOTH
// observed "no chain in Map" before either could set it (the await on
// ctx.resume / buildMicInternals sits between the read and the write).
// Both built a full audio graph, the second overwrote the first in the Map,
// and the first's src→gain→ctx.destination chain stayed CONNECTED but
// orphaned — that's the audio-doubling on layout change. Serializing per
// identity guarantees only one build's nodes ever reach the destination.
const micChainBuilds = new Map<string, Promise<MicChain>>();

interface SSAudioChain {
    refCount: number;
    track: MediaStreamTrack;
    pub: RemoteTrackPublication;
    attachedEl: HTMLMediaElement;
    src: MediaStreamAudioSourceNode;
    gain: GainNode;
}
const ssAudioChains = new Map<string, SSAudioChain>();

// ── Mic chain build / teardown ──────────────────────────────────────────────
async function buildMicInternals(
    ctx: AudioContext,
    pub: RemoteTrackPublication,
    track: MediaStreamTrack,
    nsEnabled: boolean,
    identity: string,
): Promise<Pick<MicChain, 'attachedEl' | 'src' | 'gain' | 'nsWorklet' | 'nsWorker'>> {
    // Activate the track in the browser's media pipeline. createMediaStreamSource
    // pulls audio frames only when the track is in some <audio>/<video> element
    // OR when the underlying RTP receiver has an active subscription — the
    // attach() call here is the canonical way to guarantee frames flow.
    const attachedEl = pub.track!.attach();
    attachedEl.volume = 0; // silent: actual playback goes through Web Audio
    // Route this attached element to the user's chosen output device. Without
    // this, every chain rebuild would default the new <audio> element to the
    // system speaker even if the user picked headphones in Settings.
    applyOutputDevice(attachedEl);

    const gain = ctx.createGain();
    // Seed the gain to the user's persisted slider value (with perceptual
    // curve applied). The volume-apply effect in the hook writes this value
    // again on its first run, but seeding here closes the race window where
    // a rebuild lands a fresh gain node at default 1.0 while the volume
    // effect's stale closure is still pointing at the discarded old node.
    gain.gain.value = sliderToGain(readPersistedPerUserVolume(identity, 'mic'));
    // Connect through the master gain so the Settings → Speaker Volume slider
    // can actually scale incoming audio (previously it was a no-op).
    gain.connect(getMasterGain(ctx));

    const src = ctx.createMediaStreamSource(new MediaStream([track]));

    let nsWorklet: AudioWorkletNode | undefined;
    let nsWorker: Worker | undefined;

    if (nsEnabled) {
        // Wait for the worklet processor to be registered on the AudioContext
        // before constructing the AudioWorkletNode. Without this, Chromium
        // throws InvalidStateError when 3+ participants call this in quick
        // succession — each acquire raced addModule and the constructor.
        if (workletRegistered) {
            try { await workletRegistered; } catch { /* already-registered exceptions are tolerated */ }
        }

        // Phase 3 (reliability audit): sharedRnnoiseMode is decided ONCE, at
        // first getSharedAudioContext() call (try in-worklet synchronous
        // RNNoise, fall back to the Worker-fed design) — every participant on
        // this shared context follows whichever one actually registered.
        // `?? 'worker'` is a defensive fallback for the (should be
        // unreachable, since this function only runs after
        // getSharedAudioContext() has already produced `ctx`) case where the
        // mode somehow wasn't set yet: the Worker-fed design is the
        // longer-proven of the two.
        const mode = sharedRnnoiseMode ?? 'worker';
        nsWorklet = new AudioWorkletNode(ctx, mode === 'inline' ? 'rnnoise-inline-worklet' : 'rnnoise-worklet', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        // Same +3.5 dB RNNoise compensation the local mic chain applies (see
        // RNNOISE_COMP_GAIN in voiceProcessor.ts) — the worklet only ever
        // applies it to samples it actually processed, so this is safe to set
        // unconditionally. Previously this path had NO compensation at all:
        // toggling per-participant NS on a peer silently dropped them 2-4 dB
        // relative to peers with it off, on top of the local-side inconsistency
        // that RNNOISE_COMP_GAIN already fixed. Shared with the local mic
        // chain (RNNOISE_COMP_GAIN in voiceProcessor.ts) either way.
        nsWorklet.port.postMessage({ type: 'compGain', value: RNNOISE_COMP_GAIN });

        if (mode === 'inline') {
            // No Worker at all for this participant — RNNoise runs directly
            // inside the worklet's own process() call. It manages its own
            // "ready" state internally; sending toggle immediately is safe
            // (the worklet stays in passthrough until it's actually loaded).
            nsWorklet.port.onmessage = ({ data }: MessageEvent) => {
                if (data.type === 'rnnoiseLoadFailed') {
                    console.warn('[useParticipantAudio] In-worklet RNNoise WASM load failed for', identity, '— NS unavailable:', data.error);
                }
            };
            nsWorklet.port.postMessage({ type: 'toggle', enabled: true });
        } else {
            nsWorker = new RNNoiseWorker();
            const channel = new MessageChannel();
            nsWorker.onmessage = ({ data }: MessageEvent) => {
                // P2-REND-12: Worker sends {type:'error'} on WASM load failure.
                // Guard prevents the Worker from leaking (previously this path
                // returned early and never terminated it).
                if (data.type === 'error') {
                    console.warn('[useParticipantAudio] RNNoise WASM load failed for', identity, '— NS unavailable:', data.error);
                    try { nsWorker!.terminate(); } catch { /* ignore */ }
                    return;
                }
                if (data.type !== 'ready') return;
                nsWorker!.onmessage = null; // one-shot
                // The chain may have already been torn down before WASM finished
                // loading — guard with a fresh lookup.
                const live = micChains.get(identity);
                if (!live || live.nsWorker !== nsWorker) {
                    try { nsWorker!.terminate(); } catch { /* ignore */ }
                    return;
                }
                nsWorklet!.port.postMessage(
                    { type: 'workerPort', port: channel.port2 },
                    [channel.port2],
                );
                nsWorklet!.port.postMessage({ type: 'toggle', enabled: true });
            };
            nsWorker.onerror = () => { try { nsWorker?.terminate(); } catch { /* ignore */ } };
            nsWorker.postMessage({ type: 'init' }, [channel.port1]);
        }

        src.connect(nsWorklet);
        nsWorklet.connect(gain);
    } else {
        src.connect(gain);
    }

    return { attachedEl, src, gain, nsWorklet, nsWorker };
}

function teardownMicInternals(chain: MicChain): void {
    try { chain.gain.disconnect(); } catch { /* ignore */ }
    try { chain.nsWorklet?.disconnect(); } catch { /* ignore */ }
    try { chain.src.disconnect(); } catch { /* ignore */ }
    if (chain.nsWorker) {
        try { chain.nsWorker.onmessage = null; } catch { /* ignore */ }
        try { chain.nsWorker.onerror = null; } catch { /* ignore */ }
        try { chain.nsWorker.postMessage({ type: 'destroy' }); } catch { /* ignore */ }
        const w = chain.nsWorker;
        // Brief delay so the destroy message has a chance to flush before terminate.
        setTimeout(() => { try { w.terminate(); } catch { /* ignore */ } }, 100);
    }
    unregisterOutputDeviceTarget(chain.attachedEl);
    try { chain.pub.track?.detach(chain.attachedEl); } catch { /* ignore */ }
}

async function acquireMicChain(p: RemoteParticipant, nsEnabled: boolean): Promise<MicChain | null> {
    const ctx = getSharedAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* ignore — Chrome auto-resumes on next user gesture */ }
    }

    const pub = p.getTrackPublication(Track.Source.Microphone) as RemoteTrackPublication | undefined;
    const track = pub?.track?.mediaStreamTrack;
    if (!pub || !track) return null;

    // Wait for any in-flight build/rebuild for this identity to complete
    // first. A loop in case a chained build kicks off another one before
    // we re-check the map. Without serialization here, two concurrent
    // acquires both observe a stale Map state, both call buildMicInternals,
    // and the second overwrites the first — audio doubles via the leaked
    // graph (see micChainBuilds comment).
    let inFlight = micChainBuilds.get(p.identity);
    while (inFlight) {
        try { await inFlight; } catch { /* ignore — propagated below if real */ }
        inFlight = micChainBuilds.get(p.identity);
    }

    let chain = micChains.get(p.identity);
    const needsRebuild = !!(chain && (chain.track !== track || chain.nsEnabled !== nsEnabled));

    if (!chain || needsRebuild) {
        const existing = chain;
        const buildPromise = (async (): Promise<MicChain> => {
            if (existing && needsRebuild) {
                // Rebuild internals in-place: tear the old, swap to a fresh set.
                // refCount is preserved — every existing acquirer is now reading
                // the same Map entry but with new internals.
                teardownMicInternals(existing);
                const internals = await buildMicInternals(ctx, pub, track, nsEnabled, p.identity);
                // P2-REND-6: if releaseMicChain fired during the async build it
                // removed existing from the map (refCount → 0). The new nodes are
                // already connected to the destination — tear them down so they
                // don't become an orphaned, un-releasable live audio graph.
                if (!micChains.has(p.identity)) {
                    teardownMicInternals({ refCount: 0, track, nsEnabled, pub, ...internals });
                    throw new Error('[audio] mic chain released during rebuild');
                }
                existing.track = track;
                existing.nsEnabled = nsEnabled;
                existing.pub = pub;
                existing.attachedEl = internals.attachedEl;
                existing.src = internals.src;
                existing.gain = internals.gain;
                existing.nsWorklet = internals.nsWorklet;
                existing.nsWorker = internals.nsWorker;
                return existing;
            }
            const internals = await buildMicInternals(ctx, pub, track, nsEnabled, p.identity);
            const newChain: MicChain = {
                refCount: 0,
                track,
                nsEnabled,
                pub,
                ...internals,
            };
            micChains.set(p.identity, newChain);
            return newChain;
        })();

        micChainBuilds.set(p.identity, buildPromise);
        try {
            chain = await buildPromise;
        } finally {
            // Only delete if we're still the latest build (a newer acquire
            // may have queued behind us and replaced the entry).
            if (micChainBuilds.get(p.identity) === buildPromise) {
                micChainBuilds.delete(p.identity);
            }
        }
    }

    chain.refCount++;
    return chain;
}

function releaseMicChain(identity: string): void {
    const chain = micChains.get(identity);
    if (!chain) return;
    chain.refCount--;
    if (chain.refCount <= 0) {
        teardownMicInternals(chain);
        micChains.delete(identity);
    }
}

// ── Screenshare-audio chain build / teardown ─────────────────────────────────
function buildSSAudioInternals(
    ctx: AudioContext,
    pub: RemoteTrackPublication,
    track: MediaStreamTrack,
    identity: string,
): Pick<SSAudioChain, 'attachedEl' | 'src' | 'gain'> {
    const attachedEl = pub.track!.attach();
    attachedEl.volume = 0;
    applyOutputDevice(attachedEl);
    const gain = ctx.createGain();
    // Same race-closing seed as the mic chain — apply the persisted slider
    // value (with perceptual curve) so a rebuild doesn't briefly default to 1.0.
    gain.gain.value = sliderToGain(readPersistedPerUserVolume(identity, 'screen'));
    gain.connect(getMasterGain(ctx));
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(gain);
    return { attachedEl, src, gain };
}

function teardownSSAudioInternals(chain: SSAudioChain): void {
    try { chain.gain.disconnect(); } catch { /* ignore */ }
    try { chain.src.disconnect(); } catch { /* ignore */ }
    unregisterOutputDeviceTarget(chain.attachedEl);
    try { chain.pub.track?.detach(chain.attachedEl); } catch { /* ignore */ }
}

function acquireSSAudioChain(p: RemoteParticipant): SSAudioChain | null {
    const ctx = getSharedAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });

    const pub = p.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
    const track = pub?.track?.mediaStreamTrack;
    if (!pub || !track) return null;

    let chain = ssAudioChains.get(p.identity);
    if (chain && chain.track !== track) {
        teardownSSAudioInternals(chain);
        const internals = buildSSAudioInternals(ctx, pub, track, p.identity);
        chain.track = track;
        chain.pub = pub;
        chain.attachedEl = internals.attachedEl;
        chain.src = internals.src;
        chain.gain = internals.gain;
    }
    if (!chain) {
        const internals = buildSSAudioInternals(ctx, pub, track, p.identity);
        chain = {
            refCount: 0,
            track,
            pub,
            ...internals,
        };
        ssAudioChains.set(p.identity, chain);
    }
    chain.refCount++;
    return chain;
}

function releaseSSAudioChain(identity: string): void {
    const chain = ssAudioChains.get(identity);
    if (!chain) return;
    chain.refCount--;
    if (chain.refCount <= 0) {
        teardownSSAudioInternals(chain);
        ssAudioChains.delete(identity);
    }
}

// ── Public hook ─────────────────────────────────────────────────────────────
export function useParticipantAudio(
    p: Participant,
    localParticipantIdentity: string | undefined,
    options: {
        volume: number;
        isLocalMuted: boolean;
        isLocalDeafened: boolean;
        isScreenShare?: boolean;
        screenShareVolume?: number;
        isScreenShareMuted?: boolean;
        nsEnabled?: boolean;
        screenShareSubscribed?: boolean;
    },
): void {
    const {
        volume, isLocalMuted, isLocalDeafened,
        isScreenShare, screenShareVolume, isScreenShareMuted,
        nsEnabled = false, screenShareSubscribed = false,
    } = options;
    const isLocal = p.identity === localParticipantIdentity;

    // Track presence as deps so the effect re-runs when the publisher
    // (un)mutes / replaces / adds the track. We pull these at hook-call time
    // because RemoteParticipant doesn't expose change events through React.
    const remote = p as RemoteParticipant;
    const micTrack = remote.getTrackPublication?.(Track.Source.Microphone)?.track?.mediaStreamTrack;
    const ssAudioTrack = remote.getTrackPublication?.(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack;

    // Always-current refs for volume state so the async acquire .then() can
    // apply the correct gain immediately after the chain is built or rebuilt.
    // The volume effect also writes, but it runs synchronously and may see an
    // absent or stale chain entry when a track is replaced (server-mute/unmute
    // publishes a new MediaStreamTrack). Without the re-apply here, the rebuilt
    // chain's gain stays at the localStorage-seeded default and isLocalMuted /
    // isLocalDeafened are never honoured until the next volume-effect trigger.
    const volumeRef = useRef(volume);
    const isLocalMutedRef = useRef(isLocalMuted);
    const isLocalDeafenedRef = useRef(isLocalDeafened);
    volumeRef.current = volume;
    isLocalMutedRef.current = isLocalMuted;
    isLocalDeafenedRef.current = isLocalDeafened;

    // ── Mic chain ref-counted acquire ───────────────────────────────────────
    // acquireMicChain is async (it awaits the worklet-module registration to
    // avoid the InvalidStateError race when 3+ participants land in quick
    // succession). useEffect can't itself be async — we wrap with a
    // cancellation flag. If the effect cleans up before acquire resolves,
    // the resolved chain still gets refcount++'d (acquire side-effects
    // happen even on cancel), so we ALWAYS release on cleanup to keep the
    // refcount balanced.
    useEffect(() => {
        if (isLocal) return;
        if (!micTrack) return;
        let cancelled = false;
        let acquired = false;
        acquireMicChain(remote, nsEnabled).then(chain => {
            if (cancelled) {
                // Component unmounted before chain finished building.
                // The refcount was still incremented by acquire — release
                // immediately so we don't leak the chain.
                if (chain) releaseMicChain(p.identity);
                return;
            }
            acquired = !!chain;
            // Re-apply volume immediately after the (possibly async) chain
            // build/rebuild. The synchronous volume effect ran against a missing
            // or stale gain entry — this write corrects it using the latest values
            // via the always-current refs above.
            if (chain) {
                chain.gain.gain.value = (isLocalMutedRef.current || isLocalDeafenedRef.current)
                    ? 0
                    : sliderToGain(volumeRef.current);
            }
        }).catch(err => {
            console.warn('[useParticipantAudio] mic chain acquire failed:', err);
        });
        return () => {
            cancelled = true;
            if (acquired) releaseMicChain(p.identity);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLocal, p.identity, nsEnabled, micTrack]);

    // Volume / mute apply to the SHARED gain. Idempotent: every caller writes
    // the same persistent-volume value (per-identity localStorage), so even
    // with N tiles all running this effect, the writes don't fight.
    //
    // The chain lookup is intentionally fresh on every effect run (not closed
    // over from acquire) — chain objects are mutated in place during rebuilds,
    // so re-reading from the Map gets the latest gain node reference.
    useEffect(() => {
        if (isLocal) return;
        const chain = micChains.get(p.identity);
        if (!chain) return;
        chain.gain.gain.value = (isLocalMuted || isLocalDeafened) ? 0 : sliderToGain(volume);
    }, [isLocal, p.identity, volume, isLocalMuted, isLocalDeafened, micTrack, nsEnabled]);

    // ── Screenshare-audio chain ref-counted acquire ─────────────────────────
    useEffect(() => {
        if (isLocal || !isScreenShare) return;
        const pub = remote.getTrackPublication?.(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
        if (!screenShareSubscribed) {
            // Defensively undo LiveKit's autoSubscribe so we don't even
            // decode audio the user hasn't opted in to.
            if (pub?.isSubscribed) {
                try { pub.setSubscribed(false); } catch { /* ignore */ }
            }
            return;
        }
        if (!ssAudioTrack) return;
        const chain = acquireSSAudioChain(remote);
        if (!chain) return;
        return () => releaseSSAudioChain(p.identity);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLocal, isScreenShare, screenShareSubscribed, p.identity, ssAudioTrack]);

    useEffect(() => {
        if (isLocal || !isScreenShare) return;
        const chain = ssAudioChains.get(p.identity);
        if (!chain) return;
        chain.gain.gain.value = (isLocalDeafened || isScreenShareMuted) ? 0 : sliderToGain(screenShareVolume ?? 1);
    }, [isLocal, isScreenShare, p.identity, screenShareVolume, isLocalDeafened, isScreenShareMuted, ssAudioTrack]);
}
