/**
 * RNNoise Worker — runs RNNoise WASM entirely off the main thread.
 *
 * Lifecycle:
 *   1. Main thread sends { type: 'init' } with a MessagePort (channel.port1) in the
 *      transfer list. The Worker loads the WASM, creates a DenoiseState, wires up
 *      the port, and replies { type: 'ready' }.
 *
 *   2. The AudioWorklet sends { type: 'process', buffer: Float32Array } frames
 *      (480 samples, float [-1, 1]) directly to the Worker via the shared port.
 *      The Worker scales to int16 range, runs processFrame() in-place, scales back,
 *      and returns { type: 'processed', buffer } with the transferred ArrayBuffer.
 *
 *   3. Main thread sends { type: 'destroy' } when the processor is torn down.
 *
 * This design keeps WASM processing entirely off the main thread without using
 * MediaStreamTrackGenerator (which triggers devicechange → LiveKit mic restart).
 */

import { Rnnoise } from '@shiguredo/rnnoise-wasm';
import type { DenoiseState } from '@shiguredo/rnnoise-wasm';

let denoiseState: DenoiseState | null = null;
let workerPort: MessagePort | null = null;

function handleFrame(event: MessageEvent) {
    const { data } = event;
    if (data.type !== 'process' || !denoiseState || !workerPort) return;

    const frame = new Float32Array(data.buffer);

    // RNNoise expects values in the int16 range (−32768 … 32767).
    // AudioWorklet outputs float values in [−1, 1] — scale before and after.
    for (let i = 0; i < frame.length; i++) frame[i] *= 32768;
    denoiseState.processFrame(frame);
    for (let i = 0; i < frame.length; i++) frame[i] /= 32768;

    workerPort.postMessage({ type: 'processed', buffer: frame.buffer }, [frame.buffer]);
}

self.onmessage = async ({ data, ports }: MessageEvent) => {
    if (data.type === 'init') {
        try {
            const rnnoise = await Rnnoise.load();
            denoiseState = rnnoise.createDenoiseState();
        } catch (err) {
            console.error('[RNNoiseWorker] Failed to load RNNoise WASM:', err);
            (self as unknown as Worker).postMessage({ type: 'error', error: String(err) });
            return;
        }

        workerPort = ports[0] as MessagePort;
        workerPort.onmessage = handleFrame;
        workerPort.start();

        (self as unknown as Worker).postMessage({ type: 'ready' });

    } else if (data.type === 'destroy') {
        denoiseState?.destroy();
        denoiseState = null;
        if (workerPort) {
            workerPort.onmessage = null;
            workerPort = null;
        }
    }
};
