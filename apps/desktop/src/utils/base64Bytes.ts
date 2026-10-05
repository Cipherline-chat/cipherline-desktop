/**
 * Base64 → bytes for BINARY payloads (images, files) on the UI thread.
 *
 * `Uint8Array.from(atob(b64), c => c.charCodeAt(0))` — the idiom this replaces
 * — walks the string through the iterator protocol and a callback per byte. On
 * a 5 MB image that measured 2.6 s (Electron 43's V8) to 3.8 s (Node 22) of
 * one uninterrupted task on the dev box: a link-embedded GIF froze the window
 * for seconds. The native decoder (`Uint8Array.fromBase64`, shipped in
 * Chromium 140 / V8 14 — Electron 43 has it) did the same 5 MB in 34 ms; the
 * plain loop fallback in ~100 ms.
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64;
    if (typeof native === 'function') {
        try { return native(b64); } catch { /* non-canonical padding etc.: fall through to atob */ }
    }
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
