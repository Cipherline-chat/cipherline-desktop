import { describe, it, expect } from 'vitest';
import { failureCauseOf, isNetworkClassError, networkErrorCode } from './networkError';

// Shaped exactly like the axios build (name, isAxiosError, code, optional response).
// axios itself cannot be imported here: the test setup's bare `window` stub makes
// it believe it is in a browser and it dies reading window.location.
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
const netErr = () => new AxiosError('Network Error', 'ERR_NETWORK');
const httpErr = (status: number) => new AxiosError('Request failed', 'ERR_BAD_RESPONSE', { status });

describe('networkError - the renderer twin of electron/net-error.ts', () => {
    it('classifies axios transport failures as network class', () => {
        expect(networkErrorCode(netErr())).toBe('ERR_NETWORK');
        expect(networkErrorCode(new AxiosError('timeout of 8000ms exceeded', 'ECONNABORTED'))).toBe('ECONNABORTED');
        expect(networkErrorCode(new AxiosError('x', 'ETIMEDOUT'))).toBe('ETIMEDOUT');
        expect(isNetworkClassError(netErr())).toBe(true);
    });

    it('recognises a serialised/cloned axios error by name', () => {
        expect(isNetworkClassError({ name: 'AxiosError', message: 'Network Error', code: 'ERR_NETWORK' })).toBe(true);
    });

    // ── negative controls: real bugs must NOT be waved through ──────────────
    it('an axios error that DID get an HTTP answer is not a network error', () => {
        expect(isNetworkClassError(httpErr(500))).toBe(false);
        expect(isNetworkClassError(httpErr(401))).toBe(false);
    });

    it('a deliberate abort (ERR_CANCELED) is not a network error', () => {
        expect(isNetworkClassError(new AxiosError('canceled', 'ERR_CANCELED'))).toBe(false);
    });

    it('a message that merely says "Network Error" on a non-axios error is not waved through', () => {
        expect(isNetworkClassError(new Error('Network Error'))).toBe(false);
        expect(isNetworkClassError({ message: 'Network Error', code: 'ERR_NETWORK' })).toBe(false);
        expect(isNetworkClassError('Network Error')).toBe(false);
    });

    it('programming-error classes are never network, even with a network code stuck on them', () => {
        const t = Object.assign(new TypeError('x is undefined'), { code: 'ERR_NETWORK', isAxiosError: true });
        expect(isNetworkClassError(t)).toBe(false);
        const r = Object.assign(new RangeError('r'), { code: 'ECONNABORTED', name: 'AxiosError' });
        expect(isNetworkClassError(r)).toBe(false);
    });

    it('null / undefined / primitives are not network errors and never throw', () => {
        for (const v of [null, undefined, 0, '', {}, [], Symbol.iterator]) expect(isNetworkClassError(v)).toBe(false);
    });

    it('failureCauseOf separates network, http and local failures', () => {
        expect(failureCauseOf(netErr())).toBe('network');
        expect(failureCauseOf(httpErr(503))).toBe('http');
        expect(failureCauseOf(new TypeError('boom'))).toBe('local');
        expect(failureCauseOf(undefined)).toBe('local');
    });
});
