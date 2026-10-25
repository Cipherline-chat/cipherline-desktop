/**
 * The SpeexDSP preprocess WASM (56 KB) as a checked-in base64 string (generated
 * by scripts/gen-speex-wasm.mjs, kept honest by speexWasmBase64.test.ts) and
 * decoded here with atob - no fetch, so the CSP's connect-src needs no change and
 * a packaged build cannot fail to find a sidecar file. (Vite does not treat
 * .wasm as an inlinable asset, hence the generated module.)
 *
 * Reachable only through speexSources.ts (a dynamic import), so it stays out of
 * the boot chunk - see bundleBoot.test.ts.
 */
import { SPEEX_WASM_BASE64 } from './speexWasmBase64';

/** A fresh copy each call: the caller transfers it to the audio worklet. */
export function speexWasmBytes(): ArrayBuffer {
    const bin = atob(SPEEX_WASM_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
