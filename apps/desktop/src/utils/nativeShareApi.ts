/**
 * The preload bridge's `window.nativeShare` shape and the helper's backend facts - TYPES ONLY, no imports.
 *
 * Why a separate file: `env.d.ts` names these types, and the website build (`apps/website/tsconfig.json`
 * includes `../desktop/src/env.d.ts`) typechecks every file env.d.ts reaches. When they lived in
 * nativeSharePipeline.ts, that pulled nativeShareDummy.ts / screenShare.ts -> `livekit-client`, which the
 * website image does not install, and the website Docker build failed (TS2307). Keep this file import-free;
 * `envDtsTypeImports.test.ts` enforces it for everything env.d.ts imports.
 */
export type NativeBackendName = 'nvenc' | 'vaapi' | 'pcm';

export interface NativeBackendInfo { gpu: string; driver: string; nvencApi: string; capW: number; capH: number; bgrxInput: boolean; device?: string; vaDriver?: string; entrypoint?: string; rc?: string; profile?: string; packedHeaders?: number }

export interface NativeShareApi {
    envFlag?: boolean;
    available(): Promise<{ helper: boolean }>;
    start(args: unknown): Promise<{ ok: boolean; error?: string }>;
    stop(): Promise<unknown>;
    probe(args?: unknown): Promise<{ vaapi: boolean; nvenc: boolean; sustainedFps?: number; nvencInfo?: NativeBackendInfo; vaapiInfo?: NativeBackendInfo }>;
    onEvent(cb: (ev: unknown) => void): () => void;
    onExit(cb: (x: { code: number; reason: string }) => void): () => void;
}
