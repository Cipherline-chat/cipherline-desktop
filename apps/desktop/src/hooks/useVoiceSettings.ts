import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { voiceChainNeedsProcessor } from '../utils/voiceChain';
import { MAX_VOLUME_PERCENT } from '../utils/volumeLimits';
import { deviceHintOf } from '../utils/deviceResolve';
import { DEFAULT_ECHO_CANCELLATION, resolveEchoCancellation } from '../utils/audioInput';
import { migrateVoiceDefaults } from '../utils/voiceDefaultsMigration';
import { onOutputDeviceChange, refreshOutputDevices } from '../utils/audioOutput';
import { setIncomingLevelerEnabled } from '../utils/incomingLeveler';
import { isNoiseSuppressionMode, type NoiseSuppressionMode } from '../utils/nsLatency';
import { clampGateDb, type AudioEngine } from '../utils/clAudioSettings';
import { useAudioDeviceProfiles } from './useAudioDeviceProfiles';
import { effectiveEchoCancellation, resolveEchoAutoFlag, type OutputKind } from '../utils/outputKind';
import { useOutputKind } from '../utils/outputKindProbe';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceSettings {
    noiseSuppression: boolean;
    /** Which engine runs when noiseSuppression is on: 'strong' = RNNoise (speech-trained
     *  network, deepest cleanup, ~39 ms), 'light' = Speex (steady-floor denoiser, keeps
     *  whistling / whispering, ~2.7 ms). See utils/nsLatency.ts. */
    noiseSuppressionMode: NoiseSuppressionMode;
    // Chromium's acoustic echo cancellation on the mic capture (audioInput.ts
    // micCaptureConstraints). While `echoCancellationAuto` is true this field is only the
    // remembered boolean and the EFFECTIVE value (what `settings.echoCancellation` reads
    // as from the hook) follows the output device: on for speakers / unknown, off for
    // headphones (utils/outputKind.ts). Once the user picks On or Off it is that choice.
    // Applied live mid-call.
    echoCancellation: boolean;
    // True until the user explicitly picks On/Off in Settings (or the in-call prompt). A saved
    // blob from before this flag existed also starts on Auto (owner, 2026-11-16; resolveEchoAutoFlag):
    // only a choice made in the On / Auto / Off setting is kept.
    echoCancellationAuto: boolean;
    volumeNormalization: boolean;
    /** Which mic pipeline runs. Always 'v2' now: the Rust/WebAssembly call-audio engine is the only engine (owner, 2026-11-20;
     *  utils/clAudioSettings.ts says how the other settings map onto it). loadVoiceSettings() and the hook force it, whatever was
     *  saved, so no UI or backup can leave a user on 'legacy'. The legacy in-page chain is kept only as the silent fallback for a
     *  call whose engine fails to build or start (voiceProcessor.ts). Rides in the voice-settings backup. */
    audioEngine?: AudioEngine;
    // "Normalize voice volume" (Settings -> Voice & Video -> Output): a gentle
    // per-talker leveler on what you HEAR, behind everyone's own sender-side
    // auto gain control. Default ON; applied live. See utils/incomingLeveler.ts.
    normalizeIncomingVolume: boolean;
    voiceGate: boolean;
    voiceGateThreshold: number; // dBFS, range -60 to -20; the gate's fixed threshold (default -45)
    /** The new audio engine's MANUAL noise gate (utils/clAudioSettings.ts): off by default, and the legacy voiceGate /
     *  voiceGateThreshold above are ignored under it. Absent = off. Device-wide, not remembered per microphone. */
    voiceGateManual?: boolean;
    /** Its fixed threshold, dBFS of the raw mic input (-80..-20, default -55). */
    voiceGateManualDb?: number;
    pushToTalk: boolean;
    pushToTalkKey: string | null;
    /** Hold this key to be muted (normal voice-activity mode only; inert while push-to-talk is on). null = off. */
    pushToMuteKey: string | null;
    micDeviceId: string;
    speakerDeviceId: string;
    cameraDeviceId: string;
    // Label + groupId of the picked mic / speakers, recorded at selection so a
    // pick whose id changed (Windows re-enumeration) is still found — see
    // utils/deviceResolve.ts. '' / absent = unknown (older saved settings).
    micDeviceLabel?: string;
    micDeviceGroupId?: string;
    speakerDeviceLabel?: string;
    speakerDeviceGroupId?: string;
    micVolume: number;    // 0-MIC_VOLUME_MAX (200), default 100 (100 = unity gain)
    speakerVolume: number; // 0-200, default 100
    // 5-band parametric EQ: [80Hz, 250Hz, 1kHz, 4kHz, 12kHz], gain in dB (-12 to +12)
    eqEnabled: boolean;
    eqBands: number[];
    // Camera picture settings
    cameraBrightness: number;  // 0-200, default 100
    cameraContrast: number;    // 0-200, default 100
    cameraSaturation: number;  // 0-200, default 100
}

