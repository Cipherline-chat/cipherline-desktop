import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { settleBootRefresh } from './bootRefresh';

const NOW = 1_000_000;

describe('settleBootRefresh (boot must not hang on a slow token refresh)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const never = () => new Promise<string | null>(() => {});

    it('a refresh that lands in time settles with its token, once', async () => {
        const onSettle = vi.fn();
        settleBootRefresh(Promise.resolve('NEW'), { tokenExpired: false, expSec: NOW + 3600, waitMs: 3000, nowSec: () => NOW }, onSettle);
        await vi.advanceTimersByTimeAsync(0);
        expect(onSettle).toHaveBeenCalledWith('NEW');
        await vi.advanceTimersByTimeAsync(5000);
        expect(onSettle).toHaveBeenCalledTimes(1);
    });

    it('a hung refresh with a still-valid token restores the session after waitMs (not 15 s)', async () => {
        const onSettle = vi.fn();
        settleBootRefresh(never(), { tokenExpired: false, expSec: NOW + 3600, waitMs: 3000, nowSec: () => NOW }, onSettle);
        await vi.advanceTimersByTimeAsync(2999);
        expect(onSettle).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onSettle).toHaveBeenCalledWith(null);
    });

    it('a late refresh after the timeout does not settle a second time', async () => {
        const onSettle = vi.fn();
        let resolve!: (t: string | null) => void;
        settleBootRefresh(new Promise(r => { resolve = r; }), { tokenExpired: false, expSec: NOW + 3600, waitMs: 3000, nowSec: () => NOW }, onSettle);
        await vi.advanceTimersByTimeAsync(3000);
        resolve('LATE');
        await vi.advanceTimersByTimeAsync(0);
        expect(onSettle).toHaveBeenCalledTimes(1);
        expect(onSettle).toHaveBeenCalledWith(null);
    });

    it('an EXPIRED token never times out into the session — it waits for the refresh', async () => {
        const onSettle = vi.fn();
        settleBootRefresh(never(), { tokenExpired: true, expSec: NOW - 1, waitMs: 3000, nowSec: () => NOW }, onSettle);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onSettle).not.toHaveBeenCalled();
    });

    it('a token that expires DURING the wait is not used either', async () => {
        const onSettle = vi.fn();
        let now = NOW;
        settleBootRefresh(never(), { tokenExpired: false, expSec: NOW + 2, waitMs: 3000, nowSec: () => now }, onSettle);
        now = NOW + 3;
        await vi.advanceTimersByTimeAsync(3000);
        expect(onSettle).not.toHaveBeenCalled();
    });
});
