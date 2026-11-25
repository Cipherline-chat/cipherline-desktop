/**
 * Settings → Voice processing → Noise suppression, as ONE choice: Off / Light /
 * Strong, on the same option cards as Settings → Advanced → Update channel
 * (settings/OptionCard), each saying what it removes and the delay it adds,
 * with one line under them on how Light and Strong differ.
 *
 * Storage: Off writes noiseSuppression=false (the mode is kept for next time);
 * Light / Strong write noiseSuppressionMode and switch noiseSuppression on.
 *
 * What the modes are (the call-audio engine, crates/cl-audio, utils/clAudioSettings.ts):
 *   Light  = the engine's noise suppression at full strength, in the page's own audio thread. It cannot drop out.
 *   Strong = RNNoise's current model (`@shiguredo/rnnoise-wasm`, the app's only noise suppression until 2026-10-19) in a worker
 *            thread (utils/clAudioNative.ts), feeding the same auto gain as Light; Light runs the 2017 model. When the PC is too
 *            busy, Light's frame of the same moment plays instead, with no gap and no jump in time (the worklet keeps the two aligned).
 * Delays: utils/clAudioLatency.ts, measured end to end by audio/clAudioWorkletAlign.test.ts (Light 20 ms; Strong 60 ms: the
 *         model answers 20 ms late, plus 30 ms reserved for the hand-off and 9 ms of buffering that every mode pays).
 */
import React from 'react';
import { OptionCard } from './settings/OptionCard';
import { clAudioLatencyMs, clNativeStrongLatencyMs } from '../utils/clAudioLatency';
import { formatLatencyMs, type NoiseSuppressionMode } from '../utils/nsLatency';

type NsChoice = 'off' | NoiseSuppressionMode;

/** The delay each mode adds, as the card text shows it. */
const lightMs = (): string => formatLatencyMs(clAudioLatencyMs('light'));
const strongMs = (): string => formatLatencyMs(clNativeStrongLatencyMs());

/** What the info tip next to "Noise suppression" says. */
export const NoiseSuppressionInfo: React.FC = () => (
    <>
        <p>Cleans background noise out of your mic on your device, before anyone hears it.</p>
        <p>Both modes send silence while you are not talking, so nobody hears your room between sentences.</p>
        <p>
            <b>Light</b> (adds {lightMs()}): the background under your voice is turned down as far as it will go
            without touching your voice.
        </p>
        <p>
            <b>Strong</b> (adds {strongMs()}): a larger noise model that cleans deeper, under your voice and
            between your words. It runs in its own thread, so others hear you slightly later than with Light.
        </p>
        <p>Neither removes other people talking near you: both are built to keep speech.</p>
        <p>Remembered per microphone.</p>
    </>
);

export const NoiseSuppressionEngine: React.FC<{
    enabled: boolean;
    mode: NoiseSuppressionMode;
    onEnabledChange: (on: boolean) => void;
    onModeChange: (m: NoiseSuppressionMode) => void;
    /** Without the explanation line (the per-device editor, where the main control above already has it). */
    compact?: boolean;
    /** Shown under the options when Strong cannot run on this install (clAudioSettings.strongUnavailableNote). */
    strongNote?: string | null;
}> = ({ enabled, mode, onEnabledChange, onModeChange, compact = false, strongNote = null }) => {
    const value: NsChoice = enabled ? mode : 'off';
    const pick = (next: NsChoice) => {
        if (next === 'off') { onEnabledChange(false); return; }
        onModeChange(next);
        if (!enabled) onEnabledChange(true);
    };
    const choices: { value: NsChoice; title: string; description: string }[] = [
        { value: 'off', title: 'Off', description: 'No cleanup. Your mic as it is.' },
        { value: 'light', title: 'Light', description: `Silent pauses, clean voice. Adds ${lightMs().replace(' ', '\u00a0')}.` },
        { value: 'strong', title: 'Strong', description: `Deeper cleanup, larger model. Adds ${strongMs().replace(' ', '\u00a0')}.` },
    ];
    return (
        <>
            <div className="sd-opts vv-ns" role="radiogroup" aria-label="Noise suppression">
                {choices.map(c => (
                    <OptionCard
                        key={c.value}
                        active={value === c.value}
                        onClick={() => pick(c.value)}
                        title={c.title}
                        description={c.description}
                    />
                ))}
            </div>
            {strongNote && <p className="vv-hint" role="status" data-testid="ns-strong-unavailable">{strongNote}</p>}
            {!compact && <p className="vv-hint" data-testid="ns-difference">Both send silence while you are not talking. Light cleans the background under your voice. Strong uses a larger noise model and cleans deeper, but others hear you slightly later.</p>}
        </>
    );
};
