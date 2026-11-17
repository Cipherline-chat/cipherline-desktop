import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { installStdioGuard, swallowStreamErrors } from './stdio-guard';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });

describe('swallowStreamErrors', () => {
    it('an async EPIPE on a stream is handled, not thrown as an uncaught exception', async () => {
        const w = new Writable({ write(_c, _e, cb) { cb(epipe()); } });
        const seen: Error[] = [];
        swallowStreamErrors(w, (e) => seen.push(e));
        const uncaught: unknown[] = [];
        const h = (e: unknown) => uncaught.push(e);
        process.on('uncaughtException', h);
        try {
            expect(() => w.write('x')).not.toThrow();
            await new Promise((r) => setTimeout(r, 10));
        } finally { process.off('uncaughtException', h); }
        expect(uncaught).toEqual([]);
        expect(seen).toHaveLength(1);
        expect((seen[0] as NodeJS.ErrnoException).code).toBe('EPIPE');
    });

    it('tolerates a missing stream and a callback that throws', () => {
        expect(() => swallowStreamErrors(null)).not.toThrow();
        const s = new PassThrough();
        swallowStreamErrors(s, () => { throw new Error('boom'); });
        expect(() => s.emit('error', epipe())).not.toThrow();
    });
});

describe('installStdioGuard', () => {
    it('EPIPE on stdout/stderr is swallowed and the console goes quiet instead of writing into the dead pipe', () => {
        const out = new PassThrough(); const err = new PassThrough();
        const origError = vi.fn();
        const target = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: origError, debug: vi.fn() };
        const restore = installStdioGuard([out, err], target);
        target.error('before');
        expect(origError).toHaveBeenCalledTimes(1);
        expect(() => err.emit('error', epipe())).not.toThrow();
        target.error('after');
        target.log('after');
        expect(origError).toHaveBeenCalledTimes(1);   // no further console writes
        restore();
        target.error('restored');
        expect(origError).toHaveBeenCalledTimes(2);
    });

    it('without the guard the same emit would throw (positive control)', () => {
        expect(() => new PassThrough().emit('error', epipe())).toThrow('write EPIPE');
    });
});
