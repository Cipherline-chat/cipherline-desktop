/**
 * "Create a server sticker from bytes + name" — the clean entry point for an
 * IMPORTER (the Discord import will map Discord stickers through this; the
 * mapping itself lives elsewhere). Plain async function, no React.
 *
 *   1. encrypt the bytes client-side (AES-256-GCM, WebCrypto — utils/crypto.ts)
 *   2. POST /v1/attachments/initiate with `server_id` (the server's emoji
 *      prefix; MANAGE_EMOJIS required), PUT the ciphertext to the signed URL
 *   3. POST /v1/servers/:sid/stickers/import — the `importSticker` bucket
 *      (10 / 10 s), separate from the 20/min moderator budget. Same
 *      permission, processing (320 px, <= 512 KiB), quota and 250-per-server
 *      cap as a hand upload; audit-logged as an import.
 *
 * Pass `via: 'manual'` to use the ordinary moderator route instead. On a 429
 * the caller should back off (`Retry-After`); this function does not retry.
 */
import axios from 'axios';
import { API_BASE } from '../../constants';
import { apiUrl } from '../apiPath';
import { buildAttachmentInitiateBody } from '../attachmentInitiate';
import { encryptBlob, exportKeyToBase64, generateAesGcmKey } from '../crypto';
import { sniffImageMime } from '../personalEmoji/token';
import { STICKER_NAME_RE, STICKER_UPLOAD_MAX_BYTES } from '@cipherline/shared';
import type { ServerSticker } from './serverStickers';

export interface CreateServerStickerInput {
    serverId: string;
    bytes: Uint8Array;
    /** `[a-z0-9_]{2,32}` (lowercased by the server). */
    name: string;
    description?: string;
    tags?: string[];
    token: string;
    via?: 'import' | 'manual';
    signal?: AbortSignal;
}

export async function createServerStickerFromBytes(input: CreateServerStickerInput): Promise<ServerSticker> {
    const { serverId, bytes, token, signal } = input;
    const name = input.name.toLowerCase();
    if (!STICKER_NAME_RE.test(name)) throw new Error('Sticker names are 2-32 letters, numbers or underscores.');
    if (bytes.length === 0 || bytes.length > STICKER_UPLOAD_MAX_BYTES) throw new Error('Sticker uploads must be 5 MB or smaller.');
    const mime = sniffImageMime(bytes);
    if (!mime) throw new Error('Stickers must be PNG, JPEG, WebP or GIF.');
    const headers = { Authorization: `Bearer ${token}` };

    const key = await generateAesGcmKey();
    const { encryptedBlob, ivB64 } = await encryptBlob(new Blob([bytes as BlobPart], { type: mime }), key);
    const keyB64 = await exportKeyToBase64(key);

    const init = await axios.post(`${API_BASE}/attachments/initiate`,
        buildAttachmentInitiateBody({ sizeBytes: encryptedBlob.size, mimeType: mime, serverId }),
        { headers, signal });
    const put = await fetch(init.data.upload_url, { method: 'PUT', headers: { 'Content-Type': mime }, body: encryptedBlob, signal });
    if (!put.ok) throw new Error(`Upload failed: HTTP ${put.status}`);

    const body = {
        name,
        attachment_id: init.data.attachment_id as string,
        key_b64: keyB64,
        nonce_b64: ivB64,
        ...(input.description ? { description: input.description } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
    };
    const url = input.via === 'manual' ? apiUrl`/servers/${serverId}/stickers` : apiUrl`/servers/${serverId}/stickers/import`;
    const res = await axios.post<ServerSticker>(url, body, { headers, signal });
    return res.data;
}
