import { describe, it, expect, vi } from 'vitest';
import { createCoalescedRunner } from './coalescedRun';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

describe('createCoalescedRunner', () => {
    it('runs immediately when idle', async () => {
        const job = vi.fn().mockResolvedValue(undefined);
        const run = createCoalescedRunner(job);
        await run();
        expect(job).toHaveBeenCalledTimes(1);
    });

    it('never runs two jobs at once, and collapses any number of mid-run calls into ONE trailing run', async () => {
        const gates = [deferred(), deferred()];
        let active = 0; let maxActive = 0; let calls = 0;
        const job = vi.fn(async () => {
            const g = gates[calls++];
            active++; maxActive = Math.max(maxActive, active);
            await g.promise;
            active--;
        });
        const run = createCoalescedRunner(job);
        const a = run();          // starts run #1
        const b = run();          // queued
        const c = run();          // collapses into the same follow-up
        expect(job).toHaveBeenCalledTimes(1);
        gates[0].resolve();
        await Promise.resolve(); await Promise.resolve();
        expect(job).toHaveBeenCalledTimes(2); // the single trailing run started
        gates[1].resolve();
        await Promise.all([a, b, c]);
        expect(job).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(1);
    });

    it('a call after everything settled starts a fresh run', async () => {
        const job = vi.fn().mockResolvedValue(undefined);
        const run = createCoalescedRunner(job);
        await run();
        await run();
        expect(job).toHaveBeenCalledTimes(2);
    });

    it('a failing run neither rejects the callers nor wedges the runner', async () => {
        const job = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
        const run = createCoalescedRunner(job);
        await expect(run()).resolves.toBeUndefined();
        await run();
        expect(job).toHaveBeenCalledTimes(2);
    });
});
