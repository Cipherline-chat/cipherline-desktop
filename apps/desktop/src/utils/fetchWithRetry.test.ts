import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry, backoffDelay, defaultShouldRetry } from './fetchWithRetry';

/** Records the delays asked for instead of actually waiting them out. */
function fakeSleep() {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

describe('fetchWithRetry', () => {
    it('returns the value without retrying when the first attempt works', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const { slept, sleep } = fakeSleep();
        await expect(fetchWithRetry(fn, { sleep })).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });

    // The actual cold-start shape: API refuses connections for a moment, then
    // comes up. Before this helper existed, that first failure was permanent.
    it('recovers when a later attempt succeeds', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue('ok');
        const { slept, sleep } = fakeSleep();
        await expect(fetchWithRetry(fn, { sleep })).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
        expect(slept).toEqual([500, 1000]);
    });

    it('rejects with the LAST error once attempts are exhausted', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('first'))
            .mockRejectedValue(new Error('final'));
        const { sleep } = fakeSleep();
        await expect(fetchWithRetry(fn, { attempts: 3, sleep })).rejects.toThrow('final');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('gives up rather than hanging forever', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('down'));
        const { sleep } = fakeSleep();
        await expect(fetchWithRetry(fn, { attempts: 5, sleep })).rejects.toThrow('down');
        expect(fn).toHaveBeenCalledTimes(5);
    });

    it('stops immediately on a non-retryable failure', async () => {
        const forbidden = { response: { status: 403 } };
        const fn = vi.fn().mockRejectedValue(forbidden);
        const { slept, sleep } = fakeSleep();
        await expect(fetchWithRetry(fn, { sleep })).rejects.toBe(forbidden);
        expect(fn).toHaveBeenCalledTimes(1);   // no point asking again
        expect(slept).toEqual([]);
    });

    it('reports each retry so failures are not silent', async () => {
        const onRetry = vi.fn();
        const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
        const { sleep } = fakeSleep();
        await fetchWithRetry(fn, { sleep, onRetry });
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry.mock.calls[0][1]).toBe(1);      // attempt number
        expect(onRetry.mock.calls[0][2]).toBe(500);    // delay
    });

    it('honours a custom shouldRetry', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('nope'));
        const { sleep } = fakeSleep();
        await expect(
            fetchWithRetry(fn, { sleep, shouldRetry: () => false }),
        ).rejects.toThrow('nope');
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('backoffDelay', () => {
    it('doubles each retry', () => {
        expect(backoffDelay(1)).toBe(500);
        expect(backoffDelay(2)).toBe(1000);
        expect(backoffDelay(3)).toBe(2000);
    });

    it('caps so a long outage never schedules an absurd wait', () => {
        expect(backoffDelay(10)).toBe(4000);
        expect(backoffDelay(50, 500, 4000)).toBe(4000);
    });
});

describe('defaultShouldRetry', () => {
    it('retries network errors with no response', () => {
        expect(defaultShouldRetry(new Error('Network Error'))).toBe(true);
    });

    it('retries 5xx', () => {
        expect(defaultShouldRetry({ response: { status: 502 } })).toBe(true);
        expect(defaultShouldRetry({ response: { status: 503 } })).toBe(true);
    });

    // Racing the token-refresh interceptor is exactly the cold-start case.
    it('retries 401 — usually a race with the token refresh, not a real denial', () => {
        expect(defaultShouldRetry({ response: { status: 401 } })).toBe(true);
    });

    it('retries 408 and 429', () => {
        expect(defaultShouldRetry({ response: { status: 408 } })).toBe(true);
        expect(defaultShouldRetry({ response: { status: 429 } })).toBe(true);
    });

    it('does not retry a settled refusal', () => {
        expect(defaultShouldRetry({ response: { status: 403 } })).toBe(false);
        expect(defaultShouldRetry({ response: { status: 404 } })).toBe(false);
        expect(defaultShouldRetry({ response: { status: 400 } })).toBe(false);
    });
});
