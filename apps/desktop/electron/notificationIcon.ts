/**
 * notificationIcon.ts — main-process validation of the sender-avatar icon the
 * renderer may attach to an OS toast (`notif:show` → `iconDataUrl`).
 *
 * Pure and dependency-free on purpose (no `electron` import), so vitest can
 * pin the contract. `notifications.ts` turns the returned bytes into a
 * `nativeImage`.
 *
 * The renderer is the only party that can produce this image — avatars are
 * E2EE attachments decrypted in the renderer — but main still treats the
 * payload as untrusted input from a less-privileged process: a compromised or
 * buggy renderer must not be able to hand the native image decoders an
 * arbitrarily large or arbitrarily formatted buffer through this channel.
 * So the accepted shape is deliberately narrow and exactly what
 * `src/utils/notificationAvatar.ts` produces:
 *
 *   - a `data:image/png;base64,` URL — PNG only, nothing else;
 *   - at most MAX_ICON_DATA_URL_CHARS characters (checked BEFORE decoding);
 *   - a real PNG signature followed by an IHDR chunk;
 *   - declared dimensions within 1..MAX_ICON_DIMENSION on both axes (the
 *     renderer draws 96x96; the cap leaves headroom without letting a tiny
 *     file declare a decompression-bomb-sized canvas).
 *
 * Anything else returns null and the caller falls back to the generic app
 * icon — a bad avatar must never cost the user the notification itself.
 */

/** ~190 KB of base64 ≈ 140 KB of PNG. A 96x96 RGBA PNG is ~5–30 KB. */
export const MAX_ICON_DATA_URL_CHARS = 192 * 1024;
/** Largest edge accepted, in pixels. */
export const MAX_ICON_DIMENSION = 256;

const PREFIX = 'data:image/png;base64,';
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ValidatedNotifIcon {
    png: Buffer;
    width: number;
    height: number;
}

/**
 * Validate a renderer-supplied notification icon. Returns the decoded PNG
 * bytes (plus declared size) when acceptable, otherwise null.
 */
export function validateNotifIconDataUrl(raw: unknown): ValidatedNotifIcon | null {
    if (typeof raw !== 'string') return null;
    if (raw.length > MAX_ICON_DATA_URL_CHARS) return null;
    if (!raw.startsWith(PREFIX)) return null;
    const body = raw.slice(PREFIX.length);
    // Length must be a multiple of 4 for canonical base64; also rejects ''.
    if (body.length === 0 || body.length % 4 !== 0) return null;
    if (!BASE64_BODY.test(body)) return null;

    const png = Buffer.from(body, 'base64');
    // Signature (8) + IHDR length (4) + 'IHDR' (4) + width (4) + height (4).
    if (png.length < 24) return null;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (png[i] !== PNG_SIGNATURE[i]) return null;
    }
    if (png.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width < 1 || height < 1) return null;
    if (width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) return null;

    return { png, width, height };
}
