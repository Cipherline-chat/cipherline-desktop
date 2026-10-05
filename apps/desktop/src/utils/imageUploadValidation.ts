/**
 * Shared validation for avatar/banner/group-icon uploads.
 *
 * Why a tiny module: three different files (SettingsModal, GroupSettingsModal,
 * and any future banner-on-friend-tile etc.) all need the same allowlist.
 * Centralizing prevents accidental drift between the inputs.
 */

/**
 * MIME types that round-trip cleanly through canvas → JPEG and render in
 * every browser-style surface we use (img tags, lightbox, encrypted-avatar
 * decryption pipeline). Notably excluded:
 *   - image/svg+xml — XSS via embedded scripts
 *   - image/heic / image/heif — Chromium support is patchy
 *   - image/avif — supported but not always rendered consistently
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
] as const;

/** For the `accept` attribute on `<input type="file">`. */
export const IMAGE_ACCEPT_ATTR = ALLOWED_IMAGE_MIME_TYPES.join(',');

/** 10 MiB cap. Avatars compress to < 100 KiB after canvas resize, but the
 *  raw upload could be a 4K phone photo before our resize step — 10 MiB
 *  comfortably absorbs that without letting someone DoS us with a 4 GiB file. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface ValidatedImage {
    ok: true;
    file: File;
}
export interface RejectedImage {
    ok: false;
    /** Human-readable reason — safe to display in a toast. */
    reason: string;
}

/**
 * Validate a File from <input type="file"> against the avatar/banner allowlist.
 * Caller passes the rejected result through to a toast / banner so the user
 * sees feedback instead of a silent no-op.
 */
export function validateImageUpload(file: File | null | undefined): ValidatedImage | RejectedImage {
    if (!file) return { ok: false, reason: 'No file selected.' };
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
        return {
            ok: false,
            reason: `Unsupported file type "${file.type || 'unknown'}". Use JPG, PNG, WEBP, or GIF.`,
        };
    }
    if (file.size > IMAGE_MAX_BYTES) {
        const mb = (file.size / 1024 / 1024).toFixed(1);
        return {
            ok: false,
            reason: `File is ${mb} MB. Maximum is ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
        };
    }
    return { ok: true, file };
}

/**
 * Custom server emojis — mirrors AttachmentsService's own 5 MiB cap on the
 * RAW upload exactly (see docs/custom-emoji-design.md), so a rejection here
 * and a rejection from the server always say the same number. This is NOT
 * the stored size — the server (EmojiImageProcessorService) center-crops
 * every accepted upload to a 128×128 square and re-encrypts it before it's
 * ever registered as an emoji, so the actual storage cost stays a few KB
 * regardless of how big the original picked file was. Deliberately its own
 * cap, not IMAGE_MAX_BYTES: a raw upload the server has to decode+resize is
 * a different cost shape than an avatar that's already been through this
 * same canvas-resize step client-side.
 *
 * No crop step client-side (unlike avatars/banners) — ClImageCropper always
 * flattens onto a white background and re-encodes as JPEG, which would
 * destroy both transparency (most emoji art expects it) and GIF animation.
 * Emojis upload as-picked at whatever aspect ratio the source file has; the
 * server enforces the square crop, the MIME allowlist, and the byte cap
 * regardless of what this client-side check says.
 */
export const EMOJI_MAX_BYTES = 5 * 1024 * 1024;

export function validateEmojiUpload(file: File | null | undefined): ValidatedImage | RejectedImage {
    if (!file) return { ok: false, reason: 'No file selected.' };
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
        return {
            ok: false,
            reason: `Unsupported file type "${file.type || 'unknown'}". Use JPG, PNG, WEBP, or GIF.`,
        };
    }
    if (file.size > EMOJI_MAX_BYTES) {
        const mb = (file.size / 1024 / 1024).toFixed(1);
        return {
            ok: false,
            reason: `File is ${mb} MB. Maximum is ${EMOJI_MAX_BYTES / 1024 / 1024} MB.`,
        };
    }
    return { ok: true, file };
}
