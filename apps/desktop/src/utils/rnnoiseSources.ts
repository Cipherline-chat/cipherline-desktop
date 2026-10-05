/**
 * Lazy loaders for the two RNNoise AudioWorklet sources.
 *
 * WHY this exists (startup performance): `rnnoiseInWorkletSource.ts` embeds the
 * vendored @shiguredo/rnnoise-wasm glue as a `?raw` string — ~4.8 MB of text
 * (the WASM is an inline base64 payload). Imported statically, that string
 * sat inside the app's ENTRY chunk, which tripled it (≈2.3 MB of real code →
 * 7.1 MB), and every launch and every renderer reload paid to stream, scan and
 * keep it in memory before React rendered a single pixel — for a feature that
 * only matters once a call starts.
 *
 * Both callers (voiceProcessor.ts, useParticipantAudio.ts) were already async
 * at the point of use (they `await audioWorklet.addModule(...)`), so loading
 * the source with a dynamic import there changes nothing about ordering.
 * `prefetchRnnoiseSources()` warms the chunk once the app is idle after boot,
 * so starting a call is exactly as fast as before.
 *
 * Must NOT be statically imported by anything on the boot path except through
 * these functions — `bundleBoot.test.ts` enforces that.
 */

let inlineSource: Promise<string> | null = null;
let workerFedSource: Promise<string> | null = null;

/** In-worklet synchronous RNNoise ('rnnoise-inline-worklet'). */
export function loadInlineRnnoiseWorkletSource(): Promise<string> {
    if (!inlineSource) {
        inlineSource = import('./rnnoiseInWorkletSource').then(m => m.RNNOISE_INLINE_WORKLET_SOURCE);
        // A failed chunk load must not be cached forever — the next call retries.
        inlineSource.catch(() => { inlineSource = null; });
    }
    return inlineSource;
}

/** Worker-fed RNNoise fallback ('rnnoise-worklet'). */
export function loadRnnoiseWorkletSource(): Promise<string> {
    if (!workerFedSource) {
        workerFedSource = import('./rnnoiseWorkletSource').then(m => m.RNNOISE_WORKLET_SOURCE);
        workerFedSource.catch(() => { workerFedSource = null; });
    }
    return workerFedSource;
}

/** Warm both sources in the background (idle prefetch after boot). Never throws. */
export function prefetchRnnoiseSources(): void {
    loadInlineRnnoiseWorkletSource().catch(() => { /* retried on first real use */ });
    loadRnnoiseWorkletSource().catch(() => { /* retried on first real use */ });
}
