import { describe, it, expect } from 'vitest';
import { RNNOISE_SAMPLE_RATE, isUsableRnnoiseContext, pickProcessorContext } from './voiceProcessor';

/**
 * Guards the sample-rate contract behind noise suppression.
 *
 * RNNoise is hard-wired to 48 kHz — the worklet slices fixed 480-sample frames
 * (10 ms at 48 kHz) and never resamples, and the model's band energies and
 * pitch analysis assume that rate. Feeding it any other rate does not error; it
 * quietly produces wrong output, which users experience as "noise suppression
 * does nothing".
 *
 * That was reachable in practice: livekit-client builds its AudioContext with
 * `new AudioContext({ latencyHint: 'interactive' })` — no sampleRate — so it
 * inherits the hardware default (44100 Hz is a common Windows default, and some
 * DACs/headsets sit at 96/192 kHz), then hands that context to our processor.
 */
describe('isUsableRnnoiseContext', () => {
    it('accepts exactly 48 kHz', () => {
        expect(isUsableRnnoiseContext(RNNOISE_SAMPLE_RATE)).toBe(true);
        expect(RNNOISE_SAMPLE_RATE).toBe(48000);
    });

    it('rejects the hardware rates that reach us via LiveKit\'s AudioContext', () => {
        // 44100: the classic Windows "Default Format". This is the regression —
        // NS silently did nothing on these machines while working on 48 kHz ones.
        expect(isUsableRnnoiseContext(44100)).toBe(false);
        // High-rate DACs and gaming headsets.
        expect(isUsableRnnoiseContext(96000)).toBe(false);
        expect(isUsableRnnoiseContext(192000)).toBe(false);
        // Low-rate / telephony-ish endpoints.
        expect(isUsableRnnoiseContext(16000)).toBe(false);
        expect(isUsableRnnoiseContext(8000)).toBe(false);
    });

    it('rejects near-misses — there is no tolerance to trade', () => {
        // The worklet slices a fixed 480 samples regardless, so "nearly 48 kHz"
        // still hands RNNoise the wrong duration of audio.
        expect(isUsableRnnoiseContext(47999)).toBe(false);
        expect(isUsableRnnoiseContext(48001)).toBe(false);
    });

    it('rejects an absent rate rather than assuming it is fine', () => {
        expect(isUsableRnnoiseContext(undefined)).toBe(false);
    });
});

/**
 * The mic-device-switch regression, pinned at the decision that caused it.
 *
 * livekit-client hands `processor.init()` an `audioContext` but hands
 * `processor.restart()` none (livekit-client@2.18.8, LocalTrack.ts:193-198 vs
 * :554-561), and every `room.switchActiveDevice('audioinput', ...)` goes
 * through the restart path. So picking a microphone mid-call used to tear the
 * graph down off the app's shared 48 kHz context and rebuild it on a
 * brand-new one — created two awaits deep in an async handler, i.e. with no
 * transient user activation left to auto-resume it. A suspended context's
 * MediaStreamDestination emits silence, and that silence is what
 * `sender.replaceTrack()` publishes as the microphone.
 */
describe('pickProcessorContext', () => {
    const running = (sampleRate: number) => ({ sampleRate, state: 'running' as AudioContextState });

    it('adopts the context the host passed in', () => {
        expect(pickProcessorContext(running(48000), undefined)).toBe('provided');
    });

    it('falls back to the retained host context when the caller omits one', () => {
        // THE REGRESSION. Before the fix this returned 'own'.
        expect(pickProcessorContext(undefined, running(48000))).toBe('retained');
    });

    it('builds its own only when there is nothing usable to fall back to', () => {
        expect(pickProcessorContext(undefined, undefined)).toBe('own');
    });

    it('never adopts a closed context — neither provided nor retained', () => {
        const closed = { sampleRate: 48000, state: 'closed' as AudioContextState };
        // A host context closed when the previous call ended must not be
        // resurrected; a closed context cannot create nodes at all.
        expect(pickProcessorContext(undefined, closed)).toBe('own');
        expect(pickProcessorContext(closed, undefined)).toBe('own');
        // ...but a closed *provided* one still yields to a live retained one.
        expect(pickProcessorContext(closed, running(48000))).toBe('retained');
    });

    it('never adopts a wrong-rate context, which is the older bug this must not undo', () => {
        // 44100 is the classic Windows default. Adopting it would put RNNoise
        // back on wrongly-sized frames — see isUsableRnnoiseContext above.
        expect(pickProcessorContext(running(44100), undefined)).toBe('own');
        expect(pickProcessorContext(undefined, running(44100))).toBe('own');
        expect(pickProcessorContext(running(44100), running(48000))).toBe('retained');
    });
});