/**
 * Keys that used to live in the saved blob and no longer mean anything.
 * `endCallOnCreatorLeaveDefault` was the per-user "end the call for everyone
 * when I leave" default for calls I start; that is now a Calls CHANNEL setting
 * (Calls channel settings -> Call behavior), so a saved value is ignored and
 * dropped on load instead of being carried (and re-saved) forever.
 */
// voiceGateAuto: the automatic voice gate was removed 2026-11-17 (owner: back to the fixed threshold). A saved
// flag is dropped; the saved voiceGateThreshold (default -45, i.e. exactly the pre-auto default) is what the gate uses.
export const RETIRED_VOICE_SETTING_KEYS = ['endCallOnCreatorLeaveDefault', 'voiceGateAuto'] as const;

export const VOICE_SETTINGS_STORAGE_KEY = 'cipherline_voice_settings';

/** Highest mic boost the UI allows (% of unity). Saved values above this
 *  (from when the slider went to 300) are clamped on load. */
export const MIC_VOLUME_MAX = MAX_VOLUME_PERCENT;
/** Highest output volume the UI allows — same 200% ceiling as the mic. */
export const SPEAKER_VOLUME_MAX = MAX_VOLUME_PERCENT;
const STORAGE_KEY = VOICE_SETTINGS_STORAGE_KEY;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
    noiseSuppression: true,
    // Light (Speex, ~2.7 ms) for NEW installs / devices: near-zero latency and it keeps
    // whistling / whispering. Existing users are untouched: loadVoiceSettings() keeps
    // whatever they saved, and a blob from before the mode existed loads as Strong.
    noiseSuppressionMode: 'light',
    echoCancellation: DEFAULT_ECHO_CANCELLATION,
    echoCancellationAuto: true,
    volumeNormalization: true,
    audioEngine: 'v2',
    normalizeIncomingVolume: true,
    voiceGate: true,
    voiceGateThreshold: -45,
    voiceGateManual: false,
    voiceGateManualDb: -55,
    pushToTalk: false,
    // No default key (owner decision 2026-11-16): the user picks one when they turn push-to-talk on. Until
    // then the mic stays closed. Any key, including a bare modifier such as Alt, can be bound.
    pushToTalkKey: null,
    pushToMuteKey: null,
    micDeviceId: '',
    speakerDeviceId: '',
    cameraDeviceId: '',
    micVolume: 100,
    speakerVolume: 100,
    eqEnabled: false,
    eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100,
    cameraContrast: 100,
    cameraSaturation: 100,
};


/** Re-resolve the speaker pick against the devices plugged in right now. */
function resyncOutputDevices(): void {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.enumerateDevices?.()
        .then(devices => refreshOutputDevices(devices.filter(d => d.kind === 'audiooutput')))
        .catch(() => { /* enumeration can throw pre-permission */ });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function loadVoiceSettings(): VoiceSettings {
    migrateVoiceDefaults();
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
        const saved = JSON.parse(raw);
        const merged = { ...DEFAULT_VOICE_SETTINGS, ...saved };
        // Saved before this setting existed → default (ON); a non-boolean → default.
        merged.echoCancellation = resolveEchoCancellation(merged.echoCancellation);
        // No Auto flag yet (saved before the On / Auto / Off setting): Auto (see resolveEchoAutoFlag).
        merged.echoCancellationAuto = resolveEchoAutoFlag(saved);
        if (typeof merged.micVolume === 'number') merged.micVolume = Math.min(merged.micVolume, MIC_VOLUME_MAX);
        // Output used to go to 300%; an existing user above the ceiling comes down to it.
        if (typeof merged.speakerVolume === 'number') merged.speakerVolume = Math.min(merged.speakerVolume, SPEAKER_VOLUME_MAX);
        // A saved blob with no valid mode (written before the mode existed, or hand-edited)
        // -> Strong, the engine every existing user has been on. NOT the new-install default
        // (Light): that only applies when nothing was ever saved, so no one's audio flips.
        if (!isNoiseSuppressionMode(saved?.noiseSuppressionMode)) merged.noiseSuppressionMode = 'strong';
        // The new engine is the only engine: a saved 'legacy', no value, or junk all load as 'v2' (owner, 2026-11-20).
        merged.audioEngine = 'v2';
        // The manual gate is on only when the saved value is exactly true; its threshold is clamped (a hand edit, an older build).
        merged.voiceGateManual = saved?.voiceGateManual === true;
        merged.voiceGateManualDb = clampGateDb(saved?.voiceGateManualDb);
        // Push-to-talk on with no key stays unbound (the UI asks for a key; the mic stays closed). A saved key, Alt included, is kept.
        if (typeof merged.pushToTalkKey !== 'string' || merged.pushToTalkKey === '') merged.pushToTalkKey = null;
        for (const k of RETIRED_VOICE_SETTING_KEYS) delete (merged as Record<string, unknown>)[k];
        return merged;
    } catch {
        return { ...DEFAULT_VOICE_SETTINGS };
    }
}

