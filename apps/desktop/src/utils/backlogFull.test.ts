import { describe, expect, it } from 'vitest';
import { BACKLOG_FULL_REASON, backlogPartialNotice, isBacklogFullError } from './backlogFull';
import { sendFailureReason } from './pendingSend';

const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe('isBacklogFullError', () => {
    it('matches the typed 409 only', () => {
        expect(isBacklogFullError(err(409, { code: 'RECIPIENT_BACKLOG_FULL' }))).toBe(true);
    });
    it('negative control: other 409s, other codes and non-HTTP errors do not match', () => {
        expect(isBacklogFullError(err(409, { code: 'STALE_EPOCH' }))).toBe(false);
        expect(isBacklogFullError(err(413, { code: 'RECIPIENT_BACKLOG_FULL' }))).toBe(false);
        expect(isBacklogFullError(new Error('x'))).toBe(false);
        expect(isBacklogFullError(null)).toBe(false);
    });
});

describe('sendFailureReason names a full inbox', () => {
    it('shows the plain reason beside the failed message', () => {
        expect(sendFailureReason(err(409, { code: 'RECIPIENT_BACKLOG_FULL' }))).toBe(BACKLOG_FULL_REASON);
    });
    it('does not disturb the stale-epoch reason', () => {
        expect(sendFailureReason(err(409, { code: 'STALE_EPOCH' }))).toMatch(/newest key/);
    });
});

describe('backlogPartialNotice', () => {
    it('says which part went through when one device was skipped', () => {
        const n = backlogPartialNotice({ ok: true, queued: 1, backlog_full_device_ids: ['d1'] });
        expect(n?.message).toMatch(/one device/);
        expect(n?.message).toMatch(/other devices did/);
    });
    it('pluralises', () => {
        expect(backlogPartialNotice({ backlog_full_device_ids: ['a', 'b'] })?.message).toMatch(/2 devices/);
    });
    it('is silent for an ordinary response and for an older API (no field)', () => {
        expect(backlogPartialNotice({ ok: true, queued: 2, dropped: 0 })).toBeNull();
        expect(backlogPartialNotice({ backlog_full_device_ids: [] })).toBeNull();
        expect(backlogPartialNotice(undefined)).toBeNull();
    });
});
