/**
 * Blob URLs for AudioWorklet module sources, made once per session.
 *
 * The RNNoise worklet source is ~4.8 MB of text (the vendored WASM is inlined
 * as base64). `new Blob([source])` copies and encodes all of it on the main
 * thread, and every call join did that twice — once for the mic processor's
 * context (voiceProcessor.ts) and once for the playback context
 * (useParticipantAudio.ts) — then revoked the URL. Profiled on a call join:
 * ~240 ms of main-thread `Blob` construction, in the same second the call UI
 * is mounting. A Blob URL stays valid until revoked and can be loaded by any
 * number of AudioContexts, so the source is wrapped once and reused; the cost
 * is keeping that blob alive for the rest of the session once a call has run.
 *
 * Keyed by the registered processor name (each name has exactly one source).
 */
const urls = new Map<string, string>();

export function workletModuleUrl(processorName: string, source: string): string {
    let url = urls.get(processorName);
    if (!url) {
        url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        urls.set(processorName, url);
    }
    return url;
}

/** Drop a cached URL (e.g. the module failed to load from it), so the next
 *  attempt rebuilds it from source. */
export function forgetWorkletModuleUrl(processorName: string): void {
    const url = urls.get(processorName);
    if (!url) return;
    urls.delete(processorName);
    try { URL.revokeObjectURL(url); } catch { /* already gone */ }
}
