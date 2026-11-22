// Bundled by build.mjs into the bench page: exposes the REAL page-side native engine glue (src/utils/clAudioNative.ts).
import { openNativePort, nativeEngineAvailable, onNativeEngineExit, closeNativeEngine } from '../../src/utils/clAudioNative';
(window as unknown as Record<string, unknown>).__clNative = { openNativePort, nativeEngineAvailable, onNativeEngineExit, closeNativeEngine };
