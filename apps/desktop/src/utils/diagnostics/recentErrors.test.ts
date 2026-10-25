import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetRecentErrorsForTests, captureError, getRecentErrors, installRecentErrorCapture, setErrorTap } from './recentErrors';
import { clearCallEvents, getCallEvents } from '../callEventLog';

// Shaped like the axios build; axios itself cannot be imported under the test
// setup's bare `window` stub (see networkError.test.ts).
class AxiosError extends Error {
    isAxiosError = true;
    response?: { status: number };
    code?: string;
    constructor(message: string, code?: string, response?: { status: number }) {
        super(message);
        this.name = 'AxiosError';
        this.code = code;
        this.response = response;
    }
}

let tapped: Array<{ kind: string; value: unknown }>;
beforeEach(() => {
    __resetRecentErrorsForTests();
    clearCallEvents();
    tapped = [];
    setErrorTap((kind, value) => { tapped.push({ kind, value }); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { setErrorTap(null); vi.restoreAllMocks(); });

describe('global unhandledrejection classification (renderer twin of electron/net-error.ts)', () => {
    it('an axios Network Error rejection is a NON-FATAL diagnostic: not forwarded as unhandled_error, logged as net_unhandled with the code only', () => {
        const err = new AxiosError('Network Error', 'ERR_NETWORK');
        captureError('unhandledrejection', err);
        expect(tapped).toEqual([]);                                   // beta never sees an unhandled_error
        const ev = getCallEvents().filter(e => e.kind === 'net_unhandled');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ cause: 'ERR_NETWORK' });        // no URL, no message
        // still visible in "Report a problem" via the recent-errors ring
        expect(getRecentErrors()).toHaveLength(1);
    });

    it('a timeout (ECONNABORTED) is classified the same way', () => {
        captureError('unhandledrejection', new AxiosError('timeout of 8000ms exceeded', 'ECONNABORTED'));
        expect(tapped).toEqual([]);
        expect(getCallEvents().some(e => e.kind === 'net_unhandled' && e.detail?.cause === 'ECONNABORTED')).toBe(true);
    });

    // ── negative controls: real bugs must still be reported ────────────────
    it('a TypeError is still reported as before', () => {
        const err = new TypeError('Cannot read properties of undefined');
        captureError('unhandledrejection', err);
        expect(tapped).toEqual([{ kind: 'unhandledrejection', value: err }]);
        expect(getCallEvents().some(e => e.kind === 'net_unhandled')).toBe(false);
    });

    it('an axios error WITH an HTTP response (a missed catch on a 500) is still reported', () => {
        const err = new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', { status: 500 });
        captureError('unhandledrejection', err);
        expect(tapped).toHaveLength(1);
        expect(getCallEvents().some(e => e.kind === 'net_unhandled')).toBe(false);
    });

    it('a plain Error whose message says "Network Error" is still reported', () => {
        captureError('unhandledrejection', new Error('Network Error'));
        expect(tapped).toHaveLength(1);
    });

    it('a window error EVENT (not a rejection) is never downgraded, even with a network-looking value', () => {
        captureError('error', new AxiosError('Network Error', 'ERR_NETWORK'));
        expect(tapped).toHaveLength(1);
    });

    it('wired end-to-end through the real unhandledrejection listener', () => {
        const handlers = new Map<string, (ev: Event) => void>();
        installRecentErrorCapture({ addEventListener: (t: string, h: (ev: Event) => void) => { handlers.set(t, h); } } as never);
        handlers.get('unhandledrejection')!({ reason: new AxiosError('Network Error', 'ERR_NETWORK') } as never);
        handlers.get('unhandledrejection')!({ reason: new TypeError('real bug') } as never);
        expect(tapped).toHaveLength(1);
        expect((tapped[0].value as Error).message).toBe('real bug');
    });

    it('a throwing logger cannot break error capture', () => {
        (console.warn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('no console'); });
        expect(() => captureError('unhandledrejection', new AxiosError('Network Error', 'ERR_NETWORK'))).not.toThrow();
    });
});
