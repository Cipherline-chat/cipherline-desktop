import { describe, it, expect, vi } from 'vitest';
import { processEmojiImage, EmojiProcessError } from './client';
import type { EmojiProcessResponse } from './protocol';

function fakeWorker() {
    const w = {
        onmessage: null as ((e: MessageEvent<EmojiProcessResponse>) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
        reply(m: EmojiProcessResponse) { w.onmessage?.({ data: m } as MessageEvent<EmojiProcessResponse>); },
    };
    return w;
}
const done = { type: 'done', bytes: new Uint8Array([1]), mime: 'image/webp', animated: true, frames: 3, width: 128, durationMs: 300, animationLost: false } as const;

describe('processEmojiImage client', () => {
    it('posts the job, relays progress, resolves with the result and ends the worker', async () => {
        const w = fakeWorker();
        const file = new Blob(['x']);
        const seen: number[] = [];
        const h = processEmojiImage(file, 'fit', f => seen.push(f), () => w);
        expect(w.postMessage).toHaveBeenCalledWith({ type: 'process', file, mode: 'fit' });
        w.reply({ type: 'progress', fraction: 0.5 });
        w.reply(done);
        await expect(h.result).resolves.toMatchObject({ animated: true, frames: 3 });
        expect(seen).toEqual([0.5]);
        expect(w.terminate).toHaveBeenCalledTimes(1);
    });

    it('worker error code surfaces as EmojiProcessError', async () => {
        const w = fakeWorker();
        const h = processEmojiImage(new Blob(['x']), 'crop', undefined, () => w);
        w.reply({ type: 'error', code: 'TOO_COMPLEX', message: 'nope' });
        await expect(h.result).rejects.toMatchObject({ code: 'TOO_COMPLEX', message: 'nope' });
    });

    it('cancel terminates the worker and rejects CANCELLED, once', async () => {
        const w = fakeWorker();
        const h = processEmojiImage(new Blob(['x']), 'crop', undefined, () => w);
        h.cancel(); h.cancel();
        await expect(h.result).rejects.toBeInstanceOf(EmojiProcessError);
        await expect(h.result).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(w.terminate).toHaveBeenCalledTimes(1);
    });

    it('a crashing worker rejects FAILED; an unavailable one rejects UNSUPPORTED', async () => {
        const w = fakeWorker();
        const h = processEmojiImage(new Blob(['x']), 'crop', undefined, () => w);
        w.onerror?.({} as ErrorEvent);
        await expect(h.result).rejects.toMatchObject({ code: 'FAILED' });
        const bad = processEmojiImage(new Blob(['x']), 'crop', undefined, () => { throw new Error('no workers'); });
        await expect(bad.result).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });
});
