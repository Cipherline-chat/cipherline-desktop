/**
 * Lazy loaders for the Light (Speex) noise-suppression worklet source and WASM.
 * Same reason as rnnoiseSources.ts: keep them out of the boot chunk, load them the
 * first time a call (or the Settings mic test) actually needs Light mode.
 */

let workletSource: Promise<string> | null = null;
let wasmBytes: Promise<() => ArrayBuffer> | null = null;

/** Light worklet ('speex-light-worklet'). */
export function loadSpeexLightWorkletSource(): Promise<string> {
    if (!workletSource) {
        workletSource = import('./speexLightWorkletSource').then(m => m.SPEEX_LIGHT_WORKLET_SOURCE);
        workletSource.catch(() => { workletSource = null; });
    }
    return workletSource;
}

/** A fresh, transferable copy of the Speex WASM bytes. */
export async function loadSpeexWasmBytes(): Promise<ArrayBuffer> {
    if (!wasmBytes) {
        wasmBytes = import('./speexWasm').then(m => m.speexWasmBytes);
        wasmBytes.catch(() => { wasmBytes = null; });
    }
    return (await wasmBytes)();
}
