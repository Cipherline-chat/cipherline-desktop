/**
 * Page side of "Strong" noise suppression: RNNoise's current model (`@shiguredo/rnnoise-wasm`) feeding the engine's Strong chain, in a worker thread of the page (workers/clAudioStrong.worker.ts).
 *
 * The page does two small things: start the worker (handing it the engine's wasm bytes: the same binary the audio worklet
 * runs, so there is no second file to ship or to go missing), and give one end of a MessageChannel to the AudioWorklet
 * (`node.port.postMessage({ type: 'nativePort', port }, [port])`) and the other to the worker. From then on audio frames
 * travel worklet <-> worker without touching this thread. Nothing here sees audio.
 *
 * It is plain web platform, so it is the same in Electron and in the Rust app's webview. (The names still say "native":
 * the first Strong ran in a separate native process, and the worklet's hand-off code is the same.)
 *
 * Everything fails soft: no worker, the engine not loading in time -> `null`, and the call keeps the engine's own Light,
 * which is always running underneath.
 */
import { loadClAudioWasmBytes } from './clAudioSources';

/** The worker compiles a 4 MB engine and builds two networks: a second or two on a normal PC, more on a busy one. */
export const CL_NATIVE_PORT_TIMEOUT_MS = 25_000;

export type NativeStatus = { available: true } | { available: false; reason: 'no-bridge' | 'unknown' };

let statusOnce: Promise<NativeStatus> | null = null;
function probe(): NativeStatus {
    // The engine itself is inside the page's own code (the same wasm Light runs on), so there is no file to look for: all that
    // can be missing is the platform's part.
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' || typeof MessageChannel === 'undefined') return { available: false, reason: 'no-bridge' };
    return { available: true };
}

/** Can Strong's worker run here, and if not, why (for the settings note). Asked once per page load. Never throws. */
export function nativeEngineStatus(): Promise<NativeStatus> {
    statusOnce ??= Promise.resolve().then(probe).catch((): NativeStatus => ({ available: false, reason: 'unknown' }));
    return statusOnce;
}

/** True when the worker can run here. Never throws. */
export async function nativeEngineAvailable(): Promise<boolean> {
    return (await nativeEngineStatus()).available;
}

type ExitCb = (reason: string) => void;

/**
 * One owner's Strong engine: its own worker, and the worklet's end of a channel to it. Every voice processor gets its OWN worker.
 *
 * It used to be one worker per page, shared: a second open (the Settings page's mic preview, which builds its own processor with
 * the call's settings) was handed the SAME worker, whose `openPort` closes the previous port, so the live call's worklet lost its
 * Strong engine without a word (no replies: paused, Light), and closing the preview terminated the worker under the call. A
 * settings change on the call then waited 20 s for an acknowledgement from a port nobody listened to and announced "Switched to
 * Light" (report 348d6f9b, 2026-11-25: Settings opened mid-call, mic volume dragged). Owners never share a worker now, so one
 * owner's open, failure or close cannot touch another's.
 */
export interface NativeEngine {
    /** the worklet's end of the channel: transfer it to the AudioWorklet (`{ type: 'nativePort', port }`) */
    readonly port: MessagePort;
    /** stop this engine's worker at once, quietly (its exit listeners are not called). Idempotent. */
    close(): void;
    /** this engine's worker stopped by itself (its engine failed or the script errored). Returns the unsubscribe. */
    onExit(cb: ExitCb): () => void;
}

/** Start a fresh worker for one owner and get the worklet's end of a channel to it. null on any failure (the worker is stopped). */
export async function openNativeEngine(timeoutMs = CL_NATIVE_PORT_TIMEOUT_MS): Promise<NativeEngine | null> {
    if (!(await nativeEngineAvailable())) return null;
    let w: Worker;
    try { w = new Worker(new URL('../workers/clAudioStrong.worker.ts', import.meta.url), { type: 'module', name: 'cl-audio-strong' }); } catch { return null; }
    const exitCbs = new Set<ExitCb>();
    let alive = true;
    const stop = (reason: string | null) => {
        if (!alive) return;
        alive = false;
        try { w.terminate(); } catch { /* already gone */ }
        if (reason !== null) for (const cb of [...exitCbs]) { try { cb(reason); } catch { /* a listener's own problem */ } }
        exitCbs.clear();
    };
    const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        w.onmessage = (ev: MessageEvent) => {
            const d = ev.data as { type?: string } | null;
            if (d?.type === 'ready') { clearTimeout(timer); resolve(true); }
            else if (d?.type === 'failed') { clearTimeout(timer); resolve(false); stop('engine-failed'); } // mid-call: the worklet is told and plays its own engine
        };
        w.onerror = () => { clearTimeout(timer); resolve(false); stop('worker-error'); };
        loadClAudioWasmBytes().then(
            (wasm) => { if (alive) w.postMessage({ type: 'init', wasm }, [wasm]); },
            () => { clearTimeout(timer); resolve(false); stop('engine-missing'); },
        );
    }).catch(() => false);
    if (!ok || !alive) { stop(null); return null; }
    let ch: MessageChannel;
    try { ch = new MessageChannel(); } catch { stop(null); return null; }
    w.postMessage({ type: 'open' }, [ch.port1]);
    return {
        port: ch.port2,
        close: () => stop(null),
        onExit: (cb) => { if (!alive) return () => {}; exitCbs.add(cb); return () => { exitCbs.delete(cb); }; },
    };
}

/** Do these settings ask for Strong's worker? (the page also needs nativeEngineAvailable() to say yes) */
export function wantsNativeStrong(s: { audioEngine?: string; noiseSuppression: boolean; noiseSuppressionMode?: string; volumeNormalization?: boolean; micVolume?: number }): boolean {
    if (s.audioEngine !== 'v2' || !s.noiseSuppression || s.noiseSuppressionMode !== 'strong') return false;
    return true;
}