/**
 * `userId`: the signed-in account, for the per-device audio profiles
 * (useAudioDeviceProfiles). Without it everything works as before, just
 * without remembering settings per device.
 */
export function useVoiceSettings(userId?: string | null) {
    const [settings, setSettings] = useState<VoiceSettings>(loadVoiceSettings);
    // Latest settings for setEqBand's read-modify-write (synced after each render).
    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

    // Real-time audio level indicators (P2-REND-1: kept as refs so callbacks don't
    // enter the memo deps and cause 50 Hz re-renders of the entire Dashboard during calls).
    // Components that need live levels (e.g. VoiceVideoSettings) maintain their own state.
    const vadProbabilityRef = useRef(0);
    const currentInputLevelRef = useRef(-Infinity);

    // Persist
    useEffect(() => {
        try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* persisting a UI preference is best-effort; a failed write must not break the UI */ }
    }, [settings]);

    const apply = useCallback((partial: Partial<VoiceSettings>) => {
        setSettings(prev => ({ ...prev, ...partial }));
    }, []);

    // Per-device audio settings: a device's saved settings are applied through
    // `apply` (never recorded back), and every change made through the setters
    // below is saved for the device it applies to.
    const { api: deviceProfiles, recordUserChange } = useAudioDeviceProfiles(userId, settings, apply);

    const update = useCallback((partial: Partial<VoiceSettings>) => {
        setSettings(prev => ({ ...prev, ...partial }));
        recordUserChange(partial);
    }, [recordUserChange]);

    const setNoiseSuppression    = useCallback((v: boolean) => update({ noiseSuppression: v }), [update]);
    const setNoiseSuppressionMode = useCallback((v: NoiseSuppressionMode) => { if (isNoiseSuppressionMode(v)) update({ noiseSuppressionMode: v }); }, [update]);
    // An explicit On/Off is a user choice: it stops the Auto behaviour for good (until Auto is picked again).
    const setEchoCancellation      = useCallback((v: boolean) => update({ echoCancellation: v, echoCancellationAuto: false }), [update]);
    // Back to Auto. Not recorded per device (it is not a per-mic value).
    const setEchoCancellationAuto  = useCallback(() => setSettings(prev => ({ ...prev, echoCancellationAuto: true })), []);
    const setVolumeNormalization = useCallback((v: boolean) => update({ volumeNormalization: v }), [update]);
    const setNormalizeIncomingVolume = useCallback((v: boolean) => update({ normalizeIncomingVolume: v }), [update]);
    const setVoiceGate           = useCallback((v: boolean) => update({ voiceGate: v }), [update]);
    const setVoiceGateThreshold  = useCallback((v: number) => update({ voiceGateThreshold: Math.max(-60, Math.min(-20, v)) }), [update]);
    // The manual noise gate: device-wide (not recorded per microphone, so plain setSettings).
    const setVoiceGateManual     = useCallback((v: boolean) => setSettings(prev => ({ ...prev, voiceGateManual: v === true })), []);
    const setVoiceGateManualDb   = useCallback((v: number) => setSettings(prev => ({ ...prev, voiceGateManualDb: clampGateDb(v) })), []);
    const setPushToTalk          = useCallback((v: boolean) => update({ pushToTalk: v }), [update]);
    const setPushToTalkKey       = useCallback((v: string | null) => update({ pushToTalkKey: v }), [update]);
    const setPushToMuteKey       = useCallback((v: string | null) => update({ pushToMuteKey: v }), [update]);
    /** `device`: the picked MediaDeviceInfo (or its label/groupId), so the pick
     *  can be found again if its id changes. Omit only for "follow the default". */
    const setMicDeviceId         = useCallback((v: string, device?: Pick<MediaDeviceInfo, 'label' | 'groupId'> | null) => {
        const h = deviceHintOf(v ? device : null);
        update({ micDeviceId: v, micDeviceLabel: h.label, micDeviceGroupId: h.groupId });
    }, [update]);
    const setSpeakerDeviceId     = useCallback((v: string, device?: Pick<MediaDeviceInfo, 'label' | 'groupId'> | null) => {
        const h = deviceHintOf(v ? device : null);
        update({ speakerDeviceId: v, speakerDeviceLabel: h.label, speakerDeviceGroupId: h.groupId });
    }, [update]);
    const setCameraDeviceId      = useCallback((v: string) => update({ cameraDeviceId: v }), [update]);
    // Debounced rather than the plain update()-on-every-call every other
    // setter uses. ClSlider fires on a RAF during a drag (up to ~60Hz), and
    // anyProcessingEnabled below treats micVolume !== 100 as "processing is
    // on" — so a drag that crosses exactly 100 was tearing down and rebuilding
    // the whole voice-processor worklet chain on every frame it hovered near
    // the boundary (SidebarConference's processor-attach effect creates/
    // destroys CipherlineVoiceProcessor on that transition). The trailing
    // timer still lands on the exact final value: ClSlider's release fires
    // one more onChange with the committed number, which just becomes the
    // last scheduled write.
    const micVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const setMicVolume = useCallback((v: number) => {
        const clamped = Math.max(0, Math.min(MIC_VOLUME_MAX, v));
        if (micVolumeTimerRef.current) clearTimeout(micVolumeTimerRef.current);
        micVolumeTimerRef.current = setTimeout(() => update({ micVolume: clamped }), 120);
    }, [update]);
    useEffect(() => () => { if (micVolumeTimerRef.current) clearTimeout(micVolumeTimerRef.current); }, []);
    const setSpeakerVolume       = useCallback((v: number) => update({ speakerVolume: Math.max(0, Math.min(SPEAKER_VOLUME_MAX, v)) }), [update]);
    const setEqEnabled           = useCallback((v: boolean) => update({ eqEnabled: v }), [update]);
    const setEqBand              = useCallback((index: number, gain: number) => {
        const bands = [...settingsRef.current.eqBands];
        bands[index] = Math.max(-12, Math.min(12, gain));
        // Read-modify-write against the latest render; a drag fires one band at
        // a time, so two bands never race inside one frame.
        settingsRef.current = { ...settingsRef.current, eqBands: bands };
        update({ eqBands: bands });
    }, [update]);
    const resetEqBands           = useCallback(() => update({ eqBands: [0, 0, 0, 0, 0] }), [update]);
    const setCameraBrightness    = useCallback((v: number) => update({ cameraBrightness: Math.max(0, Math.min(200, v)) }), [update]);
    const setCameraContrast      = useCallback((v: number) => update({ cameraContrast: Math.max(0, Math.min(200, v)) }), [update]);
    const setCameraSaturation    = useCallback((v: number) => update({ cameraSaturation: Math.max(0, Math.min(200, v)) }), [update]);
    const resetCameraPicture     = useCallback(() => update({ cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100 }), [update]);

    /** True if any processing feature is enabled — the same rule
     *  voiceProcessorManager uses to attach the voice processor at all (see
     *  utils/voiceChain.ts). NS is included — it is handled by the
     *  AudioWorklet+RNNoise pipeline inside CipherlineVoiceProcessor, not by the
     *  browser constraint. */
    const anyProcessingEnabled = voiceChainNeedsProcessor(settings);

    // ── Incoming-volume leveler, for the whole session ──────────────────────
    // Module state read by the call audio chains (useParticipantAudio); only a
    // strict `false` turns it off, so a saved blob from before this setting
    // existed (field missing) gets the default (ON).
    const normalizeIncoming = settings.normalizeIncomingVolume !== false;
    useEffect(() => { setIncomingLevelerEnabled(normalizeIncoming); }, [normalizeIncoming]);

    // ── Output device routing, for the whole session ──────────────────────
    // This hook lives as long as the signed-in app, so this is the one place
    // the speaker setting is applied — in a call or not. It used to be applied
    // only from inside a call (SidebarConference), so a pick made in Settings
    // outside a call left "Listen to mic", sound previews and notification
    // sounds on the previous device. Runs once at startup with the persisted
    // pick, then on every change from any picker.
    const { speakerDeviceId, speakerDeviceLabel, speakerDeviceGroupId } = settings;
    useEffect(() => {
        onOutputDeviceChange(speakerDeviceId, { label: speakerDeviceLabel, groupId: speakerDeviceGroupId });
        // Resolve it against what is plugged in right now (a pick that is gone
        // plays through the default; one with a new id is followed).
        resyncOutputDevices();
    }, [speakerDeviceId, speakerDeviceLabel, speakerDeviceGroupId]);
    // ...and again on every device change: the pick unplugged → the system
    // default (one notice, in a call); plugged back in → routed to it again.
    useEffect(() => {
        const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
        if (!md?.addEventListener) return;
        md.addEventListener('devicechange', resyncOutputDevices);
        return () => md.removeEventListener('devicechange', resyncOutputDevices);
    }, []);

    // Stable setter callbacks that write into refs — safe to include in voiceProcessor
    // options without entering the memo deps (P2-REND-1).
    const setVadProbability    = useCallback((v: number) => { vadProbabilityRef.current    = v; }, []);
    const setCurrentInputLevel = useCallback((v: number) => { currentInputLevelRef.current = v; }, []);

    // ── Echo cancellation: the stored choice, resolved against the output device ──
    // Every consumer (call capture constraints, mic warm-up, Settings meter, the live
    // toggle that re-opens the mic) reads `settings.echoCancellation`, so resolving it
    // HERE makes the auto default, and its re-evaluation on a device change, reach all
    // of them - including mid-call - without each knowing about Auto.
    const { kind: outputKind, source: outputKindSource } = useOutputKind(settings.speakerDeviceId);
    const echoEffective = effectiveEchoCancellation({ auto: settings.echoCancellationAuto, stored: settings.echoCancellation, kind: outputKind });
    const effectiveSettings = useMemo<VoiceSettings>(
        // audioEngine is pinned to 'v2' here too (not only at load): an in-memory value from any other path cannot select the legacy chain.
        () => (settings.echoCancellation === echoEffective && settings.audioEngine === 'v2' ? settings : { ...settings, echoCancellation: echoEffective, audioEngine: 'v2' }),
        [settings, echoEffective],
    );
    const echoAuto = useMemo(
        () => ({ auto: settings.echoCancellationAuto, outputKind: outputKind as OutputKind, outputKindSource }),
        [settings.echoCancellationAuto, outputKind, outputKindSource],
    );

    return useMemo(() => ({
        settings: effectiveSettings,
        echoAuto,
        anyProcessingEnabled,
        deviceProfiles,
        setNoiseSuppression,
        setNoiseSuppressionMode,
        setEchoCancellation,
        setEchoCancellationAuto,
        setVolumeNormalization,
        setNormalizeIncomingVolume,
        setVoiceGate,
        setVoiceGateThreshold,
        setVoiceGateManual,
        setVoiceGateManualDb,
        setPushToTalk,
        setPushToTalkKey,
        setPushToMuteKey,
        setMicDeviceId,
        setSpeakerDeviceId,
        setCameraDeviceId,
        setMicVolume,
        setSpeakerVolume,
        setEqEnabled,
        setEqBand,
        resetEqBands,
        setCameraBrightness,
        setCameraContrast,
        setCameraSaturation,
        resetCameraPicture,
        setVadProbability,
        setCurrentInputLevel,
    }), [
        effectiveSettings, echoAuto, anyProcessingEnabled, deviceProfiles,
        setNoiseSuppression,
        setNoiseSuppressionMode,
        setEchoCancellation,
        setEchoCancellationAuto,
        setVolumeNormalization,
        setNormalizeIncomingVolume,
        setVoiceGate, setVoiceGateThreshold, setVoiceGateManual, setVoiceGateManualDb,
        setPushToTalk, setPushToTalkKey, setPushToMuteKey,
        setMicDeviceId, setSpeakerDeviceId, setCameraDeviceId,
        setMicVolume, setSpeakerVolume,
        setEqEnabled, setEqBand, resetEqBands,
        setCameraBrightness, setCameraContrast, setCameraSaturation, resetCameraPicture,
        setVadProbability, setCurrentInputLevel,
    ]);
}

export type VoiceSettingsHook = ReturnType<typeof useVoiceSettings>;
