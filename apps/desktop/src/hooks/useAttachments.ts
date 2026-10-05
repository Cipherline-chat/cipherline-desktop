import { useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { generateAesGcmKey, encryptBlob, exportKeyToBase64 } from '../utils/crypto';
import { buildAttachmentInitiateBody } from '../utils/attachmentInitiate';

export function useAttachments(token: string | null) {
    // P2-REND-10: keyed by per-upload UUID so concurrent uploads of files with
    // the same name don't clobber each other's progress.
    const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});

    const uploadEncryptedFile = async (
        file: File | Blob,
        /** Unused, and never sent to the server — the real name belongs
         *  in the E2EE envelope. Kept only so the positional arguments
         *  after it don't shift under existing callers. */
        _fileName: string,
        mimeType: string,
        conversationId?: string,
        signal?: AbortSignal,
        /** Custom-server-emoji upload — mutually exclusive with conversationId.
         *  Routes the object key under server_emojis/<serverId>/… server-side
         *  and requires MANAGE_EMOJIS on that server (AttachmentsService). */
        serverId?: string,
        /** Group-conversation icon upload. Goes WITH conversationId, and is
         *  what makes the server file the object under
         *  group_icons/<conversationId>/… instead of <conversationId>/….
         *
         *  Load-bearing, not cosmetic: that prefix is how the server tells a
         *  group icon apart from an ordinary chat attachment, which is the
         *  distinction PATCH /attachments/:id/key now enforces before it will
         *  take custody of a decryption key. Omit it on a group icon and the
         *  key store is refused, so the icon never renders for anyone else.
         *  Ordinary chat attachments must NOT set it. */
        purpose?: 'group_icon',
    ) => {
        if (!token) throw new Error('Not authenticated');

        // 1. Generate Key & Encrypt
        const key = await generateAesGcmKey();
        const { encryptedBlob, ivB64 } = await encryptBlob(file as Blob, key);
        const keyB64 = await exportKeyToBase64(key);

        // 2. Initiate upload. No file name: see utils/attachmentInitiate.ts.
        const payload = buildAttachmentInitiateBody({
            sizeBytes: encryptedBlob.size,
            mimeType,
            conversationId,
            serverId,
            purpose,
        });

        const initRes = await axios.post(`${API_BASE}/attachments/initiate`, payload, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
        });

        const attachmentId = initRes.data.attachment_id;
        const uploadUrl = initRes.data.upload_url;

        // 3. Perform PUT upload with progress tracking
        const uploadId = crypto.randomUUID();
        const clearProgress = () => setUploadProgress(prev => {
            const next = { ...prev };
            delete next[uploadId];
            return next;
        });

        await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', uploadUrl);
            xhr.setRequestHeader('Content-Type', mimeType);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    setUploadProgress(prev => ({ ...prev, [uploadId]: pct }));
                }
            };

            xhr.onload = () => {
                clearProgress();
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    reject(new Error(`Upload failed: HTTP ${xhr.status} ${xhr.statusText}`));
                }
            };

            // P2-REND-10: clear progress on failure/abort so the entry doesn't stick.
            xhr.onerror = () => { clearProgress(); reject(new Error('Upload network error')); };
            xhr.onabort = () => { clearProgress(); reject(new Error('Upload aborted')); };

            // P2-REND-10: honour the AbortSignal from the caller.
            if (signal) {
                if (signal.aborted) { xhr.abort(); return; }
                signal.addEventListener('abort', () => xhr.abort(), { once: true });
            }

            xhr.send(encryptedBlob);
        });

        // 4. Return metadata
        return {
            attachmentId,
            keyB64,
            nonceB64: ivB64,
            byteSize: file.size || encryptedBlob.size
        };
    };

    return {
        uploadEncryptedFile,
        uploadProgress
    };
}
