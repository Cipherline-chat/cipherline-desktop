import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { voiceChainNeedsProcessor } from '../utils/voiceChain';
import { MAX_VOLUME_PERCENT } from '../utils/volumeLimits';
import { deviceHintOf } from '../utils/deviceResolve';
import { DEFAULT_ECHO_CANCELLATION, resolveEchoCancellation } from '../utils/audioInput';
import { onOutputDeviceChange, refreshOutputDevices } from '../utils/audioOutput';
import { setIncomingLevelerEnabled } from '../utils/incomingLeveler';
import { isNoiseSuppressionMode, type NoiseSuppressionMode } from '../utils/nsLatency';
import { useAudioDeviceProfiles } from './useAudioDeviceProfiles';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceSettings {
    noiseSuppression: boolean;
    /** Which engine runs when noiseSuppression is on: 'strong' = RNNoise (speech-trained
     *  network, deepest cleanup, ~39 ms), 'light' = Speex (steady-floor denoiser, keeps
     *  whistling / whispering, ~2.7 ms). See utils/nsLatency.ts. */
    noiseSuppressionMode: NoiseSuppressionMode;
    // Chromium's acoustic echo cancellation on the mic capture (audioInput.ts
    // micCaptureConstraints). Default ON; applied live mid-call.
    echoCancellation: boolean;
    volumeNormalization: boolean;
    // "Normalize voice volume" (Settings -> Voice & Video -> Output): a gentle
    // per-talker leveler on what you HEAR, behind everyone's own sender-side
    // auto gain control. Default ON; applied live. See utils/incomingLeveler.ts.
    normalizeIncomingVolume: boolean;
    voiceGate: boolean;
    voiceGateThreshold: number; // dBFS, range -60 to -20
    pushToTalk: boolean;
    pushToTalkKey: string | null;
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
export const RETIRED_VOICE_SETTING_KEYS = ['endCallOnCreatorLeaveDefault'] as const;

export const VOICE_SETTINGS_STORAGE_KEY = 'cipherline_voice_settings';

/** Highest mic boost the UI allows (% of unity). Saved values above this
 *  (from when the slider went to 300) are clamped on load. */
export const MIC_VOLUME_MAX = MAX_VOLUME_PERCENT;
/** Highest output volume the UI allows — same 200% ceiling as the mic. */
export const SPEAKER_VOLUME_MAX = MAX_VOLUME_PERCENT;
const STORAGE_KEY = VOICE_SETTINGS_STORAGE_KEY;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
    noiseSuppression: true,
    noiseSuppressionMode: 'strong',
    echoCancellation: DEFAULT_ECHO_CANCELLATION,
    volumeNormalization: true,
    normalizeIncomingVolume: true,
    voiceGate: true,
    voiceGateThreshold: -45,
    pushToTalk: false,
    pushToTalkKey: null,
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
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
        const merged = { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(raw) };
        // Saved before this setting existed → default (ON); a non-boolean → default.
        merged.echoCancellation = resolveEchoCancellation(merged.echoCancellation);
        if (typeof merged.micVolume === 'number') merged.micVolume = Math.min(merged.micVolume, MIC_VOLUME_MAX);
        // Output used to go to 300%; an existing user above the ceiling comes down to it.
        if (typeof merged.speakerVolume === 'number') merged.speakerVolume = Math.min(merged.speakerVolume, SPEAKER_VOLUME_MAX);
        // Saved before the mode existed (or hand-edited) -> the engine everyone had until now.
        if (!isNoiseSuppressionMode(merged.noiseSuppressionMode)) merged.noiseSuppressionMode = 'strong';
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
    const setEchoCancellation      = useCallback((v: boolean) => update({ echoCancellation: v }), [update]);
    const setVolumeNormalization = useCallback((v: boolean) => update({ volumeNormalization: v }), [update]);
    const setNormalizeIncomingVolume = useCallback((v: boolean) => update({ normalizeIncomingVolume: v }), [update]);
    const setVoiceGate           = useCallback((v: boolean) => update({ voiceGate: v }), [update]);
    const setVoiceGateThreshold  = useCallback((v: number) => update({ voiceGateThreshold: Math.max(-60, Math.min(-20, v)) }), [update]);
    const setPushToTalk          = useCallback((v: boolean) => update({ pushToTalk: v }), [update]);
    const setPushToTalkKey       = useCallback((v: string | null) => update({ pushToTalkKey: v }), [update]);
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

    return useMemo(() => ({
        settings,
        anyProcessingEnabled,
        deviceProfiles,
        setNoiseSuppression,
        setNoiseSuppressionMode,
        setEchoCancellation,
        setVolumeNormalization,
        setNormalizeIncomingVolume,
        setVoiceGate,
        setVoiceGateThreshold,
        setPushToTalk,
        setPushToTalkKey,
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
        settings, anyProcessingEnabled, deviceProfiles,
        setNoiseSuppression,
        setNoiseSuppressionMode,
        setEchoCancellation,
        setVolumeNormalization,
        setNormalizeIncomingVolume,
        setVoiceGate, setVoiceGateThreshold,
        setPushToTalk, setPushToTalkKey,
        setMicDeviceId, setSpeakerDeviceId, setCameraDeviceId,
        setMicVolume, setSpeakerVolume,
        setEqEnabled, setEqBand, resetEqBands,
        setCameraBrightness, setCameraContrast, setCameraSaturation, resetCameraPicture,
        setVadProbability, setCurrentInputLevel,
    ]);
}

export type VoiceSettingsHook = ReturnType<typeof useVoiceSettings>;
