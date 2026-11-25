/**
 * The account's real profile picture for the QR sign-in CONFIRM step
 * ("You are about to sign in as @name#1234") — fetched with the PENDING
 * session's own access token, decrypted in memory, persisted nowhere.
 *
 * Why this is possible before the user confirms, and why it leaks nothing:
 *
 *   - Profile avatars are AES-256-GCM blobs whose key is stored on the
 *     attachment row (useAvatarBroadcast.ts — the "avatar-class" key model),
 *     and `GET /v1/attachments/:id/key` hands that key to the UPLOADER, their
 *     friends and co-members (attachments.service.ts `getKey`). The avatar on
 *     the confirm screen is the signing-in account's OWN avatar, so the
 *     uploader branch applies.
 *   - At the confirm step this desktop already holds a real access token for
 *     that account (claimed, not yet persisted) and has already used it once
 *     for `GET /auth/me`. Two more authenticated reads of the account's own
 *     avatar tell the server nothing it does not already know: that this
 *     token's account fetched its own avatar. No new field is relayed through
 *     the link session, and the phone has to send nothing extra.
 *   - Nothing is cached: not in the avatar IndexedDB tier, not in the avatar
 *     key store. Before the user confirms there is no signed-in account for
 *     `secureLocalStore` to be bound to, and a rejected/abandoned sign-in
 *     must leave no trace of the other account on this machine. After
 *     "Continue" the Dashboard loads (and caches) the avatar the normal way.
 *
 * Which account's picture this shows is decided by the token, i.e. by the
 * server — the same authority QR-1 uses for the handle. A hostile approver's
 * substituted grant therefore shows the HOSTILE account's picture, which is
 * exactly what lets the user notice and press "This isn't my account".
 *
 * Fail-soft everywhere: any failure resolves `null` and the view keeps the
 * identity-colour letter tile.
 */
import axios from 'axios';
import { apiUrl } from './apiPath';
import { importKeyFromBase64, decryptBlob } from './crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The server caps avatar uploads at 10 MiB (attachments.service.ts
 *  MAX_AVATAR_BYTES); allow the AES-GCM tag on top. Anything larger is not an
 *  avatar this server would have accepted. */
export const LINK_AVATAR_MAX_BYTES = 10 * 1024 * 1024 + 64;

/** Only these decode in an <img> and are what avatar uploads produce. */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface LinkAvatarHttp {
    get: (url: string, config?: { headers?: Record<string, string>; responseType?: 'blob' }) => Promise<{ data: unknown }>;
}

export interface LinkAvatarDeps {
    http: LinkAvatarHttp;
    importKey: (keyB64: string) => Promise<CryptoKey>;
    decrypt: (blob: Blob, key: CryptoKey, ivB64: string, mime: string) => Promise<Blob>;
}

/** `avatar_url` from `/auth/me` is an attachment id for an encrypted avatar.
 *  Anything else (null, a legacy URL, garbage) means "no picture". */
export function isAvatarAttachmentId(value: string | null | undefined): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Download + decrypt the account's avatar with the pending token. Returns the
 * decrypted image Blob, or null on any failure.
 *
 * `deps.http` must be a FRESH axios instance, never the global one: the
 * Dashboard installs a 401 interceptor on the global instance that refreshes
 * and retries with the CURRENTLY signed-in account's token (and signs that
 * account out on a failed refresh). Both routes are @SkipAttestation +
 * @SkipVersionCheck, so the global request interceptors are not needed.
 */
export async function fetchLinkAvatarPreview(
    attachmentId: string | null | undefined,
    accessToken: string,
    deps: LinkAvatarDeps = defaultDeps(),
): Promise<Blob | null> {
    if (!isAvatarAttachmentId(attachmentId) || !accessToken) return null;
    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
    try {
        const [urlRes, keyRes] = await Promise.all([
            deps.http.get(apiUrl`/attachments/${attachmentId}/download`, auth),
            deps.http.get(apiUrl`/attachments/${attachmentId}/key`, auth),
        ]);
        const meta = urlRes.data as { download_url?: unknown; mime_type?: unknown } | null;
        const key = keyRes.data as { file_key_b64?: unknown; file_nonce_b64?: unknown } | null;
        const downloadUrl = typeof meta?.download_url === 'string' ? meta.download_url : '';
        const mime = typeof meta?.mime_type === 'string' ? meta.mime_type.toLowerCase().split(';')[0].trim() : '';
        if (!/^https?:\/\//i.test(downloadUrl) || !IMAGE_MIME.has(mime)) return null;
        if (typeof key?.file_key_b64 !== 'string' || typeof key?.file_nonce_b64 !== 'string') return null;

        // The presigned object URL carries its own capability; no Authorization
        // header goes to object storage.
        const blobRes = await deps.http.get(downloadUrl, { responseType: 'blob' });
        const encrypted = blobRes.data;
        if (!(encrypted instanceof Blob) || encrypted.size === 0 || encrypted.size > LINK_AVATAR_MAX_BYTES) return null;
        const cryptoKey = await deps.importKey(key.file_key_b64);
        const plain = await deps.decrypt(encrypted, cryptoKey, key.file_nonce_b64, mime);
        return plain.size > 0 ? plain : null;
    } catch {
        return null;
    }
}

function defaultDeps(): LinkAvatarDeps {
    const client = axios.create({ timeout: 10_000 });
    return {
        http: { get: (url, config) => client.get(url, config) },
        importKey: importKeyFromBase64,
        decrypt: decryptBlob,
    };
}
