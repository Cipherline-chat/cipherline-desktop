import { describe, it, expect, vi } from 'vitest';
import { leaveServerOptimistic, assertLeaveCommitted, describeLeaveError, type LeaveServerOptimisticDeps } from './leaveServerOptimistic';

function make(over: Partial<LeaveServerOptimisticDeps> = {}) {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const deferred: Array<() => void> = [];
    const deps: LeaveServerOptimisticDeps = {
        post: vi.fn(async () => { order.push('post:start'); await gate; order.push('post:done'); }),
        applyLocal: vi.fn(() => { order.push('apply'); }),
        rollbackLocal: vi.fn(() => { order.push('rollback'); }),
        cleanupLocal: vi.fn(() => { order.push('cleanup'); }),
        reconcile: vi.fn(() => { order.push('reconcile'); }),
        onError: vi.fn(() => { order.push('error'); }),
        recordTiming: vi.fn(),
        defer: fn => { deferred.push(fn); },
        ...over,
    };
    return { deps, order, release, runDeferred: () => deferred.splice(0).forEach(f => f()), deferred };
}

describe('leaveServerOptimistic', () => {
    it('updates the UI BEFORE the POST resolves (not after)', async () => {
        const { deps, order, release } = make();
        const p = leaveServerOptimistic(deps);
        await Promise.resolve();
        expect(order).toEqual(['apply', 'post:start']);
        expect(deps.cleanupLocal).not.toHaveBeenCalled();
        release();
        expect(await p).toBe(true);
    });

    it('success: cleanup + reconcile run deferred, after the UI update, and no rollback', async () => {
        const { deps, order, release, runDeferred, deferred } = make();
        const p = leaveServerOptimistic(deps);
        release();
        await p;
        // Nothing local-cleanup-ish has run on the click's task yet.
        expect(deferred).toHaveLength(1);
        expect(order).toEqual(['apply', 'post:start', 'post:done']);
        runDeferred();
        expect(order).toEqual(['apply', 'post:start', 'post:done', 'cleanup', 'reconcile']);
        expect(deps.rollbackLocal).not.toHaveBeenCalled();
        expect(deps.onError).not.toHaveBeenCalled();
    });

    it('failure: rolls back, reports the error, skips cleanup and reconcile', async () => {
        const boom = new Error('403');
        const { deps, order, runDeferred, deferred } = make({ post: vi.fn(async () => { throw boom; }) });
        expect(await leaveServerOptimistic(deps)).toBe(false);
        expect(order).toEqual(['apply', 'rollback', 'error']);
        expect(deps.onError).toHaveBeenCalledWith(boom);
        expect(deferred).toHaveLength(0);
        runDeferred();
        expect(deps.cleanupLocal).not.toHaveBeenCalled();
        expect(deps.reconcile).not.toHaveBeenCalled();
    });

    it('a throwing cleanup does not skip the reconcile', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { deps, release, runDeferred } = make({ cleanupLocal: vi.fn(() => { throw new Error('idb'); }) });
        const p = leaveServerOptimistic(deps);
        release();
        await p;
        runDeferred();
        expect(deps.reconcile).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('records UI and API timings, and a throwing recorder is ignored', async () => {
        const { deps, release } = make({ recordTiming: vi.fn(() => { throw new Error('x'); }) });
        const p = leaveServerOptimistic(deps);
        release();
        await expect(p).resolves.toBe(true);
        const rec = vi.fn();
        const m = make({ recordTiming: rec });
        const p2 = leaveServerOptimistic(m.deps);
        m.release();
        await p2;
        expect(rec.mock.calls.map(c => c[0])).toEqual(['server_leave_ui', 'server_leave_api']);
    });
});

describe('Dashboard wiring', () => {
    it('the leave confirm goes through leaveServerOptimistic, not an awaited POST', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
        const at = dash.indexOf('Leave-server confirmation dialog');
        expect(at).toBeGreaterThan(-1);
        const block = dash.slice(at, at + 4500);
        expect(block).toContain('leaveServerOptimistic(');
        expect(block).toContain('onConfirm={() => {');
        expect(block).not.toContain('onConfirm={async');
        expect(block).toContain('assertLeaveCommitted(res)');
        expect(block).toContain('restoreServerLocal(removed)');
        // Negative control: the scan can fail.
        expect('await axios.post(apiUrl`/servers/x/leave`)').toContain('await axios.post');
    });
});

describe('a leave only counts once the server committed it (owner report: "left, re-logged in, still in")', () => {
    it('shows the SERVER message and restores the rail when the API refuses (400 owner / 404 / 403)', async () => {
        const err = { response: { status: 400, data: { message: 'Owner cannot leave a server. Transfer ownership or delete the server first.' } } };
        const { deps } = make({ post: vi.fn(async () => { throw err; }) });
        expect(await leaveServerOptimistic(deps)).toBe(false);
        expect(deps.rollbackLocal).toHaveBeenCalled();
        expect(describeLeaveError(err)).toBe('Owner cannot leave a server. Transfer ownership or delete the server first.');
    });

    it('a 2xx that is not { ok: true } is a failure, not a silent success', async () => {
        expect(() => assertLeaveCommitted({ status: 200, data: '<html>proxy</html>' })).toThrow();
        expect(() => assertLeaveCommitted({ status: 200, data: {} })).toThrow();
        expect(() => assertLeaveCommitted(undefined)).toThrow();
        expect(() => assertLeaveCommitted({ status: 201, data: { ok: true } })).not.toThrow();
        const { deps } = make({ post: vi.fn(async () => assertLeaveCommitted({ data: {} })) });
        expect(await leaveServerOptimistic(deps)).toBe(false);
        expect(deps.rollbackLocal).toHaveBeenCalled();
        expect(deps.reconcile).not.toHaveBeenCalled();
    });

    it('describeLeaveError falls back to status, then to a network line; array messages are joined', () => {
        expect(describeLeaveError({ response: { status: 429, data: {} } })).toContain('429');
        expect(describeLeaveError(new Error('Network Error'))).toMatch(/connection/);
        expect(describeLeaveError({ response: { data: { message: ['a', 'b'] } } })).toBe('a b');
    });
});
