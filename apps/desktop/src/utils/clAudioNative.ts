/**
 * Page side of "Strong" noise suppression: FastEnhancer B + S in a worker thread of the page (workers/clAudioStrong.worker.ts).
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
let worker: Worker | null = null;
let ready: Promise<boolean> | null = null;
const exitCbs = new Set<ExitCb>();

function stopWorker(reason: string | null): void {
    const w = worker;
    worker = null; ready = null;
    if (w) { try { w.terminate(); } catch { /* already gone */ } }
    if (reason !== null) for (const cb of [...exitCbs]) { try { cb(reason); } catch { /* a listener's own problem */ } }
}

function startWorker(timeoutMs: number): Promise<boolean> {
    if (ready) return ready;
    const w = new Worker(new URL('../workers/clAudioStrong.worker.ts', import.meta.url), { type: 'module', name: 'cl-audio-strong' });
    worker = w;
    ready = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        w.onmessage = (ev: MessageEvent) => {
            const d = ev.data as { type?: string } | null;
            if (d?.type === 'ready') { clearTimeout(timer); resolve(true); }
            else if (d?.type === 'failed') {
                clearTimeout(timer); resolve(false);
                if (worker === w) stopWorker('engine-failed'); // mid-call: the worklet is told and plays its own engine
            }
        };
        w.onerror = () => { clearTimeout(timer); resolve(false); if (worker === w) stopWorker('worker-error'); };
        loadClAudioWasmBytes().then(
            (wasm) => { if (worker === w) w.postMessage({ type: 'init', wasm }, [wasm]); },
            () => { clearTimeout(timer); resolve(false); if (worker === w) stopWorker('engine-missing'); },
        );
    });
    return ready;
}

/** Start the worker (or reuse the running one) and get the worklet's end of a fresh channel to it. null on any failure. */
export async function openNativePort(timeoutMs = CL_NATIVE_PORT_TIMEOUT_MS): Promise<MessagePort | null> {
    if (!(await nativeEngineAvailable())) return null;
    let ok = false;
    try { ok = await startWorker(timeoutMs); } catch { ok = false; }
    const w = worker;
    if (!ok || !w) { stopWorker(null); return null; }
    const ch = new MessageChannel();
    w.postMessage({ type: 'open' }, [ch.port1]);
    return ch.port2;
}

/** The worker stopped mid-call (its engine failed or the script errored). Returns the unsubscribe. */
export function onNativeEngineExit(cb: ExitCb): () => void {
    exitCbs.add(cb);
    return () => { exitCbs.delete(cb); };
}

/** The call is over (or Strong was switched off): free the worker and its memory at once. The next call starts a fresh one. */
export async function closeNativeEngine(): Promise<void> {
    stopWorker(null);
}

/** Do these settings ask for Strong's worker? (the page also needs nativeEngineAvailable() to say yes) */
export function wantsNativeStrong(s: { audioEngine?: string; noiseSuppression: boolean; noiseSuppressionMode?: string; volumeNormalization?: boolean; micVolume?: number }): boolean {
    if (s.audioEngine !== 'v2' || !s.noiseSuppression || s.noiseSuppressionMode !== 'strong') return false;
    return true;
}
