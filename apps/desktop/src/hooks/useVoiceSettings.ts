import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceSettings {
    noiseSuppression: boolean;
    volumeNormalization: boolean;
    voiceGate: boolean;
    voiceGateThreshold: number; // dBFS, range -60 to -20
    pushToTalk: boolean;
    pushToTalkKey: string | null;
    micDeviceId: string;
    speakerDeviceId: string;
    cameraDeviceId: string;
    micVolume: number;    // 0-200, default 100 (100 = unity gain)
    speakerVolume: number; // 0-200, default 100
    // 5-band parametric EQ: [80Hz, 250Hz, 1kHz, 4kHz, 12kHz], gain in dB (-12 to +12)
    eqEnabled: boolean;
    eqBands: number[];
    // Camera picture settings
    cameraBrightness: number;  // 0-200, default 100
    cameraContrast: number;    // 0-200, default 100
    cameraSaturation: number;  // 0-200, default 100
}

const STORAGE_KEY = 'cipherline_voice_settings';

const DEFAULTS: VoiceSettings = {
    noiseSuppression: true,
    volumeNormalization: true,
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


// ── Hook ──────────────────────────────────────────────────────────────────────

function loadSettings(): VoiceSettings {
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULTS };
        return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULTS };
    }
}

export function useVoiceSettings() {
    const [settings, setSettings] = useState<VoiceSettings>(loadSettings);

    // Real-time audio level indicators (P2-REND-1: kept as refs so callbacks don't
    // enter the memo deps and cause 50 Hz re-renders of the entire Dashboard during calls).
    // Components that need live levels (e.g. VoiceVideoSettings) maintain their own state.
    const vadProbabilityRef = useRef(0);
    const currentInputLevelRef = useRef(-Infinity);

    // Persist
    useEffect(() => {
        try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
    }, [settings]);

    const update = useCallback((partial: Partial<VoiceSettings>) => {
        setSettings(prev => ({ ...prev, ...partial }));
    }, []);

    const setNoiseSuppression    = useCallback((v: boolean) => update({ noiseSuppression: v }), [update]);
    const setVolumeNormalization = useCallback((v: boolean) => update({ volumeNormalization: v }), [update]);
    const setVoiceGate           = useCallback((v: boolean) => update({ voiceGate: v }), [update]);
    const setVoiceGateThreshold  = useCallback((v: number) => update({ voiceGateThreshold: Math.max(-60, Math.min(-20, v)) }), [update]);
    const setPushToTalk          = useCallback((v: boolean) => update({ pushToTalk: v }), [update]);
    const setPushToTalkKey       = useCallback((v: string | null) => update({ pushToTalkKey: v }), [update]);
    const setMicDeviceId         = useCallback((v: string) => update({ micDeviceId: v }), [update]);
    const setSpeakerDeviceId     = useCallback((v: string) => update({ speakerDeviceId: v }), [update]);
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
        const clamped = Math.max(0, Math.min(300, v));
        if (micVolumeTimerRef.current) clearTimeout(micVolumeTimerRef.current);
        micVolumeTimerRef.current = setTimeout(() => update({ micVolume: clamped }), 120);
    }, [update]);
    useEffect(() => () => { if (micVolumeTimerRef.current) clearTimeout(micVolumeTimerRef.current); }, []);
    const setSpeakerVolume       = useCallback((v: number) => update({ speakerVolume: Math.max(0, Math.min(300, v)) }), [update]);
    const setEqEnabled           = useCallback((v: boolean) => update({ eqEnabled: v }), [update]);
    const setEqBand              = useCallback((index: number, gain: number) => {
        setSettings(prev => {
            const bands = [...prev.eqBands];
            bands[index] = Math.max(-12, Math.min(12, gain));
            return { ...prev, eqBands: bands };
        });
    }, []);
    const resetEqBands           = useCallback(() => update({ eqBands: [0, 0, 0, 0, 0] }), [update]);
    const setCameraBrightness    = useCallback((v: number) => update({ cameraBrightness: Math.max(0, Math.min(200, v)) }), [update]);
    const setCameraContrast      = useCallback((v: number) => update({ cameraContrast: Math.max(0, Math.min(200, v)) }), [update]);
    const setCameraSaturation    = useCallback((v: number) => update({ cameraSaturation: Math.max(0, Math.min(200, v)) }), [update]);
    const resetCameraPicture     = useCallback(() => update({ cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100 }), [update]);

    /** True if any processing feature is enabled (used to decide whether to attach the voice
     *  processor to LiveKit). NS is included — it is handled by the AudioWorklet+RNNoise
     *  pipeline inside CipherlineVoiceProcessor, not by the browser constraint. */
    const anyProcessingEnabled =
        settings.noiseSuppression ||
        settings.volumeNormalization ||
        settings.voiceGate ||
        settings.eqEnabled ||
        settings.micVolume !== 100;

    // Stable setter callbacks that write into refs — safe to include in voiceProcessor
    // options without entering the memo deps (P2-REND-1).
    const setVadProbability    = useCallback((v: number) => { vadProbabilityRef.current    = v; }, []);
    const setCurrentInputLevel = useCallback((v: number) => { currentInputLevelRef.current = v; }, []);

    return useMemo(() => ({
        settings,
        anyProcessingEnabled,
        setNoiseSuppression,
        setVolumeNormalization,
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
        settings, anyProcessingEnabled,
        setNoiseSuppression,
        setVolumeNormalization,
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
