import { describe, it, expect } from 'vitest';
import { shareInflight, _inflightShareSize } from './inflightShare';

function deferred<T>() {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('shareInflight', () => {
    it('runs ONE request for concurrent callers with the same key', async () => {
        const d = deferred<string>(); let calls = 0;
        const a = shareInflight('k', () => { calls++; return d.promise; });
        const b = shareInflight('k', () => { calls++; return d.promise; });
        d.resolve('x');
        expect(await a).toBe('x'); expect(await b).toBe('x');
        expect(calls).toBe(1);
    });

    it('is not a cache: the next caller after it settles gets a fresh request', async () => {
        let calls = 0;
        await shareInflight('k2', async () => ++calls);
        await shareInflight('k2', async () => ++calls);
        expect(calls).toBe(2);
        expect(_inflightShareSize()).toBe(0);
    });

    it('different keys (e.g. a different account token) never share', async () => {
        let calls = 0;
        await Promise.all([
            shareInflight('ch:tokenA:srv', async () => ++calls),
            shareInflight('ch:tokenB:srv', async () => ++calls),
        ]);
        expect(calls).toBe(2);
    });

    it('shares a rejection with every caller and then forgets it', async () => {
        const d = deferred<string>(); let calls = 0;
        const a = shareInflight('k3', () => { calls++; return d.promise; });
        const b = shareInflight('k3', () => { calls++; return d.promise; });
        d.reject(new Error('boom'));
        await expect(a).rejects.toThrow('boom'); await expect(b).rejects.toThrow('boom');
        expect(calls).toBe(1);
        expect(await shareInflight('k3', async () => 'ok')).toBe('ok');
    });
});
