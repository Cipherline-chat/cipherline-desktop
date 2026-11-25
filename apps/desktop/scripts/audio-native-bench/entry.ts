// Bundled by build.mjs into the bench page: exposes the REAL page-side native engine glue (src/utils/clAudioNative.ts).
// The bench drives one engine at a time, so it keeps the old open / on-exit / close shape over one owned engine.
import { openNativeEngine, nativeEngineAvailable, type NativeEngine } from '../../src/utils/clAudioNative';

let current: NativeEngine | null = null;
async function openNativePort(timeoutMs?: number): Promise<MessagePort | null> {
    current?.close();
    current = await openNativeEngine(timeoutMs);
    return current ? current.port : null;
}
function onNativeEngineExit(cb: (reason: string) => void): () => void { return current ? current.onExit(cb) : () => {}; }
async function closeNativeEngine(): Promise<void> { current?.close(); current = null; }

(window as unknown as Record<string, unknown>).__clNative = { openNativePort, nativeEngineAvailable, onNativeEngineExit, closeNativeEngine };
