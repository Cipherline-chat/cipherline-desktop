/**
 * attachmentDownload — single source of truth for fetching encrypted
 * attachment ciphertext from the API.
 *
 * Why this exists:
 *   The previous inline download paths in ChatPane.tsx had no HTTP timeouts
 *   on either the metadata `axios.get` or the presigned-URL blob fetch, so a
 *   stalled MinIO connection or a hung API call could leave the in-flight
 *   Promise unresolved indefinitely. The UI then sat in "Decrypting…" forever
 *   with no way out except an app restart.
 *
 * What this gives callers:
 *   - Hard timeouts on every step (metadata GET → 10s, blob GET → 60s by default)
 *   - AbortSignal honoured at every layer so a Cancel button actually cancels
 *   - Structured AttachmentDownloadError so callers can render a precise
 *     "Couldn't decrypt — Network timeout" / "HTTP 404" message instead of a
 *     generic spinner-of-doom.
 *   - Progress callback so the manual-decrypt progress bar still updates.
 */

import axios from 'axios';

export type AttachmentDownloadErrorCode =
    | 'metadata_timeout'
    | 'metadata_http_error'
    | 'download_timeout'
    | 'download_http_error'
    | 'aborted'
    | 'network';

export class AttachmentDownloadError extends Error {
    code: AttachmentDownloadErrorCode;
    httpStatus?: number;
    constructor(code: AttachmentDownloadErrorCode, message?: string, httpStatus?: number) {
        super(message ?? code);
        this.name = 'AttachmentDownloadError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/** Friendly one-line description for surfacing in the failure card. */
export function describeDownloadError(err: unknown): string {
    if (!(err instanceof AttachmentDownloadError)) return 'Decryption failed';
    switch (err.code) {
        case 'metadata_timeout':  return 'Server took too long to respond';
        case 'metadata_http_error': return err.httpStatus === 404
            ? 'Attachment no longer available'
            : `Server error (HTTP ${err.httpStatus ?? '?'})`;
        case 'download_timeout':  return 'Download timed out';
        case 'download_http_error': return `Download failed (HTTP ${err.httpStatus ?? '?'})`;
        case 'aborted':           return 'Cancelled';
        case 'network':           return 'Network error — check your connection';
    }
}

/**
 * True when a download failure means the ciphertext is GONE rather than
 * temporarily unreachable — i.e. render the subtle "Attachment no longer
 * available" placeholder, never the red "Couldn't decrypt — Retry" card.
 *
 * Two distinct 404s mean this, and only one of them used to be recognised:
 *   - `metadata_http_error` 404: `GET /v1/attachments/:id/download` 404s
 *     because the `attachments` row is gone. Both deleters take this path —
 *     the client retention sweep's `DELETE /v1/attachments/:id` and the API's
 *     14-day `sweepStaleAttachments` — since each removes the MinIO object and
 *     the row together.
 *   - `download_http_error` 404: the row survived but the presigned GET 404s
 *     from MinIO, i.e. the object is missing. Reachable whenever object and
 *     row fall out of step (a `DeleteObjectCommand` that succeeded while the
 *     row delete did not; a bucket restored from an older snapshot). The bytes
 *     are just as gone, so it must not surface as a decrypt failure the user
 *     is invited to retry forever.
 *
 * Deliberately narrow: ONLY 404. A 403, a timeout, or a network error is a
 * genuine, possibly transient failure and must keep its error card — silencing
 * those to make this symptom go away would hide real key/permission problems.
 */
export function isAttachmentGone(err: unknown): boolean {
    if (!(err instanceof AttachmentDownloadError)) return false;
    if (err.httpStatus !== 404) return false;
    return err.code === 'metadata_http_error' || err.code === 'download_http_error';
}

export interface DownloadOptions {
    /** Called with 0..100 as bytes are received. */
    onProgress?: (pct: number) => void;
    /** External abort signal so a Cancel button can stop the download. */
    signal?: AbortSignal;
    /** Timeout for the metadata GET that returns the presigned URL. Default 10s. */
    metadataTimeoutMs?: number;
    /** Timeout for the blob GET. Default 60s — large attachments need headroom. */
    downloadTimeoutMs?: number;
}

/**
 * Fetch the encrypted (ciphertext) blob for an attachment from MinIO via the
 * API's presigned-URL endpoint.  Throws AttachmentDownloadError on any failure
 * so callers can render a precise error message instead of staying stuck.
 */
export async function downloadEncryptedAttachment(
    attachmentId: string,
    token: string,
    apiBase: string,
    opts: DownloadOptions = {},
): Promise<Blob> {
    const {
        onProgress,
        signal: externalSignal,
        metadataTimeoutMs = 10_000,
        downloadTimeoutMs = 60_000,
    } = opts;

    // Step 1: ask the API for a presigned download URL.
    let downloadUrl: string;
    try {
        const res = await axios.get(
            `${apiBase}/attachments/${attachmentId}/download`,
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: metadataTimeoutMs,
                // Forward the abort signal so Cancel works during the metadata phase.
                signal: externalSignal as any,
            },
        );
        downloadUrl = res.data?.download_url;
        if (!downloadUrl) {
            throw new AttachmentDownloadError('metadata_http_error', 'Server did not return a download URL');
        }
    } catch (err: any) {
        if (err instanceof AttachmentDownloadError) throw err;
        if (axios.isCancel?.(err) || err?.code === 'ERR_CANCELED' || externalSignal?.aborted) {
            throw new AttachmentDownloadError('aborted');
        }
        if (err?.code === 'ECONNABORTED' || err?.message?.toLowerCase?.().includes('timeout')) {
            throw new AttachmentDownloadError('metadata_timeout');
        }
        if (axios.isAxiosError?.(err) && err.response) {
            throw new AttachmentDownloadError('metadata_http_error', err.message, err.response.status);
        }
        throw new AttachmentDownloadError('network', err?.message);
    }

    // Step 2: fetch the ciphertext blob from MinIO via the presigned URL.
    // We use XMLHttpRequest here (rather than fetch) so we can stream
    // download progress with `onProgress` — fetch doesn't expose that on
    // the request body in a stable cross-browser way for the response side
    // without ReadableStream juggling.
    return await new Promise<Blob>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let timedOut = false;

        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            try { xhr.abort(); } catch { /* ignore */ }
            reject(new AttachmentDownloadError('download_timeout'));
        }, downloadTimeoutMs);

        const onAbort = () => {
            try { xhr.abort(); } catch { /* ignore */ }
        };
        externalSignal?.addEventListener?.('abort', onAbort);

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            externalSignal?.removeEventListener?.('abort', onAbort);
        };

        xhr.open('GET', downloadUrl);
        xhr.responseType = 'blob';

        xhr.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
            }
        };

        xhr.onload = () => {
            cleanup();
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response as Blob);
            } else {
                reject(new AttachmentDownloadError('download_http_error', `HTTP ${xhr.status}`, xhr.status));
            }
        };

        xhr.onerror = () => {
            cleanup();
            if (timedOut) return; // already rejected with timeout
            if (externalSignal?.aborted) {
                reject(new AttachmentDownloadError('aborted'));
            } else {
                reject(new AttachmentDownloadError('network', 'Download network error'));
            }
        };

        xhr.onabort = () => {
            cleanup();
            if (timedOut) return; // already rejected with timeout
            reject(new AttachmentDownloadError('aborted'));
        };

        try {
            xhr.send();
        } catch (err: any) {
            cleanup();
            reject(new AttachmentDownloadError('network', err?.message));
        }
    });
}
