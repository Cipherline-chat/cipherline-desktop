/**
 * Settings → Voice processing → Noise suppression, as ONE choice: Off / Light /
 * Strong, on the same option cards as Settings → Advanced → Update channel
 * (settings/OptionCard), each saying what it removes and the delay it adds,
 * with one line under them on how Light and Strong differ.
 *
 * Storage is unchanged: Off writes noiseSuppression=false (the engine choice is
 * kept for next time); Light / Strong write noiseSuppressionMode and switch
 * noiseSuppression on. The delays come from utils/nsLatency.ts, which
 * noiseSuppressionWorklets.test.ts keeps equal to what the real worklets add
 * (Light = Speex, one 128-sample frame = 2.7 ms; Strong = RNNoise, 1855
 * samples = 39 ms). What each removes is from the engines themselves
 * (speexLightWorkletSource.ts): Speex estimates the steady background floor
 * and takes it down; RNNoise is a speech-trained network that also removes
 * sudden, non-steady noise, and with it whistling and whispering. Both keep
 * speech, so neither removes other people talking near you.
 */
import React from 'react';
import { OptionCard } from './settings/OptionCard';
import {
    formatLatencyMs, nsDifferenceLine, nsLatencyComparison,
    type NoiseSuppressionMode,
} from '../utils/nsLatency';

type NsChoice = 'off' | NoiseSuppressionMode;

/** What the info tip next to "Noise suppression" says. */
export const NoiseSuppressionInfo: React.FC = () => {
    const cmp = nsLatencyComparison();
    return (
        <>
            <p>Cleans background noise out of your mic on your device, before anyone hears it.</p>
            <p>
                <b>Light</b> (Speex, adds {formatLatencyMs(cmp.lightMs)}): learns the steady background — fans,
                hum, hiss, air conditioning — and turns it down. Everything else passes, whistling and
                whispering included. Pair it with the voice gate to silence the gaps between words.
            </p>
            <p>
                <b>Strong</b> (RNNoise, a small AI model trained on speech, adds {formatLatencyMs(cmp.strongMs)}): also
                removes sudden noise like keyboard clacks, mouse clicks and clatter. It can cut whistling and
                whispering too.
            </p>
            <p>Neither removes other people talking near you: both are built to keep speech.</p>
            <p>Remembered per microphone.</p>
        </>
    );
};

export const NoiseSuppressionEngine: React.FC<{
    enabled: boolean;
    mode: NoiseSuppressionMode;
    onEnabledChange: (on: boolean) => void;
    onModeChange: (m: NoiseSuppressionMode) => void;
    /** Without the explanation line (the per-device editor, where the main control above already has it). */
    compact?: boolean;
}> = ({ enabled, mode, onEnabledChange, onModeChange, compact = false }) => {
    const value: NsChoice = enabled ? mode : 'off';
    const pick = (next: NsChoice) => {
        if (next === 'off') { onEnabledChange(false); return; }
        onModeChange(next);
        if (!enabled) onEnabledChange(true);
    };
    const cmp = nsLatencyComparison();
    const choices: { value: NsChoice; title: string; description: string }[] = [
        { value: 'off', title: 'Off', description: 'No cleanup. Your mic as it is.' },
        { value: 'light', title: 'Light', description: `Steady hum and fans. Adds ${formatLatencyMs(cmp.lightMs).replace(' ', '\u00a0')}.` },
        { value: 'strong', title: 'Strong', description: `Also keyboard clacks. Adds ${formatLatencyMs(cmp.strongMs).replace(' ', '\u00a0')}.` },
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
            {!compact && <p className="vv-hint" data-testid="ns-difference">{nsDifferenceLine()}</p>}
        </>
    );
};
