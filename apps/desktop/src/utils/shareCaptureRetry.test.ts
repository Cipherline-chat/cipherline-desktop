import { describe, it, expect, vi } from 'vitest';
import { retryTransientCapture, isTransientCaptureError, CAPTURE_RETRY_DELAYS_MS } from './shareCaptureRetry';

const err = (name: string) => Object.assign(new Error('x'), { name });

describe('isTransientCaptureError', () => {
    it('NotReadableError and AbortError only', () => {
        expect(isTransientCaptureError(err('NotReadableError'))).toBe(true);
        expect(isTransientCaptureError(err('AbortError'))).toBe(true);
        expect(isTransientCaptureError(err('NotAllowedError'))).toBe(false);
        expect(isTransientCaptureError(err('NotFoundError'))).toBe(false);
        expect(isTransientCaptureError(null)).toBe(false);
    });
});

describe('retryTransientCapture', () => {
    it('returns the first success without sleeping', async () => {
        const sleep = vi.fn(async (_ms: number) => {});
        expect(await retryTransientCapture(async () => 'ok', { sleep })).toBe('ok');
        expect(sleep).not.toHaveBeenCalled();
    });
    it('the quality-change failure: NotReadableError once, then the capture comes back', async () => {
        const sleep = vi.fn(async (_ms: number) => {});
        const onRetry = vi.fn();
        const attempt = vi.fn(async (n: number) => { if (n === 0) throw err('NotReadableError'); return 'track'; });
        expect(await retryTransientCapture(attempt, { sleep, onRetry })).toBe('track');
        expect(attempt).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(CAPTURE_RETRY_DELAYS_MS[0]);
        expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'NotReadableError' }));
    });
    it('gives up after the last delay and throws the last error', async () => {
        const sleep = vi.fn(async (_ms: number) => {});
        const attempt = vi.fn(async () => { throw err('NotReadableError'); });
        await expect(retryTransientCapture(attempt, { sleep })).rejects.toMatchObject({ name: 'NotReadableError' });
        expect(attempt).toHaveBeenCalledTimes(CAPTURE_RETRY_DELAYS_MS.length + 1);
        expect(sleep.mock.calls.map(c => c[0])).toEqual([...CAPTURE_RETRY_DELAYS_MS]);
    });
    it('never retries a refusal or a vanished source', async () => {
        for (const name of ['NotAllowedError', 'NotFoundError', 'TypeError']) {
            const attempt = vi.fn(async () => { throw err(name); });
            await expect(retryTransientCapture(attempt, { sleep: async () => {} })).rejects.toMatchObject({ name });
            expect(attempt).toHaveBeenCalledTimes(1);
        }
    });
    it('no delays (a plain start) = no retry', async () => {
        const attempt = vi.fn(async () => { throw err('NotReadableError'); });
        await expect(retryTransientCapture(attempt, { delaysMs: [] })).rejects.toBeDefined();
        expect(attempt).toHaveBeenCalledTimes(1);
    });
});
