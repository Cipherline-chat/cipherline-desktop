/**
 * Uploads a link-preview thumbnail as an ordinary encrypted attachment
 * (the same flow every chat file takes: AES-256-GCM in the renderer, the
 * ciphertext PUT to the presigned URL, the key and IV returned for the E2EE
 * message — never sent to the server).
 *
 * What the server learns is what it learns for any attachment: an opaque blob
 * of about this size in this conversation / channel, under its normal
 * retention. The MIME type sent is `application/octet-stream`, so it does not
 * even learn the blob is an image. No file name (attachmentInitiate.ts).
 *
 * The initiate call goes through the app's axios (httpBootstrap's attestation
 * and version headers, like every API call); the PUT goes straight to the
 * presigned storage URL, as the chat's own uploads do.
 */
import axios from 'axios';
import { encryptBlob, exportKeyToBase64, generateAesGcmKey } from '../crypto';
import { buildAttachmentInitiateBody, type AttachmentInitiateBody } from '../attachmentInitiate';
import type { ThumbUploader } from './prepare';

export interface ThumbUploadTarget {
    token: string;
    apiBase: string;
    conversationId?: string;
    channelId?: string;
}

export interface ThumbUploadDeps {
    /** POST /attachments/initiate (default: the app's axios). */
    initiate?: (url: string, body: AttachmentInitiateBody, token: string) => Promise<{ attachment_id?: unknown; upload_url?: unknown }>;
    /** PUT to the presigned URL (default: fetch). */
    put?: (url: string, body: Blob) => Promise<{ ok: boolean; status: number }>;
}

const defaultInitiate: NonNullable<ThumbUploadDeps['initiate']> = async (url, body, token) =>
    (await axios.post(url, body, { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 })).data;
const defaultPut: NonNullable<ThumbUploadDeps['put']> = (url, body) =>
    fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });

export function createThumbUploader(target: ThumbUploadTarget, deps: ThumbUploadDeps = {}): ThumbUploader {
    const initiate = deps.initiate ?? defaultInitiate;
    const put = deps.put ?? defaultPut;
    return async (blob: Blob) => {
        const key = await generateAesGcmKey();
        const { encryptedBlob, ivB64 } = await encryptBlob(blob, key);
        const keyB64 = await exportKeyToBase64(key);
        const data = await initiate(`${target.apiBase}/attachments/initiate`, buildAttachmentInitiateBody({
            sizeBytes: encryptedBlob.size,
            mimeType: 'application/octet-stream',
            ...(target.channelId ? { channelId: target.channelId } : { conversationId: target.conversationId }),
        }), target.token);
        if (typeof data?.attachment_id !== 'string' || typeof data?.upload_url !== 'string') throw new Error('bad initiate response');
        const res = await put(data.upload_url, encryptedBlob);
        if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
        return { attachment_id: data.attachment_id, file_key_b64: keyB64, file_nonce_b64: ivB64, byte_size: blob.size };
    };
}
