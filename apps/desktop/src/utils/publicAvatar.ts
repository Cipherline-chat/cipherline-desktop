/**
 * Public profile picture: the ONE profile image that is not end-to-end
 * encrypted (owner decision 2026-10-06).
 *
 * Your avatar is still uploaded encrypted exactly as before (avatarUpload.ts);
 * in addition, the same cropped image is uploaded in plaintext to
 * `PUT /v1/users/me/public-avatar`, where the server re-encodes it (256x256
 * WebP, all metadata stripped) and shows it on your public referral page
 * (cipherline.chat/ref/<code>). Nothing else is ever sent there: only the
 * avatar image bytes, plus the attachment id of the encrypted avatar it was
 * made from (`source`, which the server already has as your `avatar_url`).
 * Banners, messages, files and everything else stay end-to-end encrypted.
 *
 * Three entry points, all fail-soft (a public-avatar problem must never fail
 * or slow an avatar change, a sign-in or app start):
 *   - {@link publishPublicAvatarInBackground}: called by `uploadAvatarBlob`,
 *     the ONE avatar-upload helper shared by Settings → Profile and the
 *     onboarding profile step, so every avatar-set path publishes with no
 *     extra wiring.
 *   - removal needs no client call: `PATCH /auth/profile` with
 *     `avatar_url: null` deletes the public copy server-side (and a copy made
 *     from an older avatar is never served). {@link removePublicAvatar} exists
 *     for the startup self-heal below.
 *   - {@link syncPublicAvatar}: the startup backfill/self-heal, run on idle by
 *     `usePublicAvatarSync` (existing users who set their avatar before this
 *     shipped, or changed it from a client that does not publish).
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import secureLocalStore from './secureLocalStore';

export const PUBLIC_AVATAR_ENDPOINT = `${API_BASE}/users/me/public-avatar`;

/** Server-side cap (public-avatar.processor.ts PUBLIC_AVATAR_MAX_INPUT_BYTES). */
export const PUBLIC_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type PublicAvatarMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface PublicAvatarStatus {
    exists: boolean;
    source: string | null;
    updated_at: string | null;
    served: boolean;
}

/** Content type from the image's own magic bytes (the server sniffs too;
 *  this only picks the header it will accept). null = not uploadable. */
export function sniffImageMime(head: Uint8Array): PublicAvatarMime | null {
    const ascii = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b));
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
    return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session's access token, read at call time from the same encrypted
 * store AuthContext persists (and refreshes) it in. Read here rather than
 * threaded through `uploadAvatarBlob`'s deps so every existing caller of that
 * helper (including the onboarding branch) publishes with no new wiring.
 */
function currentAccessToken(): string | null {
    try {
        return secureLocalStore.getItem('cipherline_token');
    } catch {
        return null;
    }
}

/**
 * Upload `blob` (the plaintext, already-cropped avatar) as the public copy of
 * the encrypted avatar `sourceAttachmentId`. Throws on failure; callers that
 * must not fail use the background variant.
 */
export async function publishPublicAvatar(
    blob: Blob,
    sourceAttachmentId: string,
    token: string | null = currentAccessToken(),
): Promise<PublicAvatarStatus | null> {
    if (!token) return null;
    if (!UUID_RE.test(sourceAttachmentId)) return null;
    if (blob.size === 0 || blob.size > PUBLIC_AVATAR_MAX_BYTES) return null;
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const mime = sniffImageMime(head);
    if (!mime) return null;
    const res = await axios.put<PublicAvatarStatus>(PUBLIC_AVATAR_ENDPOINT, blob, {
        params: { source: sourceAttachmentId },
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
        // No transform: the Blob is the body, byte for byte.
        transformRequest: [(data) => data],
        timeout: 30_000,
    });
    return res.data;
}

/** Fire-and-forget {@link publishPublicAvatar}. Never throws, never awaited
 *  by the avatar save, so a slow or failing public upload costs the user
 *  nothing; the startup sync retries it next launch. */
export function publishPublicAvatarInBackground(blob: Blob, sourceAttachmentId: string): void {
    void publishPublicAvatar(blob, sourceAttachmentId).catch((err) => {
        console.warn('[publicAvatar] publish failed; will retry at next start', err?.response?.status ?? err);
    });
}

export async function getPublicAvatarStatus(token: string): Promise<PublicAvatarStatus> {
    const res = await axios.get<PublicAvatarStatus>(PUBLIC_AVATAR_ENDPOINT, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
    });
    return res.data;
}

export async function removePublicAvatar(token: string): Promise<void> {
    await axios.delete(PUBLIC_AVATAR_ENDPOINT, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
    });
}

export type PublicAvatarAction = 'none' | 'upload' | 'remove';

/**
 * What the startup sync should do, given the profile's current encrypted
 * avatar id and the server's record of the public copy. Pure.
 *   - avatar set, copy missing or made from a different avatar -> upload
 *   - no avatar, but a copy exists                              -> remove
 *   - otherwise                                                 -> nothing
 */
export function decidePublicAvatarAction(
    avatarUrl: string | null | undefined,
    status: Pick<PublicAvatarStatus, 'exists' | 'source'>,
): PublicAvatarAction {
    const current = avatarUrl || null;
    if (current) return status.exists && status.source === current ? 'none' : 'upload';
    return status.exists ? 'remove' : 'none';
}

export interface SyncPublicAvatarDeps {
    token: string;
    /** The profile's current encrypted avatar id (`user.avatar_url`). */
    avatarUrl: string | null;
    /** The decrypted avatar the client already has (cache first, then a normal
     *  authenticated download + decrypt). null = not available right now. */
    loadDecryptedAvatar: (attachmentId: string) => Promise<Blob | null>;
}

/**
 * Bring the public copy in line with the current avatar. At most one GET and
 * one write. Never throws; returns what it did (for tests and logs).
 */
export async function syncPublicAvatar(deps: SyncPublicAvatarDeps): Promise<PublicAvatarAction | 'skipped'> {
    try {
        const status = await getPublicAvatarStatus(deps.token);
        const action = decidePublicAvatarAction(deps.avatarUrl, status);
        if (action === 'remove') {
            await removePublicAvatar(deps.token);
            return action;
        }
        if (action === 'upload' && deps.avatarUrl) {
            const blob = await deps.loadDecryptedAvatar(deps.avatarUrl);
            if (!blob) return 'skipped';
            const done = await publishPublicAvatar(blob, deps.avatarUrl, deps.token);
            return done ? action : 'skipped';
        }
        return action;
    } catch (err) {
        console.warn('[publicAvatar] startup sync skipped', (err as { response?: { status?: number } })?.response?.status ?? err);
        return 'skipped';
    }
}
