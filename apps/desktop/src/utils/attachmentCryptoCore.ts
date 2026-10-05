/**
 * AES-256-GCM for attachment / saved-GIF blobs — the one implementation, run
 * either in the attachment crypto worker (normal case) or in-thread (fallback).
 * No DOM, no `window`: it must load inside a dedicated Worker.
 *
 * Format is unchanged from what utils/crypto.ts always produced: ciphertext +
 * 16-byte GCM tag, with the 12-byte IV either returned separately (chat
 * attachments, IV travels in the E2EE envelope) or prepended (`bundleIv`, the
 * on-disk saved-GIF format).
 */

function bytesToBase64(u8: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export async function encryptBlobCore(file: Blob, key: CryptoKey, bundleIv: boolean): Promise<{ encryptedBlob: Blob; ivB64: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = await file.arrayBuffer();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    // M9: the bundled form prepends the IV into the payload itself. A Blob
    // built from parts avoids the extra full-size copy into a combined buffer.
    const encryptedBlob = bundleIv
        ? new Blob([iv, ciphertext], { type: 'application/octet-stream' })
        : new Blob([ciphertext], { type: 'application/octet-stream' });
    return { encryptedBlob, ivB64: bytesToBase64(iv) };
}

/** `type` must already be sanitised by the caller (crypto.ts sanitizeMime). */
export async function decryptBlobCore(encryptedBlob: Blob, key: CryptoKey, ivB64: string | null, type: string): Promise<Blob> {
    const combined = new Uint8Array(await encryptedBlob.arrayBuffer());
    let iv: Uint8Array<ArrayBuffer>;
    let ciphertext: Uint8Array<ArrayBuffer>;
    if (ivB64) {
        iv = base64ToBytes(ivB64);
        ciphertext = combined;
    } else {
        // Unbundle the 12-byte IV (M9 offline recovery / saved-GIF payloads).
        // Views, not copies.
        iv = combined.subarray(0, 12);
        ciphertext = combined.subarray(12);
    }
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new Blob([plaintext], { type });
}
