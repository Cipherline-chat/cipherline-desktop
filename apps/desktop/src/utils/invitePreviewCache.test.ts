import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    INVITE_GONE_TTL_MS, INVITE_MAX_CONCURRENT, INVITE_MAX_THROTTLE_RETRIES, INVITE_VALID_TTL_MS,
    createInviteLookup, isGoneStatus, retryAfterMs,
} from './invitePreviewCache';

/**
 * The shared invite-preview lookup (owner report 2026-11-21: "scrolling a long
 * list of invite cards eventually turns them all expired/unavailable").
 * Real timers are faked so Retry-After waits and TTLs are exact.
 */

const httpError = (status: number, headers: Record<string, string> = {}) =>
    Object.assign(new Error(`status ${status}`), { response: { status, headers } });

describe('createInviteLookup', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
    afterEach(() => { vi.useRealTimers(); });

    it('a remounting card within 5 minutes costs no second request', async () => {
        const l = createInviteLookup();
        const f = vi.fn(async () => ({ name: 'a' }));
        expect(await l.lookup('abc', f)).toEqual({ kind: 'valid', data: { name: 'a' } });
        vi.setSystemTime(Date.now() + INVITE_VALID_TTL_MS - 1);
        expect(await l.lookup('abc', f)).toEqual({ kind: 'valid', data: { name: 'a' } });
        expect(f).toHaveBeenCalledTimes(1);
        // ...and a minute-old answer is still reused (the old cache kept 60 s).
        expect(INVITE_VALID_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
    });

    it('asks again once the answer is older than the TTL, and for another code', async () => {
        const l = createInviteLookup();
        const f = vi.fn(async () => 1);
        await l.lookup('abc', f);
        await l.lookup('xyz', f);
        expect(f).toHaveBeenCalledTimes(2);
        vi.setSystemTime(Date.now() + INVITE_VALID_TTL_MS);
        await l.lookup('abc', f);
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('two cards asking for the same code at once share one request', async () => {
        const l = createInviteLookup();
        let release!: (v: number) => void;
        const f = vi.fn(() => new Promise<number>(r => { release = r; }));
        const a = l.lookup('abc', f);
        const b = l.lookup('abc', f);
        await vi.advanceTimersByTimeAsync(0);
        release(7);
        expect(await a).toEqual({ kind: 'valid', data: 7 });
        expect(await b).toEqual({ kind: 'valid', data: 7 });
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('404 / 410 / the API\'s 400 are "gone" — and remembered, so a remount does not ask again', async () => {
        for (const status of [404, 410, 400]) {
            const l = createInviteLookup();
            const f = vi.fn(async () => { throw httpError(status); });
            expect(await l.lookup('dead', f)).toEqual({ kind: 'gone', status });
            expect(await l.lookup('dead', f)).toEqual({ kind: 'gone', status });
            expect(f).toHaveBeenCalledTimes(1);
            vi.setSystemTime(Date.now() + INVITE_GONE_TTL_MS);
            await l.lookup('dead', f);
            expect(f).toHaveBeenCalledTimes(2);
        }
    });

    it('a 429 waits out Retry-After and tries again — the answer is the invite, never "gone"', async () => {
        const l = createInviteLookup();
        const f = vi.fn()
            .mockRejectedValueOnce(httpError(429, { 'retry-after': '20' }))
            .mockResolvedValueOnce({ name: 'ok' });
        const p = l.lookup('abc', f);
        await vi.advanceTimersByTimeAsync(19_000);
        expect(f).toHaveBeenCalledTimes(1);           // still waiting out the window
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await p).toEqual({ kind: 'valid', data: { name: 'ok' } });
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('a 429 pauses EVERY lookup (no thundering herd the moment the window reopens)', async () => {
        const l = createInviteLookup();
        const first = vi.fn().mockRejectedValueOnce(httpError(429, { 'retry-after': '30' })).mockResolvedValue('a');
        const other = vi.fn(async () => 'b');
        const p1 = l.lookup('a', first);
        await vi.advanceTimersByTimeAsync(0);
        const p2 = l.lookup('b', other);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(other).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await p1).toEqual({ kind: 'valid', data: 'a' });
        expect(await p2).toEqual({ kind: 'valid', data: 'b' });
    });

    it('still rate limited after the retries → "throttled" (not gone), and not remembered', async () => {
        const l = createInviteLookup();
        const f = vi.fn(async () => { throw httpError(429, { 'retry-after': '2' }); });
        const p = l.lookup('abc', f);
        await vi.advanceTimersByTimeAsync(60_000);
        const r = await p;
        expect(r.kind).toBe('throttled');
        expect(f).toHaveBeenCalledTimes(INVITE_MAX_THROTTLE_RETRIES + 1);
        f.mockResolvedValueOnce({ name: 'later' } as never);
        const again = l.lookup('abc', f);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await again).toEqual({ kind: 'valid', data: { name: 'later' } });
    });

    it('network error / 5xx → "failed", not remembered (the next ask goes to the server)', async () => {
        const l = createInviteLookup();
        const f = vi.fn()
            .mockRejectedValueOnce(httpError(503))
            .mockRejectedValueOnce(new Error('Network Error'))
            .mockResolvedValueOnce('ok');
        expect(await l.lookup('abc', f)).toEqual({ kind: 'failed', status: 503 });
        expect(await l.lookup('abc', f)).toEqual({ kind: 'failed', status: undefined });
        expect(await l.lookup('abc', f)).toEqual({ kind: 'valid', data: 'ok' });
    });

    it(`never runs more than ${INVITE_MAX_CONCURRENT} requests at once`, async () => {
        const l = createInviteLookup();
        let running = 0;
        let peak = 0;
        const f = () => new Promise<number>(r => {
            running++; peak = Math.max(peak, running);
            setTimeout(() => { running--; r(1); }, 100);
        });
        const all = Array.from({ length: 30 }, (_, i) => l.lookup(`c${i}`, f));
        await vi.advanceTimersByTimeAsync(2_000);
        const results = await Promise.all(all);
        expect(results.every(r => r.kind === 'valid')).toBe(true);
        expect(peak).toBe(INVITE_MAX_CONCURRENT);
    });

    it('fresh (the Retry button) skips the kept answer', async () => {
        const l = createInviteLookup();
        const f = vi.fn(async () => 1);
        await l.lookup('abc', f);
        await l.lookup('abc', f, true);
        expect(f).toHaveBeenCalledTimes(2);
    });
});

describe('isGoneStatus / retryAfterMs', () => {
    it('only 404 / 410 / 400 are gone', () => {
        expect([404, 410, 400].every(isGoneStatus)).toBe(true);
        expect([429, 500, 502, 503, 401, 403, undefined].some(isGoneStatus)).toBe(false);
    });
    it('reads seconds and HTTP dates, clamps, and defaults', () => {
        expect(retryAfterMs('7')).toBe(7_000);
        expect(retryAfterMs('0')).toBe(1_000);
        expect(retryAfterMs('9999')).toBe(120_000);
        expect(retryAfterMs(undefined)).toBe(5_000);
        expect(retryAfterMs('soon')).toBe(5_000);
        const now = Date.parse('2026-11-21T00:00:00Z');
        expect(retryAfterMs('Sat, 21 Nov 2026 00:00:30 GMT', now)).toBe(30_000);
    });
});
