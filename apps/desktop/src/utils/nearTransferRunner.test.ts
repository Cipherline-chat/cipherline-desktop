import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn(), recv: vi.fn() }));
vi.mock('./nearHistoryTransfer', () => ({ sendHistoryOverNear: h.send, receiveHistoryOverNear: h.recv }));

import { NearTransferRunner } from './nearTransferRunner';
import type { NearHistoryPort } from './nearHistoryPort';

const port: NearHistoryPort = { estimate: async () => null, writeContainer: vi.fn(async () => undefined), importContainer: vi.fn(async () => ({ messages: 5, attachments: 2 })) };
const api = {} as never;
beforeEach(() => { h.send.mockReset(); h.recv.mockReset(); });

describe('transfer runner', () => {
    it('send: builds the container with the attachments switch and ends cleanly', async () => {
        h.send.mockImplementation(async (o: { writeContainer: (s: never) => Promise<void> }) => { await o.writeContainer({} as never); });
        const r = new NearTransferRunner();
        await r.startSend({ api, port, includeAttachments: false, device: 'Pixel 9', now: () => 5 });
        expect(port.writeContainer).toHaveBeenCalledWith({}, { includeAttachments: false });
        expect(r.getSnapshot()).toMatchObject({ direction: 'send', device: 'Pixel 9', running: false, finishedAt: 5 });
        expect(r.getSnapshot().error).toBeUndefined();
    });
    it('receive: applying while the import runs, then counts for the success line', async () => {
        const seen: boolean[] = [];
        h.recv.mockImplementation(async (o: { importContainer: (s: never, n: number) => Promise<void> }) => { await o.importContainer({} as never, 10); });
        const r = new NearTransferRunner();
        r.subscribe(() => seen.push(r.getSnapshot().applying));
        await r.startReceive({ api, port, device: 'iPhone 16' });
        expect(seen).toContain(true);
        expect(r.getSnapshot()).toMatchObject({ direction: 'receive', applying: false, running: false, counts: { messages: 5, attachments: 2 } });
    });
    it('receive: "no local-network path" means nothing was offered (the quiet pointer), not an error banner', async () => {
        h.recv.mockRejectedValue(Object.assign(new Error('no local-network path'), { code: 'failed' }));
        const r = new NearTransferRunner();
        await r.startReceive({ api, port, device: 'x' });
        expect(r.getSnapshot().notOffered).toBe(true);
    });
    it('a failure keeps its code; stop() marks it stopped and aborts', async () => {
        h.send.mockRejectedValue(Object.assign(new Error('boom'), { code: 'transfer_failed' }));
        const r = new NearTransferRunner();
        await r.startSend({ api, port, includeAttachments: true, device: 'x' });
        expect(r.getSnapshot().error).toEqual({ code: 'transfer_failed', message: 'boom' });
        expect(r.getSnapshot().notOffered).toBe(false);
        r.stop(); expect(r.getSnapshot()).toMatchObject({ stopped: true, running: false });
        r.reset(); expect(r.getSnapshot().direction).toBeNull();
    });
    it('giveUp(): aborts the transfer, marks it gaveUp (not stopped) and is idempotent', async () => {
        let signal: AbortSignal | undefined;
        h.send.mockImplementation((o: { signal: AbortSignal }) => new Promise((_res, rej) => { signal = o.signal; o.signal.addEventListener('abort', () => rej(Object.assign(new Error('Transfer aborted'), { name: 'AbortError' }))); }));
        const r = new NearTransferRunner();
        const done = r.startSend({ api, port, includeAttachments: true, device: 'x' });
        await Promise.resolve();
        r.giveUp(); r.giveUp();
        await done;
        expect(signal?.aborted).toBe(true);
        expect(r.getSnapshot()).toMatchObject({ gaveUp: true, stopped: false, running: false });
    });
});
