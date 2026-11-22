/**
 * The cl-audio engine WASM (1.3 MB) as a checked-in base64 string, decoded with atob: no fetch, so the CSP's
 * connect-src needs no change and a packaged build cannot fail to find a sidecar file - exactly how speexWasm.ts
 * ships SpeexDSP. Regenerate with scripts/gen-cl-audio-wasm.mjs (see crates/cl-audio/README.md); clAudioWasm.test.ts
 * fails when it is stale. Reachable only through clAudioSources.ts (a dynamic import).
 */
import { CL_AUDIO_WASM_BASE64 } from '../audio/engine/clAudioWasmBase64';

/** A fresh copy each call. */
export function clAudioWasmBytes(): ArrayBuffer {
    const bin = atob(CL_AUDIO_WASM_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
