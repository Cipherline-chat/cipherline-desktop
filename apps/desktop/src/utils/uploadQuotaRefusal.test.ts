import { describe, expect, it } from 'vitest';
import { uploadQuotaRefusal } from './uploadQuotaRefusal';

const GB = 1024 ** 3;
const axiosErr = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe('uploadQuotaRefusal', () => {
    it('reads the typed 413 body and shows the server text', () => {
        const r = uploadQuotaRefusal(axiosErr(413, { code: 'upload_quota_exceeded', message: 'You have reached your upload limit', remaining_bytes: 5 * 1024 * 1024, limit_bytes: 10 * GB, window_days: 14 }));
        expect(r).toEqual({ title: 'Upload limit reached', message: 'You have reached your upload limit', remainingBytes: 5 * 1024 * 1024 });
    });
    it('falls back to its own plain words when the message is missing', () => {
        const r = uploadQuotaRefusal(axiosErr(413, { code: 'upload_quota_exceeded', remaining_bytes: 0, limit_bytes: 10 * GB, window_days: 14 }));
        expect(r?.message).toContain('10 GB');
        expect(r?.message).toContain('14 days');
        expect(r?.message).toContain('Messages and smaller files still send');
    });
    it('is NOT triggered by other errors (negative control)', () => {
        expect(uploadQuotaRefusal(axiosErr(413, { message: 'Message too large' }))).toBeNull();
        expect(uploadQuotaRefusal(axiosErr(400, { code: 'upload_quota_exceeded' }))).toBeNull();
        expect(uploadQuotaRefusal(axiosErr(400, { code: 'upgrade_required' }))).toBeNull();
        expect(uploadQuotaRefusal(new Error('network'))).toBeNull();
        expect(uploadQuotaRefusal(null)).toBeNull();
    });
});
