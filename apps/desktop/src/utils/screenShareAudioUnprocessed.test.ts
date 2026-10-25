/**
 * Owner rule (2026-10-24): screen-share audio never goes through noise
 * suppression — nor any other voice processing. Pinned end to end:
 *
 * SENDER
 *   - native path (WASAPI / ScreenCaptureKit): addon PCM → its OWN
 *     AudioContext → 'pcm-ring' worklet → MediaStreamDestination → published.
 *     Nothing else is connected in that graph;
 *   - Chromium loopback fallback: getDisplayMedia audio asked explicitly for
 *     echoCancellation / noiseSuppression / autoGainControl = false;
 *   - the voice processor (RNNoise / Speex / gate / AGC, and the NS load
 *     guard watching its context) is attached ONLY to the Microphone
 *     publication.
 * RECEIVER
 *   - the screen-share audio chain is element → or source → gain → master
 *     gain; it never takes the NS path and never gets the incoming-voice
 *     leveler (both are microphone-only).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCREEN_SHARE_AUDIO_CAPTURE } from './screenShare';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('screen-share audio is never voice-processed', () => {
    it('loopback capture constraints switch every Chromium audio-processing stage off', () => {
        expect(SCREEN_SHARE_AUDIO_CAPTURE).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
        const src = read('components/SidebarConference.tsx');
        expect(src).toContain('audio: useNativeAudio ? false : (options.audio ? { ...SCREEN_SHARE_AUDIO_CAPTURE } : false),');
    });

    it('the native share-audio graph is pcm-ring → destination in its own AudioContext, nothing else', () => {
        const src = read('components/SidebarConference.tsx');
        const start = src.indexOf("new AudioWorkletNode(ctx, 'pcm-ring'");
        expect(start).toBeGreaterThan(0);
        const block = src.slice(start - 3000, start + 2500);
        expect(block).toMatch(/new AudioContext\(\{ sampleRate: 48000, latencyHint: 'playback' \}\)/);
        expect(block).toMatch(/workletNode\.connect\(destination\)/);
        expect(block).not.toMatch(/voiceProcessor|rnnoise|speex|gate-worklet|agc-worklet/i);
    });

    it('the voice processor attaches to the Microphone publication only', () => {
        const callPane = read('components/CallPane.tsx');
        expect(callPane).toMatch(/pub\.source === Track\.Source\.Microphone && pub\.track instanceof LocalAudioTrack/);
        // Nothing processes ScreenShareAudio anywhere in the app.
        for (const f of ['components/CallPane.tsx', 'components/SidebarConference.tsx', 'utils/voiceProcessorManager.ts']) {
            expect(read(f)).not.toMatch(/ScreenShareAudio[^\n]{0,80}(setProcessor|voiceProcessorManager\.attach)/);
        }
    });

    it('the receive-side share chain: no NS path, no leveler, plain gain to the master bus', () => {
        const src = read('hooks/useParticipantAudio.ts');
        expect(src).toMatch(/const path = pathFor\(p\.identity, 'screen', false\);/);
        expect(src).toMatch(/levelBoost: type === 'mic' && levelBoostLatched\.has\(identity\)/);
        const b = src.slice(src.indexOf('function buildSSAudioInternals'), src.indexOf('function teardownSSAudioInternals'));
        expect(b).not.toMatch(/AudioWorkletNode|nsWorklet|nsWorker|rnnoise|speex/i);
        expect(b).toMatch(/src\.connect\(gain\)/);
        expect(b).toMatch(/gain\.connect\(getMasterGain\(ctx\)\)/);
    });
});
