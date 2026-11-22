import { describe, it, expect, beforeEach } from 'vitest';
import { Permissions, SLOWMODE_ERROR_CODE, AGE_GATE_ERROR_CODE } from '@cipherline/shared';
import {
    slowmodeSecondsOf, isSlowmodeExempt, isChannelAgeGated, isSlowmodeError, slowmodeRetryMs, isAgeGateError,
    formatCountdown, startSlowmode, slowmodeLeftMs, clampSlowmode, resetSlowmodeClockForTests,
} from './channelModeration';
import { withRateLimitRetry } from './deliveryQueue';
import { sendFailureReason } from './pendingSend';

const err = (status: number, data: Record<string, unknown>) => Object.assign(new Error('x'), { response: { status, data, headers: {} } });
const slow = (ms: number) => err(429, { code: SLOWMODE_ERROR_CODE, retry_after_ms: ms, slowmode_seconds: 30 });

describe('settings readers', () => {
    it('slowmodeSecondsOf: absent / junk = off', () => {
        expect(slowmodeSecondsOf(undefined)).toBe(0);
        expect(slowmodeSecondsOf({})).toBe(0);
        expect(slowmodeSecondsOf({ slowmode_seconds: 0 })).toBe(0);
        expect(slowmodeSecondsOf({ slowmode_seconds: -3 })).toBe(0);
        expect(slowmodeSecondsOf({ slowmode_seconds: 30 })).toBe(30);
    });
    it('isSlowmodeExempt mirrors the server: MANAGE_MESSAGES or MANAGE_CHANNELS only', () => {
        expect(isSlowmodeExempt(Permissions.MANAGE_MESSAGES.toString())).toBe(true);
        expect(isSlowmodeExempt(Permissions.MANAGE_CHANNELS.toString())).toBe(true);
        expect(isSlowmodeExempt((Permissions.SEND_MESSAGES | Permissions.VIEW_CHANNEL).toString())).toBe(false);
        expect(isSlowmodeExempt(undefined)).toBe(false);
        expect(isSlowmodeExempt('not a number')).toBe(false);
    });
    it('isChannelAgeGated: restricted and not confirmed', () => {
        expect(isChannelAgeGated({ age_restricted: true })).toBe(true);
        expect(isChannelAgeGated({ age_restricted: true, age_gate_confirmed: false })).toBe(true);
        expect(isChannelAgeGated({ age_restricted: true, age_gate_confirmed: true })).toBe(false);
        expect(isChannelAgeGated({ age_restricted: false })).toBe(false);
        expect(isChannelAgeGated({})).toBe(false);
        expect(isChannelAgeGated(null)).toBe(false);
    });
});

describe('server errors', () => {
    it('recognises slowmode only by status AND code (a throttler 429 is not slowmode)', () => {
        expect(isSlowmodeError(slow(5000))).toBe(true);
        expect(isSlowmodeError(err(429, { message: 'ThrottlerException' }))).toBe(false);
        expect(isSlowmodeError(err(403, { code: SLOWMODE_ERROR_CODE }))).toBe(false);
        expect(slowmodeRetryMs(slow(5000))).toBe(5000);
        expect(slowmodeRetryMs(err(429, {}))).toBeUndefined();
        expect(slowmodeRetryMs(err(429, { code: SLOWMODE_ERROR_CODE, retry_after_ms: 'soon' }))).toBeUndefined();
    });
    it('recognises the age gate', () => {
        expect(isAgeGateError(err(403, { code: AGE_GATE_ERROR_CODE }))).toBe(true);
        expect(isAgeGateError(err(403, { code: 'OTHER' }))).toBe(false);
    });
    it('a slowmode refusal is NOT retried by the delivery queue (the throttler 429 still is)', async () => {
        let n = 0;
        await expect(withRateLimitRetry(async () => { n++; throw slow(60_000); }, { sleep: async () => undefined })).rejects.toBeDefined();
        expect(n).toBe(1);
        n = 0;
        await expect(withRateLimitRetry(async () => { n++; throw err(429, {}); }, { sleep: async () => undefined })).rejects.toBeDefined();
        expect(n).toBe(3);
    });
    it('the failed-message reason names the wait', () => {
        expect(sendFailureReason(slow(23_000))).toBe('Slowmode: wait 0:23');
        expect(sendFailureReason(err(429, { code: SLOWMODE_ERROR_CODE }))).toBe('Slowmode is on in this channel');
        expect(sendFailureReason(err(429, {}))).toBe('Sending too fast');
        expect(sendFailureReason(err(403, { code: AGE_GATE_ERROR_CODE }))).toMatch(/18/);
    });
});

describe('formatCountdown', () => {
    it.each([[0, '0:00'], [1, '0:01'], [23_000, '0:23'], [23_001, '0:24'], [60_000, '1:00'], [605_000, '10:05'], [3_600_000, '1:00:00'], [21_600_000, '6:00:00'], [-5, '0:00']])('%i ms -> %s', (ms, out) => {
        expect(formatCountdown(ms)).toBe(out);
    });
});

describe('the slowmode clock', () => {
    beforeEach(resetSlowmodeClockForTests);
    it('runs down, per user and per channel, then frees', () => {
        startSlowmode('u', 'c', 10_000, 1000);
        expect(slowmodeLeftMs('u', 'c', 1000)).toBe(10_000);
        expect(slowmodeLeftMs('u', 'c', 6000)).toBe(5000);
        expect(slowmodeLeftMs('u', 'other', 6000)).toBe(0);
        expect(slowmodeLeftMs('someone-else', 'c', 6000)).toBe(0);
        expect(slowmodeLeftMs('u', 'c', 11_000)).toBe(0);
    });
    it('lowering the slowmode shortens a running window; switching it off ends it', () => {
        startSlowmode('u', 'c', 3_600_000, 0);
        clampSlowmode('u', 'c', 5_000, 1000);
        expect(slowmodeLeftMs('u', 'c', 1000)).toBe(5000);
        clampSlowmode('u', 'c', 0, 2000);
        expect(slowmodeLeftMs('u', 'c', 2000)).toBe(0);
    });
    it('clamping never LENGTHENS a window', () => {
        startSlowmode('u', 'c', 2_000, 0);
        clampSlowmode('u', 'c', 60_000, 0);
        expect(slowmodeLeftMs('u', 'c', 0)).toBe(2000);
    });
});
