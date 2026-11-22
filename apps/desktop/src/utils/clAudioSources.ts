/**
 * Lazy loaders for the new audio engine's worklet source and WASM, same reason as speexSources.ts: nothing here may
 * enter the boot chunk (the WASM as base64 is 1.7 MB); the first call that selects the engine pulls it in.
 */

let workletSource: Promise<string> | null = null;
let wasmBytes: Promise<() => ArrayBuffer> | null = null;

export function loadClAudioWorkletSource(): Promise<string> {
    if (!workletSource) {
        workletSource = import('./clAudioWorkletSource').then(m => m.CL_AUDIO_WORKLET_SOURCE);
        workletSource.catch(() => { workletSource = null; });
    }
    return workletSource;
}

/** A fresh copy of the engine's WASM bytes each call (the worklet gets its own via processorOptions). */
export async function loadClAudioWasmBytes(): Promise<ArrayBuffer> {
    if (!wasmBytes) {
        wasmBytes = import('./clAudioWasm').then(m => m.clAudioWasmBytes);
        wasmBytes.catch(() => { wasmBytes = null; });
    }
    return (await wasmBytes)();
}
