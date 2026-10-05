/**
 * Avatar upload pipeline — single source of truth shared by Settings and the
 * onboarding wizard.
 *
 * Two pieces:
 *   1. `resizeImageToBlob` — decode a user-picked image and re-encode it to a
 *      square-capped JPEG (default 512px / q0.8, the avatar preset). Pure-ish:
 *      relies on DOM (FileReader/Image/canvas) but takes no app state.
 *   2. `uploadAvatarBlob` — encrypt + upload the blob, persist the decryption
 *      key locally, and broadcast it to the server key store. Returns the new
 *      attachment id (the value that goes in `PATCH /auth/profile.avatar_url`).
 *
 * The hook-bound dependencies (`uploadEncryptedFile`, `broadcastProfileAvatarKey`)
 * are injected so this stays a plain async function callable from anywhere that
 * already holds those hooks (SettingsModal, RegistrationWizard).
 */
import { saveAvatarKey } from './avatarKeyStore';

/** Resize/re-encode an image File to a JPEG Blob, capping the longest edge. */
export function resizeImageToBlob(
    file: File | Blob,
    maxSize = 512,
    quality = 0.8,
): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.onload = (event) => {
            const src = event.target?.result;
            if (typeof src !== 'string') { reject(new Error('Invalid image data')); return; }
            const img = new Image();
            img.onerror = () => reject(new Error('Failed to decode image'));
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Canvas unavailable')); return; }
                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > maxSize) { height *= maxSize / width; width = maxSize; }
                } else {
                    if (height > maxSize) { width *= maxSize / height; height = maxSize; }
                }
                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(
                    (blob) => blob ? resolve(blob) : reject(new Error('Failed to encode image')),
                    'image/jpeg',
                    quality,
                );
            };
            img.src = src;
        };
        reader.readAsDataURL(file);
    });
}

/** The hook functions an avatar upload needs, injected by the caller. */
export interface AvatarUploadDeps {
    uploadEncryptedFile: (
        file: File | Blob,
        fileName: string,
        mimeType: string,
        conversationId?: string,
    ) => Promise<{ attachmentId: string; keyB64: string; nonceB64: string }>;
    broadcastProfileAvatarKey: (attachmentId: string, keyB64: string, nonceB64: string) => Promise<void>;
}

/**
 * Encrypt + upload an already-resized avatar blob, persist its key on-device,
 * and broadcast the key to the server so other devices/peers can decrypt it.
 * Returns the attachment id to store in the profile.
 */
export async function uploadAvatarBlob(
    blob: Blob,
    deps: AvatarUploadDeps,
    fileName = 'avatar.jpg',
): Promise<string> {
    const { attachmentId, keyB64, nonceB64 } =
        await deps.uploadEncryptedFile(blob, fileName, 'image/jpeg');
    await saveAvatarKey(attachmentId, keyB64, nonceB64);
    await deps.broadcastProfileAvatarKey(attachmentId, keyB64, nonceB64);
    return attachmentId;
}
