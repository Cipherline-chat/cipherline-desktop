// @vitest-environment jsdom
// (attachmentDownload.ts imports axios, whose browser platform shim reads
//  `location.href` at module load — the default node environment has none.)
import { describe, it, expect } from 'vitest';
import { AttachmentDownloadError, isAttachmentGone, describeDownloadError } from './attachmentDownload';

/**
 * `isAttachmentGone` decides between the two very different failure UIs:
 *   gone  → subtle gray "Attachment no longer available", no Retry
 *   not   → the red "Couldn't decrypt — Retry" card
 *
 * The second is load-bearing and must NOT be blanket-silenced to make the
 * retention symptom go away: a 403, a timeout or a network error is a real
 * problem the user needs to see. Only a 404 means the bytes are gone.
 */
describe('isAttachmentGone', () => {
    it('is true for a 404 on the metadata leg (attachments row deleted)', () => {
        // Both deleters take this path: the client retention sweep's
        // DELETE /v1/attachments/:id and the API's 14-day sweepStaleAttachments.
        expect(isAttachmentGone(new AttachmentDownloadError('metadata_http_error', 'Request failed', 404))).toBe(true);
    });

    it('is true for a 404 on the blob leg (MinIO object missing, row survived)', () => {
        // Regression: this used to fall through to the red card because the
        // check demanded code === 'metadata_http_error'.
        expect(isAttachmentGone(new AttachmentDownloadError('download_http_error', 'HTTP 404', 404))).toBe(true);
    });

    it('is false for every non-404 HTTP status — a real error keeps its card', () => {
        for (const status of [400, 401, 403, 409, 500, 502, 503]) {
            expect(isAttachmentGone(new AttachmentDownloadError('metadata_http_error', 'x', status))).toBe(false);
            expect(isAttachmentGone(new AttachmentDownloadError('download_http_error', 'x', status))).toBe(false);
        }
    });

    it('is false for timeouts, network errors and user cancellation', () => {
        expect(isAttachmentGone(new AttachmentDownloadError('metadata_timeout'))).toBe(false);
        expect(isAttachmentGone(new AttachmentDownloadError('download_timeout'))).toBe(false);
        expect(isAttachmentGone(new AttachmentDownloadError('network', 'offline'))).toBe(false);
        expect(isAttachmentGone(new AttachmentDownloadError('aborted'))).toBe(false);
    });

    it('is false for a decrypt failure — a genuine key problem, not a deletion', () => {
        // This is the case the fix must keep visible: bad key material, GCM
        // auth failure, a corrupt envelope. It is not an AttachmentDownloadError.
        expect(isAttachmentGone(new Error('OperationError'))).toBe(false);
        expect(isAttachmentGone(null)).toBe(false);
        expect(isAttachmentGone(undefined)).toBe(false);
        expect(isAttachmentGone({ code: 'metadata_http_error', httpStatus: 404 })).toBe(false);
    });

    it('a 404 status without a matching code is still not "gone"', () => {
        // Defensive: only the two HTTP-shaped codes can carry a meaningful 404.
        expect(isAttachmentGone(new AttachmentDownloadError('network', 'x', 404))).toBe(false);
    });

    it('agrees with the human-readable description on the metadata 404', () => {
        const err = new AttachmentDownloadError('metadata_http_error', 'x', 404);
        expect(isAttachmentGone(err)).toBe(true);
        expect(describeDownloadError(err)).toBe('Attachment no longer available');
    });
});
