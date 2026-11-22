/** The preload bridge for the native audio engine (electron/preload.ts `audioEngine`). Absent outside Electron. */
export interface AudioEngineApi {
    available(): Promise<{ available: boolean; reason?: string }>;
    open(): Promise<{ ok: boolean; error?: string }>;
    close(): Promise<{ ok: boolean }>;
}
