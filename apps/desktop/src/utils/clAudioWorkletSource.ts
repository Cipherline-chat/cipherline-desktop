import clAudioWorkletSrc from '../audio/clAudioWorklet.js?raw';

/**
 * 'cl-audio-worklet': the Rust/WebAssembly call-audio engine as one AudioWorklet stage (noise suppression, level
 * control and limiter in one). Plain script, registered like the gate/AGC worklets (voiceProcessor.ts). The wasm is not
 * in this text: its bytes travel in processorOptions (clAudioSources.ts), so this stays small and the 1.3 MB module is
 * only fetched when the new engine is actually used. See audio/clAudioWorklet.js for the design.
 */
export const CL_AUDIO_WORKLET_SOURCE: string = clAudioWorkletSrc;
