import { describe, expect, it, vi } from 'vitest';
import { REPUBLISH_ACK_BOUND_MS, REPUBLISH_CLEAR_DELAY_MS, ShareRepublishSignal } from './shareRepublishSignal';
import { SHARE_REPUBLISH_ATTR } from './shareHold';

function rig(setAttributes: (a: Record<string, string>) => Promise<void>) {
    const logged: Array<Record<string, unknown>> = [];
    let n = 0;
    const signal = new ShareRepublishSignal({
        log: d => { logged.push(d as Record<string, unknown>); },
        nextToken: () => `t${++n}`,
    });
    return { signal, logged, lp: { setAttributes: vi.fn(setAttributes) } };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('ShareRepublishSignal', () => {
    it('sets the flag and reports the ack', async () => {
        const { signal, lp, logged } = rig(async () => {});
        await expect(signal.begin(lp)).resolves.toEqual({ seq: 't1', acked: true });
        expect(lp.setAttributes).toHaveBeenCalledWith({ [SHARE_REPUBLISH_ATTR]: 't1' });
        expect(logged[0]).toMatchObject({ phase: 'set', acked: true });
    });

    it('the attribute carries an opaque token and nothing else', async () => {
        const { signal, lp } = rig(async () => {});
        await signal.begin(lp);
        const sent = lp.setAttributes.mock.calls[0][0];
        expect(Object.keys(sent)).toEqual([SHARE_REPUBLISH_ATTR]);
        expect(sent[SHARE_REPUBLISH_ATTR]).toBe('t1');
    });

    it('a slow network costs at most the bound, then the republish carries on', async () => {
        vi.useFakeTimers();
        try {
            const { signal, lp, logged } = rig(() => new Promise(() => { /* the echo never comes */ }));
            let result: { acked: boolean } | null = null;
            void signal.begin(lp).then(r => { result = r; });
            await vi.advanceTimersByTimeAsync(REPUBLISH_ACK_BOUND_MS - 1);
            expect(result).toBeNull();
            await vi.advanceTimersByTimeAsync(1);
            expect(result).toMatchObject({ acked: false });
            expect(logged[0]).toMatchObject({ phase: 'set', acked: false });
        } finally { vi.useRealTimers(); }
    });

    it('a rejected update does not throw into the republish', async () => {
        const { signal, lp } = rig(async () => { throw new Error('timeout'); });
        await expect(signal.begin(lp)).resolves.toMatchObject({ acked: false });
    });

    it('a successful republish keeps the flag up until the new track has had time to arrive', async () => {
        vi.useFakeTimers();
        try {
            const { signal, lp, logged } = rig(async () => {});
            const { seq } = await signal.begin(lp);
            signal.end(lp, seq, 'published');
            await flush();
            // The bug: a clear ahead of the new track reads as "not coming back".
            expect(lp.setAttributes).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(REPUBLISH_CLEAR_DELAY_MS - 1);
            expect(lp.setAttributes).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(lp.setAttributes).toHaveBeenLastCalledWith({ [SHARE_REPUBLISH_ATTR]: '' });
            expect(logged[1]).toEqual({ phase: 'clear', why: 'published' });
        } finally { vi.useRealTimers(); }
    });

    it('a stop in that window clears at once, and the late timer then does nothing', async () => {
        vi.useFakeTimers();
        try {
            const { signal, lp } = rig(async () => {});
            const { seq } = await signal.begin(lp);
            signal.end(lp, seq, 'published');
            signal.cancel(lp);
            await flush();
            expect(lp.setAttributes).toHaveBeenCalledTimes(2);
            expect(lp.setAttributes).toHaveBeenLastCalledWith({ [SHARE_REPUBLISH_ATTR]: '' });
            await vi.advanceTimersByTimeAsync(REPUBLISH_CLEAR_DELAY_MS);
            expect(lp.setAttributes).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });

    it('a further change in that window keeps its own flag up', async () => {
        vi.useFakeTimers();
        try {
            const { signal, lp } = rig(async () => {});
            const first = await signal.begin(lp);
            signal.end(lp, first.seq, 'published');
            const second = signal.begin(lp);
            await flush();
            await vi.advanceTimersByTimeAsync(REPUBLISH_CLEAR_DELAY_MS);
            await second;
            expect(lp.setAttributes).toHaveBeenLastCalledWith({ [SHARE_REPUBLISH_ATTR]: 't2' });
        } finally { vi.useRealTimers(); }
    });

    it('end clears on a failed republish too', async () => {
        const { signal, lp, logged } = rig(async () => {});
        const { seq } = await signal.begin(lp);
        signal.end(lp, seq, 'failed');
        await flush();
        expect(lp.setAttributes).toHaveBeenLastCalledWith({ [SHARE_REPUBLISH_ATTR]: '' });
        expect(logged[1]).toEqual({ phase: 'clear', why: 'failed' });
    });

    it('a run that did not announce anything clears nothing', async () => {
        const { signal, lp } = rig(async () => {});
        signal.end(lp, null, 'published');
        await flush();
        expect(lp.setAttributes).not.toHaveBeenCalled();
    });

    it('an older run finishing cannot take back a newer change\'s flag', async () => {
        const { signal, lp } = rig(async () => {});
        const first = await signal.begin(lp);
        const second = await signal.begin(lp);
        signal.end(lp, first.seq, 'failed');
        await flush();
        expect(lp.setAttributes).toHaveBeenCalledTimes(2);
        signal.end(lp, second.seq, 'failed');
        await flush();
        expect(lp.setAttributes).toHaveBeenLastCalledWith({ [SHARE_REPUBLISH_ATTR]: '' });
    });

    it('cancel takes the flag back before a stop, and costs nothing when there is none', async () => {
        const { signal, lp, logged } = rig(async () => {});
        signal.cancel(lp);
        await flush();
        expect(lp.setAttributes).not.toHaveBeenCalled();
        expect(logged).toEqual([]);
        await signal.begin(lp);
        signal.cancel(lp);
        await flush();
        expect(lp.setAttributes).toHaveBeenLastCalledWith({ [SHARE_REPUBLISH_ATTR]: '' });
        expect(logged[1]).toEqual({ phase: 'clear', why: 'stopped' });
        signal.cancel(lp); // once is enough
        await flush();
        expect(lp.setAttributes).toHaveBeenCalledTimes(2);
    });
});
