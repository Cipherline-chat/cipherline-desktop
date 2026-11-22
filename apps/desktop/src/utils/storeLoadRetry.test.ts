import { describe, it, expect } from 'vitest';
import {
    classifyStoreLoadError, storeErrorName, StoreLoadStageError, STORE_LOAD_RETRY_DELAYS_MS,
} from './storeLoadRetry';

const dom = (name: string, msg = 'x') => new DOMException(msg, name);

describe('classifyStoreLoadError', () => {
    it.each([
        ['UnknownError', 'open'],
        ['AbortError', 'read'],
        ['InvalidStateError', 'read'],
        ['TimeoutError', 'open'],
    ] as const)('%s at %s is transient (retried)', (name, stage) => {
        expect(classifyStoreLoadError(new StoreLoadStageError(stage, dom(name)))).toEqual({ stage, name, transient: true });
    });

    it('"backing store" in the message is transient whatever the name', () => {
        const e = new Error('Internal error opening backing store for indexedDB.open.');
        expect(classifyStoreLoadError(new StoreLoadStageError('open', e)).transient).toBe(true);
    });

    it.each(['VersionError', 'DataError', 'NotFoundError', 'SecurityError', 'QuotaExceededError', 'ConstraintError'])(
        '%s is not transient (fails at once)', (name) => {
            expect(classifyStoreLoadError(new StoreLoadStageError('open', dom(name))).transient).toBe(false);
        },
    );

    it('no IndexedDB at all is not transient', () => {
        expect(classifyStoreLoadError(new StoreLoadStageError('open', new Error('IndexedDB unavailable in this environment'))).transient).toBe(false);
    });

    it('an IPC rejection from main is transient; a plain programming error at ipc is not', () => {
        expect(classifyStoreLoadError(new StoreLoadStageError('ipc', new Error("Error invoking remote method 'securekv:open': Error: boom")))).toEqual({ stage: 'ipc', name: 'Error', transient: true });
        expect(classifyStoreLoadError(new StoreLoadStageError('ipc', new TypeError('x is not a function'))).transient).toBe(false);
    });

    it('an untagged error counts as a read failure, retried only for a transient name', () => {
        expect(classifyStoreLoadError(new TypeError('boom'))).toEqual({ stage: 'read', name: 'TypeError', transient: false });
        expect(classifyStoreLoadError(dom('AbortError'))).toEqual({ stage: 'read', name: 'AbortError', transient: true });
    });
});

describe('storeErrorName — labels only', () => {
    it('keeps a plain error name', () => { expect(storeErrorName(dom('UnknownError'))).toBe('UnknownError'); });
    it('never passes through anything that is not a bare word', () => {
        expect(storeErrorName({ name: 'C:\\Users\\alice\\AppData' })).toBe('Error');
        expect(storeErrorName({ name: 'a'.repeat(41) })).toBe('Error');
        expect(storeErrorName({ name: 'user@example.com' })).toBe('Error');
        expect(storeErrorName(null)).toBe('Error');
        expect(storeErrorName('UnknownError')).toBe('Error');
    });
});

describe('backoff schedule', () => {
    it('is 3-4 attempts over about 5-10 seconds, growing', () => {
        const total = STORE_LOAD_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
        expect(STORE_LOAD_RETRY_DELAYS_MS.length + 1).toBeGreaterThanOrEqual(3);
        expect(STORE_LOAD_RETRY_DELAYS_MS.length + 1).toBeLessThanOrEqual(4);
        expect(total).toBeGreaterThanOrEqual(5_000);
        expect(total).toBeLessThanOrEqual(10_000);
        for (let i = 1; i < STORE_LOAD_RETRY_DELAYS_MS.length; i++) {
            expect(STORE_LOAD_RETRY_DELAYS_MS[i]).toBeGreaterThan(STORE_LOAD_RETRY_DELAYS_MS[i - 1]);
        }
    });
});
